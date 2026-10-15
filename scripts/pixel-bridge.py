#!/usr/bin/env python3
"""Show conductor workers as characters in Pixel Agents (github.com/pixel-agents-hq/pixel-agents).

Pixel Agents accepts Claude-style hook events from external processes ("hooks-only external
sessions"). Each delegate run becomes one session whose cwd is ~/.claude/conductor/agents/<Label>,
so the character is labelled with the worker's name. Posts to every live Pixel Agents server and
never fails: the office is decoration, the delegate must not depend on it.

Each worker is one persistent character (session "conductor-<Label>"): it sits idle at its desk,
works while a delegate run is active, and goes back to idle when the run ends.

usage: pixel-bridge.py start|beat|end <label> [write:0|1] [detail]
       pixel-bridge.py roster <label>...     (seat idle workers; run when Pixel Agents starts)
"""
import glob
import json
import os
import sys
import time
import urllib.request

AGENTS = os.path.expanduser("~/.claude/conductor/agents")


def servers():
    seen, out = set(), []
    for f in glob.glob(os.path.expanduser("~/.pixel-agents/servers/*.json")) + [os.path.expanduser("~/.pixel-agents/server.json")]:
        try:
            d = json.load(open(f))
        except Exception:
            continue
        key = (d.get("port"), d.get("token"))
        if d.get("port") and d.get("token") and key not in seen:
            seen.add(key)
            out.append(d)
    return out


def post(srv, body):
    req = urllib.request.Request(
        f"http://127.0.0.1:{srv['port']}/api/hooks/claude",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + srv["token"]},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=1.5).read()
    except Exception:
        pass


def main():
    if len(sys.argv) < 3:
        return
    kind = sys.argv[1]
    if kind == "roster":
        for label in sys.argv[2:]:
            emit("idle", label, False, "")
        return
    label = sys.argv[2]
    write = len(sys.argv) > 3 and sys.argv[3] == "1"
    detail = sys.argv[4] if len(sys.argv) > 4 else ""
    emit(kind, label, write, detail)


def emit(kind, label, write, detail):
    sid = "conductor-" + label
    cwd = os.path.join(AGENTS, label)
    os.makedirs(cwd, exist_ok=True)
    base = {"session_id": sid, "cwd": cwd}
    tool = {"tool_name": "Edit" if write else "Read",
            "tool_input": {"file_path": os.path.join(cwd, (detail or "task")[:80].replace("/", "_"))}}
    # SessionStart is idempotent ("known" for a live session) and recreates the character after a
    # Pixel Agents restart. The first PreToolUse adopts a new session; the second shows the activity.
    hello = [{"hook_event_name": "SessionStart", "source": "startup"}, {"hook_event_name": "PreToolUse", **tool}, "pause"]
    if kind == "start":
        events = hello + [{"hook_event_name": "PreToolUse", **tool}]
    elif kind == "idle":
        events = hello + [{"hook_event_name": "PostToolUse", **tool}, {"hook_event_name": "Stop"}]
    elif kind == "beat":
        events = [{"hook_event_name": "PreToolUse", **tool}]
    elif kind == "end":
        events = [{"hook_event_name": "PostToolUse", **tool}, {"hook_event_name": "Stop"}]
    elif kind == "gone":
        events = [{"hook_event_name": "SessionEnd", "reason": "exit"}]
    else:
        return
    for ev in events:
        if ev == "pause":
            time.sleep(0.8)
            continue
        for srv in servers():
            post(srv, {**base, **ev})


if __name__ == "__main__":
    main()
