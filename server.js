const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3333;
const STATE_FILE = process.env.DRAFT_STATE_FILE || path.join(__dirname, 'draft_state.json');
// A gitignored draft_data.local.json (your own board) takes precedence over the committed sample board
const LOCAL_DATA_FILE = path.join(__dirname, 'draft_data.local.json');
const DATA_FILE = fs.existsSync(LOCAL_DATA_FILE) ? LOCAL_DATA_FILE : path.join(__dirname, 'draft_data.json');

// Post-draft report grader (shared engine with the browser)
const GameTheory = require('./public/js/gametheory.js');

// Lazily cached master player board for report grading
let dataCache = null;
function loadData() {
  if (!dataCache) dataCache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return dataCache;
}
function loadPlayers() {
  return loadData().players || [];
}

// Starting-slot limits (C/F/D/G) from the league config baked into the board data
function leagueRosterLimits() {
  const slots = (loadData().config && loadData().config.league && loadData().config.league.slots) || {};
  return {
    C: slots.C || 3, F: slots.F || 5, D: slots.D || 4, G: slots.G || 2,
    UTIL: slots.UTIL || 0,
    FLEX: (slots.UTIL || 0) + (slots.BN || 0) // UTIL (skater) then bench
  };
}

function normName(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Master board row for a synced pick name (accent/punctuation-insensitive)
function findPlayer(name) {
  const key = normName(name);
  return loadPlayers().find((p) => normName(p.n || p.name) === key) || null;
}

// Pure pick-history integrity report for a draft state: every pick number below
// currentPick with no recorded entry, pick numbers recorded more than once, and
// canonical player names appearing in more than one entry. Never mutates state.
function getPickHistoryIntegrity(state) {
  const history = (state && state.pickHistory) || [];
  const currentPick = Math.max(1, parseInt(state && state.currentPick, 10) || 1);
  const byNumber = new Map();
  const byName = new Map();
  for (const entry of history) {
    const num = parseInt(entry && entry.pickNumber, 10);
    if (Number.isFinite(num) && num >= 1) {
      if (!byNumber.has(num)) byNumber.set(num, []);
      byNumber.get(num).push(entry);
    }
    const name = (entry && entry.name) || '';
    if (name) {
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(num);
    }
  }
  const missing = [];
  for (let n = 1; n < currentPick; n++) {
    if (!byNumber.has(n)) missing.push(n);
  }
  const repeated = [...byNumber.entries()]
    .filter(([, entries]) => entries.length > 1)
    .sort((a, b) => a[0] - b[0])
    .map(([pickNumber, entries]) => ({
      pickNumber,
      count: entries.length,
      names: entries.map((e) => e.name)
    }));
  const duplicateNames = [...byName.entries()]
    .filter(([, nums]) => nums.size > 1)
    .map(([name, nums]) => ({ name, pickNumbers: [...nums].sort((a, b) => a - b) }));
  return {
    checkedUpTo: currentPick,
    missing,
    repeated,
    duplicateNames,
    ok: missing.length === 0 && repeated.length === 0 && duplicateNames.length === 0
  };
}

// Keep the live integrity snapshot on the state so every API/WS consumer sees it
function refreshIntegrity() {
  draftState.pickHistoryIntegrity = getPickHistoryIntegrity(draftState);
  return draftState.pickHistoryIntegrity;
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enable CORS for ESPN & Yahoo Fantasy Draft integration & companion tools
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// State-changing requests only from the app itself, localhost tools, or the draft rooms.
// CORS alone does not stop a simple cross-site POST (e.g. /api/reset with no body).
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$|^https:\/\/([a-z0-9-]+\.)*(espn|yahoo)\.com$/i;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'OPTIONS' && origin && !ALLOWED_ORIGIN.test(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});

// The browser loads the board from here so the local override reaches the UI too
app.get('/draft_data.json', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(DATA_FILE);
});

