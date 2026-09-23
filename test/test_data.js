// Board data integrity: guards against corrupt ADP, bad rows, and ensures the board exists in exactly one place.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const data = JSON.parse(read('draft_data.json'));
const players = data.players;

assert(!fs.existsSync(path.join(__dirname, '..', 'public', 'draft_data.json')), 'the board must exist in exactly one place');

// League config drives every roster limit
const slots = data.config.league.slots;
assert.strictEqual(data.config.league.teams, 8);
assert.deepStrictEqual(
  { C: slots.C, F: slots.F, D: slots.D, G: slots.G, UTIL: slots.UTIL, BN: slots.BN },
  { C: 2, F: 6, D: 6, G: 2, UTIL: 1, BN: 5 },
  'League slots must match the real league (C2 F6 D6 G2 UTIL1 BN5)'
);
console.log('✓ League config');

// Row integrity
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const seen = new Set();
const seenIds = new Set();
players.forEach((p) => {
  assert(p.n && typeof p.n === 'string', 'player has a name');
  assert(!seen.has(norm(p.n)), `duplicate player after normalisation: ${p.n}`);
  seen.add(norm(p.n));
  assert(!seenIds.has(p.id), `duplicate id ${p.id}`);
  seenIds.add(p.id);
  assert(Array.isArray(p.p) && p.p.length && p.p.every((x) => ['C', 'F', 'D', 'G'].includes(x)), `${p.n}: positions must be C/F/D/G`);
  ['vorp', 'fp', 'dropoff', 'rank'].forEach((k) => assert(Number.isFinite(p[k]), `${p.n}: ${k} must be a finite number`));
  assert(p.posLabel, `${p.n}: posLabel`);
});
assert.strictEqual(players.length, 820);
console.log('✓ 820 unique players with valid positions and numbers');

// C-eligible skaters always carry F too (they flex into forward slots)
players.filter((p) => p.p.includes('C')).forEach((p) => assert(p.p.includes('F'), `${p.n}: C must also be F-eligible`));

// ADP columns: plain numbers with at most one decimal (a mis-split parse produced values like 7.02016)
const KINDS = ['espn', 'yahoo', 'average'];
players.forEach((p) => KINDS.forEach((k) => {
  const v = p.adp && p.adp[k];
  if (v === undefined) return;
  assert(Number.isFinite(v) && v > 0, `${p.n}: ${k} ADP must be a positive number`);
  assert(Math.abs(Math.round(v * 10) / 10 - v) < 1e-9, `${p.n}: ${k} ADP ${v} has more than one decimal (corrupt parse)`);
}));
// A fringe player can never have a top-of-draft ADP
players.filter((p) => p.rank > 150 && p.adp && p.adp.espn).forEach((p) => assert(p.adp.espn >= 60, `${p.n} (rank ${p.rank}) has implausible ESPN ADP ${p.adp.espn}`));
// ESPN vs average should broadly agree for anyone who matters
players.filter((p) => p.rank <= 300 && p.adp && p.adp.espn && p.adp.average).forEach((p) => {
  assert(Math.abs(p.adp.espn - p.adp.average) < 150, `${p.n}: ESPN ADP ${p.adp.espn} vs average ${p.adp.average} disagree wildly`);
});
console.log('✓ ADP values are clean and plausible');

// Everyone in the top 200 has some ADP so survival odds are meaningful
players.filter((p) => p.rank < 200).forEach((p) => {
  assert(p.adp && (p.adp.espn || p.adp.average || p.adp.yahoo), `${p.n} (rank ${p.rank}) has no ADP at all`);
});
console.log('✓ Top-200 players all have ADP');

// The extension's name lookup must resolve every board name to itself
const vm = require('vm');
const sandbox = { window: {} };
vm.runInNewContext(read('yahoo-sync/players_data.js'), sandbox);
const bad = players.filter((p) => sandbox.window.resolveCopilotPlayer(p.n) !== p.n).map((p) => p.n);
assert.strictEqual(bad.length, 0, `players_data.js must resolve every board name to itself; failing: ${bad.slice(0, 5)}`);
const stale = sandbox.window.COPILOT_PLAYER_LIST.filter((n) => !seen.has(norm(n)));
assert.strictEqual(stale.length, 0, `players_data.js must not list players missing from the board: ${stale.slice(0, 5)}`);
console.log('✓ Extension name lookup matches the board');

console.log('ALL DATA TESTS PASSED!');
