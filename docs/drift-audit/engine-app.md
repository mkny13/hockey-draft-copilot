# Drift audit: game-theory engine + app UI (#130)

## Claim checks

| claim | doc location | code location | verdict | action |
|---|---|---|---|---|
| normal CDF via Abramowitz & Stegun, default std 7.0 | README §1 / AGENTS gametheory.js | gametheory.js normalCDF | match | none |
| ΔEV formula | README §1 | comparePlayersGameTheory | doc-drift | fixed README §1 (removed extraneous [VORP(A)-VORP(B)] term; VORP baseline cancels) |
| shortlist ordering | README | evaluateBoard | match | none |
| diminishing multipliers (100/100/30/35, 85/65/35, 5% must-fill) | README/AGENTS | getDiminishingMultiplier | match | none |
| discount never raises negative VORP | AGENTS conventions | evaluateBoard | match | none |
| named functions exist | AGENTS | gametheory.js exports | match | none |
| isomorphic wrapper | AGENTS | IIFE factory | match | none |

## Zombie code

All exported keys and top-level functions in app.js/bookmarklet.js have callers. No zombies deleted.

## mock_draft summary

Before and after identical:

```
Monte Carlo: 12 sims per slot, 8 teams, 22 rounds

slot | engine pts | ADP pts | edge  | edge>0 | engine rank | ADP rank | roster mix (C/F/D/G)
   1 |       5469 |    5218 |   251 |    92% |         1.0 |      3.3 | 6.2/7.0/6.8/2.0
   2 |       5446 |    5236 |   210 |    92% |         1.1 |      2.8 | 6.7/6.7/6.5/2.2
   3 |       5480 |    5213 |   267 |    92% |         1.0 |      3.1 | 6.3/6.9/6.5/2.3
   4 |       5525 |    5228 |   297 |   100% |         1.0 |      3.2 | 6.3/7.1/6.3/2.3
   5 |       5502 |    5191 |   310 |    92% |         1.0 |      3.8 | 5.8/7.3/6.7/2.3
   6 |       5505 |    5100 |   405 |   100% |         1.0 |      4.0 | 6.0/7.3/6.4/2.3
   7 |       5501 |    5055 |   446 |   100% |         1.1 |      5.3 | 5.8/7.3/6.7/2.3
   8 |       5459 |    5191 |   269 |   100% |         1.2 |      3.5 | 6.4/6.6/6.6/2.4
```
