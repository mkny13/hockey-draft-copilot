const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scrape = require('../scrape.js');

console.log('Testing automated projection scraper (scrape.js)...');

/* ------------------------------------------------------------ CSV parser */

(function testParseCsv() {
  const rows = scrape.parseCsv('a,b,c\n"x, y","say ""hi""",z\n"multi\nline",2,3\n');
  assert.deepStrictEqual(rows[0], ['a', 'b', 'c']);
  assert.deepStrictEqual(rows[1], ['x, y', 'say "hi"', 'z']);
  assert.deepStrictEqual(rows[2], ['multi\nline', '2', '3']);
  console.log('\u2713 CSV parser handles quotes, escaped quotes, embedded newlines');
})();

/* ---------------------------------------------------------- name matching */

(function testNameKey() {
  assert.strictEqual(scrape.nameKey('Nathan MacKinnon'), scrape.nameKey('Nathan Mackinnon'));
  assert.strictEqual(scrape.nameKey('J.T. Miller'), scrape.nameKey('JT Miller'));
 // Accented spellings collapse onto the ASCII key.
  assert.strictEqual(scrape.nameKey('Nikita Kucherov'), scrape.nameKey('Nikita Kuch\u00e9rov'));
  assert.strictEqual(scrape.nameKey(''), '');
  console.log('\u2713 nameKey normalizes case, punctuation, and accents');
})();

/* --------------------------------------------------------------- fixtures */

// DtZ skater tab shape (header row + three players; "+/-" column included).
const DTZ_SKATERS_CSV = [
  'Player,Age,Pos,Team,ADP,GP,Goals,Assists,Points,PP Points,SHP,Hit,BLK,PIM,FOW,FOL,SOG,+/-,VOR,Rank,Unadj VOR,FP',
  'Nathan MacKinnon,31,"C",COL,1.5,82,52,88,140,45,2,25,20,18,850,700,310,20,240,1,240,500',
  'Kyle Connor,29,"LW",WPG,12.0,80,48,55,103,30,1,20,15,16,120,90,290,5,180,15,180,420',
  'Charlie McAvoy,29,"D",BOS,45.0,75,12,55,67,25,0,90,120,40,0,0,180,15,120,60,120,300',
  ''
].join('\n');

// DtZ goalie tab shape.
const DTZ_GOALIES_CSV = [
  'Player,Age,Team,Pos,ADP,GP,W,L,GA,SA,SV,SV%,GAA',
  'Connor Hellebuyck,33,WPG,G,60,60,35,20,150,1750,1600,0.914,2.5',
  'Igor Shesterkin,31,NYR,G,80,55,30,18,140,1600,1460,0.913,2.55',
  ''
].join('\n');

// Apples & Ginos tab: rows 0-6 are instructions/weights/headers, data at row 7.
// "Nathan Mackinnon" (lowercase k) intentionally matches DtZ's spelling only
// through nameKey normalization.
const AG_CSV = [
  'instructions...', '', 'weights...', '', 'more junk...', '',
  'Name,Team,Y! Pos,Proj,GP,G,A,PTS,PPP,SOG,HIT,BLK,PIM,S%,ATOI',
  'Nathan Mackinnon,COL,C/LW,,82,52,88,140,45,310,25,20,18,.120,21:40',
  'Leon Draisaitl,EDM,C/LW,,80,45,60,105,35,250,30,25,20,.090,22:10',
  ''
].join('\n');

// A&G layout guard: G+A must line up with PTS or the columns have moved.
const AG_BROKEN_CSV = [
  '', '', '', '', '', '', 'Name,Team,Y! Pos,Proj,GP,G,A,PTS',
  'Broken Row,COL,C,,82,52,88,10,45',
  ''
].join('\n');

