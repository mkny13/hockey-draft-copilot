# Fantasy Hockey Draft Game Theory Co-Pilot

A live, high-contrast drafting co-pilot for macOS that pairs aggregate player projections (DtZ, DFO, Apples & Ginos, The Athletic) with real-time Game Theory decision analysis on the clock.

Built for an 8-team ESPN league: **C2 · F6 · D6 · UTIL1 · G2 · BN5** (22 rounds). The league config lives in `draft_data.json` (`config.league.slots`) and drives every roster limit in the app.

---

## Key Features

### 1. Automated Game Theory Decision Engine (EVONA)
- **Closed-Form 2-Round Expected Value ($\Delta EV$)**:
  Calculates the expected point gain of drafting any target $B$ compared to the board's top VORP anchor $A$:
  $$\Delta EV(B \text{ over } A) = (1 - S(B)) \cdot \text{Cliff}(B) - (1 - S(A)) \cdot \text{Cliff}(A) - [VORP(A) - VORP(B)]$$
  - Measures the **Expected Cliff Loss** saved by drafting $B$ immediately versus letting them slide to your next snake turn ($T_{next}$).
  - Automatically identifies whether taking an urgent cliff target (e.g. Leon Draisaitl at Pick 5) yields higher net portfolio value than taking a high-survival anchor (e.g. Quinn Hughes at 65% survival).
