# Fantasy Hockey Draft Game Theory Co-Pilot

A live, high-contrast drafting co-pilot for your Mac that combines aggregate fantasy hockey projections with game theory decision analysis on the clock.

## Features
- **Aggregate Projections**: Blends 800+ players from 4 major projection sources (DtZ, DFO, Apples & Ginos) with multi-site ADP and replacement level VORP.
- **On The Clock Decision Protocol**:
  - **Step 1: Red Alert (`MUST REACH (Cliff)`)**: Identifies imminent positional cliffs with low survival probability ($P < 35\%$, $Next \ge 15$).
  - **Step 2: Urgency Filtering**: Surfaces `NOW OR NEVER` ($P < 20\%$) and `TARGET` ($20\% \le P \le 75\%$) while filtering out `WAIT (ADP Safe)` sleepers who will safely fall.
  - **Step 3: Adjusted Value Tiebreaking**: Applies positional diminishing returns ($Adj\_VORP$) and breaks ties by positional cliff size.
- **Snake Schedule Automation**: Computes next pick automatically based on league teams and draft slot.
- **Yahoo Fantasy Live Sync**: Live sync bookmarklet and companion script that watches your live Yahoo Draft room and automatically pushes drafted players hands-free.
- **Trade-off Comparator**: Head-to-head calculator testing $P(A) > \frac{Loss_B}{Loss_A}$.

## Quick Start
```bash
./start.sh
```
Or:
```bash
npm install
npm test
npm start
```
Open [http://localhost:3333](http://localhost:3333) in your browser.
