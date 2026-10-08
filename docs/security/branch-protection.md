# Branch Protection Policy and Runbook

This document specifies the branch protection policy for `mkny13/hockey-draft-copilot`, its integration with Mahler's autonomous conductor workflow, and the procedures for applying, inspecting, and verifying protection.

## Overview and Policy Settings

The default branch `main` is protected with classic branch protection configured via GitHub REST API to ensure code quality and build verification before changes are merged.

Target protection configuration on `main`:

- **Required Status Checks**:
  - `contexts: ["test"]`: Enforces that pull request CI (defined in `.github/workflows/ci.yml`) runs and passes before merging. The `test` job executes the comprehensive 7-file test suite (`npm test`).
  - `strict: true`: Requires branches to be up to date with the latest base branch (`main`) before merging (D19).
- **Administrator Enforcement**:
  - `enforce_admins: true`: Applies status checks and merge requirements to repository administrators, preventing accidental bypass.
- **Merge Strategy**:
  - `allow_squash_merge: true`: Squash merging remains enabled on the repository for clean, atomic commits on `main`.
- **Pull Request Review Requirements**:
  - `required_pull_request_reviews: null`: No required GitHub pull request review approvals or CODEOWNERS reviews.
- **Push and Branch Restrictions**:
  - `restrictions: null`: No actor-level push restrictions.
  - `allow_force_pushes: false`: Force pushes to `main` are strictly forbidden.
  - `allow_deletions: false`: Branch deletion of `main` is strictly forbidden.
  - No signatures (`required_signatures: false`), deployments, or merge queues required.

## Conductor Architecture Rationale (D18 / D19)

Mahler manages development pipelines through autonomous agents guided by a conductor:

- **DESIGN D18 (Conductor-owned review and squash merge)**:
  In Mahler's autonomous development cycle, the conductor conducts builds through GitHub issues and pull requests. The conductor independently performs review and validation checks (`recipes/review.md`), monitors CI status, and executes squash merges when all checks pass green. Requiring GitHub PR review approvals (`required_pull_request_reviews`) would block conductor autonomous merges (`mahler ship`) or require artificial reviewer bots.
- **DESIGN D19 (Current-base verification)**:
  To eliminate race conditions and avoid merging code against stale base commits, branch protection mandates `strict: true`. Any branch must be synchronized with the latest `main` commit before CI completes and the branch can be merged.

## GitHub API Commands

### 1. Inspect Repository Settings
Verify default branch and squash merge support:

```bash
gh api repos/mkny13/hockey-draft-copilot --jq '{default_branch, allow_squash_merge}'
```

Expected output:
```json
{
  "allow_squash_merge": true,
  "default_branch": "main"
}
```

### 2. Apply Branch Protection
Configure classic branch protection via `PUT /repos/:owner/:repo/branches/:branch/protection`:

```bash
gh api --method PUT repos/mkny13/hockey-draft-copilot/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "test"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

### 3. Read Back Branch Protection
Inspect the active protection rules:

```bash
gh api repos/mkny13/hockey-draft-copilot/branches/main/protection
```

Confirm that:
- `required_status_checks.strict` is `true`
- `required_status_checks.contexts` contains `["test"]`
- `enforce_admins.enabled` is `true`
- `allow_force_pushes.enabled` is `false`
- `allow_deletions.enabled` is `false`
- `required_pull_request_reviews` is not configured

## Acceptance Verification

The repository state is verified using Mahler's practices audit scanner:

```bash
PYTHONPATH=/Users/mike/Mahler python3 - <<'PYTEST'
from pathlib import Path
from mahler.gh import GH
from mahler.practices_audit import scan_project

project = {
    'name': 'hockey',
    'repo': 'mkny13/hockey-draft-copilot',
    'verify': 'npm test',
    'path': str(Path.cwd())
}
finding = next(f for f in scan_project(project, GH(project['repo'])).findings if f.check == 'branch-protection')
print(finding)
assert finding.state == 'pass', finding.reason
PYTEST
```

Expected output:
```
Finding(check='branch-protection', state='pass', reason='Squash merging enabled and a PR test check is required.', evidence=('GitHub API: repository default_branch/allow_squash_merge', 'GitHub API: branches/<default>/protection; rules/branches/<default>', 'default_branch=main; allow_squash_merge=True', 'required checks: test'))
```