// Daily Faceoff (5v5 embedded) inline-JS shape: skaters array between the
// skaters/goalies column-def anchors, goalies between goalies/all anchors.
// The goalie row uses GS (starts) and a one-decimal Save_perc, exactly as the
// live page ships them.
const DFO_HTML = [
  '<html><script>',
  'const skatersCatColumnDefs = [];',
  'const data = [',
  '          {',
  "          id: 'Connor McDavid_Oilers',",
  "          isFavourite: favouritePlayerListData.some(e => e.name === 'Connor McDavid' && e.team === 'Oilers'),",
  "          isExcluded: excludePlayerListData.some(e => e.name === 'Connor McDavid' && e.team === 'Oilers'),",
  "          player: {'logo': 'https://x/McDavid-logo.webp', 'name': 'Connor McDavid'},",
  "          team: {'logo': 'https://x/Edmonton_Oilers-logo.webp', 'name': 'Oilers'},",
  '          Pos: "C",',
  '          alt_pos: "C/LW",',
  '          adp: "2.5",',
  '          GP: 82,',
  '          G: 45,',
  '          A: 75,',
  '          PTS: 120,',
  '          PPP: 40,',
  '          plus_minus: 15,',
  '          PIM: 20,',
  '          SOG: 300,',
  '          FOW: 800,',
  '          HIT: 30,',
  '          BLK: 25,',
  '          VAR: -1.5,',
  '          },',
  '        ];',
  'const goaliesCatColumnDefs = [];',
  'const data = [',
  '          {',
  "          id: 'Connor Hellebuyck_Jets',",
  "          player: {'logo': 'https://x/Hellebuyck-logo.webp', 'name': 'Connor Hellebuyck'},",
  "          team: {'logo': 'https://x/Winnipeg_Jets-logo.webp', 'name': 'Jets'},",
  '          Pos: "G",',
  '          alt_pos: "G",',
  '          adp: "62",',
  '          GS: 55,',
  '          W: 30,',
  '          L: 20,',
  '          t_o: 4,',
  '          SO: 5,',
  '          SV: 1500,',
  '          Save_perc: 0.9,',
  '          GA: 140,',
  '          GAA: 2.5,',
  '          SA: 1650,',
  '          VAR: -2.94,',
  '          },',
  '        ];',
  'const allCatColumnDefs = [];',
  '</script></html>'
].join('\n');

/* --------------------------------------------------------- DtZ adapters */

(function testDtzSkaters() {
  const rows = scrape.parseDtzSkaters(scrape.parseCsv(DTZ_SKATERS_CSV));
  assert.strictEqual(rows.length, 3);
  const mac = rows[0];
  assert.strictEqual(mac.name, 'Nathan MacKinnon');
  assert.deepStrictEqual(mac.pos, ['C']);
  assert.strictEqual(mac.team, 'COL');
  assert.strictEqual(mac.adp, 1.5);
  assert.strictEqual(mac.gp, 82);
  assert.strictEqual(mac.stats.G, 52);
  assert.strictEqual(mac.stats.PTS, 140);
  assert.strictEqual(mac.stats['+/-'], 20);
  assert.strictEqual(mac.stats.HIT, 25);
  assert.deepStrictEqual(rows[1].pos, ['LW']);
  assert.deepStrictEqual(rows[2].pos, ['D']);
  console.log('\u2713 DtZ skater adapter parses the live column layout');
})();

(function testDtzGoalies() {
  const rows = scrape.parseDtzGoalies(scrape.parseCsv(DTZ_GOALIES_CSV));
  assert.strictEqual(rows.length, 2);
  const hel = rows[0];
  assert.strictEqual(hel.name, 'Connor Hellebuyck');
  assert.strictEqual(hel.stats['SV%'], 0.914);
  assert.strictEqual(hel.stats.GAA, 2.5);
  assert.strictEqual(hel.stats.W, 35);
  console.log('\u2713 DtZ goalie adapter parses the live column layout');
})();

/* ------------------------------------------------------ A&G adapter */

(function testAgSkaters() {
  const rows = scrape.parseAgSkaters(scrape.parseCsv(AG_CSV));
  assert.strictEqual(rows.length, 2);
  const mac = rows[0];
  assert.strictEqual(mac.name, 'Nathan Mackinnon');
  assert.deepStrictEqual(mac.pos, ['C', 'LW']);
  assert.strictEqual(mac.gp, 82);
  assert.strictEqual(mac.stats.PTS, 140);
  assert.strictEqual(mac.stats.SOG, 310);
  assert.strictEqual(mac.adp, null); // A&G publishes no ADP
  assert.throws(function () {
    scrape.parseAgSkaters(scrape.parseCsv(AG_BROKEN_CSV));
  }, /layout shifted/);
  console.log('\u2713 Apples & Ginos adapter parses row-7 data start, guard catches layout shifts');
})();

