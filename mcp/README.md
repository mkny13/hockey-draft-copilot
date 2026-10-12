# nhl-stats MCP server

A local, read-only stdio [MCP](https://modelcontextprotocol.io) server that returns raw NHL stats
on demand: MoneyPuck expected-goals data plus the official NHL API. It is a general statistics
tool for any season MoneyPuck covers, with no fantasy scoring. Design: [docs/nhl-stats-mcp.md](../docs/nhl-stats-mcp.md).

## Install and register

```bash
cd mcp && npm install
claude mcp add nhl-stats -- node mcp/server.js
```

Run these from the main checkout. A worktree's copy is not what Claude Code launches.

## Tools

All list tools accept `season` (start year, default current), `team`, `min_gp`, `sort` (any
numeric column), `order`, `limit` (default 25, max 200) and `fields` (source column names to
return; unknown names produce a warning). Prefix a field with `mp.` or `nhl.` to force a source.

| Tool | What it returns | Example prompt |
|---|---|---|
| `goalie_stats` | MoneyPuck goalies + NHL stats, with `gsax`, `gsax60` (and per danger band); `situation` filter | "Show the top 5 goalies by GSAx." |
| `skater_stats` | MoneyPuck skaters + NHL stats (hits, blocks, TOI), with `g_minus_ixg`, `sh_pct`, `g_per_ixg`, `onice_xgf_pct`; `position` filter | "Which skaters most outscored their ixG in 2024-25?" |
| `team_stats` | MoneyPuck teams + NHL summary, with `xgf60`, `xga60`, `xgf_pct` | "Rank teams by 5on5 xGF% this season." |
| `player_game_log` | NHL game log; `include_xg: true` adds MoneyPuck per-game `ixg`/`hits`/`blocks` or `xga`/`gsax` | "McDavid's last 10 games with ixG." |
| `player_lookup` | Name search (accents, nicknames, last name) returning `playerId` | "Look up Stützle." |
| `schedule` | Games by `date` and/or `team` | "Who plays tonight?" |
| `standings` | Standings now, or by `date`/`season` | "Final 2023-24 standings." |

Every response is one JSON block: `{ season, asOf, source, stale?, warnings?, ... }`.

## Cache

Responses are cached on disk in `mcp/.cache/` (override with `NHL_MCP_CACHE_DIR`).

| Source | TTL |
|---|---|
| MoneyPuck season CSVs and per-player game-by-game | 6 h |
| NHL REST reports, game logs, standings, schedule | 1 h |
| Any past season | never expires |

If an upstream fetch fails, an expired cache entry is returned with `stale: true`. With no cache
the tool errors with the URL and status. MoneyPuck per-game data is fetched only when
`include_xg: true`.

## Tests

`npm test` at the repo root runs `test/test_mcp.js` offline from `test/fixtures/mcp/`. No
install in `mcp/` is needed for it.

## Attribution and terms

Expected-goals data comes from [MoneyPuck.com](https://moneypuck.com) and is free for
**non-commercial use with attribution**. Every response's `source` field credits MoneyPuck.com
(xG) and NHL.com (official stats). Keep that attribution, and do not use this server for
commercial purposes. See [MoneyPuck's data terms](https://moneypuck.com/data.htm).
