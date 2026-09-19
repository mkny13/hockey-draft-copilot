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

async function startServer(stateFile) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), DRAFT_STATE_FILE: stateFile }),
    stdio: 'ignore'
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/state`); return { child, base, port }; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
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

  const { child, base, port } = await startServer(stateFile);
  try {
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

    // Settings clamp and validation
    r = await json(post(base, '/api/settings', { slot: 99, teams: 6 }));
    assert.strictEqual(r.state.teams, 6);
    assert.strictEqual(r.state.slot, 6, 'Slot is clamped into 1..teams');
    await post(base, '/api/settings', { slot: 5, teams: 8 });
    const bad = await post(base, '/api/pick', { nope: 1 });
    assert.strictEqual(bad.status, 400);
    console.log('✓ Settings clamped; bad body rejected');

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
    console.log('✓ Evaluation snapshot and draft-complete state');

    // Post-draft report with the extended limits
    const rep = await json(fetch(`${base}/api/report`));
    assert.strictEqual(rep.success, true);
    console.log('✓ Report endpoint');

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

    // Reset changes the reset id
    const before = (await json(fetch(`${base}/api/state`))).resetId;
    await new Promise((r) => setTimeout(r, 5));
    const after = (await json(post(base, '/api/reset'))).state.resetId;
    assert.notStrictEqual(before, after);
    console.log('✓ Reset issues a new reset id');
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('ALL SERVER TESTS PASSED!');
})().catch((err) => { console.error(err); process.exit(1); });