// Serve frontend static assets with no-cache headers to ensure immediate updates in browser
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Default draft state
const defaultState = {
  currentPick: 1,
  slot: 5,
  teams: 8,
  stdDev: 7.0,
  rosterLimits: leagueRosterLimits(),
  drafted: {}, // name -> true
  mine: {},    // name -> true
  pickHistory: [], // array of { pickNumber, name, team, pos, isMine, timestamp }
  resetId: Date.now()
};

let draftState = { ...defaultState };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const loaded = JSON.parse(data);
      // League slots always come from the board data, never from a stale saved state
      draftState = { ...defaultState, ...loaded, rosterLimits: defaultState.rosterLimits };
      console.log(`Loaded state: Pick ${draftState.currentPick}, ${draftState.pickHistory.length} picks recorded.`);
    }
  } catch (err) {
    console.error('Error loading state from disk, using defaults:', err);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(draftState, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving state to disk:', err);
  }
}

loadState();
refreshIntegrity();

// Create HTTP and WebSocket servers
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Live decision snapshot for the in-room HUD (headline, short list, top trade-off)
function buildEvaluation() {
  const res = GameTheory.evaluateBoard(loadPlayers(), {
    currentPick: draftState.currentPick,
    slot: draftState.slot,
    teams: draftState.teams,
    stdDev: draftState.stdDev,
    drafted: draftState.drafted,
    mine: draftState.mine,
    rosterCounts: GameTheory.getRosterCounts(draftState.pickHistory, draftState.rosterLimits),
    rosterLimits: draftState.rosterLimits
  });
  const live = res.liveProtocol || {};
  return {
    onTheClock: res.onTheClock,
    draftComplete: res.draftComplete,
    rosterComplete: res.rosterComplete,
    currentPick: res.currentPick,
    targetTurn: res.targetTurn,
    picksUntilTurn: res.picksUntilTurn,
    headline: live.headline || '',
    subtext: live.subtext || '',
    alertType: live.alertType || 'info',
    // Nothing left to recommend once the last pick is in, or once my roster is full
    shortlist: (res.draftComplete || res.rosterComplete) ? [] : (res.shortlist || []).slice(0, 5).map((p) => ({
      name: p.name,
      pos: p.posLabel,
      team: p.team || '',
      action: p.action,
      survivalProb: p.survivalProb,
      adjVorp: p.adjVorp
    })),
    tradeoff: !res.draftComplete && !res.rosterComplete && res.topMatchup && res.topMatchup.cmp ? res.topMatchup.cmp.verdict : '',
    // Always fresh so the HUD banner can warn the moment a pick number goes dark
    pickHistoryIntegrity: getPickHistoryIntegrity(draftState)
  };
}

function broadcast(type, payload) {
  let evaluation = null;
  try {
    evaluation = buildEvaluation();
  } catch (err) {
    console.error('Evaluation failed:', err);
  }
  const msg = JSON.stringify({ type, payload, state: draftState, evaluation });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  });
}

wss.on('connection', (ws) => {
  let evaluation = null;
  try {
    evaluation = buildEvaluation();
  } catch (err) {
    console.error('Evaluation failed:', err);
  }
  ws.send(JSON.stringify({ type: 'INIT_STATE', state: draftState, evaluation }));
});

// API Endpoints
app.get('/api/state', (req, res) => {
  res.json(draftState);
});

app.get('/api/evaluation', (req, res) => {
  try {
    res.json(buildEvaluation());
  } catch (err) {
    console.error('Evaluation failed:', err);
    res.status(500).json({ error: 'Evaluation failed' });
  }
});

