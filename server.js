const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3333;
const STATE_FILE = process.env.DRAFT_STATE_FILE || path.join(__dirname, 'draft_state.json');
const DATA_FILE = path.join(__dirname, 'draft_data.json');

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
    currentPick: res.currentPick,
    targetTurn: res.targetTurn,
    picksUntilTurn: res.picksUntilTurn,
    headline: live.headline || '',
    subtext: live.subtext || '',
    alertType: live.alertType || 'info',
    shortlist: (res.shortlist || []).slice(0, 5).map((p) => ({
      name: p.name,
      pos: p.posLabel,
      team: p.team || '',
      action: p.action,
      survivalProb: p.survivalProb,
      adjVorp: p.adjVorp
    })),
    tradeoff: res.topMatchup && res.topMatchup.cmp ? res.topMatchup.cmp.verdict : ''
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
  saveState();

  broadcast('PICK_MADE', entry);
  console.log(`[Pick #${pickNum}] ${cleanName} (${isMyPick ? 'MY TEAM' : 'Opponent'})`);

  res.json({ success: true, pick: entry, state: draftState });
});

app.post('/api/undo', (req, res) => {
  if (!draftState.pickHistory.length) {
    return res.json({ message: 'No picks to undo', state: draftState });
  }

  const lastPick = draftState.pickHistory.pop();
  delete draftState.drafted[lastPick.name];
  delete draftState.mine[lastPick.name];

  draftState.currentPick = Math.max(1, lastPick.pickNumber || draftState.currentPick - 1);
  saveState();

  broadcast('PICK_UNDONE', lastPick);
  console.log(`[UNDO] Reverted Pick #${lastPick.pickNumber}: ${lastPick.name}`);

  res.json({ success: true, undone: lastPick, state: draftState });
});

app.post('/api/reset', (req, res) => {
  draftState.currentPick = 1;
  draftState.drafted = {};
  draftState.mine = {};
  draftState.pickHistory = [];
  draftState.resetId = Date.now();
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