/* ------------------------------------------------------ DFO adapter */

(function testDfoRecords() {
  const skaters = scrape.parseDfoRecords(scrape.extractDfoSegment(DFO_HTML, 'skatersCatColumnDefs', 'goaliesCatColumnDefs'));
  const goalies = scrape.parseDfoRecords(scrape.extractDfoSegment(DFO_HTML, 'goaliesCatColumnDefs', 'allCatColumnDefs'));
  assert.strictEqual(skaters.length, 1);
  assert.strictEqual(goalies.length, 1);

  const mcd = skaters[0];
  assert.strictEqual(mcd.name, 'Connor McDavid');
  assert.strictEqual(mcd.team, 'Oilers');
  assert.deepStrictEqual(mcd.pos, ['C', 'LW']); // Pos + alt_pos union
  assert.strictEqual(mcd.adp, 2.5);
  assert.strictEqual(mcd.stats.GP, 82);
  assert.strictEqual(mcd.stats['+/-'], 15);
  assert.strictEqual(mcd.stats.FOW, 800);

  const hel = goalies[0];
  assert.strictEqual(hel.stats.GP, 55);          // GS (starts) mapped to GP
  assert.strictEqual(hel.stats['SV%'], 1500 / 1650); // precision restored
  assert.strictEqual(hel.stats.SO, 5);
  assert.strictEqual(hel.stats.W, 30);
  console.log('\u2713 Daily Faceoff adapter parses inline JS, maps GS to GP, restores SV% precision');
})();

/* -------------------------------------------------------- payload assembly */

(function testBuildPayload() {
  const rows = {
    DTZ: scrape.parseDtzSkaters(scrape.parseCsv(DTZ_SKATERS_CSV))
      .concat(scrape.parseDtzGoalies(scrape.parseCsv(DTZ_GOALIES_CSV))),
    DFO: scrape.parseDfoRecords(scrape.extractDfoSegment(DFO_HTML, 'skatersCatColumnDefs', 'goaliesCatColumnDefs'))
      .concat(scrape.parseDfoRecords(scrape.extractDfoSegment(DFO_HTML, 'goaliesCatColumnDefs', 'allCatColumnDefs'))),
    AGN: scrape.parseAgSkaters(scrape.parseCsv(AG_CSV)),
    AGB: []
  };
  const payload = scrape.buildPayload(rows, '2026-27');
  assert.strictEqual(payload.meta.season, '2026-27');
  assert.deepStrictEqual(payload.stats, scrape.STATS);

  // "Nathan MacKinnon" (DtZ) and "Nathan Mackinnon" (A&G) merge into one row.
  const names = payload.players.map(function (p) { return p.n; });
  // 7 unique players from 9 source rows: MacKinnon (DTZ+AGN) and Hellebuyck
  // (DTZ+DFO) each merge into a single row via nameKey.
  assert.strictEqual(payload.players.length, 7, 'expected 7 merged players, got ' + payload.players.length + ': ' + names.join(', '));
  const mac = payload.players.find(function (p) { return scrape.nameKey(p.n) === scrape.nameKey('Nathan MacKinnon'); });
  assert.ok(mac, 'MacKinnon row missing');
  assert.ok(mac.s.DTZ && mac.s.AGN && !mac.s.DFO, 'MacKinnon should carry DTZ + AGN lines only');
  assert.strictEqual(mac.t, 'COL');              // team votes: 2x COL
  assert.deepStrictEqual(mac.p, ['C', 'LW']);    // union of source positions
  assert.deepStrictEqual(mac.adp, { average: 1.5, yahoo: 1.5 }); // A&G has no ADP

  const hel = payload.players.find(function (p) { return scrape.nameKey(p.n) === scrape.nameKey('Connor Hellebuyck'); });
  assert.deepStrictEqual(hel.adp, { average: 61, yahoo: 61 });   // (60 + 62) / 2
  assert.strictEqual(hel.t, 'WPG');
  assert.ok(hel.s.DFO && hel.s.DTZ, 'Hellebuyck should carry DTZ + DFO lines');

  const mcd = payload.players.find(function (p) { return scrape.nameKey(p.n) === scrape.nameKey('Connor McDavid'); });
  assert.strictEqual(mcd.t, 'EDM');              // DFO full name mapped to tricode
  assert.deepStrictEqual(mcd.adp, { average: 2.5, yahoo: 2.5 });
  console.log('\u2713 buildPayload merges by normalized name, averages ADPs, votes teams');

  global.__fixturePayload = payload;
})();

