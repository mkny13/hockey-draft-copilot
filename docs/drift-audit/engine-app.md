# Drift audit: game-theory engine + app UI (#130)

## Claim checks

| claim | doc location | code location | verdict | action |
|---|---|---|---|---|
| normal CDF via Abramowitz & Stegun, default std 7.0 | README §1 / AGENTS gametheory.js | gametheory.js normalCDF | match | none |
| ΔEV formula | README §1 | comparePlayersGameTheory | match | none |
| shortlist ordering | README | evaluateBoard | match | none |
| diminishing multipliers (100/100/30/35, 85/65/35, 5% must-fill) | README/AGENTS | getDiminishingMultiplier | match | none |
| discount never raises negative VORP | AGENTS conventions | evaluateBoard | match | none |
| named functions exist | AGENTS | gametheory.js exports | match | none |
| isomorphic wrapper | AGENTS | IIFE factory | match | none |

## Zombie code

All exported keys and top-level functions in app.js/bookmarklet.js have callers. No zombies deleted.

## mock_draft summary

Before and after identical (see /tmp/mock_before.txt).
