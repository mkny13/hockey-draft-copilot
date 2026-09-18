# Fantasy Hockey Draft Game Theory Co-Pilot

A live, high-contrast drafting co-pilot for macOS that pairs aggregate player projections (DtZ, DFO, Apples & Ginos) with real-time Game Theory decision analysis on the clock.

---

## Key Features

### 1. Automated Game Theory Decision Engine (EVONA)
- **Closed-Form 2-Round Expected Value ($\Delta EV$)**:
  Calculates the expected point gain of drafting any target $B$ compared to the board's top VORP anchor $A$:
  $$\Delta EV(B \text{ over } A) = (1 - S(B)) \cdot \text{Cliff}(B) - (1 - S(A)) \cdot \text{Cliff}(A) - [VORP(A) - VORP(B)]$$
  - Measures the **Expected Cliff Loss** saved by drafting $B$ immediately versus letting them slide to your next snake turn ($T_{next}$).
  - Automatically identifies whether taking an urgent cliff target (e.g. Leon Draisaitl at Pick 5) yields higher net portfolio value than taking a high-survival anchor (e.g. Quinn Hughes at 65% survival).
- **Automated Trade-Off Advice on Every Shortlist Card**:
  - Displays **`⚡ +X.X EV Edge`** for game-theory winners and **`🛡️ SAFE TO WAIT`** for safe anchors.
  - Renders **2-Round Expected Value (`2-Rnd EV`)** alongside single-round `VORP`.
  - Includes a crisp, 1-line plain-English strategic reason (e.g. *"Locks in +53.9 C/F cliff. Quinn Hughes (65% surv) is likely to slide to Turn #12 (+41.4 net EV advantage over drafting Quinn Hughes now)."*).
- **Live Direction Banner**:
  - Automatically switches headline to **`🎯 GAME THEORY PICK`** whenever multi-round EV diverges from raw single-round VORP.
- **Auto-Populated Comparator with `⚡ Auto ON`**:
  - Automatically loads and analyzes the primary dilemma on the board by default with zero manual clicks required.
  - Toggle button allows drafters to switch between automatic dilemma tracking and custom manual pairings.

### 2. League Roster & Multi-Position Rules
- **Center (`C`) & Forward (`F`) League Mapping**:
  - Skaters are mapped to Center (`C`) and Forward (`F`) positions (all LW, RW, and W players map to `F`).
  - Dual-eligible players (`C, F`) receive multi-position optionality and are never penalized if either starting slot is open.
- **Graded Diminishing Returns**:
  - Starters ($count < limit$): **100%** utility ($\text{Adj\_VORP} = \text{VORP}$)
  - Primary Bench ($count = limit$): **85%** utility
  - Deep Bench ($count = limit + 1$): **65%** utility
  - Excess ($count \ge limit + 2$): **35%** utility

### 3. Packaged Hands-Free Yahoo Draft Room Sync (MV3)
Located in [`yahoo-sync/`](yahoo-sync/):
- **Background Health Service Worker (`background.js`)**:
  - Runs periodic 5-second health checks against `http://localhost:3333/api/state`.
  - Measures latency and broadcasts status updates to the popup and open Yahoo Draft tabs.
- **Extension Options Popup (`popup.html` / `popup.js`)**:
  - Displays live server status (`● Connected` with millisecond latency or `● Disconnected / Offline`).
  - Persists configurable server URL in `chrome.storage.local` with on-demand ping verification.
- **In-Room Live Connection Badge (`status.css` / `content.js`)**:
  - Injects a high-contrast badge pinned to the top-right corner of the Yahoo draft room DOM (`#copilot-yahoo-badge`).
  - Green glowing dot indicates live synchronization; tracks synced pick counts.
  - Watches draft table rows with a `MutationObserver` and streaming fallback to push picks hands-free to `/api/pick`.

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

### 2. Load the Chrome Extension in Yahoo
1. In Google Chrome, go to `chrome://extensions`.
2. Toggle on **Developer mode** in the upper right.
3. Click **Load unpacked** in the top left.
4. Select the folder:
   ```
   /Volumes/ExtSSD160/scripts/Hockey/yahoo-sync
   ```
5. Open your Yahoo Draft Room. The green **`🏒 Co-Pilot: Live`** badge will appear in the top-right corner, streaming picks hands-free as they happen.

---

## Running Tests

```bash
npm test
```
Runs the full suite in [`test/test_gametheory.js`](test/test_gametheory.js) using Node.js built-in `assert`:
- High-precision Abramowitz & Stegun normal CDF & $P_{survive}$ odds
- Snake draft turnaround calculator
- Positional cliff alerts & dynamic drop-offs
- C & F multi-position optionality and graded diminishing returns curve
- Generalized EVONA trade-off evaluator
- Multi-candidate automated trade-offs (e.g. Pick 5 Draisaitl vs Hughes verification)
- Pick 1 board dominance verification (Connor McDavid strictly #1)

---

## Architecture & Code Map

- `server.js`: Node.js Express & WebSocket server (`PORT=3333`). Manages live draft state (`draft_state.json`), CORS-enabled `/api/pick`, `/api/undo`, `/api/reset`, `/api/settings`, and live WS broadcast.
- `public/js/gametheory.js`: Mathematical game-theory engine implementing survival odds ($P_{survive}$), snake schedule calculations, diminishing returns, automated target trade-offs (`computeTargetTradeoffs`), top matchup selector (`getTopMatchup`), and 2-round EVONA comparator (`comparePlayersGameTheory`).
- `public/js/app.js`: Client-side UI controller, search, reactive table rendering, shortlisted cards with trade-off callouts, auto-comparator handler, and WebSocket receiver.
- `public/css/style.css`: High-contrast dark theme optimized for drafting under time pressure.
- `draft_data.json`: Master 820-player aggregate projection dataset with custom scoring and C/F eligibility.
- `yahoo-sync/`: Complete Manifest V3 extension, bookmarklet, and Tampermonkey script for `draft.fantasysports.yahoo.com`.
