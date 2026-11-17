#!/usr/bin/env python3
"""PreToolUse hook: block edits to live draft data (draft_state.json, draft_data.local.json).

Exit 2 blocks the tool call; any internal error exits 0 so a hook bug never wedges a session.
"""
import json
import os
import re
import shlex
import sys

PROTECTED = {"draft_state.json", "draft_data.local.json"}


def is_bash_write_target(cmd):
    if not cmd or not any(p in cmd for p in PROTECTED):
        return False

    # 1. Output redirect > or >>
    # e.g. echo x > draft_state.json or cat foo >> draft_data.local.json
    if re.search(r"(?:^|[\s\d&])>>?\s*['\"]*(?:[^\s'\"]*/)?(draft_state\.json|draft_data\.local\.json)\b", cmd):
        return True

    # 2. tee, rm, mv, truncate
    if re.search(r"\b(?:rm|mv|tee|truncate)\b[^\n|;&]*\b(?:[^\s'\"]*/)?(draft_state\.json|draft_data\.local\.json)\b", cmd):
        return True

    # 3. sed -i or sed --in-place
    if re.search(r"\bsed\b[^\n|;&]*(?:-i|--in-place)[^\n|;&]*\b(?:[^\s'\"]*/)?(draft_state\.json|draft_data\.local\.json)\b", cmd):
        return True

    # 4. cp ... <protected> as destination
    for part in re.split(r"[\n|;&]+", cmd):
        part = part.strip()
        if re.search(r"\bcp\b", part):
            try:
                tokens = shlex.split(part)
            except Exception:
                tokens = part.split()
            for i, tok in enumerate(tokens):
                if tok == "cp":
                    args = [t for t in tokens[i + 1:] if not t.startswith("-")]
                    if len(args) >= 2:
                        dest = os.path.basename(args[-1].strip("'\""))
                        if dest in PROTECTED:
                            return True
    return False


try:
    data = json.load(sys.stdin)
    tool_input = data.get("tool_input") or {}

    # File path edit check (Edit, Write, MultiEdit, NotebookEdit)
    path = tool_input.get("file_path") or ""
    if os.path.basename(path) in PROTECTED:
        sys.stderr.write(
            "Blocked: %s is live draft data (gitignored, owned by the running server). "
            "Do not edit it directly; use the server API or a DRAFT_STATE_FILE temp copy.\n"
            % os.path.basename(path)
        )
        sys.exit(2)

    # Bash command check
    command = tool_input.get("command") or ""
    if is_bash_write_target(command):
        sys.stderr.write(
            "Blocked: command targets live draft data (draft_state.json / draft_data.local.json). "
            "Do not modify or delete it directly; use the server API or a DRAFT_STATE_FILE temp copy.\n"
        )
        sys.exit(2)
except SystemExit:
    raise
except Exception:
    pass
sys.exit(0)
