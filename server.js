const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3333;
const STATE_FILE = path.join(__dirname, 'draft_state.json');
const DATA_FILE = path.join(__dirname, 'draft_data.json');

// Post-draft report grader (shared engine with the browser)
const GameTheory = require('./public/js/gametheory.js');

// Automated projection scraper (issue #1): DtZ + Daily Faceoff + Apples & Ginos
const scrape = require('./scrape.js');

// Periodic re-scrape schedule. Override with SCRAPE_CRON (any valid cron
// expression, or "off" to disable); default: every 6 hours.
const SCRAPE_CRON = process.env.SCRAPE_CRON || '0 */6 * * *';

// Lazily cached master player board for report grading
let playersCache = null;
function loadPlayers() {
  if (!playersCache) {
    playersCache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).players || [];
  }
  return playersCache;
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enable CORS for Yahoo Fantasy Draft integration & companion tools
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Serve frontend static assets
app.use(express.static(path.join(__dirname, 'public')));

// Default draft state
const defaultState = {
  currentPick: 1,
  slot: 5,
  teams: 8,
  stdDev: 7.0,
  rosterLimits: { C: 3, F: 5, D: 4, G: 2 },
  drafted: {}, // name -> true
  mine: {},    // name -> true
  pickHistory: [] // array of { pickNumber, name, team, pos, isMine, timestamp }
};

let draftState = { ...defaultState };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const loaded = JSON.parse(data);
      draftState = { ...defaultState, ...loaded };
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

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, state: draftState });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'INIT_STATE', state: draftState }));
});

// API Endpoints
app.get('/api/state', (req, res) => {
  res.json(draftState);
});

app.post('/api/pick', (req, res) => {
  const { name, team, pos, isMine } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Player name is required' });
  }

  const cleanName = name.trim();

  // If already picked, avoid duplicate
  if (draftState.drafted[cleanName] || draftState.mine[cleanName]) {
    return res.json({ message: 'Player already drafted', state: draftState });
  }

  const pickNum = draftState.currentPick;
  const isMyPick = !!isMine;

  if (isMyPick) {
    draftState.mine[cleanName] = true;
  } else {
    draftState.drafted[cleanName] = true;
  }

  const entry = {
    pickNumber: pickNum,
    name: cleanName,
    team: team || '',
    pos: pos || [],
    isMine: isMyPick,
    timestamp: new Date().toISOString()
  };

  draftState.pickHistory.push(entry);
  draftState.currentPick += 1;
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

  draftState.currentPick = Math.max(1, draftState.currentPick - 1);
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
  saveState();

  broadcast('RESET', null);
  console.log('[RESET] Draft board cleared.');

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
  if (slot !== undefined) draftState.slot = parseInt(slot, 10) || draftState.slot;
  if (teams !== undefined) draftState.teams = parseInt(teams, 10) || draftState.teams;
  if (stdDev !== undefined) draftState.stdDev = parseFloat(stdDev) || draftState.stdDev;
  if (currentPick !== undefined) draftState.currentPick = parseInt(currentPick, 10) || draftState.currentPick;
  if (rosterLimits !== undefined) draftState.rosterLimits = { ...draftState.rosterLimits, ...rosterLimits };

  saveState();
  broadcast('SETTINGS_UPDATED', draftState);
  res.json({ success: true, state: draftState });
});

// ===================== Projection Data Refresh (issue #1) =====================

// Last refresh bookkeeping for /api/refresh (GET) status reporting
let lastRefresh = { status: 'never', at: null, sources: [], errors: {}, count: null };

// One refresh at a time -- overlapping scrapes would just race the atomic
// writes and burn bandwidth.
let refreshInProgress = false;
async function runScheduledRefresh(trigger) {
  if (refreshInProgress) {
    return { ok: false, reason: 'refresh already in progress' };
  }
  refreshInProgress = true;
  const startedAt = new Date().toISOString();
  try {
    const result = await scrape.runRefresh();
    playersCache = null; // report grader must see the new board
    lastRefresh = {
      status: 'ok',
      at: startedAt,
      trigger: trigger,
      sources: result.sourcesUsed,
      errors: result.sourceErrors,
      count: result.meta.count,
      meta: result.meta
    };
    broadcast('DATA_UPDATED', lastRefresh);
    console.log(`[refresh:${trigger}] board updated: ${result.meta.count} players from ${result.sourcesUsed.join(', ')}`);
    if (Object.keys(result.sourceErrors).length) {
      console.warn(`[refresh:${trigger}] source warnings:`, result.sourceErrors);
    }
    return { ok: true, result: result };
  } catch (err) {
    lastRefresh = {
      status: 'failed',
      at: startedAt,
      trigger: trigger,
      errors: { pipeline: err.message }
    };
    // The previous draft_data.json is untouched on disk (scrape writes
    // atomically after the full pipeline succeeds), so nothing to roll back.
    console.error(`[refresh:${trigger}] FAILED, previous board left intact:`, err.message);
    return { ok: false, error: err.message };
  } finally {
    refreshInProgress = false;
  }
}

// Manual trigger: rebuild the board from the live sources right now.
app.post('/api/refresh', async (req, res) => {
  const outcome = await runScheduledRefresh('manual');
  if (!outcome.ok) {
    const status = outcome.reason ? 409 : 502;
    return res.status(status).json({ success: false, error: outcome.reason || outcome.error, lastRefresh });
  }
  const result = outcome.result;
  res.json({
    success: true,
    meta: result.meta,
    sourcesUsed: result.sourcesUsed,
    sourceErrors: result.sourceErrors,
    lastRefresh
  });
});

// Refresh status: when did the board last change, and what is scheduled?
app.get('/api/refresh', (req, res) => {
  res.json({
    success: true,
    inProgress: refreshInProgress,
    schedule: SCRAPE_CRON === 'off' ? null : SCRAPE_CRON,
    lastRefresh
  });
});

// Periodic re-scrape while the server runs.
if (SCRAPE_CRON !== 'off' && cron.validate(SCRAPE_CRON)) {
  cron.schedule(SCRAPE_CRON, () => { runScheduledRefresh('cron'); });
  console.log(`[scrape] scheduled periodic refresh: "${SCRAPE_CRON}" (set SCRAPE_CRON=off to disable)`);
} else if (SCRAPE_CRON !== 'off') {
  console.warn(`[scrape] invalid SCRAPE_CRON "${SCRAPE_CRON}" -- periodic refresh disabled`);
}

// Start Server
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`  🏒 FANTASY HOCKEY GAME THEORY CO-PILOT IS LIVE!   `);
  console.log(`  Web App:       http://localhost:${PORT}           `);
  console.log(`  Live Sync API: http://localhost:${PORT}/api/pick  `);
  console.log(`====================================================`);
});
