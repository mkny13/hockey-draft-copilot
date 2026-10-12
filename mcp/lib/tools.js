// Tool handlers: pure functions of (args, deps) with deps = { fetchText, fetchJson, now }.
// Each returns a plain object; server.js wraps it as one JSON text block.
const S = require('./sources');
const N = require('./names');

const SITUATIONS = ['all', '5on5', '4on5', '5on4', 'other'];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

// ---------- helpers ----------

// CSV cells arrive as strings; numeric-looking ones become numbers.
function coerce(row) {
  const o = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    o[k] = typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
  }
  return o;
}

// NHL web API wraps strings as { default, fr, ... }; flatten them.
function flatten(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('default' in v) return v.default;
    const o = {};
    for (const k of Object.keys(v)) o[k] = flatten(v[k]);
    return o;
  }
  return v;
}

const round = (x, d = 3) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const div = (a, b) => (typeof a === 'number' && typeof b === 'number' && b !== 0 ? a / b : null);
const sub = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : null);

// Tracks asOf/stale across every fetch a handler makes.
function track(deps) {
  const state = { fetchedAt: null, stale: false, calls: 0 };
  const note = (r) => {
    state.calls++;
    if (r.fetchedAt != null && (state.fetchedAt == null || r.fetchedAt < state.fetchedAt)) state.fetchedAt = r.fetchedAt;
    if (r.stale) state.stale = true;
    return r;
  };
  return {
    state,
    deps: {
      now: deps.now,
      fetchText: async (u, o) => note(await deps.fetchText(u, o)),
      fetchJson: async (u, o) => note(await deps.fetchJson(u, o)),
    },
  };
}

function envelope(t, season, warnings, payload) {
  const out = {
    season,
    asOf: new Date(t.state.fetchedAt != null ? t.state.fetchedAt : t.deps.now()).toISOString(),
    source: S.SOURCE,
  };
  if (t.state.stale) out.stale = true;
  if (warnings.length) out.warnings = warnings;
  return { ...out, ...payload };
}

function checkSituation(sit) {
  const s = sit || 'all';
  if (!SITUATIONS.includes(s)) throw new Error(`invalid situation: ${sit} (one of ${SITUATIONS.join(', ')})`);
  return s;
}

function clampLimit(limit) {
  const n = limit == null ? DEFAULT_LIMIT : Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// A row keeps three views of each value: computed, `mp` (MoneyPuck), `nhl` (official).
// Field lookup order: computed, `mp.`/`nhl.` prefixed names, bare name in MoneyPuck then NHL.
function lookupField(row, name) {
  if (name in row.computed) return row.computed[name];
  if (name.startsWith('mp.')) return row.mp[name.slice(3)];
  if (name.startsWith('nhl.')) return row.nhl[name.slice(4)];
  if (name in row.mp) return row.mp[name];
  if (name in row.nhl) return row.nhl[name];
  return undefined;
}

function hasField(rows, name) {
  return rows.some((r) => lookupField(r, name) !== undefined);
}

const ID_FIELDS = ['playerId', 'name'];

// Shapes one row, applies `fields` (or the defaults), warns about unknown fields once.
function shapeRows(rows, { fields, defaults, idFields = ID_FIELDS }, warnings) {
  let wanted = defaults;
  if (Array.isArray(fields) && fields.length) {
    wanted = [];
    for (const f of fields) {
      if (hasField(rows, f) || !rows.length) wanted.push(f);
      else warnings.push(`unknown field: ${f}`);
    }
  }
  const keys = [...idFields.filter((k) => !wanted.includes(k)), ...wanted];
  return rows.map((r) => {
    const o = {};
    for (const k of keys) {
      const v = lookupField(r, k);
      o[k] = v === undefined ? null : (typeof v === 'number' ? round(v) : v);
    }
    return o;
  });
}

// Sorts on any numeric column (returned or not). Unknown sort column warns and falls back.
function sortRows(rows, sort, order, fallback, warnings) {
  let key = sort || fallback;
  if (sort && !hasField(rows, sort)) {
    if (rows.length) warnings.push(`unknown sort column: ${sort}; sorted by ${fallback}`);
    key = fallback;
  }
  const dir = order === 'asc' ? 1 : -1;
  const val = (r) => {
    const v = lookupField(r, key);
    return typeof v === 'number' ? v : null;
  };
  return rows.slice().sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return dir * (x - y);
  });
}

