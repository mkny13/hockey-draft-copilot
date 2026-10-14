// Live-data guard: locks in the server's pick-ingestion guards against a synthetic draft state
// (canonical names, duplicate rejection, pick-number contiguity, pickHistoryIntegrity, repair-pick).
// Spawns the real server on a free port with a throwaway DRAFT_STATE_FILE.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(stateFile) {
  const port = await freePort();
  const env = Object.assign({}, process.env, { PORT: String(port), DRAFT_STATE_FILE: stateFile });
  delete env.HOST;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(200) });
      if (res.ok) return { child, base };
    } catch (_) { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error('server did not start');
}

const post = (base, url, body) => fetch(base + url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {})
});
const state = async (base) => (await fetch(base + '/api/state')).json();

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-guard-'));
  const stateFile = path.join(tmp, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ slot: 5, teams: 8, pickHistory: [], drafted: {}, mine: {}, currentPick: 1 }));
  const { child, base } = await startServer(stateFile);
  const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'draft_data.json'), 'utf8')).players;
  const [p1, p2, p3, p4] = board;
  try {
    await post(base, '/api/reset');

    // 1. Canonical-name matching: a differently-cased draft-room name is stored with the board's spelling
    let res = await post(base, '/api/pick', { name: p1.n.toLowerCase(), round: 1, pickInRound: 1 });
    assert.strictEqual(res.status, 200);
    let s = await state(base);
    assert.strictEqual(s.pickHistory[0].name, p1.n, 'Pick is stored under the board spelling');
    assert.strictEqual(s.drafted[p1.n], true, 'Canonical name leaves the available list');
    assert.deepStrictEqual(s.pickHistory[0].pos, p1.p, 'Position is filled from the board');
    assert.strictEqual(s.pickHistoryIntegrity.ok, true);
    console.log('✓ Guard: canonical-name matching and board-filled position');

    // 2. Duplicate rejection: the same player (any spelling) is not recorded twice
    res = await (await post(base, '/api/pick', { name: p1.n, round: 1, pickInRound: 2 })).json();
    assert.strictEqual(res.message, 'Player already drafted');
    s = await state(base);
    assert.strictEqual(s.pickHistory.length, 1, 'Duplicate pick is not appended');
    assert.strictEqual(s.currentPick, 2);
    assert.deepStrictEqual(s.pickHistoryIntegrity.duplicateNames, []);
    console.log('✓ Guard: duplicate player rejected');

    // 3. Pick-number contiguity: skipping picks 2-3 surfaces them as missing
    await post(base, '/api/pick', { name: p2.n, round: 1, pickInRound: 4 });
    s = await state(base);
    assert.strictEqual(s.currentPick, 5);
    assert.deepStrictEqual(s.pickHistoryIntegrity.missing, [2, 3]);
    assert.deepStrictEqual(s.pickHistoryIntegrity.repeated, []);
    assert.strictEqual(s.pickHistoryIntegrity.ok, false);
    assert.strictEqual(s.pickHistoryIntegrity.checkedUpTo, 5);
    console.log('✓ Guard: gap in pick numbers reported in pickHistoryIntegrity');

    // 4. repair-pick backfills a gap without advancing currentPick
    res = await post(base, '/api/repair-pick', { pickNumber: 2, name: p3.n });
    assert.strictEqual(res.status, 200);
    s = await state(base);
    assert.strictEqual(s.currentPick, 5, 'repair-pick leaves the counter alone');
    assert.deepStrictEqual(s.pickHistoryIntegrity.missing, [3]);
    assert.deepStrictEqual(s.pickHistory.map((e) => e.pickNumber), [1, 2, 4], 'History stays in pick order');
    assert.strictEqual(s.pickHistory[1].repaired, true);

    // repair guards: occupied number, already-recorded player, live/future number
    assert.strictEqual((await post(base, '/api/repair-pick', { pickNumber: 2, name: p4.n })).status, 400);
    assert.strictEqual((await post(base, '/api/repair-pick', { pickNumber: 3, name: p3.n })).status, 400);
    assert.strictEqual((await post(base, '/api/repair-pick', { pickNumber: 5, name: p4.n })).status, 400);
    res = await post(base, '/api/repair-pick', { pickNumber: 3, name: p4.n });
    assert.strictEqual(res.status, 200);
    s = await state(base);
    assert.strictEqual(s.currentPick, 5);
    assert.strictEqual(s.pickHistoryIntegrity.ok, true);
    assert.deepStrictEqual(s.pickHistoryIntegrity.missing, []);
    console.log('✓ Guard: repair-pick backfills gaps without advancing currentPick');

    // 5. Snapshot tracks undo and is also served on the evaluation endpoint
    await post(base, '/api/undo', { pickNumber: 3 });
    s = await state(base);
    assert.deepStrictEqual(s.pickHistoryIntegrity.missing, [3]);
    assert.strictEqual(s.currentPick, 5, 'Undoing a historical pick keeps the counter');
    const ev = await (await fetch(base + '/api/evaluation')).json();
    assert.deepStrictEqual(ev.pickHistoryIntegrity.missing, [3]);
    console.log('✓ Guard: integrity snapshot follows undo and /api/evaluation');

    console.log('ALL LIVE-DATA GUARD TESTS PASSED!');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
