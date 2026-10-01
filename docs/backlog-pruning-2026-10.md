# Backlog pruning pass — October 2026

A record of the pruning pass run on 2026-10-01 against `mkny13/hockey-draft-copilot`
(issue #66), so a later pass can diff against it.

Scope: close finished goals, find issues superseded by current code, find duplicates or
overlaps, and decide what to do with parked items. GitHub-side reading and commenting was
done in the planning run; this file is the committed record.

## How the pass was run

```bash
gh issue list -R mkny13/hockey-draft-copilot --state all --limit 200 \
  --json number,state,title,labels
git ls-remote origin 'mahler/*'
git fetch origin
git rev-list --count origin/main..origin/<branch>   # per leftover branch
git diff --stat origin/main...origin/<branch>
```

Every open issue was re-checked against current `main` rather than against its description
text: `yahoo-sync/content.js`, `server.js`, `public/js/gametheory.js` and the `test/` files
were read to decide whether an issue's work is already in the codebase.

## Open issues at build time

| # | Title | Verdict | Reason |
|---|-------|---------|--------|
| 66 | Issue Backlog Pruning Pass | keep | This pass. Closed by its own merge. |
| 22 | Extension: HUD integrity warning, durable pick retry, and draft-board reconciliation | keep | Still real work: `main`'s `yahoo-sync/content.js` has no durable pick queue, no HUD integrity row and no board reconciliation. PR #28 was closed unmerged, so nothing landed. Its `mahler:working` label is Mahler's to own and was left alone. |

No other issue was open. **Nothing was closed by this pass**, so no
`<!-- mahler:agent -->`-prefixed explanation comments were required.

## The #22 / PR #28 / #12 status mix-up

- **PR #28** (`mahler/22-extension-hud-integrity-warning-durable`) was **closed without
  merging** on 2026-09-24. It is not in `main`'s history.
- A **"Shipped"** comment was nevertheless posted on #22 afterwards.
- **#12** ("Detect and repair unrecorded picks (gap in pick history)") was closed on
  2026-09-25 on the strength of that comment.
- The two issues are not the same work. #12 landed in `main` as the **server-side**
  `pickHistoryIntegrity` snapshot and the `POST /api/repair-pick` route (`server.js:169`,
  `server.js:569`), guarded by `test/test_server.js`. #22 is the **extension-side** half:
  a durable pick queue in `yahoo-sync/content.js`, a HUD integrity row and reconciliation
  against the draft board, with coverage in `test/test_sync.js`. `test/test_sync.js` has no
  `repair`/`integrity`/`queue`/`pending` coverage, which is the same conclusion from the
  test side.
- Consequence: #22 is mislabelled as shipped in its history and must be rebuilt from
  current `main`. Its snapshot branches predate #47 and #55, both of which rewrote
  `content.js` and `test/test_sync.js`, so none of them can be reopened or merged as-is.
  #22's Plan was edited to add `yahoo-sync/manifest.json` and to say "rebuild on current
  `main`".

## Leftover remote branches

No branch under `mahler/*` is an ancestor of `main`, because the snapshots were taken on
older `main` commits. Whether the work behind them landed was checked content-wise instead.

### #22 refs (8) — do not merge, safe to delete

Each carries 1–2 commits ahead of `main`, all touching `content.js` and `test_sync.js` at a
revision that #47 and #55 have since rewritten. The feature is still unimplemented on
`main`, so deleting them loses no working code; a future #22 run should start clean.

| Branch | Commits ahead | Shortstat vs `main` |
|--------|---------------|---------------------|
| `mahler/22-extension-hud-integrity-warning-durable` | 1 | 3 files, +535 −46 |
| `mahler/22-extension-hud-integrity-warning-durable-r9582` | 2 | 3 files, +541 −45 |
| `mahler/snapshot/22-run9568` | 1 | 3 files, +422 −45 |
| `mahler/snapshot/22-run9582` | 2 | 3 files, +541 −45 |
| `mahler/snapshot/22-run9584` | 2 | 3 files, +537 −46 |
| `mahler/snapshot/22-run9756` | 1 | 3 files, +535 −46 |
| `mahler/snapshot/22-stale-run9694` | 2 | 3 files, +537 −46 |
| `mahler/snapshot/22-stale-run9756` | 2 | 3 files, +537 −46 |

**Recommendation:** delete all eight. They are not mergeable against current `main`, and
`#22` needs a fresh implementation rather than a rebase of any of them. Wait until #22
merges so the history of the attempt is not lost while the issue is still live.

### `mahler/snapshot/13-run2208` — work landed, safe to delete

Two commits ahead of `main` (`8ae64d8` roster-complete detection, `e4b8b2e` its tests).
Both landed in `main` by another route: `public/js/gametheory.js:269` computes
`rosterComplete`, `public/js/app.js:311` and `:420` branch on it, and `test/test_sync.js`
covers the final pick's toast plus the roster-complete HUD state. #13 was closed on
2026-09-22.

**Recommendation:** delete. The diff against `main` is only base drift from later commits.

### Remaining `mahler/snapshot/*` refs (31)

`snapshot/1-run2168`, `1-run2171`, `1-stale-run2171`, `14-run2198`, `17-run9554`,
`18-run9541`, `19-run9562`, `20-run9547`, `21-run9587`, `29-run9613`, `3-run2166`,
`30-run9605`, `30-run9609`, `31-run9602`, `32-run9595`, `39-run9704`, `4-run2164`,
`40-run9629`, `40-run9739`, `40-run9742`, `40-run9748`, `41-run9736`, `46-run9814`,
`47-run9793`, `47-run9805`, `48-run9776`, `49-run9769`, `5-run2162`, `55-run9847`,
`56-run9839`, `57-run9854`, `62-run9888`, `63-run10105`.

Every one belongs to a closed issue. They were not audited commit-by-commit in this pass —
that is the one piece of work a later pass may want to finish before deleting them.

**Recommendation:** delete in bulk once the #22 refs are gone, after a spot-check that no
branch holds work absent from `main`.

## Findings carried forward

- **Parked items:** none. No issue has ever carried `mahler:parked`.
- **Duplicates / overlaps:** none.
- **Superseded issues:** none, other than the mislabelled #22 above.
- **Goal issues:** #6, #27, #38, #45, #54 and #61 are all closed as completed; no goal
  issue is open with all of its sub-issues closed.

## Verification

`npm install && npm test` — all seven files `pass` in the `--- Test Summary ---` block.
`test/test_docs.js` scans `README.md`, `AGENTS.md` and `CLAUDE.md` only, so this file
under `docs/` does not affect the docs-parity assertions.