- **Survival-weighted fallbacks**: every comparison asks "what do I get if I miss him?" The fallback is the survival-weighted expected best remaining player at that position, never the other side of the matchup (two centers are not each other's fallback), and never assumed to survive when he won't.
- **Strict shortlist ordering**: decisive 2-round edge first, then composite score (EV2 + expected cliff loss), then VORP, then name. "Safe" (high-survival) players stay off the list unless one is worth more than every urgent option, so a team cannot defer its goalies forever.
- **Automated Trade-Off Advice on Every Shortlist Card**:
  - Displays **`⚡ +X.X EV Edge`** for game-theory winners and **`🛡️ SAFE TO WAIT`** for safe anchors.
  - Renders **2-Round Expected Value (`2-Rnd EV`)** alongside single-round `VORP`.
  - Includes a crisp, 1-line plain-English strategic reason (e.g. *"Locks in +53.9 C/F cliff. Quinn Hughes (65% surv) is likely to slide to Turn #12 (+41.4 net EV advantage over drafting Quinn Hughes now)."*).
- **Live Direction Banner**:
  - Automatically switches headline to **`🎯 GAME THEORY PICK`** whenever multi-round EV diverges from raw single-round VORP.
- **Auto-Populated Comparator with `⚡ Auto ON`**:
  - Automatically loads and analyzes the primary dilemma on the board by default with zero manual clicks required.
  - Toggle button allows drafters to switch between automatic dilemma tracking and custom manual pairings.

### 2. Post-Draft Report, Monte Carlo & Alerts
- **📊 Draft Report** (`GET /api/report`): graded surplus-value recap and positional balance of the finished draft.
- **🎲 Monte Carlo**: round-by-round survival odds for chosen targets from simulated drafts.
- **Alerts**: optional audio chime and desktop notification when you are ON THE CLOCK or a critical cliff appears (header **Enable Alerts** button).

### 3. League Roster & Multi-Position Rules
- **Center (`C`) & Forward (`F`) League Mapping**:
  - Skaters are mapped to Center (`C`) and Forward (`F`) positions (all LW, RW, and W players map to `F`).
  - Dual-eligible players (`C, F`) receive multi-position optionality and are never penalized if either starting slot is open.
- **Roster limits** come from the league config: starters `C2 F6 D6 G2`, plus a shared flex pool of `UTIL 1 + BN 5`. Pure centers spill into `F` once `C` is full.
- **Diminishing returns** ($\text{Adj\_VORP} = \text{VORP} \times m$, never applied to negative VORP):
  - Open starter slot at any eligible position: **100%**
  - Overflow into the `UTIL` slot (one skater; goalies cannot use it): **100%**
  - Overflow into bench (`BENCH_VALUE`): **30%**. Bench players never score; they are injury cover
  - Beyond the whole roster: **35%**
  - Leagues with no flex info fall back to the older graded curve: 85% / 65% / 35% by overflow count.
- **Must-fill starters**: once remaining picks equal the number of unfilled starter slots, only players who fill an open starter slot are worth anything (multiplier 5% for the rest). This is the safety net that guarantees a full lineup.

### 4. Packaged Hands-Free Live Draft Room Sync (ESPN & Yahoo MV3)
Located in [`yahoo-sync/`](yahoo-sync/):
- **ESPN & Yahoo Compatibility**:
  - Automatically matches and observes ESPN Fantasy Hockey draft rooms (`https://fantasy.espn.com/hockey/draft*`) as well as Yahoo draft rooms.
  - Reads ESPN pick toasts (`Name / TEAM, POS` + `R#, P#`), the draft board, and history feeds. A toast is recognised only as the **innermost small element** holding both the player and the round/pick marker, and anything inside the Available Players table is ignored, so the top available player can never be recorded as a pick.
  - The extension sends the round and pick number with each pick. **Ownership is decided by the server from the snake schedule and your slot**, not from page CSS; the page's own "mine" flag is ignored because it proved unreliable. The app's own **+ Mine** / **Taken** buttons are the one manual override.
- **Background Health Service Worker (`background.js`)**:
  - Runs periodic 5-second health checks against `http://localhost:3333/api/state`.
  - Measures latency and broadcasts status updates to the popup and open ESPN/Yahoo Draft tabs.
- **Extension Options Popup (`popup.html` / `popup.js`)**:
  - Displays live server status (`● Connected` with millisecond latency or `● Disconnected / Offline`).
  - Persists configurable server URL in `chrome.storage.local` with on-demand ping verification.
- **In-Room Live Connection Badge (`status.css` / `content.js`)**:
  - Injects a high-contrast badge pinned to the top-right corner of the ESPN / Yahoo draft room DOM (`#copilot-yahoo-badge`).
  - Green glowing dot indicates live synchronization; tracks synced pick counts.
  - Watches draft table rows with a `MutationObserver` and streaming fallback to push picks hands-free to `/api/pick`.
- **Live HUD (click the badge)**: connection status, pick counts, scan/reset controls, quick-add, and the decision panel: current headline and subtext, the top-5 short list with survival odds, and the game-theory trade-off verdict. The server attaches an `evaluation` snapshot to every WebSocket broadcast.
- **Server-side pick handling**: names are canonicalised to the board's spelling (accents/case/punctuation), positions and team are filled from the board, duplicates are rejected, and undo restores the undone pick's number.
- **Bookmarklet / Tampermonkey**: alternatives to the extension (`bookmarklet.js`, the bookmarklet generated by the app header modal, `tampermonkey.user.js`).

---

## Quick Start

### 1. Start the Server
```bash
./start.sh
```
Or manually:
```bash
npm install
npm test
npm start
```
The application will be live at [http://localhost:3333](http://localhost:3333).

### 2. Load the Chrome Extension in ESPN (or Yahoo)
1. In Google Chrome, go to `chrome://extensions`.
2. Toggle on **Developer mode** in the upper right.
3. Click **Load unpacked** in the top left.
4. Select the folder (always the **main checkout**, which is where `npm start` runs too; a copy inside `.claude/worktrees/` is not what Chrome loads):
   ```
   /Volumes/ExtSSD160/scripts/Hockey/yahoo-sync
   ```
   After pulling new code, click **Reload** on the extension and refresh the draft tab. Set your real draft slot in the app first (the default of 5 is a placeholder).
5. Open your ESPN Draft Room (or Yahoo Draft Room). The green **`🏒 Co-Pilot: Live`** badge will appear in the top-right corner, streaming picks hands-free as they happen. Alternatively, use the 1-click **Sync ESPN Draft** bookmarklet provided in the app header modal.

---

## Running Tests

```bash
npm test          # full suite (~25s)
npm run test:quick  # engine + data only (what ./start.sh runs before launching)
```
Plain Node `assert`, no framework. `jsdom` (dev dependency) simulates the draft-room DOM.

| File | Covers |
|---|---|
| `test/test_gametheory.js` | Normal CDF and $P_{survive}$, snake scheduling, cliff alerts, C/F rules, EVONA comparator, survival-weighted fallbacks (`findNextAlt`), UTIL / bench / must-fill logic, negative-VORP guard, strict shortlist order (input-order independent), draft-complete state, roster counting, post-draft grader, Monte Carlo |
| `test/test_data.js` | Board integrity: 820 unique players, league config, clean one-decimal ADP (guards the old corrupt-parse bug), top-200 ADP coverage, both `draft_data.json` copies identical, extension name lookup matches the board |
| `test/test_server.js` | Spawns the real server (temp state file): league limits, canonical names, snake-schedule ownership, manual override, pick numbering, undo, settings clamp, origin check, evaluation snapshot, WebSocket broadcasts, reset |
| `test/test_sync.js` | Runs the real extension content script and both bookmarklets in jsdom: wrapper-with-available-list layout (the "top available player recorded as a pick" bug), player-pool guard, marker order, dynamic toasts, retry after network failure, HUD rendering, badge state, manifest sanity |
| `test/test_mock_draft.js` | Strategy regression: the engine beats a pure-ADP drafter, fills 2 goalies and a full lineup, and drafts are deterministic |

---

## Mock Drafts & Strategy Simulation

```bash
node scripts/mock_draft.js --slot 5 --verbose        # one draft, the engine picks for slot 5
node scripts/mock_draft.js --slots 1-8 --sims 20     # Monte Carlo across draft slots
```
The Co-Pilot's recommended pick drives one team; the other seven draft from ESPN ADP with per-team noise (±7) and fill their starting slots like real teams. Each sim is also run with a noise-free pure-ADP drafter at the same slot, so the lineup-points difference isolates what the engine adds. Latest results (12 sims per slot): the engine finishes 1st in every slot and beats the ADP drafter by roughly +440 lineup points at slots 1-6 and +570 at slots 7-8. Caveat: the opponents' ±7 noise matches the engine's own survival model, so real drafters will be less flattering.

---

## Architecture & Code Map

- `server.js`: Node.js Express & WebSocket server (`PORT=3333`). Manages live draft state (`draft_state.json`), CORS-enabled `/api/pick`, `/api/undo`, `/api/reset`, `/api/settings`, `/api/state`, `/api/evaluation`, `/api/report`, and live WS broadcast (with an `evaluation` snapshot for the HUD). League roster limits are derived from `draft_data.json` on every load.
- `public/js/gametheory.js`: Mathematical game-theory engine (isomorphic): survival odds ($P_{survive}$), snake schedule, roster counting and flex/must-fill logic, diminishing returns, target trade-offs (`computeTargetTradeoffs`), top matchup (`getTopMatchup`), 2-round EVONA comparator (`comparePlayersGameTheory`, `findNextAlt`), post-draft grader, and Monte Carlo.
- `public/js/app.js`: Client-side UI controller, search, reactive table rendering, shortlisted cards with trade-off callouts, auto-comparator handler, and WebSocket receiver.
- `public/css/style.css`: High-contrast dark theme optimized for drafting under time pressure.
- `draft_data.json` (mirrored in `public/`): the 820-player board, an export of the aggregate app (`rankings.csv`) with the league's real scoring and roster settings, C/F eligibility, and ESPN ADP. **VORP/FP are the user's own numbers: do not recompute them from raw source data** (that loses The Athletic source). Only the ADP columns are regenerated.
- `scripts/ingest_espn_adp.js`: merges ESPN ADP from Hashtag Hockey only. Values must be plain numbers with at most one decimal; Daily Faceoff's text has columns glued together and produced corrupt values, so it is no longer used.
- `scripts/mock_draft.js`: seeded mock-draft / Monte Carlo simulator (see above).
- `yahoo-sync/`: Complete Manifest V3 extension, bookmarklet, and Tampermonkey script for `fantasy.espn.com` and `draft.fantasysports.yahoo.com`.