function filterPosition(position, p) {
  if (!position) return true;
  const want = String(position).toUpperCase();
  if (want === 'F') return ['C', 'L', 'R', 'F'].includes(p);
  return p === want;
}

// ---------- goalie_stats ----------

const GOALIE_DEFAULTS = [
  'name', 'team', 'games_played', 'gamesStarted', 'wins', 'losses', 'otLosses', 'shutouts',
  'shotsAgainst', 'saves', 'goalsAgainst', 'savePct', 'goalsAgainstAverage',
  'icetime', 'xGoals', 'gsax', 'gsax60',
];

function goalieComputed(mp) {
  const c = {
    gsax: sub(mp.xGoals, mp.goals),
    gsax_low: sub(mp.lowDangerxGoals, mp.lowDangerGoals),
    gsax_medium: sub(mp.mediumDangerxGoals, mp.mediumDangerGoals),
    gsax_high: sub(mp.highDangerxGoals, mp.highDangerGoals),
  };
  const hours = div(mp.icetime, 3600);
  c.gsax60 = div(c.gsax, hours);
  c.gsax60_low = div(c.gsax_low, hours);
  c.gsax60_medium = div(c.gsax_medium, hours);
  c.gsax60_high = div(c.gsax_high, hours);
  c.sv_pct_mp = mp.ongoal ? 1 - mp.goals / mp.ongoal : null;
  return c;
}

async function goalieStats(args = {}, deps) {
  const t = track(deps);
  const warnings = [];
  const season = S.resolveSeason(args.season, deps);
  const situation = checkSituation(args.situation);
  const team = N.normalizeTeam(args.team);
  const minGp = args.min_gp == null ? 1 : Number(args.min_gp);
  const mpP = S.moneypuck(t.deps, season, 'goalies');
  const nhlP = situation === 'all' ? S.nhlStats(t.deps, 'goalie/summary', season) : null;
  const [mp, nhl] = await Promise.all([mpP, nhlP]);
  const nhlById = new Map(nhl ? nhl.rows.map((r) => [r.playerId, r]) : []);
  if (!nhl) warnings.push('official NHL columns (wins, losses, savePct, ...) are all-situations only; they are omitted for situation != all');
  let rows = [];
  for (const raw of mp.rows) {
    const m = coerce(raw);
    if (m.situation !== situation) continue;
    const n = nhlById.get(m.playerId) || {};
    const tm = n.teamAbbrevs ? N.lastTeam(n.teamAbbrevs) : N.normalizeTeam(m.team);
    if (team && tm !== team) continue;
    if (m.games_played < minGp) continue;
    const nm = { ...n };
    if (n.goalieFullName) nm.name = n.goalieFullName;
    rows.push({ mp: m, nhl: nm, computed: { playerId: m.playerId, name: n.goalieFullName || m.name, team: tm, ...goalieComputed(m) } });
  }
  rows = sortRows(rows, args.sort, args.order, 'gsax', warnings);
  const goalies = shapeRows(rows.slice(0, clampLimit(args.limit)), { fields: args.fields, defaults: GOALIE_DEFAULTS }, warnings);
  return envelope(t, season, warnings, { situation, count: rows.length, goalies });
}

// ---------- skater_stats ----------

const SKATER_DEFAULTS = [
  'name', 'team', 'position', 'games_played', 'icetime',
  'goals', 'assists', 'points', 'shots', 'hits', 'blockedShots', 'ppPoints', 'shPoints',
  'I_F_xGoals', 'g_minus_ixg', 'sh_pct', 'g_per_ixg', 'onice_xgf_pct',
];

function skaterComputed(mp) {
  return {
    g_minus_ixg: sub(mp.I_F_goals, mp.I_F_xGoals),
    sh_pct: div(mp.I_F_goals, mp.I_F_shotsOnGoal),
    g_per_ixg: div(mp.I_F_goals, mp.I_F_xGoals),
    onice_xgf_pct: div(mp.OnIce_F_xGoals, (mp.OnIce_F_xGoals || 0) + (mp.OnIce_A_xGoals || 0)),
  };
}

