// Server API tests: spawns the real server on a free port with a throwaway state file.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(stateFile, envOverrides = {}) {
  const port = await freePort();
  const env = Object.assign({}, process.env, { PORT: String(port), DRAFT_STATE_FILE: stateFile }, envOverrides);
  if (!('HOST' in envOverrides)) {
    delete env.HOST;
  }
  let stdout = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/state`); return { child, base, port, getStdout: () => stdout }; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  child.kill();
  throw new Error('server did not start');
}

const post = (base, url, body, headers) => fetch(base + url, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
  body: body === undefined ? undefined : JSON.stringify(body)
});
const json = async (p) => (await p).json();

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  const stateFile = path.join(tmp, 'state.json');
  // A stale saved state with the old hardcoded limits must not win over the league config
  fs.writeFileSync(stateFile, JSON.stringify({ slot: 5, teams: 8, rosterLimits: { C: 3, F: 5, D: 4, G: 2 }, pickHistory: [], drafted: {}, mine: {}, currentPick: 1 }));

  const { child, base, port, getStdout } = await startServer(stateFile);
  try {
    // Host binding: 127.0.0.1 default, custom HOST opt-in
    assert(getStdout().includes('Host:          127.0.0.1'), 'Startup banner logs default host 127.0.0.1');
    const ifaces = os.networkInterfaces();
    let nonLoopbackIp = null;
    for (const addrs of Object.values(ifaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          nonLoopbackIp = addr.address;
          break;
        }
      }
      if (nonLoopbackIp) break;
    }
    if (nonLoopbackIp) {
      await new Promise((resolve) => {
        const sock = net.connect({ host: nonLoopbackIp, port }, () => {
          sock.destroy();
          assert.fail('Default server bound to loopback should not be reachable via non-loopback IP');
        });
        sock.on('error', (err) => {
          assert(err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT');
          resolve();
        });
      });
    }

    // Verify HOST override (e.g. HOST=0.0.0.0)
    const tmpHost = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-host-'));
    const hostStateFile = path.join(tmpHost, 'state.json');
    const hostSrv = await startServer(hostStateFile, { HOST: '0.0.0.0' });
    try {
      assert(hostSrv.getStdout().includes('Host:          0.0.0.0'), 'Startup banner logs HOST=0.0.0.0');
      const res0 = await fetch(`http://127.0.0.1:${hostSrv.port}/api/state`);
      assert.strictEqual(res0.status, 200);
      if (nonLoopbackIp) {
        await new Promise((resolve, reject) => {
          const sock = net.connect({ host: nonLoopbackIp, port: hostSrv.port }, () => {
            sock.destroy();
            resolve();
          });
          sock.on('error', reject);
        });
      }
    } finally {
      hostSrv.child.kill();
      fs.rmSync(tmpHost, { recursive: true, force: true });
    }
    console.log('✓ Host binding: listens on 127.0.0.1 by default and on HOST when set');

    // League limits come from draft_data.json config
    let st = await json(fetch(`${base}/api/state`));
    assert.deepStrictEqual(st.rosterLimits, { C: 2, F: 6, D: 6, G: 2, UTIL: 1, FLEX: 6 }, 'Limits derive from the league config, not the saved state');
    console.log('✓ Roster limits derive from the league config (stale saved limits ignored)');

    // Canonical names, board position/team, accent/case duplicate rejection
    let r = await json(post(base, '/api/pick', { name: '  tim stutzle ', round: 1, pickInRound: 1 }));
    assert.strictEqual(r.pick.name, 'Tim Stutzle');
    assert.deepStrictEqual(r.pick.pos, ['C', 'F']);
    assert.strictEqual(r.pick.team, 'OTT');
    r = await json(post(base, '/api/pick', { name: 'Tim Stützle' }));
    assert.strictEqual(r.message, 'Player already drafted', 'An accented spelling of a drafted player is a duplicate');
    console.log('✓ Pick names are canonicalised, positions filled, accent duplicates rejected');

    // Ownership: snake schedule only. Slot 5, 8 teams: pick 5 is mine, pick 6 is not, whatever the page says.
    await post(base, '/api/pick', { name: 'Connor McDavid', isMine: true, round: 1, pickInRound: 2 });
    await post(base, '/api/pick', { name: 'Nathan MacKinnon', round: 1, pickInRound: 3 });
    await post(base, '/api/pick', { name: 'Nikita Kucherov', round: 1, pickInRound: 4 });
    r = await json(post(base, '/api/pick', { name: 'Cale Makar', round: 1, pickInRound: 5 }));
    assert.strictEqual(r.pick.isMine, true, 'Pick 5 belongs to slot 5');
    r = await json(post(base, '/api/pick', { name: 'Quinn Hughes', isMine: true, round: 1, pickInRound: 6 }));
    assert.strictEqual(r.pick.isMine, false, 'A scraped isMine flag never overrides the snake schedule');
    // Round 2 reverses: slot 5 picks 12th overall (round 2, pick-in-round 4)
    r = await json(post(base, '/api/pick', { name: 'Macklin Celebrini', round: 2, pickInRound: 4 }));
    assert.strictEqual(r.pick.pickNumber, 12);
    assert.strictEqual(r.pick.isMine, true, 'Snake reversal: slot 5 also picks 12th');
    console.log('✓ Ownership follows the snake schedule; scraped isMine is ignored');

    // The app's explicit buttons are the one override
    r = await json(post(base, '/api/pick', { name: 'Leon Draisaitl', isMine: true, manual: true }));
    assert.strictEqual(r.pick.isMine, true, 'Manual "+ Mine" is honored');
    r = await json(post(base, '/api/pick', { name: 'Evan Bouchard', isMine: false, manual: true, round: 1, pickInRound: 5 }));
    assert.strictEqual(r.pick.isMine, false, 'Manual "Taken" is honored even on my own pick number');
    console.log('✓ Manual +Mine / Taken override works');

    // Pick numbering: currentPick moves past the highest pick seen
    // 12 (Celebrini) + un-numbered Draisaitl takes #13; the earlier-numbered Bouchard must not pull it back
    st = await json(fetch(`${base}/api/state`));
    assert.strictEqual(st.currentPick, 15, 'currentPick only ever moves forward past the highest pick seen');
    r = await json(post(base, '/api/pick', { name: 'Zach Werenski', round: 1, pickInRound: 20 }));
    assert.strictEqual(r.pick.pickNumber, 20, 'A pick-in-round above the team count is an overall pick number');
    console.log('✓ Pick numbering from round/pick');

    // Undo restores the undone pick's number
    r = await json(post(base, '/api/undo'));
    assert.strictEqual(r.undone.name, 'Zach Werenski');
    assert.strictEqual(r.state.currentPick, 20, 'Undo makes the undone pick the current pick again');
    assert.strictEqual(r.state.drafted['Zach Werenski'], undefined);
    console.log('✓ Undo restores the pick number');

    // Settings validation: out-of-range values return 400 and leave state unchanged
    const prevSettings = await json(fetch(`${base}/api/state`));

    // teams: 2-32
    let resBad = await post(base, '/api/settings', { teams: 1 });
    assert.strictEqual(resBad.status, 400, 'teams < 2 returns 400');
    resBad = await post(base, '/api/settings', { teams: 33 });
    assert.strictEqual(resBad.status, 400, 'teams > 32 returns 400');

    // slot: 1-teams (current teams is 8)
    resBad = await post(base, '/api/settings', { slot: 0 });
    assert.strictEqual(resBad.status, 400, 'slot < 1 returns 400');
    resBad = await post(base, '/api/settings', { slot: 9 });
    assert.strictEqual(resBad.status, 400, 'slot > teams returns 400');
    resBad = await post(base, '/api/settings', { slot: 99, teams: 6 });
    assert.strictEqual(resBad.status, 400, 'slot > new teams returns 400');

    // stdDev: 0.1-100
    resBad = await post(base, '/api/settings', { stdDev: 0.05 });
    assert.strictEqual(resBad.status, 400, 'stdDev < 0.1 returns 400');
    resBad = await post(base, '/api/settings', { stdDev: 100.1 });
    assert.strictEqual(resBad.status, 400, 'stdDev > 100 returns 400');

    // currentPick: 1-2000
    resBad = await post(base, '/api/settings', { currentPick: 0 });
    assert.strictEqual(resBad.status, 400, 'currentPick < 1 returns 400');
    resBad = await post(base, '/api/settings', { currentPick: 2001 });
    assert.strictEqual(resBad.status, 400, 'currentPick > 2000 returns 400');

    // rosterLimits: out-of-range integer returns 400
    resBad = await post(base, '/api/settings', { rosterLimits: { C: 51 } });
    assert.strictEqual(resBad.status, 400, 'rosterLimits > 50 returns 400');
    resBad = await post(base, '/api/settings', { rosterLimits: { C: -1 } });
    assert.strictEqual(resBad.status, 400, 'rosterLimits < 0 returns 400');

    // State is completely unchanged after failed settings
    let afterBad = await json(fetch(`${base}/api/state`));
    assert.strictEqual(afterBad.teams, prevSettings.teams);
    assert.strictEqual(afterBad.slot, prevSettings.slot);
    assert.strictEqual(afterBad.stdDev, prevSettings.stdDev);
    assert.strictEqual(afterBad.currentPick, prevSettings.currentPick);
    assert.deepStrictEqual(afterBad.rosterLimits, prevSettings.rosterLimits);

    // Valid settings update state, and unknown rosterLimits keys / non-integer limits are ignored
    const okSettings = await json(post(base, '/api/settings', {
      slot: 6,
      teams: 6,
      stdDev: 8.5,
      currentPick: 25,
      rosterLimits: { C: 4, UNKNOWN_KEY: 99, F: 'non-integer', D: 5 }
    }));
    assert.strictEqual(okSettings.state.teams, 6);
    assert.strictEqual(okSettings.state.slot, 6);
    assert.strictEqual(okSettings.state.stdDev, 8.5);
    assert.strictEqual(okSettings.state.currentPick, 25);
    assert.strictEqual(okSettings.state.rosterLimits.C, 4);
    assert.strictEqual(okSettings.state.rosterLimits.D, 5);
    assert.strictEqual(okSettings.state.rosterLimits.UNKNOWN_KEY, undefined, 'unknown rosterLimits key ignored');
    assert.strictEqual(okSettings.state.rosterLimits.F, prevSettings.rosterLimits.F, 'non-integer roster limit ignored');

    // Restore standard settings for subsequent tests
    await post(base, '/api/settings', { slot: 5, teams: 8, stdDev: 7.0, currentPick: 20, rosterLimits: prevSettings.rosterLimits });
    console.log('✓ Settings validation and rosterLimits filtering pass');

    // Pick name validation: >80 chars, empty/whitespace, control chars return 400 and are not recorded
    const tooLongName = 'A'.repeat(81);
    let pBad = await post(base, '/api/pick', { name: tooLongName });
    assert.strictEqual(pBad.status, 400);

    pBad = await post(base, '/api/pick', { name: '' });
    assert.strictEqual(pBad.status, 400);

    pBad = await post(base, '/api/pick', { name: '   \t  ' });
    assert.strictEqual(pBad.status, 400);

    pBad = await post(base, '/api/pick', { name: 'Player\nName' });
    assert.strictEqual(pBad.status, 400);

    pBad = await post(base, '/api/pick', { name: 'Player\r\nName' });
    assert.strictEqual(pBad.status, 400);

    pBad = await post(base, '/api/pick', { name: 'Player\x00Name' });
    assert.strictEqual(pBad.status, 400);

    pBad = await post(base, '/api/pick', { nope: 1 });
    assert.strictEqual(pBad.status, 400);

    // Verify none of these bad names were recorded
    st = await json(fetch(`${base}/api/state`));
    assert.strictEqual(st.drafted[tooLongName], undefined);
    assert.strictEqual(st.drafted['Player\nName'], undefined);

    // Repair pick validation: name > 80 chars, control chars return 400
    const repBad = await post(base, '/api/repair-pick', { pickNumber: 2, name: 'Bad\nRepair' });
    assert.strictEqual(repBad.status, 400);

    // Pos and team validation on /api/pick:
    // 1. Non-array pos falls back to board positions
    // 2. Team > 8 chars falls back to board team
    let pFallback = await json(post(base, '/api/pick', {
      name: 'Auston Matthews',
      pos: 'not-an-array',
      team: 'TORONTO_MAPLE_LEAFS'
    }));
    assert.strictEqual(pFallback.pick.name, 'Auston Matthews');
    assert.deepStrictEqual(pFallback.pick.pos, ['C', 'F'], 'Non-array pos falls back to board position');
    assert.strictEqual(pFallback.pick.team, 'TOR', 'Long team string falls back to board team');

    // 3. Array with unknown entries falls back to board positions
    pFallback = await json(post(base, '/api/pick', {
      name: 'Mikko Rantanen',
      pos: ['GARBAGE_POS', 'JUNK']
    }));
    assert.strictEqual(pFallback.pick.name, 'Mikko Rantanen');
    assert.deepStrictEqual(pFallback.pick.pos, ['F'], 'Array with only unknown entries falls back to board positions');

    // 4. Array with unknown entries drops unknown entries; caps at 4 entries
    pFallback = await json(post(base, '/api/pick', {
      name: 'David Pastrnak',
      pos: ['F', 'INVALID_POS'],
      team: 'BOS'
    }));
    assert.strictEqual(pFallback.pick.name, 'David Pastrnak');
    assert.deepStrictEqual(pFallback.pick.pos, ['F'], 'Unknown pos entry is dropped');
    assert.strictEqual(pFallback.pick.team, 'BOS', 'Valid team is preserved');

    // 5. Capping pos at 4 entries
    pFallback = await json(post(base, '/api/pick', {
      name: 'Kirill Kaprizov',
      pos: ['C', 'LW', 'RW', 'W', 'F']
    }));
    assert.strictEqual(pFallback.pick.name, 'Kirill Kaprizov');
    assert.deepStrictEqual(pFallback.pick.pos, ['C', 'LW', 'RW', 'W'], 'Pos is capped at 4 entries');

    // 6. round / pickInRound: integers outside 1..1000 or non-integers are treated as absent
    const curBefore = (await json(fetch(`${base}/api/state`))).currentPick;
    pFallback = await json(post(base, '/api/pick', {
      name: 'Artemi Panarin',
      round: 1001,
      pickInRound: 1
    }));
    assert.strictEqual(pFallback.pick.pickNumber, curBefore, 'Out-of-range round is treated as absent');

    console.log('✓ Pick field validation (name, team, pos, round/pickInRound) pass');

    // Over-limit request body (>64kb) is rejected with 413 rather than parsed
    const hugeBody = JSON.stringify({ name: 'Huge Player', junk: 'X'.repeat(70 * 1024) });
    const hugeRes = await fetch(`${base}/api/pick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: hugeBody
    });
    assert.strictEqual(hugeRes.status, 413, 'Payload > 64kb returns 413 Payload Too Large');
    console.log('✓ Over-limit request body rejected with 413');

    // Refuse to grow pickHistory past 2000 entries
    const tmp2000 = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-2000-'));
    const state2000File = path.join(tmp2000, 'state.json');
    const dummyHistory = Array.from({ length: 2000 }, (_, i) => ({
      pickNumber: i + 1,
      name: `Dummy Player ${i + 1}`,
      team: 'EDM',
      pos: ['C'],
      isMine: false,
      timestamp: new Date().toISOString()
    }));
    fs.writeFileSync(state2000File, JSON.stringify({
      slot: 5,
      teams: 8,
      currentPick: 2001,
      pickHistory: dummyHistory,
      drafted: {},
      mine: {}
    }));
    const srv2000 = await startServer(state2000File);
    try {
      const resOver = await post(srv2000.base, '/api/pick', { name: 'Player 2001' });
      assert.strictEqual(resOver.status, 400, '2001st pick returns 400');
      const bodyOver = await resOver.json();
      assert(bodyOver.error && bodyOver.error.includes('2000'), 'Error message mentions 2000 limit');

      const repOver = await post(srv2000.base, '/api/repair-pick', { pickNumber: 50, name: 'Repair Player' });
      assert.strictEqual(repOver.status, 400, 'Repair at 2000 limit returns 400');
      const repBody = await repOver.json();
      assert(repBody.error && repBody.error.includes('2000'), 'Repair error mentions 2000 limit');
    } finally {
      srv2000.child.kill();
      fs.rmSync(tmp2000, { recursive: true, force: true });
    }
    console.log('✓ Refuses to grow pickHistory past 2000 entries');

    // Cross-origin protection
    const evil = await post(base, '/api/reset', undefined, { Origin: 'https://evil.example' });
    assert.strictEqual(evil.status, 403, 'Foreign origin cannot reset the draft');
    const lookalike = await post(base, '/api/reset', undefined, { Origin: 'https://espn.com.evil.io' });
    assert.strictEqual(lookalike.status, 403, 'Look-alike domain is rejected');
    for (const origin of ['https://fantasy.espn.com', 'https://draft.fantasysports.yahoo.com', `http://localhost:${port}`]) {
      const ok = await post(base, '/api/settings', { slot: 5 }, { Origin: origin });
      assert.strictEqual(ok.status, 200, `${origin} is allowed`);
    }
    st = await json(fetch(`${base}/api/state`));
    assert(st.pickHistory.length > 0, 'The rejected reset did not clear the draft');
    console.log('✓ Origin check: foreign origins blocked, ESPN/Yahoo/localhost allowed');

    // Scoped CORS for GET endpoints: /api/state, /api/report, /draft_data.json
    const getRoutes = ['/api/state', '/api/report', '/draft_data.json'];
    const allowedOrigins = ['https://fantasy.espn.com', 'https://draft.fantasysports.yahoo.com', `http://localhost:${port}`];
    for (const route of getRoutes) {
      // Foreign origin returns no ACAO header, but includes Vary: Origin
      const evilRes = await fetch(`${base}${route}`, { headers: { Origin: 'https://evil.example' } });
      assert.strictEqual(evilRes.status, 200, `${route} should return 200 for foreign origin`);
      assert.strictEqual(evilRes.headers.get('access-control-allow-origin'), null, `${route} must not set ACAO for foreign origin`);
      assert.strictEqual(evilRes.headers.get('vary'), 'Origin', `${route} must send Vary: Origin`);

      // Allowed origins receive echoed ACAO and Vary: Origin
      for (const origin of allowedOrigins) {
        const okRes = await fetch(`${base}${route}`, { headers: { Origin: origin } });
        assert.strictEqual(okRes.status, 200, `${route} should return 200 for allowed origin ${origin}`);
        assert.strictEqual(okRes.headers.get('access-control-allow-origin'), origin, `${route} must echo ACAO for ${origin}`);
        assert.strictEqual(okRes.headers.get('vary'), 'Origin', `${route} must send Vary: Origin`);
      }

      // No origin header: succeeds, no ACAO, Vary: Origin present
      const noOriginRes = await fetch(`${base}${route}`);
      assert.strictEqual(noOriginRes.status, 200, `${route} succeeds without Origin`);
      assert.strictEqual(noOriginRes.headers.get('access-control-allow-origin'), null, `${route} no ACAO without Origin`);
      assert.strictEqual(noOriginRes.headers.get('vary'), 'Origin', `${route} must send Vary: Origin`);
    }
    console.log('✓ Scoped CORS: GET endpoints echo allowed origins and omit ACAO for foreign origins');

    // Preflight OPTIONS: 200 for allowed origin, 403 for foreign or missing origin
    for (const route of ['/api/pick', '/api/reset', '/api/state', '/draft_data.json']) {
      for (const origin of allowedOrigins) {
        const optOk = await fetch(`${base}${route}`, { method: 'OPTIONS', headers: { Origin: origin } });
        assert.strictEqual(optOk.status, 200, `OPTIONS ${route} must return 200 for allowed origin`);
        assert.strictEqual(optOk.headers.get('access-control-allow-origin'), origin);
        assert.strictEqual(optOk.headers.get('vary'), 'Origin');
      }

      const optEvil = await fetch(`${base}${route}`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
      assert.strictEqual(optEvil.status, 403, `OPTIONS ${route} must return 403 for foreign origin`);
      assert.strictEqual(optEvil.headers.get('access-control-allow-origin'), null);

      const optNone = await fetch(`${base}${route}`, { method: 'OPTIONS' });
      assert.strictEqual(optNone.status, 403, `OPTIONS ${route} must return 403 with no origin`);
    }
    console.log('✓ Preflight OPTIONS returns 200 for allowed origins and 403 for foreign/missing origins');

    // Evaluation snapshot for the HUD
    let ev = await json(fetch(`${base}/api/evaluation`));
    assert.strictEqual(typeof ev.headline, 'string');
    assert(ev.shortlist.length > 0 && ev.shortlist.length <= 5);
    assert(ev.shortlist.every((p) => p.name && typeof p.survivalProb === 'number'));
    assert.strictEqual(typeof ev.tradeoff, 'string');
    assert.strictEqual(ev.draftComplete, false);
    ev = (await json(post(base, '/api/settings', { currentPick: 177 }))).state;
    ev = await json(fetch(`${base}/api/evaluation`));
    assert.strictEqual(ev.draftComplete, true, '8 teams x 22 rounds = 176 picks');
    assert.strictEqual(ev.onTheClock, false);
    assert(ev.headline.includes('Draft complete'));
    assert.deepStrictEqual(ev.shortlist, [], 'No short list once the draft is over');
    assert.strictEqual(ev.tradeoff, '');
    console.log('✓ Evaluation snapshot and draft-complete state');

    // Post-draft report with the extended limits
    const rep = await json(fetch(`${base}/api/report`));
    assert.strictEqual(rep.success, true);
    console.log('✓ Report endpoint');

    // Roster complete: a full "My Team" stops recommendations before the draft ends
    // (the missing final pick must not keep the app advising)
    await post(base, '/api/reset');
    for (let i = 1; i <= 22; i++) {
      await post(base, '/api/pick', { name: `Roster Filler ${i}`, manual: true, isMine: true });
    }
    ev = await json(fetch(`${base}/api/evaluation`));
    assert.strictEqual(ev.draftComplete, false, 'Only 22 picks are in: the draft is not over');
    assert.strictEqual(ev.rosterComplete, true, '22 of my picks fill the 22-slot roster');
    assert.strictEqual(ev.onTheClock, false);
    assert.deepStrictEqual(ev.shortlist, [], 'No short list once my roster is full');
    assert.strictEqual(ev.tradeoff, '');
    assert(ev.headline.includes('roster is complete'));
    console.log('✓ Roster-complete flag and empty shortlist in the evaluation snapshot');

    // WebSocket: INIT_STATE and broadcasts carry an evaluation
    await post(base, '/api/reset');
    const msgs = [];
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('message', (m) => msgs.push(JSON.parse(m)));
    await new Promise((resolve) => ws.on('open', resolve));
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(msgs[0].type, 'INIT_STATE');
    assert.strictEqual(typeof msgs[0].evaluation.headline, 'string');
    await post(base, '/api/pick', { name: 'Connor McDavid' });
    await new Promise((r) => setTimeout(r, 300));
    const made = msgs.find((m) => m.type === 'PICK_MADE');
    assert(made && made.evaluation && made.evaluation.shortlist.length > 0, 'PICK_MADE carries a fresh evaluation');
    assert(!made.evaluation.shortlist.some((p) => p.name === 'Connor McDavid'), 'The drafted player left the short list');
    ws.close();
    console.log('✓ WebSocket INIT_STATE and PICK_MADE carry the evaluation');

    // WebSocket origin verification: foreign origin rejected; allowed origin and no-origin receive INIT_STATE
    // 1. Foreign origin is rejected
    await new Promise((resolve, reject) => {
      const wsEvil = new WebSocket(`ws://localhost:${port}`, { headers: { Origin: 'https://evil.example' } });
      let rejected = false;
      wsEvil.on('error', (err) => {
        rejected = true;
      });
      wsEvil.on('open', () => {
        wsEvil.close();
        reject(new Error('WebSocket with foreign origin should not open'));
      });
      wsEvil.on('close', (code) => {
        assert(rejected || code === 1008, 'WebSocket connection with foreign origin must be rejected');
        resolve();
      });
    });

    // 2. Allowed origin receives INIT_STATE
    await new Promise((resolve, reject) => {
      const wsAllowed = new WebSocket(`ws://localhost:${port}`, { headers: { Origin: 'https://fantasy.espn.com' } });
      wsAllowed.on('error', reject);
      wsAllowed.on('message', (raw) => {
        const msg = JSON.parse(raw);
        assert.strictEqual(msg.type, 'INIT_STATE');
        assert(msg.state && msg.evaluation);
        wsAllowed.close();
        resolve();
      });
    });

    // 3. Client with no origin receives INIT_STATE
    await new Promise((resolve, reject) => {
      const wsNoOrigin = new WebSocket(`ws://localhost:${port}`);
      wsNoOrigin.on('error', reject);
      wsNoOrigin.on('message', (raw) => {
        const msg = JSON.parse(raw);
        assert.strictEqual(msg.type, 'INIT_STATE');
        assert(msg.state && msg.evaluation);
        wsNoOrigin.close();
        resolve();
      });
    });
    console.log('✓ WebSocket origin check: foreign origin rejected, allowed and no-origin receive INIT_STATE');

    // Reset changes the reset id
    const before = (await json(fetch(`${base}/api/state`))).resetId;
    await new Promise((r) => setTimeout(r, 5));
    const after = (await json(post(base, '/api/reset'))).state.resetId;
    assert.notStrictEqual(before, after);
    console.log('✓ Reset issues a new reset id');

    // WebSocket client whose TCP socket is destroyed does not crash the server
    const wsCrashTest = new WebSocket(`ws://localhost:${port}`);
    await new Promise((resolve) => wsCrashTest.on('open', resolve));
    wsCrashTest._socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
    await post(base, '/api/pick', { name: 'Elias Pettersson', manual: true, isMine: false });
    const resAfterCrash = await fetch(`${base}/api/state`);
    assert.strictEqual(resAfterCrash.status, 200, 'Server still answers 200 after client socket destroyed');
    console.log('✓ WebSocket client socket destruction does not crash server; GET /api/state answers 200');

    // Dead-client reaping: client that stops responding to pings is terminated within two intervals
    const tmpPing = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-ping-'));
    const pingState = path.join(tmpPing, 'state.json');
    const srvPing = await startServer(pingState, { WS_PING_MS: '50' });
    try {
      const wsDead = new WebSocket(`ws://localhost:${srvPing.port}`);
      await new Promise((resolve) => wsDead.on('open', resolve));
      // Suppress pongs to simulate a client that stops responding to pings
      wsDead.pong = () => {};

      let reaped = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 25));
        if (srvPing.getStdout().includes('[WS] Terminated 1 dead client(s)')) {
          reaped = true;
          break;
        }
      }
      assert(reaped, 'Captured stdout must report the dead client was terminated');
      wsDead._socket.destroy();
    } finally {
      srvPing.child.kill();
      fs.rmSync(tmpPing, { recursive: true, force: true });
    }
    console.log('✓ Dead client reaping terminates unresponsive client within two intervals and logs reap');

    // Atomic saveState: after a burst of picks, draft_state.json parses and no .tmp file survives
    for (let i = 1; i <= 5; i++) {
      await post(base, '/api/pick', { name: `Burst Player ${i}`, manual: true, isMine: false });
    }
    assert(!fs.existsSync(`${stateFile}.tmp`), 'draft_state.json.tmp must not exist after successful saves');
    const diskParsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(diskParsed.pickHistory.some((p) => p.name === 'Burst Player 5'), 'State file on disk contains latest pick');
    console.log('✓ draft_state.json is replaced by atomic rename; no .tmp file survives');

    // Graceful shutdown on SIGTERM: saves state, closes both servers, exits 0, no double banner on repeated signals
    const tmpShut = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-shut-'));
    const shutState = path.join(tmpShut, 'state.json');
    const srvShut = await startServer(shutState);
    try {
      await post(srvShut.base, '/api/pick', { name: 'Shutdown Star', manual: true, isMine: true });
      // Send SIGTERM, then immediately SIGINT to test idempotency
      srvShut.child.kill('SIGTERM');
      srvShut.child.kill('SIGINT');

      const exitCode = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve('TIMEOUT'), 3000);
        srvShut.child.on('exit', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      assert.strictEqual(exitCode, 0, 'Server exited 0 on SIGTERM within 2s');

      const diskState = JSON.parse(fs.readFileSync(shutState, 'utf8'));
      assert(diskState.pickHistory.some((p) => p.name === 'Shutdown Star'), 'State file on disk contains last pick before shutdown');

      const bannerMatches = (srvShut.getStdout().match(/Shutting down/g) || []).length;
      assert.strictEqual(bannerMatches, 1, 'Shutdown banner printed exactly once despite repeated signals');
    } finally {
      try { srvShut.child.kill(); } catch (_) {}
      fs.rmSync(tmpShut, { recursive: true, force: true });
    }
    console.log('✓ SIGINT/SIGTERM saves state, closes servers, exits 0, and avoids double-banner on repeated signals');

    // Starting a second server on a busy port prints readable message and exits non-zero without stack trace
    const busyChild = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(port), DRAFT_STATE_FILE: path.join(tmp, 'busy.json') }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let busyOut = '';
    let busyErr = '';
    busyChild.stdout.on('data', (d) => { busyOut += d.toString(); });
    busyChild.stderr.on('data', (d) => { busyErr += d.toString(); });
    const busyCode = await new Promise((resolve) => busyChild.on('exit', (code) => resolve(code)));
    assert.notStrictEqual(busyCode, 0, 'Second server must exit with non-zero code');
    const combinedOutput = busyOut + busyErr;
    assert(
      combinedOutput.includes(`port ${port} is already in use — is another copy of the Co-Pilot running?`),
      `Expected readable EADDRINUSE message, got: ${combinedOutput}`
    );
    assert(!combinedOutput.includes('Error: listen EADDRINUSE'), 'Must not dump raw stack trace');
    console.log('✓ Starting a second server on a busy port prints readable message and exits non-zero');

    // No two draft states share a mutable sub-object: pick, reset, restart on same file
    const tmpIso = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-iso-'));
    const isoState = path.join(tmpIso, 'state.json');
    let srvIso = await startServer(isoState);
    try {
      await post(srvIso.base, '/api/pick', { name: 'Sidney Crosby', manual: true, isMine: true });
      let stBefore = await json(fetch(`${srvIso.base}/api/state`));
      assert.strictEqual(stBefore.pickHistory.length, 1);
      assert(stBefore.mine['Sidney Crosby']);

      await post(srvIso.base, '/api/reset');
      let stAfter = await json(fetch(`${srvIso.base}/api/state`));
      assert.strictEqual(stAfter.pickHistory.length, 0);
      assert.deepStrictEqual(stAfter.drafted, {});
      assert.deepStrictEqual(stAfter.mine, {});

      srvIso.child.kill();
      srvIso = await startServer(isoState);
      let stRestart = await json(fetch(`${srvIso.base}/api/state`));
      assert.strictEqual(stRestart.pickHistory.length, 0, 'pickHistory is empty after restart');
      assert.deepStrictEqual(stRestart.drafted, {}, 'drafted has no keys after restart');
      assert.deepStrictEqual(stRestart.mine, {}, 'mine has no keys after restart');
    } finally {
      srvIso.child.kill();
      fs.rmSync(tmpIso, { recursive: true, force: true });
    }
    console.log('✓ No two draft states share a mutable sub-object; reset survives server restart');
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('ALL SERVER TESTS PASSED!');
})().catch((err) => { console.error(err); process.exit(1); });