/* --------------------------------------- valuation compute + serialization */

(function testComputeAndSerialize() {
  const payload = global.__fixturePayload;
  const result = scrape.computeBoard(payload, scrape.DEFAULT_CONFIG);
  assert.ok(result.rows.length === payload.players.length);

  const config = {
    league: { teams: 10, slots: { C: 2, F: 5, D: 4, G: 2, BN: 3 } },
    model: { adp_source: 'yahoo', eligibility: 'yahoo' }
  };
  const result2 = scrape.computeBoard(payload, config);
  const marks = {};
  marks[scrape.nameKey('Nathan MacKinnon')] = 'watch';
  marks[scrape.nameKey('Sidney Crosby')] = 'avoid'; // player absent from sources
  const board = scrape.serializeBoard(payload, result2, config, marks, 'test-source');

  const REQUIRED_KEYS = ['n', 't', 'p', 'rawPos', 'posLabel', 'tier', 'prnk', 'adp', 'fp', 'fpg', 'gp',
    'vorp', 'rawVorp', 'adjVorp', 'dropoff', 'mark', 'id', 'rank'];
  for (const p of board.players) {
    for (const k of REQUIRED_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(p, k), 'missing key ' + k);
    }
    assert.ok(p.prnk.length > 0, 'positional rank label should be filled for ' + p.n);
    assert.strictEqual(p.adjVorp, p.rawVorp); // pre-draft board: no dynamic adjustments
    assert.strictEqual(p.fpg, Math.round((p.fp / p.gp) * 1000) / 1000);
    assert.ok(typeof p.id === 'number' && typeof p.rank === 'number');
  }

  // VORP strictly decreasing down the board; MacKinnon (55 FP above C replacement)
  // sits on top.
  for (let i = 1; i < board.players.length; i++) {
    assert.ok(board.players[i - 1].vorp >= board.players[i].vorp);
  }
  assert.strictEqual(board.players[0].n, 'Nathan MacKinnon');
  assert.strictEqual(board.players[0].mark, 'watch');   // marks carried through
  assert.strictEqual(board.players[0].rawPos.join(','), 'C,LW');

  // C/F league convention: wingers map to Forward.
  const drai = board.players.find(function (p) { return scrape.nameKey(p.n) === scrape.nameKey('Leon Draisaitl'); });
  assert.deepStrictEqual(drai.p, ['C', 'F']);
  assert.strictEqual(drai.posLabel, 'C/F');
  const connor = board.players.find(function (p) { return scrape.nameKey(p.n) === scrape.nameKey('Kyle Connor'); });
  assert.deepStrictEqual(connor.p, ['F']);

  // Previous board's config survives; season survives; meta rewritten.
  assert.strictEqual(board.config.league.teams, 10);
  assert.strictEqual(board.meta.season, '2026-27');
  assert.strictEqual(board.meta.source, 'test-source');
  console.log('\u2713 compute() + serializeBoard emit the exact board schema with C/F mapping');
})();

/* ------------------------------------------------- runRefresh pipeline */

function fixtureRows() {
  return {
    DTZ: scrape.parseDtzSkaters(scrape.parseCsv(DTZ_SKATERS_CSV))
      .concat(scrape.parseDtzGoalies(scrape.parseCsv(DTZ_GOALIES_CSV))),
    DFO: scrape.parseDfoRecords(scrape.extractDfoSegment(DFO_HTML, 'skatersCatColumnDefs', 'goaliesCatColumnDefs'))
      .concat(scrape.parseDfoRecords(scrape.extractDfoSegment(DFO_HTML, 'goaliesCatColumnDefs', 'allCatColumnDefs'))),
    AGN: scrape.parseAgSkaters(scrape.parseCsv(AG_CSV)),
    AGB: []
  };
}

