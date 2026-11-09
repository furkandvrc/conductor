#!/usr/bin/env bash
# PostToolUse hook (Claude Code). The session-start note is read once and fades by the time the
# orchestrator is deep in a task; this is the reminder at the moment it matters. It counts inline
# file reads (Read/Grep/Glob, and cat/grep/sed -n/… through Bash) since the last `delegate` call
# and, every N of them, adds one line to the context naming the workers. Silent otherwise.
# N comes from CONDUCTOR_DELEGATION: light 20, balanced 8, max 4, off = never. Must never fail.
[ "${CONDUCTOR_ROLE:-}" = worker ] && exit 0
conf="${CONDUCTOR_CONFIG:-$HOME/.config/conductor/conductor.env}"
# shellcheck disable=SC1090
[ -r "$conf" ] && . "$conf"
case "${CONDUCTOR_DELEGATION:-balanced}" in off) exit 0 ;; light) every=20 ;; max) every=4 ;; *) every=8 ;; esac

state="${CONDUCTOR_HOME:-$HOME/.claude/conductor}"
workers="$state/orchestrator-workers-claude.txt"   # written by session-start.sh; this hook is Claude Code only
[ -s "$workers" ] || exit 0

payload="$(head -c 65536)"
field() { printf '%s' "$payload" | grep -oE "\"$1\" *: *\"([^\"\\\\]|\\\\.)*\"" | head -1 | sed -E "s/^\"$1\" *: *\"//; s/\"\$//"; }
sid="$(field session_id | tr -cd 'A-Za-z0-9_-')"
[ -n "$sid" ] || exit 0
tool="$(field tool_name)"
mkdir -p "$state/nudge" 2>/dev/null || exit 0
f="$state/nudge/$sid"

hit=""
case "$tool" in
  Read|Grep|Glob) hit=1 ;;
  Bash)
    cmd="$(field command)"
    case "$cmd" in *delegate\ *) rm -f "$f"; exit 0 ;; esac
    printf '%s' "$cmd" | grep -qE '^(cd [^;&|]*(&&|;) *)?(rtk +(proxy +)?)?(cat|grep|rg|sed -n|head|tail|find|ls|wc|awk|read)( |$)' && hit=1 ;;
esac
[ -n "$hit" ] || exit 0

# one byte per read: small appends are atomic, so parallel tool calls never lose a count
printf . >> "$f" 2>/dev/null || exit 0
n=$(( $(wc -c < "$f") + 0 ))
[ "$n" -lt "$every" ] && exit 0
: > "$f"
ids="$(grep -oE '^- [a-z0-9-]+' "$workers" | cut -c3- | paste -sd, - | sed 's/,/, /g')"
msg="conductor: $every inline file reads since your last delegate. If more reading, exploring, reviewing or mechanical editing is ahead, hand that chunk to a worker ($ids) with a detailed brief: delegate <worker> <brief>. Keep decisions and verification here. Skip this if you are about to finish."
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$msg"
exit 0