app.post('/api/pick', (req, res) => {
  const { name, team, pos, round, pickInRound, isMine, manual } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Player name is required' });
  }

  // Store the board's own spelling so the player actually leaves the available list
  const master = findPlayer(name);
  const cleanName = master ? master.n : name.trim();

  // If already picked, avoid duplicate
  if (draftState.drafted[cleanName] || draftState.mine[cleanName]) {
    return res.json({ message: 'Player already drafted', state: draftState });
  }

  // Overall pick number: exact when the draft room reports round/pick (P is
  // the pick within the round), otherwise the running counter.
  let pickNum = draftState.currentPick;
  const rnd = parseInt(round, 10);
  const pir = parseInt(pickInRound, 10);
  if (rnd >= 1 && pir >= 1) {
    pickNum = pir > draftState.teams ? pir : (rnd - 1) * draftState.teams + pir;
  }

  // Ownership comes from the snake schedule. The page-scraped isMine flag proved
  // unreliable (class selectors match whole wrappers), so it is honored only when
  // the app itself sends it from an explicit "+ Mine" / "Taken" click.
  const isMyPick = manual === true
    ? !!isMine
    : GameTheory.getPickDetails(pickNum, draftState.teams).ownerSlot === draftState.slot;

  if (isMyPick) {
    draftState.mine[cleanName] = true;
  } else {
    draftState.drafted[cleanName] = true;
  }

  const entry = {
    pickNumber: pickNum,
    name: cleanName,
    team: team || (master && master.t) || '',
    pos: (pos && pos.length) ? pos : ((master && master.p) || []),
    isMine: isMyPick,
    timestamp: new Date().toISOString()
  };

  draftState.pickHistory.push(entry);
  draftState.currentPick = Math.max(draftState.currentPick, pickNum) + 1;
  refreshIntegrity();
  saveState();

  broadcast('PICK_MADE', entry);
  console.log(`[Pick #${pickNum}] ${cleanName} (${isMyPick ? 'MY TEAM' : 'Opponent'})`);

  res.json({ success: true, pick: entry, state: draftState });
});

app.post('/api/undo', (req, res) => {
  if (!draftState.pickHistory.length) {
    return res.json({ message: 'No picks to undo', state: draftState });
  }

  // Undo normally pops the latest entry; a pickNumber targets that exact entry,
  // e.g. to remove a mis-entered historical pick without touching the counter.
  const requested = parseInt(req.body && req.body.pickNumber, 10);
  let idx;
  if (Number.isFinite(requested)) {
    idx = draftState.pickHistory.findIndex((e) => e.pickNumber === requested);
    if (idx === -1) {
      return res.status(404).json({ error: `Pick #${requested} is not in the draft history` });
    }
  } else {
    idx = draftState.pickHistory.length - 1;
  }

  const wasLatest = idx === draftState.pickHistory.length - 1;
  const removed = draftState.pickHistory.splice(idx, 1)[0];

  // Only clear the ownership maps when no remaining entry still records the player
  const stillRecorded = draftState.pickHistory.some((e) => e.name === removed.name);
  if (!stillRecorded) {
    delete draftState.drafted[removed.name];
    delete draftState.mine[removed.name];
  }

  // Only a removed latest pick rewinds the counter; historical repairs undo in place
  if (wasLatest) {
    draftState.currentPick = Math.max(1, removed.pickNumber || draftState.currentPick - 1);
  }
  refreshIntegrity();
  saveState();

  broadcast('PICK_UNDONE', removed);
  console.log(`[UNDO] Reverted Pick #${removed.pickNumber}: ${removed.name}`);

  res.json({ success: true, undone: removed, state: draftState });
});

