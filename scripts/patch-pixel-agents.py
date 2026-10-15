#!/usr/bin/env python3
"""Adapt the Pixel Agents web UI for Conductor. Re-run safely at every office start.

1. Labels: stock Pixel Agents shows a status line ("Using mcp__…", "Idle") over the session's folder
   name. Characters get one name instead: Conductor workers (folder ~/.claude/conductor/agents/<Worker>,
   names from CONDUCTOR_OFFICE_WORKERS, set by conductor-panel) keep their name, everything else reads "Claude".
   Status lines that ask for the user ("Needs approval", "Waiting for input") are still shown under
   the name; routine ones ("Using …", "Idle") are not.
2. Hidden sessions: background sessions that are not your work, by default claude-mem's observer
   sessions, get no character at all. Folder names to hide come from CONDUCTOR_OFFICE_HIDE
   (comma-separated; default "sessions,observer-sessions"; set it to "none" to hide nothing).
3. Bubbles: the permission / turn-done speech bubbles are drawn on the canvas right where the name
   label sits, so with "Always Show Labels" on the label covers them. While a character has a
   bubble its label is lifted above it.
4. Request size (server, dist/cli.js): Pixel Agents' own Claude hook posts whole tool inputs, and
   its 64 KB body limit rejects large ones (HTTP 413), so those events are lost. The limit is raised
   to 16 MB; the server only listens on 127.0.0.1.

The bundle is minified, so each change is a regex. Every run starts from the pristine copy saved as
<bundle>.orig, so the result never depends on earlier patches. If a Pixel Agents release changes the
markup, the affected change is skipped and the office keeps working unpatched.
usage: patch-pixel-agents.py [--check]
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys

MARK = "/*conductor-patch*/"
OLD_MARKS = ("/*conductor-labels*/",)
def workers():
    raw = os.environ.get("CONDUCTOR_OFFICE_WORKERS", "")
    names = [x.strip() for x in raw.split(",") if x.strip()]
    return names or ["Gemini", "Cursor", "Copilot", "Codex", "Claude", "Local"]
LABEL = re.compile(
    r"children:(\w+)\}\),(\w+)\.folderName&&\(0,(\w+)\.jsx\)\(`span`,\{className:`text-2xs leading-none "
    r"overflow-hidden text-ellipsis block`,children:\2\.folderName\}\)"
)
ADD_AGENT = re.compile(r"addAgent\((\w),(\w),(\w),(\w),(\w),(\w),(\w)\)\{")
# let d=a.state===R.TYPE?6:0,f=p.toScreenX(a.x),g=p.toScreenY(a.y+d-32); … style:{left:f,top:g-(O?34:28),
LABEL_POS = re.compile(r"let (\w)=(\w)\.state===(\w)\.TYPE\?6:0,(\w)=(\w)\.toScreenX\(\2\.x\),(\w)=\5\.toScreenY\(\2\.y\+\1-32\);")
BODY_LIMIT = re.compile(r"bodyLimit:\w+([,}])")
BODY_BYTES = 16 * 1024 * 1024


def hidden():
    raw = os.environ.get("CONDUCTOR_OFFICE_HIDE", "sessions,observer-sessions").strip()
    if raw.lower() in ("", "none", "0"):
        return []
    return [x.strip() for x in raw.split(",") if x.strip()]


def helper():
    return (MARK + "var __cName=f=>" + json.dumps(workers()) + '.includes(f)?f:"Claude";'
            + "var __cHide=f=>" + json.dumps(hidden()) + ".includes(f);"
            + 'var __cAlert=s=>s==="Needs approval"||s==="Waiting for input";\n')


def bundle():
    dist = os.environ.get("CONDUCTOR_PIXEL_DIST")   # tests point this at a fixture
    if dist:
        files = [f for f in glob.glob(os.path.join(dist, "webview", "assets", "index-*.js")) if not f.endswith(".orig")]
        return files[0] if files else None
    try:
        root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:
        root = ""
    roots = [r for r in [root, "/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules", "/usr/lib/node_modules"] if r]
    for r in roots:
        files = [f for f in glob.glob(os.path.join(r, "pixel-agents", "dist", "webview", "assets", "index-*.js")) if not f.endswith(".orig")]
        if files:
            return files[0]
    return None


def pristine_copy(f, marks=()):
    """Return the unpatched text of f, saving it as f.orig the first time."""
    if not os.path.exists(f + ".orig"):
        current = open(f, encoding="utf-8").read()
        if marks and current.startswith(marks):
            return None
        shutil.copy2(f, f + ".orig")
    return open(f + ".orig", encoding="utf-8").read()


def patch_server(dist):
    f = os.path.join(dist, "cli.js")
    if not os.path.exists(f):
        return "server: not found"
    pristine = pristine_copy(f)
    out, n = BODY_LIMIT.subn(lambda m: f"bodyLimit:{BODY_BYTES}{m.group(1)}", pristine, count=1)
    if n != 1:
        return "server: body limit markup not recognised"
    if out == open(f, encoding="utf-8").read():
        return "server: up to date"
    if "--check" in sys.argv:
        return "server: needs update"
    open(f, "w", encoding="utf-8").write(out)
    return f"server: body limit {BODY_BYTES // (1024 * 1024)} MB"


def main():
    f = bundle()
    if f:
        print("patch-pixel-agents: " + patch_server(os.path.dirname(os.path.dirname(os.path.dirname(f)))))
    if not f:
        print("patch-pixel-agents: pixel-agents not installed")
        return
    current = open(f, encoding="utf-8").read()
    if not os.path.exists(f + ".orig"):
        if current.startswith((MARK,) + OLD_MARKS):
            print("patch-pixel-agents: patched bundle without a pristine copy; reinstall pixel-agents")
            return
        shutil.copy2(f, f + ".orig")
    pristine = open(f + ".orig", encoding="utf-8").read()

    out, applied = pristine, []
    # name on the first line; the status line only when it needs the user
    out, n = LABEL.subn(lambda m: (f"children:__cName({m.group(2)}.folderName)}}),__cAlert({m.group(1)})&&(0,{m.group(3)}.jsx)"
                                   f"(`span`,{{className:`text-2xs leading-none overflow-hidden text-ellipsis block`,children:{m.group(1)}}})"), out)
    if n == 1: applied.append("labels")
    out, n = ADD_AGENT.subn(lambda m: m.group(0) + f"if(__cHide({m.group(6)}))return;", out, count=1)
    if n == 1: applied.append("hide")
    m = LABEL_POS.search(out)
    if m:
        v_d, v_a, _, v_left, v_cam, v_top = m.groups()   # minified names; never reuse `f` (the bundle path)
        old = f"style:{{left:{v_left},top:{v_top}-("
        i = out.find(old, m.end())
        if 0 <= i < m.end() + 4000:
            # bubble sprite is ~16 world px tall: when one is showing, anchor the label above it
            out = out[:i] + f"style:{{left:{v_left},top:({v_a}.bubbleType?{v_cam}.toScreenY({v_a}.y+{v_d}-50):{v_top})-(" + out[i + len(old):]
            applied.append("bubbles")
    out = helper() + out

    if out == current:
        print("patch-pixel-agents: up to date (" + ", ".join(applied) + ")")
        return
    if "--check" in sys.argv:
        print("patch-pixel-agents: needs update")
        return
    open(f, "w", encoding="utf-8").write(out)
    print("patch-pixel-agents: applied " + (", ".join(applied) or "nothing (markup not recognised)") + f"; hidden folders: {hidden() or 'none'}")


if __name__ == "__main__":
    main()