// A stand-in for the owner's existing board: config + season + hand-entered
// marks that must survive a re-scrape.
const PREVIOUS_BOARD = JSON.stringify({
  meta: { season: '2025-26', source: 'Google Sheet Enhanced Master (C and F league)', count: 4 },
  config: {
    league: { teams: 12, slots: { C: 2, F: 5, D: 4, G: 2, BN: 3 } },
    model: { adp_source: 'average', eligibility: 'yahoo' }
  },
  players: [
    { id: 0, rank: 1, n: 'Nathan MacKinnon', mark: 'watch' },
    { id: 1, rank: 2, n: 'Sidney Crosby', mark: 'avoid' },
    { id: 2, rank: 3, n: 'Old Guy', mark: 'watch' },
    { id: 3, rank: 4, n: 'Unmarked Guy', mark: '' }
  ]
});

async function testRunRefresh() {
  // Successful run: injected fetchers, previous board, captured output.
  let written = null;
  const result = await scrape.runRefresh({
    fetchSources: async function () { return { rows: fixtureRows(), errors: {} }; },
    readFile: function () { return PREVIOUS_BOARD; },
    writeFile: function (board) { written = board; return 12345; }
  });

  assert.ok(written, 'writeFile hook not called');
  assert.deepStrictEqual(result.sourcesUsed.sort(), ['AGN', 'DFO', 'DTZ']);
  assert.strictEqual(result.bytes, 12345);

  // Previous board's config and season survive; marks survive (by name key).
  assert.strictEqual(written.config.league.teams, 12);
  assert.strictEqual(written.meta.season, '2025-26');
  const mac = written.players.find(function (p) { return scrape.nameKey(p.n) === scrape.nameKey('Nathan MacKinnon'); });
  assert.strictEqual(mac.mark, 'watch');

  // Partial failure: one source erroring only removes that voice.
  const partial = await scrape.runRefresh({
    fetchSources: async function () { return { rows: { DTZ: fixtureRows().DTZ }, errors: { DFO: 'HTTP 500' } }; },
    readFile: function () { return PREVIOUS_BOARD; },
    writeFile: function () { return 1; }
  });
  assert.deepStrictEqual(partial.sourcesUsed, ['DTZ']);
  assert.strictEqual(partial.sourceErrors.DFO, 'HTTP 500');
  assert.ok(partial.players.length > 0);

  // Total failure: refresh aborts, nothing is written.
  await assert.rejects(
    scrape.runRefresh({
      fetchSources: async function () { return { rows: {}, errors: { DTZ: 'HTTP 429', DFO: 'HTTP 500' } }; },
      readFile: function () { return PREVIOUS_BOARD; },
      writeFile: function () { throw new Error('must not write'); }
    }),
    /every source failed/
  );

  // Unreadable previous board: defaults kick in instead of crashing.
  const fresh = await scrape.runRefresh({
    fetchSources: async function () { return { rows: fixtureRows(), errors: {} }; },
    readFile: function () { throw new Error('ENOENT'); },
    writeFile: function (board) { written = board; return 1; }
  });
  assert.strictEqual(fresh.config.league.teams, scrape.DEFAULT_CONFIG.league.teams);
  assert.ok(written.meta.season.length === 7, 'season synthesized, e.g. 2026-27');

  console.log('\u2713 runRefresh: config/season/marks preserved, partial failures contained, total failure aborts cleanly');
}

/* --------------------------------------------------------- atomic writes */

function testWriteBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-test-'));
  fs.mkdirSync(path.join(dir, 'public'));
  const dataFile = path.join(dir, 'draft_data.json');
  const publicFile = path.join(dir, 'public', 'draft_data.json');
  const board = { meta: { count: 1 }, players: [{ n: 'Test' }] };
  const bytes = scrape.writeBoard(board, dataFile, publicFile);
  assert.strictEqual(bytes, JSON.stringify(board, null, 2).length);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')), board);
  assert.strictEqual(fs.readFileSync(dataFile, 'utf8'), fs.readFileSync(publicFile, 'utf8'));
  // No temp files left behind.
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['draft_data.json', 'public']);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\u2713 writeBoard dual-writes root + public/ copies atomically');
}

(async function main() {
  await testRunRefresh();
  testWriteBoard();
  console.log('\nAll scrape tests passed.');
})().catch(function (err) {
  console.error('SCRAPER TEST FAILURE:', err);
  process.exit(1);
});
