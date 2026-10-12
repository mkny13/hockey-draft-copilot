# Design: local NHL stats MCP server (MoneyPuck xG + NHL API)

Status: built, 2026-10-12. Endpoints were verified 2026-10-09 and again while building. Where
this doc and a live endpoint ever disagree, the endpoint wins and this doc gets fixed.

## 1. Problem

Claude Code needs a free, local way to pull raw NHL stats on demand, including expected-goals
data (xG, GSAx) that the official NHL API lacks. Existing public NHL MCP servers only wrap the
official API. PuckAPI has xG but is a paid hosted service. So this is a small, local, stdio MCP
server, `nhl-stats`, that wraps MoneyPuck season CSVs and the NHL APIs.

It is a **general statistics tool**: no fantasy scoring, no draft board, no projections.
Fantasy analysis is a separate piece of work that can be built on top of it.

## 2. Goals and non-goals

Goals
- A stdio MCP server exposing seven read-only tools: `goalie_stats`, `skater_stats`,
  `team_stats`, `player_game_log`, `player_lookup`, `schedule`, `standings`.
- Thin wrappers over MoneyPuck and the NHL API with filters (season, situation, team, position,
  min GP, sort, limit) and field selection, so they also work for general statistical analysis
  on any season MoneyPuck covers.
- Return the source's columns. Computed fields are plain hockey ones only.
- Keep load off the upstreams with an on-disk cache. Per-game MoneyPuck data is fetched only
  when the caller asks.
- Tests run offline from fixtures.

Non-goals
- Fantasy points, league scoring, projections, board matching, anything reading `draft_data*.json`.
- Yahoo or ESPN league APIs, betting odds, injury news, line projections, playoff data
  (regular season only, `gameTypeId=2`), any UI.

## 3. Data sources

### 3.1 MoneyPuck season summaries (xG)

`https://moneypuck.com/moneypuck/playerData/seasonSummary/{season}/regular/{file}.csv`

- `{season}` is the start year (`2025` for 2025-26). `{file}` is `goalies`, `skaters`, `teams`.
- Sent with a browser-like `User-Agent`. Data lags about a day. Free for non-commercial use with
  attribution, so every tool response carries
  `"source": "MoneyPuck.com (xG), NHL.com (official stats)"`.
- One row per player (or team) per `situation`: `all`, `5on5`, `4on5`, `5on4`, `other`.
- Parsed with a small quote-aware parser. Columns are looked up by header name, never by index.
  `teams.csv` repeats the `team` header; both columns hold the same value.
- `playerId` **is the NHL player id**. That is the join key to NHL data.
- **MoneyPuck strips non-ASCII letters from names** ("Alexis Lafrenière" is `Alexis Lafrenire`).
  Never match MoneyPuck rows by name. Join on `playerId`; the display name comes from the NHL API.
- Goalie `icetime`, skater `icetime` and team `iceTime` are seconds.

Per-game data: `https://moneypuck.com/moneypuck/playerData/careers/gameByGame/regular/{skaters|goalies}/{playerId}.csv`
has one row per game per situation for a player's whole career (`gameId` matches the NHL
`gameId`, `gameDate` is `YYYYMMDD`, `season` is the start year). It is large (up to ~3 MB per
player), so it is fetched only when `include_xg: true`. The league-wide `all_teams.csv`
(~127 MB) is never used.

### 3.2 NHL stats REST API (official counting stats, no key)

Base `https://api.nhle.com/stats/rest/en/`. Query
`?limit=-1&cayenneExp=seasonId=20252026%20and%20gameTypeId=2`. Response `{ data: [...], total }`.

Reports used: `goalie/summary`, `skater/summary`, `skater/realtime` (hits, blocked shots),
`skater/timeonice` (PP/SH/EV time per game, seconds), `team/summary` (no abbreviation; joined to
standings by team name).

Gotcha: `teamAbbrevs` is comma-joined for players traded mid-season (`"TOR,EDM"`). The current
team is the last entry.

### 3.3 NHL web API (game logs, standings, schedule)

Base `https://api-web.nhle.com/v1/`. It redirects, so redirects are followed.

- `player/{id}/game-log/{seasonId}/2`: `gameLog[]`. Skater rows have no hits or blocks.
- `player/{id}/landing`: bio (`firstName`, `lastName`, `currentTeamAbbrev`, `position`).
- `standings/now`, `standings/{date}`: `standings[]` (team abbreviation, record, goals).
  A date after the regular season returns an empty list, so a past season uses `standings-season`
  to find its `standingsEnd` date and asks for that day.
- `schedule/{date}`: `gameWeek[].games[]` (a whole week; the tool keeps the requested day).
- `club-schedule-season/{team}/{seasonId}`: `games[]` for one team.

## 4. Architecture and file layout

```
mcp/
  package.json   # own deps: @modelcontextprotocol/sdk, zod
  server.js      # stdio MCP wiring only; the only file that imports the SDK
  README.md
  lib/
    fetch.js     # fetchText/fetchJson with UA, 20 s timeout, redirects, disk cache
    csv.js       # tiny quote-aware CSV parser
    sources.js   # one function per upstream
    names.js     # normalize(), team aliases, player lookup scoring
    tools.js     # the seven tool handlers: pure functions of (args, deps)
  .cache/        # gitignored
test/test_mcp.js, test/fixtures/mcp/
```

- `mcp/lib/` uses only Node built-ins, so the root `npm test` needs no `mcp/` install.
- Handlers take `deps = { fetchText, fetchJson, now }` so tests inject fixtures.
- CommonJS. Read-only; writes only to `mcp/.cache/`.
- Season: an integer start year. Default is this year from September on, else last year. The
  NHL `seasonId` is `${season}${season+1}`.

