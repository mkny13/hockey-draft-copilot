# Agent instructions — Fantasy Hockey Draft Game Theory Co-Pilot

Shared conventions for any AI tool (Claude Code, Mahler agents, etc.) working in this repo.
`CLAUDE.md` points here — keep this file as the single source of truth.

## What this is

A live, high-contrast fantasy hockey drafting co-pilot for macOS that pairs aggregate player projections (DtZ, DFO, Apples & Ginos) with real-time game theory decision analysis on the clock.
See [README.md](README.md) for full system overview.

## Build and Verify

```bash
npm test
```

- Verifies standard normal CDF calculation, survival odds ($P_{survive}$), snake turn scheduling, positional cliff alerts, and head-to-head game theory trade-off evaluator.
- Runs with Node.js built-in `assert` module.

## Architecture & Code Map

- `server.js`: Node.js Express & WebSocket server (`PORT=3333`). Manages live draft state (`draft_state.json`), CORS-enabled `/api/pick`, `/api/undo`, `/api/reset`, and live WS broadcast.
- `public/js/valuation.js`: Pure mathematical valuation engine adapted from `fantasy-hockey-aggregate.pages.dev`. Blends multi-source projections and computes baseline VORP, replacement level, and tiers.
- `public/js/gametheory.js`: Mathematical game-theory engine implementing survival odds ($P_{survive}$ via Abramowitz & Stegun normal CDF), snake schedule turn calculations, diminishing returns ($Adj\_VORP$), and the 3-step decision protocol (`MUST REACH` > `NOW OR NEVER` > `TARGET` vs `WAIT`).
- `public/js/app.js`: Client-side UI state controller, live search, reactive table rendering, and WebSocket receiver.
- `yahoo-sync/`: Live sync bookmarklet, Chrome extension manifest v3, and Tampermonkey script for `draft.fantasysports.yahoo.com`.
- `start.sh`: Executable startup script that installs dependencies, runs tests, starts the server, and opens `http://localhost:3333`.

## Conventions

- Keep core game-theory formulas in `public/js/gametheory.js` isomorphic (usable in both Node.js via `require()` and browser via `window.GameTheory`).
- Any new decision rule or formula change MUST include unit test coverage in `test/test_gametheory.js`.
