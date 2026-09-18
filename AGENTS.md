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

- `server.js`: Node.js Express & WebSocket server (`PORT=3333`). Manages live draft state (`draft_state.json`), CORS-enabled `/api/pick`, `/api/undo`, `/api/reset`, `/api/settings`, and live WS broadcast.
- `public/js/valuation.js`: Pure mathematical valuation engine adapted from `fantasy-hockey-aggregate.pages.dev`. Blends multi-source projections and computes baseline VORP, replacement level, and tiers.
- `public/js/gametheory.js`: Mathematical game-theory engine implementing survival odds ($P_{survive}$ via Abramowitz & Stegun normal CDF), snake schedule turn calculations, diminishing returns ($Adj\_VORP$), automated target trade-offs (`computeTargetTradeoffs`), top matchup selector (`getTopMatchup`), and 2-round EVONA comparator (`comparePlayersGameTheory`).
- `public/js/app.js`: Client-side UI state controller, live search, reactive table rendering, automated trade-off advice cards, auto-comparator handler, and WebSocket receiver.
- `yahoo-sync/`: Complete Manifest V3 Chrome Extension (`background.js` health monitor, `popup.html`/`popup.js` options UI, `content.js` pick stream, and `status.css` in-room connection badge).
- `start.sh`: Executable startup script that installs dependencies, runs tests, starts the server, and opens `http://localhost:3333`.

## Conventions

- Keep core game-theory formulas in `public/js/gametheory.js` isomorphic (usable in both Node.js via `require()` and browser via `window.GameTheory`).
- League positions use **Center (`C`)** and **Forward (`F`)**—not separate LW/RW. Dual-eligible `C, F` players flex to open starting slots without false diminishing penalties.
- Any new decision rule, EV calculation, or formula change MUST include unit test coverage in `test/test_gametheory.js`.
