#!/usr/bin/env python3
"""Make Pixel Agents name characters "Claude", "Gemini", "Cursor", "Copilot", "Local".

Stock Pixel Agents labels a character with its status line ("Using mcp__…", "Reading …",
"Idle") over the session's folder name ("furkan", "sessions"). This rewrites the label to
one name: conductor workers (folder ~/.claude/conductor/agents/<Worker>) keep their worker
name, every other Claude Code session reads "Claude". Activity stays visible through the
character animation and the label's status dot.

The bundle is minified, so the match is a regex over the label JSX. Idempotent; keeps a
one-time .orig backup; exits 0 without changing anything when the pattern is not found
(a Pixel Agents release changed the markup), so it can never break the office.
usage: patch-pixel-agents.py [--check]
"""
import glob
import os
import re
import shutil
import subprocess
import sys

MARK = "/*conductor-labels*/"
VERSION = "v3"
# workers keep their name; claude-mem's observer sessions (folder "sessions") get their own label
HELPER = (MARK + "/*" + VERSION + "*/" + 'var __cName=f=>["Gemini","Cursor","Copilot","Local"].includes(f)?f:f==="sessions"?"claude-mem":"Claude";\n')
LABEL = re.compile(
    r"children:(\w+)\}\),(\w+)\.folderName&&\(0,(\w+)\.jsx\)\(`span`,\{className:`text-2xs leading-none "
    r"overflow-hidden text-ellipsis block`,children:\2\.folderName\}\)"
)


def bundle():
    try:
        root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:
        root = "/opt/homebrew/lib/node_modules"
    files = glob.glob(os.path.join(root, "pixel-agents", "dist", "webview", "assets", "index-*.js"))
    return files[0] if files else None


def main():
    f = bundle()
    if not f:
        print("patch-pixel-agents: pixel-agents not installed")
        return
    s = open(f, encoding="utf-8").read()
    if MARK in s:
        first, rest = s.split("\n", 1)
        if first + "\n" == HELPER:
            print("patch-pixel-agents: already patched")
            return
        if first.startswith(MARK):                      # older helper: swap the one line
            open(f, "w", encoding="utf-8").write(HELPER + rest)
            print("patch-pixel-agents: helper updated to " + VERSION)
            return
    if "--check" in sys.argv:
        print("patch-pixel-agents: not patched")
        return
    new, n = LABEL.subn(lambda m: f"children:__cName({m.group(2)}.folderName)}}),!1", s)
    if n != 1:
        print(f"patch-pixel-agents: label markup not recognised ({n} matches) — left unchanged")
        return
    if not os.path.exists(f + ".orig"):
        shutil.copy2(f, f + ".orig")
    open(f, "w", encoding="utf-8").write(HELPER + new)
    print("patch-pixel-agents: labels patched")


if __name__ == "__main__":
    main()
