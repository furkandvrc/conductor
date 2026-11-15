#!/usr/bin/env python3
"""agy_status: tell gen-image early that an Antigravity image run has already failed.

agy's print mode hands the image to a subagent and returns; when that subagent fails (quota,
sign-in, a refused prompt) the error lands only in the conversation transcripts, never as an
image file. Without this check gen-image waited for a file that could not appear.

usage: agy_status.py <work dir> <brain dir> [<conversation id>]
Prints one line, or nothing while the run is still going:
  FATAL limit<TAB><message>   quota / usage limit (agy says RESOURCE_EXHAUSTED or 429 quota)
  FATAL auth<TAB><message>    not signed in / permission denied
  DONE<TAB><message>          the agent ended its turn after its subagents reported back
"""
import glob
import json
import os
import re
import sys

LIMIT = re.compile(r"RESOURCE_EXHAUSTED|exhausted your capacity|quota (?:reached|exceeded|exhausted|will reset)"
                   r"|Individual quota|usage limit|hit your (?:\w+ )?limit|insufficient_quota", re.I)
AUTH = re.compile(r"UNAUTHENTICATED|PERMISSION_DENIED|not (?:logged|signed) in|please (?:log|sign) in"
                  r"|401 Unauthorized|invalid api key|authentication (?:failed|required)", re.I)


def kind(text):
    if LIMIT.search(text):
        return "limit"
    if AUTH.search(text):
        return "auth"
    return ""


def short(text, n=300):
    text = re.sub(r"\s+", " ", text).strip()
    # agy's JSON error lines carry a readable short_error; prefer it
    m = re.search(r'"short_error"\s*:\s*"([^"]+)"', text) or re.search(r'"message"\s*:\s*"([^"]+)"', text)
    return (m.group(1) if m else text)[:n]


def steps(conv_dir):
    try:
        with open(os.path.join(conv_dir, ".system_generated", "logs", "transcript.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    yield json.loads(line)
                except ValueError:
                    pass
    except OSError:
        return


def main(argv):
    work, brain = argv[1], argv[2]
    conv = argv[3] if len(argv) > 3 else ""

    # 1. agy itself (the planner model) failed: AGY_ERROR / error: lines on stderr or in the event stream
    for name in ("err.log", "events.ndjson"):
        try:
            with open(os.path.join(work, name), encoding="utf-8", errors="replace") as f:
                for line in f:
                    text = line if re.match(r"\s*(?:AGY_ERROR|error|ERROR)\b", line) else ""
                    if not text and line.lstrip().startswith("{"):
                        try:  # an error event in the stream; never the prompt or the model's prose
                            e = json.loads(line)
                        except ValueError:
                            e = None
                        if isinstance(e, dict) and (e.get("error") or "error" in (e.get("event"), e.get("type"))):
                            text = json.dumps(e.get("error") or e)
                    k = kind(text)
                    if k:
                        print(f"FATAL {k}\t{short(text)}")
                        return 0
        except OSError:
            pass
    if not conv:
        return 0

    # 2. the image subagents: a step that ended in ERROR with a quota or sign-in message
    parent = os.path.join(brain, conv)
    subs = set()
    for p in glob.glob(os.path.join(parent, ".system_generated", "subagents", "*.json")):
        try:
            with open(p, encoding="utf-8") as f:
                c = json.load(f).get("conversationId")
            if c:
                subs.add(c)
        except (OSError, ValueError):
            pass
    for c in sorted(subs) + [conv]:
        for s in steps(os.path.join(brain, c)):
            if s.get("status") == "ERROR":
                err = str(s.get("error") or s.get("content") or "")
                # a failed step is final, so a bare 429 there is the limit too
                k = kind(err) or ("limit" if re.search(r"\b429\b|Too Many Requests", err) else "")
                if k:
                    print(f"FATAL {k}\t{short(err)}")
                    return 0

    # 3. the parent agent heard back from its subagents and ended its turn (no tool call pending)
    all_steps = list(steps(parent))
    if subs and all_steps:
        last = all_steps[-1]
        heard = any(s.get("type") == "SYSTEM_MESSAGE" and "sender=" in str(s.get("content", "")) for s in all_steps)
        if heard and last.get("type") == "PLANNER_RESPONSE" and not last.get("tool_calls"):
            msg = str(last.get("content") or "")
            k = kind(msg)
            print(f"FATAL {k}\t{short(msg)}" if k else f"DONE\t{short(msg)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
