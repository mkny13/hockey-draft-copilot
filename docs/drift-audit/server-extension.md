# Drift audit: server + Chrome extension vs README/AGENTS

Scope: server (`server.js`) and Chrome extension (`yahoo-sync/*`) compared to `README.md` and `AGENTS.md`. Code is truth except safety rules (origin allowlist, loopback bind, body limits, pick ownership, Available Players skip), which are written up, not changed.

## Claim audit

| Claim | Doc location | Code location | Verdict | Action |
|---|---|---|---|---|
| Env vars `PORT`, `HOST`, `DRAFT_STATE_FILE`, `WS_PING_MS` with defaults 3333/127.0.0.1/draft_state.json/30000 | README.md, AGENTS.md | server.js (process.env) | match | none |
| Endpoint list `/api/pick`, `/api/undo`, `/api/repair-pick`, `/api/reset`, `/api/settings`, `/api/state`, `/api/evaluation`, `/api/report`, `/draft_data.json` | AGENTS.md | server.js app.get/app.post | match | none |
| `ALLOWED_ORIGIN` hosts + 4 enforcement rules (CORS withheld, non-GET 403, OPTIONS 403, WS handshake rejected) | AGENTS.md Security boundaries | server.js | match | none |
| 64kb body limit | AGENTS.md | server.js express.json limit | match | none |
| `pickHistoryIntegrity` fields `missing`, `repeated`, `duplicateNames` | AGENTS.md | server.js getPickHistoryIntegrity | match | none |
| `draft_data.local.json` preference | README.md, AGENTS.md | server.js loadData | match | none |
| background.js 5s health check skipping network when no draft tab open | AGENTS.md | yahoo-sync/background.js setInterval 5000 + tabs check | match | none |
| manifest host_permissions / content-script matches vs Security boundaries | AGENTS.md | yahoo-sync/manifest.json | match | none |
| `window.__COPILOT_SCAN_MS` / `window.__copilotScanInterval` test seams | AGENTS.md Test seams | yahoo-sync/content.js | match | none |

## Zombie code

Candidate search (`grep -rn <name>` across repo, tests included) found no unreferenced top-level functions, constants, routes, or `chrome.runtime` message types in `server.js` or `yahoo-sync/*.js`. Every defined symbol has at least one caller (including tests). No deletions performed.

No behaviour changed under `yahoo-sync/`; manifest version not bumped.