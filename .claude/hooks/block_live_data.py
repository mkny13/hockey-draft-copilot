#!/usr/bin/env python3
"""PreToolUse hook: block edits to live draft data (draft_state.json, draft_data.local.json).

Exit 2 blocks the tool call; any internal error exits 0 so a hook bug never wedges a session.
"""
import json
import os
import sys

PROTECTED = {"draft_state.json", "draft_data.local.json"}

try:
    data = json.load(sys.stdin)
    path = (data.get("tool_input") or {}).get("file_path") or ""
    if os.path.basename(path) in PROTECTED:
        sys.stderr.write(
            "Blocked: %s is live draft data (gitignored, owned by the running server). "
            "Do not edit it directly; use the server API or a DRAFT_STATE_FILE temp copy.\n"
            % os.path.basename(path)
        )
        sys.exit(2)
except SystemExit:
    raise
except Exception:
    pass
sys.exit(0)