async function skaterStats(args = {}, deps) {
  const t = track(deps);
  const warnings = [];
  const season = S.resolveSeason(args.season, deps);
  const situation = checkSituation(args.situation);
  const team = N.normalizeTeam(args.team);
  const minGp = args.min_gp == null ? 1 : Number(args.min_gp);
  const all = situation === 'all';
  const [mp, sum, rt, toi] = await Promise.all([
    S.moneypuck(t.deps, season, 'skaters'),
    all ? S.nhlStats(t.deps, 'skater/summary', season) : null,
    all ? S.nhlStats(t.deps, 'skater/realtime', season) : null,
    all ? S.nhlStats(t.deps, 'skater/timeonice', season) : null,
  ]);
  const nhlById = new Map();
  if (all) {
    for (const src of [sum, rt, toi]) {
      for (const r of src.rows) nhlById.set(r.playerId, { ...(nhlById.get(r.playerId) || {}), ...r });
    }
  } else {
    warnings.push('official NHL columns (points, hits, ppPoints, ...) are all-situations only; use the MoneyPuck I_F_* columns for situation != all');
  }
  let rows = [];
  for (const raw of mp.rows) {
    const m = coerce(raw);
    if (m.situation !== situation) continue;
    if (!filterPosition(args.position, m.position)) continue;
    const n = nhlById.get(m.playerId) || {};
    const tm = n.teamAbbrevs ? N.lastTeam(n.teamAbbrevs) : N.normalizeTeam(m.team);
    if (team && tm !== team) continue;
    if (m.games_played < minGp) continue;
    rows.push({ mp: m, nhl: n, computed: { playerId: m.playerId, name: n.skaterFullName || m.name, team: tm, ...skaterComputed(m) } });
  }
  rows = sortRows(rows, args.sort, args.order, all ? 'points' : 'I_F_points', warnings);
  const skaters = shapeRows(rows.slice(0, clampLimit(args.limit)), {
    fields: args.fields,
    defaults: all ? SKATER_DEFAULTS : SKATER_DEFAULTS.filter((f) => !['goals', 'assists', 'points', 'shots', 'hits', 'blockedShots', 'ppPoints', 'shPoints'].includes(f)).concat(['I_F_goals', 'I_F_points', 'I_F_shotsOnGoal', 'I_F_hits', 'shotsBlockedByPlayer']),
  }, warnings);
  return envelope(t, season, warnings, { situation, count: rows.length, skaters });
}

// ---------- team_stats ----------

const TEAM_DEFAULTS = [
  'team', 'name', 'games_played', 'wins', 'losses', 'otLosses', 'points',
  'goalsForPerGame', 'goalsAgainstPerGame', 'shotsForPerGame', 'shotsAgainstPerGame', 'powerPlayPct', 'penaltyKillPct',
  'xGoalsFor', 'xGoalsAgainst', 'xgf60', 'xga60', 'xgf_pct',
];

function teamComputed(mp) {
  const hours = div(mp.iceTime, 3600);
  return {
    xgf60: div(mp.xGoalsFor, hours),
    xga60: div(mp.xGoalsAgainst, hours),
    xgf_pct: div(mp.xGoalsFor, (mp.xGoalsFor || 0) + (mp.xGoalsAgainst || 0)),
    hd_xga60: div(mp.highDangerxGoalsAgainst, hours),
    hd_xgf60: div(mp.highDangerxGoalsFor, hours),
    gf60: div(mp.goalsFor, hours),
    ga60: div(mp.goalsAgainst, hours),
  };
}

async function loadStandings(deps, season, date) {
  const r = await S.standings(deps, { season, date });
  return (r.data.standings || []).map(flatten);
}

async function teamStats(args = {}, deps) {
  const t = track(deps);
  const warnings = [];
  const season = S.resolveSeason(args.season, deps);
  const situation = checkSituation(args.situation);
  const team = N.normalizeTeam(args.team);
  const minGp = args.min_gp == null ? 1 : Number(args.min_gp);
  const [mp, sum, stand] = await Promise.all([
    S.moneypuck(t.deps, season, 'teams'),
    S.nhlStats(t.deps, 'team/summary', season),
    loadStandings(t.deps, season),
  ]);
  const abbrevByName = new Map(stand.map((s) => [N.normalize(s.teamName), N.normalizeTeam(s.teamAbbrev)]));
  const sumByAbbrev = new Map();
  for (const r of sum.rows) {
    const ab = abbrevByName.get(N.normalize(r.teamFullName));
    if (ab) sumByAbbrev.set(ab, r); else warnings.push(`no standings abbreviation for team "${r.teamFullName}"`);
  }
  const standByAbbrev = new Map(stand.map((s) => [N.normalizeTeam(s.teamAbbrev), s]));
  let rows = [];
  for (const raw of mp.rows) {
    const m = coerce(raw);
    if (m.situation !== situation) continue;
    const ab = N.normalizeTeam(m.team);
    if (team && ab !== team) continue;
    if (m.games_played < minGp) continue;
    const n = sumByAbbrev.get(ab) || {};
    const st = standByAbbrev.get(ab) || {};
    rows.push({ mp: m, nhl: { ...st, ...n }, computed: { team: ab, name: n.teamFullName || st.teamName || m.name, ...teamComputed(m) } });
  }
  rows = sortRows(rows, args.sort, args.order, 'xgf_pct', warnings);
  const teams = shapeRows(rows.slice(0, clampLimit(args.limit == null ? 32 : args.limit)), { fields: args.fields, defaults: TEAM_DEFAULTS, idFields: ['team'] }, warnings);
  return envelope(t, season, warnings, { situation, count: rows.length, teams });
}