// Repair a pick that the draft room never reported (e.g. a missed toast): file the
// player at an exact historical number without moving the live counter. Ownership
// always comes from the snake schedule, like every other recorded pick.
app.post('/api/repair-pick', (req, res) => {
  const { pickNumber, name } = req.body || {};
  const num = parseInt(pickNumber, 10);
  if (!Number.isFinite(num) || num < 1) {
    return res.status(400).json({ error: 'A positive pickNumber is required' });
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Player name is required' });
  }
  if (num >= draftState.currentPick) {
    return res.status(400).json({ error: `Pick #${num} is not below the current pick (${draftState.currentPick}); live picks go through /api/pick` });
  }
  if (draftState.pickHistory.some((e) => e.pickNumber === num)) {
    return res.status(400).json({ error: `Pick #${num} is already recorded` });
  }

  // Store the board's own spelling so the repaired player leaves the available list
  const master = findPlayer(name);
  const cleanName = master ? master.n : name.trim();
  if (draftState.drafted[cleanName] || draftState.mine[cleanName]) {
    return res.status(400).json({ error: `${cleanName} is already recorded in the draft history` });
  }

  const isMyPick = GameTheory.getPickDetails(num, draftState.teams).ownerSlot === draftState.slot;
  const entry = {
    pickNumber: num,
    name: cleanName,
    team: (master && master.t) || '',
    pos: (master && master.p) || [],
    isMine: isMyPick,
    repaired: true,
    timestamp: new Date().toISOString()
  };

  // Insert in pick-number order so the history reads like the draft board
  const idx = draftState.pickHistory.findIndex((e) => e.pickNumber > num);
  if (idx === -1) draftState.pickHistory.push(entry);
  else draftState.pickHistory.splice(idx, 0, entry);

  if (isMyPick) draftState.mine[cleanName] = true;
  else draftState.drafted[cleanName] = true;

  // The counter never moves: this pick was on the clock long ago
  refreshIntegrity();
  saveState();

  broadcast('PICK_REPAIRED', entry);
  console.log(`[REPAIR] Pick #${num} filed as ${cleanName} (${isMyPick ? 'MY TEAM' : 'Opponent'}), counter unchanged at ${draftState.currentPick}`);

  res.json({ success: true, pick: entry, state: draftState });
});

app.post('/api/reset', (req, res) => {
  draftState.currentPick = 1;
  draftState.drafted = {};
  draftState.mine = {};
  draftState.pickHistory = [];
  draftState.resetId = Date.now();
  refreshIntegrity();
  saveState();

  broadcast('RESET', { resetId: draftState.resetId });
  console.log(`[RESET] Draft board cleared (Reset ID: ${draftState.resetId}).`);

  res.json({ success: true, state: draftState });
});

// Post-draft report: graded surplus value recap from current draft state
app.get('/api/report', (req, res) => {
  try {
    const players = loadPlayers();
    const report = GameTheory.gradeDraft(draftState.pickHistory, players, {
      rosterLimits: draftState.rosterLimits,
      slot: draftState.slot,
      teams: draftState.teams
    });
    res.json({
      success: true,
      report: report,
      meta: {
        slot: draftState.slot,
        teams: draftState.teams,
        totalPicks: draftState.pickHistory.length,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('Error generating post-draft report:', err);
    res.status(500).json({ error: 'Failed to generate post-draft report' });
  }
});

app.post('/api/settings', (req, res) => {
  const { slot, teams, stdDev, currentPick, rosterLimits } = req.body;
  if (teams !== undefined) draftState.teams = Math.max(2, parseInt(teams, 10) || draftState.teams);
  if (slot !== undefined) draftState.slot = parseInt(slot, 10) || draftState.slot;
  draftState.slot = Math.min(Math.max(1, draftState.slot), draftState.teams);
  if (stdDev !== undefined) draftState.stdDev = parseFloat(stdDev) || draftState.stdDev;
  if (currentPick !== undefined) draftState.currentPick = parseInt(currentPick, 10) || draftState.currentPick;
  if (rosterLimits !== undefined) draftState.rosterLimits = { ...draftState.rosterLimits, ...rosterLimits };
  // A manual counter jump can open or close gaps below it
  refreshIntegrity();
  saveState();
  broadcast('SETTINGS_UPDATED', draftState);
  res.json({ success: true, state: draftState });
});

// Start Server
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`  🏒 FANTASY HOCKEY GAME THEORY CO-PILOT IS LIVE!   `);
  console.log(`  Web App:       http://localhost:${PORT}           `);
  console.log(`  Live Sync API: http://localhost:${PORT}/api/pick  `);
  console.log(`====================================================`);
});
