const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3333;
const STATE_FILE = path.join(__dirname, 'draft_state.json');

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
  rosterLimits: { C: 4, LW: 4, RW: 4, D: 4, G: 2 },
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

// Start Server
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`  🏒 FANTASY HOCKEY GAME THEORY CO-PILOT IS LIVE!   `);
  console.log(`  Web App:       http://localhost:${PORT}           `);
  console.log(`  Live Sync API: http://localhost:${PORT}/api/pick  `);
  console.log(`====================================================`);
});