// ---------- player index / player_lookup ----------

async function playerIndex(deps, season) {
  const [sk, g] = await Promise.all([S.nhlStats(deps, 'skater/summary', season), S.nhlStats(deps, 'goalie/summary', season)]);
  return N.buildIndex([
    ...sk.rows.map((r) => ({ playerId: r.playerId, name: r.skaterFullName, lastName: r.lastName, team: N.lastTeam(r.teamAbbrevs), teamAbbrevs: r.teamAbbrevs, pos: r.positionCode, gp: r.gamesPlayed })),
    ...g.rows.map((r) => ({ playerId: r.playerId, name: r.goalieFullName, lastName: r.lastName, team: N.lastTeam(r.teamAbbrevs), teamAbbrevs: r.teamAbbrevs, pos: 'G', gp: r.gamesPlayed })),
  ]);
}

async function playerLookup(args = {}, deps) {
  if (!args.query) throw new Error('query is required');
  const t = track(deps);
  const season = S.resolveSeason(args.season, deps);
  const index = await playerIndex(t.deps, season);
  const limit = args.limit == null ? 5 : Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit))));
  const r = N.lookup(index, args.query, { team: args.team, limit });
  return envelope(t, season, r.warnings, { query: args.query, matches: r.matches });
}

// ---------- player_game_log ----------

const SKATER_LOG_DEFAULTS = ['gameDate', 'teamAbbrev', 'opponentAbbrev', 'homeRoadFlag', 'toi', 'goals', 'assists', 'points', 'powerPlayPoints', 'shorthandedPoints', 'gameWinningGoals', 'shots', 'pim'];
const GOALIE_LOG_DEFAULTS = ['gameDate', 'teamAbbrev', 'opponentAbbrev', 'homeRoadFlag', 'toi', 'gamesStarted', 'decision', 'shotsAgainst', 'goalsAgainst', 'savePctg', 'shutouts'];

async function playerGameLog(args = {}, deps) {
  if (args.player == null || args.player === '') throw new Error('player is required (NHL playerId or a name)');
  const t = track(deps);
  const warnings = [];
  const season = S.resolveSeason(args.season, deps);
  let id, bio;
  if (/^\d+$/.test(String(args.player))) {
    id = Number(args.player);
    const l = await S.landing(t.deps, id);
    const d = flatten(l.data);
    bio = { playerId: id, name: `${d.firstName} ${d.lastName}`, team: N.normalizeTeam(d.currentTeamAbbrev), pos: d.position };
  } else {
    const index = await playerIndex(t.deps, season);
    const r = N.lookup(index, args.player, { limit: 5 });
    if (!r.matches.length) throw new Error(`no player matches "${args.player}" in ${season}`);
    if (r.ambiguous) return envelope(t, season, r.warnings, { player: null, candidates: r.matches, games: [] });
    const m = r.matches[0];
    id = m.playerId;
    bio = { playerId: id, name: m.name, team: m.team, pos: m.pos };
  }
  const log = await S.gameLog(t.deps, id, season);
  const isGoalie = bio.pos === 'G';
  const lastN = args.last_n == null ? 10 : Math.max(1, Math.floor(Number(args.last_n)));
  const rows = (log.data.gameLog || []).slice(0, lastN).map((g) => {
    const nhl = flatten(g);
    return { mp: {}, nhl, computed: { gameId: nhl.gameId } };
  });
  if (args.include_xg) {
    const gbg = await S.moneypuckGameByGame(t.deps, id, isGoalie ? 'goalies' : 'skaters');
    const byGame = new Map();
    for (const raw of gbg.rows) {
      const m = coerce(raw);
      if (m.situation === 'all' && m.season === season) byGame.set(m.gameId, m);
    }
    for (const r of rows) {
      const m = byGame.get(r.nhl.gameId);
      if (!m) continue;
      // NHL names win on collisions (gameDate); MoneyPuck keeps its other columns.
      r.mp = Object.fromEntries(Object.entries(m).filter(([k]) => !(k in r.nhl)));
      if (isGoalie) {
        r.computed.xga = m.xGoals;
        r.computed.gsax = sub(m.xGoals, m.goals);
      } else {
        r.computed.ixg = m.I_F_xGoals;
        r.computed.hits = m.I_F_hits;
        r.computed.blocks = m.shotsBlockedByPlayer;
      }
    }
    if (!byGame.size) warnings.push('no MoneyPuck per-game rows found for this player and season');
  }
  let defaults = isGoalie ? GOALIE_LOG_DEFAULTS : SKATER_LOG_DEFAULTS;
  if (args.include_xg) defaults = defaults.concat(isGoalie ? ['xga', 'gsax'] : ['ixg', 'hits', 'blocks']);
  const games = shapeRows(rows, { fields: args.fields, defaults, idFields: ['gameId'] }, warnings);
  return envelope(t, season, warnings, { player: bio, games });
}

