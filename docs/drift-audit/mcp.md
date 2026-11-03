# Drift audit: nhl-stats MCP vs docs/nhl-stats-mcp.md

## Tool name parity

| claim | doc location | code location | verdict | action |
|---|---|---|---|---|
| Seven tools: goalie_stats, skater_stats, team_stats, player_game_log, player_lookup, schedule, standings | docs/nhl-stats-mcp.md §2; mcp/README.md ## Tools | mcp/server.js SPECS; mcp/lib/tools.js exports | match | none |

## Data sources & URLs

| claim | doc location | code location | verdict | action |
|---|---|---|---|---|
| MoneyPuck season summary URL pattern | docs §3.1 | mcp/lib/sources.js MP_BASE | match | none |
| NHL stats REST base | docs §3.2 | mcp/lib/sources.js NHL_BASE | match | none |
| Cache in mcp/.cache/, NHL_MCP_CACHE_DIR override | docs §6; mcp/README Cache | mcp/lib/fetch.js defaultCacheDir | match | none |

## Constraints

| claim | doc location | code location | verdict | action |
|---|---|---|---|---|
| Only mcp/server.js imports SDK | AGENTS.md; docs §8 | grep mcp/lib | holds | none |
| mcp/lib uses Node built-ins only | docs §8 | mcp/lib/*.js requires | holds | none |

## Zombie code

| candidate | evidence | action |
|---|---|---|
| TTL (fetch.js) | no external caller | removed from exports |
| UA (fetch.js) | no external caller | removed from exports |
| TEAM_ALIASES (names.js) | no external caller | removed from exports |
| NICKNAMES (names.js) | no external caller | removed from exports |
| coerce (tools.js) | no external caller outside defining file | removed from exports |
| flatten (tools.js) | no external caller outside defining file | removed from exports |
| SITUATIONS (tools.js) | no external caller outside defining file | removed from exports |