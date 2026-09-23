# Agent instructions — Fantasy Hockey Draft Game Theory Co-Pilot

Shared conventions for any AI tool (Claude Code, Mahler agents, etc.) working in this repo.
`CLAUDE.md` points here — keep this file as the single source of truth.

## What this is

A live, high-contrast fantasy hockey drafting co-pilot for macOS that pairs aggregate player projections (DtZ, DFO, Apples & Ginos) with real-time game theory decision analysis on the clock.
See [README.md](README.md) for full system overview.

## Build and Verify

```bash
npm test            # full suite: engine, data, server API, draft-room sync (jsdom), mock-draft regression (~25s)
npm run test:quick  # engine + data only
```

- Runs with Node.js built-in `assert`; `jsdom` is the only dev dependency.
- Strategy check: `node scripts/mock_draft.js --slots 1-8 --sims 12` (engine vs a pure-ADP drafter). Rerun it after any change to `gametheory.js` decision logic; `test/test_mock_draft.js` guards the basics.
- Tests never read the live `draft_state.json` (the server tests use a temp file via `DRAFT_STATE_FILE`).

## Architecture & Code Map

- `server.js`: Node.js Express & WebSocket server (`PORT=3333`). Manages live draft state (`draft_state.json`), CORS-enabled `/api/pick`, `/api/undo`, `/api/reset`, `/api/settings`, and live WS broadcast (each broadcast carries an `evaluation` snapshot for the in-room HUD; also `GET /api/evaluation`).
- `public/js/gametheory.js`: Mathematical game-theory engine implementing survival odds ($P_{survive}$ via Abramowitz & Stegun normal CDF), snake schedule turn calculations, roster counting with a UTIL/bench flex pool and must-fill starters, diminishing returns ($Adj\_VORP$), automated target trade-offs (`computeTargetTradeoffs`), top matchup selector (`getTopMatchup`), survival-weighted fallbacks (`findNextAlt`), and 2-round EVONA comparator (`comparePlayersGameTheory`), plus the post-draft grader and Monte Carlo.
- `public/js/app.js`: Client-side UI state controller, live search, reactive table rendering, automated trade-off advice cards, auto-comparator handler, and WebSocket receiver.
- `yahoo-sync/`: Complete Manifest V3 Chrome Extension (`background.js` health monitor, `popup.html`/`popup.js` options UI, `content.js` pick stream + HUD supporting ESPN & Yahoo, `players_data.js` name resolver generated from the board, and `status.css`).
- `test/`: `test_gametheory.js`, `test_data.js`, `test_server.js`, `test_sync.js`, `test_mock_draft.js`.
- `scripts/ingest_espn_adp.js`: ESPN ADP updater (Hashtag Hockey only; rejects values that are not plain one-decimal numbers).
- `scripts/mock_draft.js`: seeded mock drafts and Monte Carlo of the engine vs an ADP drafter.
- `start.sh`: Executable startup script that installs dependencies, runs tests, starts the server, and opens `http://localhost:3333`.

## Conventions

- **Where things run:** the Chrome extension is loaded unpacked from the **main checkout's** `yahoo-sync/`, and `npm start` runs from there. Work done in a git worktree is invisible to Chrome until it is merged into main; always sync/merge and rerun `npm test` in main.
- **Board data:** `draft_data.json` is the single committed **sample** board (real names/ADP, synthetic FP/VORP) with the league settings (C2 F6 D6 UTIL1 G2 BN5, 8 teams), served to the browser through the `/draft_data.json` route. The author's real board lives in the gitignored `draft_data.local.json`, which `server.js` prefers (scripts and tests still read the sample); never rebuild VORP/FP from raw source data. Only ADP columns come from `scripts/ingest_espn_adp.js`. Roster limits are derived from `config.league.slots` in that file.
- **Pick ownership** is decided by the server from the snake schedule and the configured slot, never from the draft page's DOM. The only override is the app's own "+ Mine" / "Taken" buttons, which send `manual: true`. The draft slot is a user setting (default 5 is a placeholder).
- **Draft-page scanners** (extension, both bookmarklets) must match only the innermost small element containing the player and `R#, P#`, and must skip the Available Players table; a page-wide wrapper contains the available list and will record the wrong player.
- A discount must never raise a negative VORP; the shortlist must remain a strict total order.

- Keep core game-theory formulas in `public/js/gametheory.js` isomorphic (usable in both Node.js via `require()` and browser via `window.GameTheory`).
- League positions use **Center (`C`)** and **Forward (`F`)**—not separate LW/RW. Dual-eligible `C, F` players flex to open starting slots without false diminishing penalties.
- Any new decision rule, EV calculation, or formula change MUST include unit test coverage in `test/test_gametheory.js`. Server behavior belongs in `test/test_server.js`; draft-page scanning belongs in `test/test_sync.js` (reproduce the DOM layout as a fixture).

## Security boundaries

- The server is loopback-only by default (`http://localhost:3333`); it is not exposed beyond the local machine.
- The extension's `host_permissions` and content-script `matches` cover only the fantasy draft hosts (`https://fantasy.espn.com/*`, `https://*.fantasysports.yahoo.com/*`) plus `http://localhost:3333/*` for the health check — never bare ESPN/Yahoo domains.
- No credentials or `.env` files are used anywhere in this project.
- Untrusted draft-room text (player names, stored sync URLs) is escaped at render time in both the app UI and the in-room HUD.