// ---------- schedule ----------

function gameRow(g, date) {
  const f = flatten(g);
  const away = f.awayTeam || {}, home = f.homeTeam || {};
  return {
    mp: {},
    nhl: { ...f, gameDate: f.gameDate || date, away: away.abbrev, home: home.abbrev, awayScore: away.score, homeScore: home.score },
    computed: {},
  };
}

async function schedule(args = {}, deps) {
  const t = track(deps);
  const warnings = [];
  const team = N.normalizeTeam(args.team);
  const date = args.date || null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  const dateSeason = date && args.season == null ? Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) >= 9 ? 0 : 1) : null;
  const season = S.resolveSeason(args.season != null ? args.season : dateSeason, deps);
  let rows = [];
  if (team) {
    const r = await S.clubSchedule(t.deps, team, season);
    rows = (r.data.games || []).map((g) => gameRow(g, null));
    if (date) rows = rows.filter((x) => x.nhl.gameDate === date);
  } else {
    const d = date || new Date(deps.now()).toISOString().slice(0, 10);
    const r = await S.schedule(t.deps, d);
    for (const day of r.data.gameWeek || []) {
      if (day.date !== d) continue;
      for (const g of day.games || []) rows.push(gameRow(g, day.date));
    }
  }
  const total = rows.length;
  rows = sortRows(rows, args.sort, args.order || 'asc', 'startTimeUTC', warnings);
  if (!args.sort) rows.sort((a, b) => String(a.nhl.startTimeUTC).localeCompare(String(b.nhl.startTimeUTC)));
  const games = shapeRows(rows.slice(0, clampLimit(args.limit)), {
    fields: args.fields,
    defaults: ['gameDate', 'startTimeUTC', 'gameState', 'gameType', 'away', 'home', 'awayScore', 'homeScore'],
    idFields: ['id'],
  }, warnings);
  return envelope(t, season, warnings, { date, team, count: total, games });
}

// ---------- standings ----------

const STANDINGS_DEFAULTS = [
  'teamAbbrev', 'teamName', 'conferenceAbbrev', 'divisionAbbrev', 'gamesPlayed', 'wins', 'losses', 'otLosses',
  'points', 'pointPctg', 'regulationWins', 'goalFor', 'goalAgainst', 'goalDifferential',
];

async function standings(args = {}, deps) {
  const t = track(deps);
  const warnings = [];
  const season = S.resolveSeason(args.season, deps);
  const team = N.normalizeTeam(args.team);
  const list = await loadStandings(t.deps, season, args.date);
  let rows = list
    .filter((s) => !team || N.normalizeTeam(s.teamAbbrev) === team)
    .map((s) => ({ mp: {}, nhl: s, computed: {} }));
  rows = sortRows(rows, args.sort, args.order, 'points', warnings);
  const out = shapeRows(rows.slice(0, clampLimit(args.limit == null ? 32 : args.limit)), { fields: args.fields, defaults: STANDINGS_DEFAULTS, idFields: [] }, warnings);
  return envelope(t, season, warnings, { date: args.date || null, count: rows.length, standings: out });
}

module.exports = {
  goalie_stats: goalieStats, skater_stats: skaterStats, team_stats: teamStats,
  player_game_log: playerGameLog, player_lookup: playerLookup, schedule, standings,
  // exported for tests
  coerce, flatten, SITUATIONS,
};
