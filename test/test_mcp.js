const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const FX = path.join(__dirname, 'fixtures', 'mcp');
const { parseCsv } = require(path.join(root, 'mcp/lib/csv'));
const N = require(path.join(root, 'mcp/lib/names'));
const tools = require(path.join(root, 'mcp/lib/tools'));
const { createFetcher } = require(path.join(root, 'mcp/lib/fetch'));

const fx = (f) => fs.readFileSync(path.join(FX, f), 'utf8');
const close = (a, b, eps = 1e-3) => assert(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// ---- stub deps: URL -> fixture, with a call log ----
const NOW = Date.UTC(2026, 9, 12, 12); // Oct 12 2026 -> current season 2026
const ROUTES = [
  [/seasonSummary\/\d+\/regular\/goalies\.csv/, 'mp_goalies.csv'],
  [/seasonSummary\/\d+\/regular\/skaters\.csv/, 'mp_skaters.csv'],
  [/seasonSummary\/\d+\/regular\/teams\.csv/, 'mp_teams.csv'],
  [/gameByGame\/regular\/goalies\//, 'mp_gbg_goalie.csv'],
  [/gameByGame\/regular\/skaters\//, 'mp_gbg_skater.csv'],
  [/goalie\/summary/, 'nhl_goalie_summary.json'],
  [/skater\/summary/, 'nhl_skater_summary.json'],
  [/skater\/realtime/, 'nhl_skater_realtime.json'],
  [/skater\/timeonice/, 'nhl_skater_timeonice.json'],
  [/team\/summary/, 'nhl_team_summary.json'],
  [/standings-season/, 'nhl_standings_season.json'],
  [/standings\//, 'nhl_standings.json'],
  [/game-log\/\d+\/2/, null], // chosen by player id below
  [/player\/\d+\/landing/, null],
  [/schedule\/\d{4}-\d{2}-\d{2}/, 'nhl_schedule_date.json'],
  [/club-schedule-season/, 'nhl_club_schedule.json'],
];

function makeDeps() {
  const calls = [];
  const body = (url) => {
    let m;
    if ((m = /player\/(\d+)\/game-log/.exec(url))) return fx(m[1] === '8478048' ? 'nhl_gamelog_goalie.json' : 'nhl_gamelog_skater.json');
    if ((m = /player\/(\d+)\/landing/.exec(url))) {
      const bios = { 8478402: ['Connor', 'McDavid', 'EDM', 'C'], 8478048: ['Igor', 'Shesterkin', 'NYR', 'G'] };
      const b = bios[m[1]];
      return JSON.stringify({ firstName: { default: b[0] }, lastName: { default: b[1] }, currentTeamAbbrev: b[2], position: b[3] });
    }
    for (const [re, f] of ROUTES) if (re.test(url) && f) return fx(f);
    throw new Error('HTTP 404');
  };
  const deps = {
    now: () => NOW,
    fetchText: async (url, o) => { calls.push({ url, ttl: o && o.ttl }); return { body: body(url), fetchedAt: NOW - 1000, stale: false }; },
    fetchJson: async (url, o) => { calls.push({ url, ttl: o && o.ttl }); return { data: JSON.parse(body(url)), fetchedAt: NOW - 1000, stale: false }; },
  };
  return { deps, calls };
}

(async () => {
  // ---- csv ----
  {
    const rows = parseCsv('a,b,c\n1,"x, y",3\n"q ""z""",5,\r\n');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].b, 'x, y');
    assert.strictEqual(rows[0].c, '3');
    assert.strictEqual(rows[1].a, 'q "z"');
    assert.strictEqual(rows[1].c, '');
    assert.deepStrictEqual(parseCsv(''), []);
    const teams = parseCsv(fx('mp_teams.csv'));
    assert.strictEqual(teams[0].team, teams[0].name, 'duplicate header still maps by name');
  }

  // ---- names ----
  {
    assert.strictEqual(N.normalize('Tim Stützle'), 'tim stutzle');
    assert.strictEqual(N.normalize("J.T. Miller"), 'jt miller');
    assert.strictEqual(N.normalize('Alexis Lafrenière'), 'alexis lafreniere');
    assert.strictEqual(N.normalizeTeam('TB'), 'TBL');
    assert.strictEqual(N.normalizeTeam('tbl'), 'TBL');
    assert.strictEqual(N.normalizeTeam('S.J'), 'SJS');
    assert.strictEqual(N.normalizeTeam('UTAH'), 'UTA');
    assert.strictEqual(N.lastTeam('TOR,EDM'), 'EDM');
    assert.strictEqual(N.lastTeam('EDM,PIT,COL'), 'COL');
    assert.strictEqual(N.lastTeam('TB'), 'TBL');
    const idx = N.buildIndex([
      { playerId: 1, name: 'Mitchell Marner', team: 'VGK', gp: 80 },
      { playerId: 2, name: 'Sebastian Aho', team: 'CAR', gp: 80 },
      { playerId: 3, name: 'Sebastian Aho', team: 'NYI', gp: 50 },
      { playerId: 4, name: 'Tim Stützle', team: 'OTT', gp: 80 },
      { playerId: 5, name: 'Alex Ovechkin', team: 'WSH', gp: 70 },
    ]);
    assert.strictEqual(N.lookup(idx, 'tim stutzle').matches[0].score, 1.0);
    const nick = N.lookup(idx, 'Mitch Marner').matches[0];
    assert.strictEqual(nick.playerId, 1);
    assert.strictEqual(nick.score, 0.8);
    assert.strictEqual(N.lookup(idx, 'Alexander Ovechkin').matches[0].score, 0.8);
    assert.strictEqual(N.lookup(idx, 'stutzle').matches[0].score, 0.6);
    assert.strictEqual(N.lookup(idx, 'tutz').matches[0].score, 0.4);
    const tie = N.lookup(idx, 'Sebastian Aho');
    assert.strictEqual(tie.matches.length, 2);
    assert(tie.warnings.length && /ambiguous/.test(tie.warnings[0]));
    const byTeam = N.lookup(idx, 'Sebastian Aho', { team: 'NYI' });
    assert.strictEqual(byTeam.matches.length, 1);
    assert.strictEqual(byTeam.matches[0].playerId, 3);
    assert.deepStrictEqual(N.lookup(idx, 'zzz').matches, []);
  }

  // ---- goalie_stats ----
  {
    const { deps } = makeDeps();
    const r = await tools.goalie_stats({ season: 2025 }, deps);
    assert(/MoneyPuck/.test(r.source));
    assert.strictEqual(r.season, 2025);
    assert.strictEqual(r.goalies[0].name.length > 0, true);
    const shes = r.goalies.find((g) => g.playerId === 8478048);
    // GSAx = xGoals - goals; GSAx/60 = gsax / (icetime / 3600)
    close(shes.gsax, 147.25 - 126);
    close(shes.gsax60, (147.25 - 126) / (181453 / 3600));
    assert.strictEqual(shes.team, 'NYR');
    assert(shes.wins > 0 && shes.savePct > 0, 'NHL columns joined on playerId');
    // default sort is gsax desc
    for (let i = 1; i < r.goalies.length; i++) assert(r.goalies[i - 1].gsax >= r.goalies[i].gsax);
    // situation filter: NHL columns are omitted with a warning
    const s5 = await tools.goalie_stats({ season: 2025, situation: '5on5' }, deps);
    const s5shes = s5.goalies.find((g) => g.playerId === 8478048);
    close(s5shes.gsax, 98.08 - 81);
    assert.strictEqual(s5shes.wins, null);
    assert(s5.warnings.some((w) => /all-situations only/.test(w)));
    await assert.rejects(() => tools.goalie_stats({ situation: 'pp' }, deps), /invalid situation/);
    // min_gp, limit, sort, team
    assert.deepStrictEqual((await tools.goalie_stats({ season: 2025, min_gp: 40 }, deps)).goalies.map((g) => g.playerId).sort(), [8475683, 8478048]);
    const lim = await tools.goalie_stats({ season: 2025, limit: 1, sort: 'games_played' }, deps);
    assert.strictEqual(lim.goalies.length, 1);
    assert.strictEqual(lim.count, 3);
    assert.strictEqual(lim.goalies[0].playerId, 8475683);
    const asc = await tools.goalie_stats({ season: 2025, sort: 'gsax', order: 'asc' }, deps);
    assert(asc.goalies[0].gsax <= asc.goalies[1].gsax);
    assert.deepStrictEqual((await tools.goalie_stats({ season: 2025, team: 'nyr' }, deps)).goalies.map((g) => g.playerId), [8478048]);
    // sorting works on a column that is not returned, unknown sort warns
    const hd = await tools.goalie_stats({ season: 2025, sort: 'gsax_high', fields: ['name'] }, deps);
    assert.deepStrictEqual(Object.keys(hd.goalies[0]), ['playerId', 'name']);
    const bad = await tools.goalie_stats({ season: 2025, sort: 'nope' }, deps);
    assert(bad.warnings.some((w) => /unknown sort column/.test(w)));
    // fields selection: raw MoneyPuck columns, NHL columns, computed, prefixes, unknown warns
    const f = await tools.goalie_stats({ season: 2025, team: 'NYR', fields: ['xGoals', 'goals', 'nhl.goals', 'mp.goals', 'gsax_high', 'bogus'] }, deps);
    const row = f.goalies[0];
    assert.strictEqual(row.xGoals, 147.25);
    assert.strictEqual(row.goals, 126, 'bare name resolves MoneyPuck first');
    assert.strictEqual(row['mp.goals'], 126);
    assert.strictEqual(row['nhl.goals'], 0);
    assert(row.gsax_high != null);
    assert(!('bogus' in row));
    assert.deepStrictEqual(f.warnings, ['unknown field: bogus']);
    // past season never expires
    const { deps: d2, calls } = makeDeps();
    await tools.goalie_stats({ season: 2024 }, d2);
    assert(calls.every((c) => c.ttl === Infinity), 'past season ttl is Infinity');
    const { deps: d3, calls: c3 } = makeDeps();
    await tools.goalie_stats({}, d3);
    assert(c3.every((c) => /seasonSummary\/2026|seasonId=20262027/.test(c.url)), 'default season is current (Oct => this year)');
    assert(c3.every((c) => c.ttl !== Infinity));
  }

  // ---- skater_stats ----
  {
    const { deps } = makeDeps();
    const r = await tools.skater_stats({ season: 2025 }, deps);
    const mc = r.skaters.find((s) => s.playerId === 8478402);
    close(mc.g_minus_ixg, 48 - 43.6);
    assert(mc.sh_pct > 0 && mc.sh_pct < 1);
    assert(mc.hits >= 0 && mc.blockedShots >= 0, 'hits/blocks come from skater/realtime');
    assert.strictEqual(r.skaters[0].playerId, 8478402, 'default sort is points desc');
    // accent cases: NHL display name wins over MoneyPuck's stripped name
    assert.strictEqual(r.skaters.find((s) => s.playerId === 8482109).name, 'Alexis Lafrenière');
    assert.strictEqual(r.skaters.find((s) => s.playerId === 8482116).name, 'Tim Stützle');
    // traded players: last teamAbbrevs entry; TB alias
    assert.strictEqual(r.skaters.find((s) => s.playerId === 8476967).team, 'COL');
    assert.strictEqual(r.skaters.find((s) => s.playerId === 8470621).team, 'TBL');
    assert.deepStrictEqual((await tools.skater_stats({ season: 2025, team: 'TB' }, deps)).skaters.map((s) => s.playerId), [8470621]);
    assert.deepStrictEqual((await tools.skater_stats({ season: 2025, position: 'D' }, deps)).skaters.map((s) => s.playerId), [8476967]);
    assert.strictEqual((await tools.skater_stats({ season: 2025, position: 'F' }, deps)).count, 4);
    // onice_xgf_pct from MoneyPuck on-ice columns
    const mp = parseCsv(fx('mp_skaters.csv')).find((x) => x.playerId === '8478402' && x.situation === 'all');
    close(mc.onice_xgf_pct, Number(mp.OnIce_F_xGoals) / (Number(mp.OnIce_F_xGoals) + Number(mp.OnIce_A_xGoals)));
    // situation: MoneyPuck I_F_* defaults
    const pp = await tools.skater_stats({ season: 2025, situation: '5on4' }, deps);
    assert(pp.warnings.some((w) => /all-situations only/.test(w)));
    assert('I_F_goals' in pp.skaters[0] && !('points' in pp.skaters[0]));
    const fs2 = await tools.skater_stats({ season: 2025, fields: ['I_F_xGoals', 'timeOnIcePerGame', 'ppTimeOnIcePerGame'], limit: 1 }, deps);
    assert(fs2.skaters[0].timeOnIcePerGame > 0 && fs2.skaters[0].ppTimeOnIcePerGame > 0);
    assert.strictEqual((await tools.skater_stats({ season: 2025, limit: 2 }, deps)).skaters.length, 2);
    assert.strictEqual((await tools.skater_stats({ season: 2025, min_gp: 82 }, deps)).count, 3);
  }

  // ---- team_stats ----
  {
    const { deps } = makeDeps();
    const r = await tools.team_stats({ season: 2025 }, deps);
    assert.strictEqual(r.teams.length, 4);
    const edm = r.teams.find((t) => t.team === 'EDM');
    close(edm.xgf60, 274.56 / (298229 / 3600));
    close(edm.xga60, 257.25 / (298229 / 3600));
    close(edm.xgf_pct, 274.56 / (274.56 + 257.25));
    assert.strictEqual(edm.name, 'Edmonton Oilers');
    assert(edm.points > 0 && edm.goalsForPerGame > 0, 'standings/summary join by abbreviation');
    const e5 = await tools.team_stats({ season: 2025, situation: '5on5', team: 'edm' }, deps);
    assert.strictEqual(e5.teams.length, 1);
    close(e5.teams[0].xgf60, 182.23 / (248729 / 3600));
    const sorted = await tools.team_stats({ season: 2025, sort: 'xga60', order: 'asc', limit: 2 }, deps);
    assert(sorted.teams[0].xga60 <= sorted.teams[1].xga60 && sorted.teams.length === 2);
  }

  // ---- player_lookup ----
  {
    const { deps } = makeDeps();
    const r = await tools.player_lookup({ query: 'Lafreniere', season: 2025 }, deps);
    assert.strictEqual(r.matches[0].playerId, 8482109);
    assert.strictEqual(r.matches[0].name, 'Alexis Lafrenière');
    assert.strictEqual((await tools.player_lookup({ query: 'stutzle', season: 2025 }, deps)).matches[0].playerId, 8482116);
    assert.strictEqual((await tools.player_lookup({ query: 'Shesterkin', season: 2025 }, deps)).matches[0].pos, 'G');
    const t = await tools.player_lookup({ query: 'perry', season: 2025 }, deps);
    assert.strictEqual(t.matches[0].team, 'TBL');
    assert.strictEqual(t.matches[0].teamAbbrevs, 'LAK,TBL');
    await assert.rejects(() => tools.player_lookup({}, deps), /query is required/);
  }

  // ---- player_game_log ----
  {
    const { deps, calls } = makeDeps();
    const r = await tools.player_game_log({ player: 'McDavid', season: 2025, last_n: 3 }, deps);
    assert.strictEqual(r.player.playerId, 8478402);
    assert.strictEqual(r.games.length, 3);
    assert.strictEqual(r.games[0].gameDate, '2026-04-16');
    assert.strictEqual(r.games[0].points, 4);
    assert(!('ixg' in r.games[0]));
    assert(!calls.some((c) => /moneypuck/.test(c.url)), 'MoneyPuck per-game data is not fetched unless asked');
    const x = await tools.player_game_log({ player: 8478402, season: 2025, last_n: 2, include_xg: true }, deps);
    assert(calls.some((c) => /gameByGame\/regular\/skaters\/8478402/.test(c.url)));
    assert(calls.filter((c) => /gameByGame/.test(c.url)).every((c) => c.ttl === 6 * 3600 * 1000), 'per-game data cached 6 h');
    assert.strictEqual(x.player.name, 'Connor McDavid');
    assert(x.games[0].ixg > 0 && 'hits' in x.games[0] && 'blocks' in x.games[0]);
    const g = await tools.player_game_log({ player: 'Shesterkin', season: 2025, last_n: 2, include_xg: true }, deps);
    assert.strictEqual(g.player.pos, 'G');
    assert(g.games[0].shotsAgainst > 0 && 'decision' in g.games[0]);
    assert(g.games[0].xga > 0, 'goalie per-game xGA');
    close(g.games[0].gsax, g.games[0].xga - parseCsv(fx('mp_gbg_goalie.csv')).find((c) => c.gameId === String(g.games[0].gameId) && c.situation === 'all').goals);
    const sel = await tools.player_game_log({ player: 8478402, season: 2025, last_n: 1, fields: ['shots', 'nope'] }, deps);
    assert.deepStrictEqual(Object.keys(sel.games[0]), ['gameId', 'shots']);
    assert.deepStrictEqual(sel.warnings, ['unknown field: nope']);
    await assert.rejects(() => tools.player_game_log({}, deps), /player is required/);
    await assert.rejects(() => tools.player_game_log({ player: 'Nobodyatall', season: 2025 }, deps), /no player matches/);
  }

  // ---- schedule ----
  {
    const { deps } = makeDeps();
    const byDate = await tools.schedule({ date: '2026-03-10' }, deps);
    assert.strictEqual(byDate.games.length, 3);
    assert.strictEqual(byDate.games[0].away, 'LAK');
    assert.strictEqual(byDate.games[0].home, 'BOS');
    assert.strictEqual(byDate.season, 2025, 'season is derived from the date');
    assert.strictEqual((await tools.schedule({ date: '2026-03-11' }, deps)).games.length, 0);
    const byTeam = await tools.schedule({ team: 'EDM', season: 2025 }, deps);
    assert.strictEqual(byTeam.games.length, 3);
    assert(byTeam.games.every((g) => g.home === 'EDM' || g.away === 'EDM'));
    const both = await tools.schedule({ team: 'EDM', season: 2025, date: '2025-10-11' }, deps);
    assert.strictEqual(both.games.length, 1);
    assert.strictEqual(both.games[0].away, 'VAN');
    assert.strictEqual((await tools.schedule({ team: 'EDM', season: 2025, limit: 2 }, deps)).games.length, 2);
    await assert.rejects(() => tools.schedule({ date: 'March 10' }, deps), /YYYY-MM-DD/);
    const f = await tools.schedule({ date: '2026-03-10', fields: ['away'] }, deps);
    assert.deepStrictEqual(Object.keys(f.games[0]), ['id', 'away']);
  }

  // ---- standings ----
  {
    const { deps, calls } = makeDeps();
    const r = await tools.standings({ season: 2025 }, deps);
    assert.strictEqual(r.standings[0].teamAbbrev, 'COL');
    assert.strictEqual(r.standings[0].teamName, 'Colorado Avalanche');
    assert(calls.some((c) => /standings\/2026-04-16/.test(c.url)), 'past season uses the final standings date');
    const now = await tools.standings({}, deps);
    assert(calls.some((c) => /standings\/now/.test(c.url)));
    assert.strictEqual(now.standings.length, 4);
    assert.strictEqual((await tools.standings({ team: 'tbl' }, deps)).standings.length, 1);
    assert.strictEqual((await tools.standings({ date: '2026-04-01', limit: 2, fields: ['wins'] }, deps)).standings.length, 2);
  }

  // ---- cache ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhlmcp-'));
    let t = 1000000;
    let n = 0;
    let fail = false;
    const fetchImpl = async () => {
      n++;
      if (fail) return { ok: false, status: 503, text: async () => '' };
      return { ok: true, status: 200, text: async () => `body${n}` };
    };
    const f = createFetcher({ cacheDir: dir, now: () => t, fetchImpl });
    const url = 'https://example.test/a.csv';
    const HOUR = 3600 * 1000;
    let r = await f.fetchText(url, { ttl: HOUR });
    assert.strictEqual(r.body, 'body1');
    assert.strictEqual(r.cached, false);
    t += HOUR / 2;
    r = await f.fetchText(url, { ttl: HOUR });
    assert.strictEqual(n, 1, 'fresh hit does no fetch');
    assert.strictEqual(r.body, 'body1');
    t += HOUR;
    r = await f.fetchText(url, { ttl: HOUR });
    assert.strictEqual(n, 2, 'expired entry refetches');
    assert.strictEqual(r.body, 'body2');
    t += 10 * HOUR;
    r = await f.fetchText(url, { ttl: Infinity });
    assert.strictEqual(n, 2, 'infinite ttl never expires');
    t += 10 * HOUR;
    fail = true;
    r = await f.fetchText(url, { ttl: HOUR });
    assert.strictEqual(r.stale, true, 'failure with an expired cache entry is stale');
    assert.strictEqual(r.body, 'body2');
    await assert.rejects(() => f.fetchText('https://example.test/none.csv'), (e) => /example\.test\/none\.csv/.test(e.message) && /503/.test(e.message));
    assert(fs.readdirSync(dir).length === 1, "failed fetches are not cached");
    const j = await createFetcher({ cacheDir: dir, now: () => t, fetchImpl: async () => ({ ok: true, text: async () => '{"a":1}' }) }).fetchJson('https://example.test/j');
    assert.strictEqual(j.data.a, 1);
    // stale flag surfaces in tool responses
    const { deps } = makeDeps();
    const staleDeps = { ...deps, fetchText: async (u, o) => ({ ...(await deps.fetchText(u, o)), stale: true }) };
    assert.strictEqual((await tools.goalie_stats({ season: 2025 }, staleDeps)).stale, true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- guard: mcp/lib stays fantasy-free and board-free ----
  {
    const libDir = path.join(root, 'mcp', 'lib');
    for (const file of fs.readdirSync(libDir)) {
      const src = fs.readFileSync(path.join(libDir, file), 'utf8');
      assert(!/draft_data/.test(src), `${file} must not read draft_data*.json`);
      assert(!/config\.scoring/.test(src), `${file} must not mention config.scoring`);
      assert(!/require\(['"]@modelcontextprotocol/.test(src), `${file} must not import the SDK`);
    }
    const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(rootPkg.dependencies).sort(), ['express', 'ws']);
  }

  console.log('test_mcp.js: all tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