## 5. Tools

Every tool returns one MCP text block of JSON:
`{ season, asOf, source, stale?, warnings?, ...payload }`. `asOf` is the oldest fetch time among
the data used. `stale: true` means an upstream fetch failed and an expired cache entry was used.

Common inputs for list tools: `season`, `situation` (`all|5on5|4on5|5on4|other`, default `all`),
`team` (aliases accepted), `position`, `min_gp` (default 1), `sort`, `order` (`desc` default),
`limit` (default 25, max 200).

**Field selection.** `fields: string[]` picks the columns to return. A name resolves to a
computed field first, then (bare name) a MoneyPuck column, then an NHL column. Prefix `mp.` or
`nhl.` to force a source (goalie `goals` means goals against in MoneyPuck but goals scored in the
NHL data). An unknown name yields a warning, not an error. Without `fields`, a default set of
source columns plus the computed ones is returned. `sort` accepts any numeric column, returned
or not.

- **`goalie_stats`**: MoneyPuck goalies joined to NHL `goalie/summary` on `playerId`. Computed:
  `gsax = xGoals - goals`, `gsax60 = gsax / (icetime / 3600)`, and per danger band
  `gsax_low|medium|high`, `gsax60_low|medium|high`. Default sort `gsax`. NHL columns exist only
  for `situation=all`.
- **`skater_stats`**: MoneyPuck skaters joined to NHL `skater/summary`, `realtime` and
  `timeonice`. Computed: `g_minus_ixg = I_F_goals - I_F_xGoals`, `sh_pct = goals / shots`,
  `g_per_ixg = goals / ixG`, `onice_xgf_pct = OnIce_F_xGoals / (OnIce_F_xGoals + OnIce_A_xGoals)`.
  `position` is `C|L|R|D`, or `F` for all forwards. Default sort `points`.
- **`team_stats`**: MoneyPuck teams joined to NHL `team/summary` and standings. Computed:
  `xgf60`, `xga60`, `xgf_pct`, `hd_xgf60`, `hd_xga60`, `gf60`, `ga60` (per 60 of team `iceTime`).
  Default sort `xgf_pct`.
- **`player_game_log`**: `player` (id or name), `last_n` (default 10), `include_xg`. NHL game log
  rows. With `include_xg: true`, MoneyPuck's per-player CSV (cached 6 h) is fetched, filtered to
  `situation == all` and the season, and adds `ixg`, `hits`, `blocks` (skaters) or `xga`, `gsax`
  (goalies). Not fetched otherwise.
- **`player_lookup`**: free-text name search over NHL season data. Scores 1.0 exact normalized
  name, 0.8 nickname, 0.6 last name, 0.4 substring. A tie at the top score returns the
  candidates with a warning instead of guessing.
- **`schedule`**: games by `date` and/or `team` (NHL web schedule). With only a date, the whole
  league that day. With a team, the club's season schedule (filtered by `date` if given).
- **`standings`**: `date` or `season` (default now); filter by `team`; default sort `points`.

## 6. Caching

- `mcp/.cache/` (override with `NHL_MCP_CACHE_DIR`). One file per URL, named by the sha1 of the
  URL; each entry is `{ fetchedAt, url, body }`.
- TTLs: MoneyPuck season CSVs and per-game CSVs 6 h; NHL REST reports, game logs, standings and
  schedule 1 h; any past season never expires.
- On fetch failure (network, non-2xx, 20 s timeout): a cached copy, however old, is returned with
  `stale: true`. With no cache the tool returns an MCP error naming the URL and status.
- Parsed CSVs are memoized in memory per process.
- No background refresh; fetches happen only on demand.

## 7. Names and teams

The NHL `playerId` is the key everywhere. Name handling exists only for `player_lookup` and for
resolving a name passed to `player_game_log`.

`normalize(s)`: NFD, strip combining marks, lowercase, drop `.` `'` `-`, collapse whitespace.
Team aliases (to the MoneyPuck form): `TB, T.B → TBL`; `LA, L.A → LAK`; `NJ, N.J → NJD`;
`SJ, S.J → SJS`; `UTAH, UTH → UTA`; `MON → MTL`; `WAS → WSH`; `CLS → CBJ`; `NAS → NSH`.
For comma-joined `teamAbbrevs`, the last entry is the current team.

## 8. Testing

`test/test_mcp.js` (Node `assert`, requires only `mcp/lib/*`, no network, no SDK) with trimmed
real-header fixtures in `test/fixtures/mcp/`. Cases: Lafrenière (MoneyPuck drops the è), Stützle,
a `"EDM,PIT,COL"` traded player, a `"LAK,TBL"` alias player. Covers csv parsing, normalization,
aliases and ties, each tool with stub deps (GSAx math, situation filter, `min_gp`/`limit`/`sort`,
`fields`, a past season, schedule by date and by team), `include_xg` only when asked, the cache
(fresh hit, expiry, stale-on-error, error without cache, with an injected `now` and a temp
directory), and a guard that `mcp/lib` never reads `draft_data*.json`, mentions
`config.scoring`, or imports the SDK. It is part of the root `npm test`.

## 9. Open questions

None. The original design's fantasy questions (luck thresholds, assist luck, rest-of-season
projection, board coverage, game-log fantasy points) are out of scope and belong to the separate
fantasy-analysis issue. Schedule-aware matchups are answered by the `schedule` tool.
