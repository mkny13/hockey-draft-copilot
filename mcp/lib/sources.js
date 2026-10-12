// One function per upstream. All take `deps` ({ fetchText, fetchJson, now }) so tests
// can inject fixtures. Only Node built-ins are used.
const { parseCsv } = require('./csv');

const MP_BASE = 'https://moneypuck.com/moneypuck/playerData';
const NHL_STATS = 'https://api.nhle.com/stats/rest/en';
const NHL_WEB = 'https://api-web.nhle.com/v1';
const HOUR = 3600 * 1000;
const MP_TTL = 6 * HOUR;
const NHL_TTL = 1 * HOUR;

const SOURCE = 'MoneyPuck.com (xG), NHL.com (official stats)';

// `season` is the start year; the default is this year from September on, else last year.
function currentSeason(now) {
  const d = new Date(now());
  return d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
}

function resolveSeason(season, deps) {
  if (season == null || season === '') return currentSeason(deps.now);
  const n = Number(season);
  if (!Number.isInteger(n) || n < 1917 || n > 2100) throw new Error(`invalid season: ${season} (use the start year, e.g. 2025 for 2025-26)`);
  return n;
}

const seasonId = (season) => `${season}${season + 1}`;
const ttlFor = (season, base, deps) => (season < currentSeason(deps.now) ? Infinity : base);

const parsedCache = new WeakMap();
async function csvRows(deps, url, ttl) {
  let m = parsedCache.get(deps);
  if (!m) { m = new Map(); parsedCache.set(deps, m); }
  const r = await deps.fetchText(url, { ttl });
  const hit = m.get(url);
  if (hit && hit.body === r.body) return { rows: hit.rows, fetchedAt: r.fetchedAt, stale: r.stale };
  const rows = parseCsv(r.body);
  m.set(url, { body: r.body, rows });
  return { rows, fetchedAt: r.fetchedAt, stale: r.stale };
}

function moneypuck(deps, season, file) {
  return csvRows(deps, `${MP_BASE}/seasonSummary/${season}/regular/${file}.csv`, ttlFor(season, MP_TTL, deps));
}

function moneypuckGameByGame(deps, playerId, kind) {
  return csvRows(deps, `${MP_BASE}/careers/gameByGame/regular/${kind}/${playerId}.csv`, MP_TTL);
}

async function nhlStats(deps, report, season) {
  const url = `${NHL_STATS}/${report}?limit=-1&cayenneExp=seasonId=${seasonId(season)}%20and%20gameTypeId=2`;
  const r = await deps.fetchJson(url, { ttl: ttlFor(season, NHL_TTL, deps) });
  return { rows: (r.data && r.data.data) || [], fetchedAt: r.fetchedAt, stale: r.stale };
}

async function webJson(deps, pathPart, ttl) {
  const r = await deps.fetchJson(`${NHL_WEB}/${pathPart}`, { ttl });
  return { data: r.data, fetchedAt: r.fetchedAt, stale: r.stale };
}

const gameLog = (deps, playerId, season) =>
  webJson(deps, `player/${playerId}/game-log/${seasonId(season)}/2`, ttlFor(season, NHL_TTL, deps));

const landing = (deps, playerId) => webJson(deps, `player/${playerId}/landing`, NHL_TTL);

// Past seasons resolve to their last standings day via standings-season (a later date returns empty).
async function standings(deps, { date, season }) {
  const cur = currentSeason(deps.now);
  const past = season != null && season < cur;
  if (date) return webJson(deps, `standings/${date}`, past ? Infinity : NHL_TTL);
  if (past) {
    const list = await webJson(deps, 'standings-season', NHL_TTL);
    const s = (list.data.seasons || []).find((x) => x.id === Number(seasonId(season)));
    if (!s) throw new Error(`no standings for season ${season}`);
    return webJson(deps, `standings/${s.standingsEnd}`, Infinity);
  }
  return webJson(deps, 'standings/now', NHL_TTL);
}

const schedule = (deps, date) => webJson(deps, `schedule/${date}`, NHL_TTL);

const clubSchedule = (deps, team, season) =>
  webJson(deps, `club-schedule-season/${team}/${seasonId(season)}`, ttlFor(season, NHL_TTL, deps));

module.exports = {
  SOURCE, currentSeason, resolveSeason, seasonId, moneypuck, moneypuckGameByGame, nhlStats,
  gameLog, landing, standings, schedule, clubSchedule,
};
