#!/usr/bin/env bash
# SessionStart hook (Claude Code and Codex). Prints a few lines into the orchestrator's context:
# which workers it can delegate to, what each is good at and, by CONDUCTOR_DELEGATION, when to
# delegate. Kept short: it is paid for in every session. Also starts the dashboard (CONDUCTOR_PANEL_AUTOSTART=0 to opt out) and, with
# CONDUCTOR_OFFICE_AUTOSTART=1, the Pixel Agents office. Must never fail or block the session.
here="$(cd "$(dirname "$0")/.." && pwd)"
# a worker started by `delegate` must not be told it is an orchestrator
[ "${CONDUCTOR_ROLE:-}" = worker ] && exit 0
conf="${CONDUCTOR_CONFIG:-$HOME/.config/conductor/conductor.env}"
# shellcheck disable=SC1090
[ -r "$conf" ] && . "$conf"
command -v node >/dev/null 2>&1 || { echo "conductor: Node.js 18+ is required for the delegate command."; exit 0; }

# Which host is running us?
payload=""
if [ -p /dev/stdin ] || [ -f /dev/stdin ]; then payload="$(head -c 65536)"; fi
host="${CONDUCTOR_ORCHESTRATOR:-auto}"
if [ "$host" = auto ]; then
  # Codex sets PLUGIN_ROOT (Claude Code only sets CLAUDE_PLUGIN_ROOT) and runs plugins from ~/.codex
  host=claude
  if [ -n "${PLUGIN_ROOT:-}" ]; then host=codex; fi
  case "$here$payload" in *"/.codex/"*) host=codex ;; esac
fi

if [ "${CONDUCTOR_PANEL_AUTOSTART:-1}" != 0 ]; then ( "$here/bin/conductor-panel" start >/dev/null 2>&1 </dev/null & ); fi
if [ "${CONDUCTOR_OFFICE_AUTOSTART:-0}" = 1 ]; then ( "$here/bin/conductor-panel" office start >/dev/null 2>&1 </dev/null & ); fi

dash="http://127.0.0.1:${CONDUCTOR_PANEL_PORT:-4747}"
# Claude Code puts the plugin's bin/ on PATH; Codex does not, so give it the full path.
dcmd="delegate"; [ "$host" != claude ] && dcmd="$here/bin/delegate"
level="${CONDUCTOR_DELEGATION:-balanced}"
state="${CONDUCTOR_HOME:-$HOME/.claude/conductor}"
workers=""
[ "$level" != off ] && workers="$(node "$here/lib/delegate.js" list --for "$host" 2>/dev/null)"
# the PostToolUse nudge reads this list; stale per-session counters are dropped here
mkdir -p "$state" 2>/dev/null && printf '%s\n' "$workers" > "$state/orchestrator-workers-$host.txt" 2>/dev/null
find "$state/nudge" -type f -mtime +2 -delete 2>/dev/null
if [ "$level" = off ]; then echo "conductor: delegation is switched off (dashboard → Settings). Dashboard: $dash"; exit 0; fi
if [ -z "$workers" ]; then
  echo "conductor: no worker models are set up yet. If the user wants to delegate work to cheaper models, suggest the conductor setup skill. Dashboard: $dash"
  exit 0
fi
case "$level" in
  light) when="Delegate large volume work: reading or mapping 10+ files, long logs or docs, big mechanical edits, full reviews." ;;
  max) when="Delegate by default: all reading and exploring beyond the file you are editing, reviews, every multi-file or mechanical edit, tests, translation, commit messages. Do yourself only planning, decisions, verification and edits of a few lines." ;;
  *) when="Delegate by default: exploring or reading more than ~3 files, long logs or docs, reviews and second opinions, multi-file or mechanical edits, tests from a spec, translation, commit messages. Do it yourself: small edits in files you already read, decisions, anything touching secrets, auth, payments or infra." ;;
esac
echo "conductor: you are the orchestrator. The user installed conductor so you hand work to other models: using \`$dcmd <worker> \"<brief>\"\` counts as the user asking (it is not the Agent tool). $when Write the brief in detail (goal, files, constraints, done-when); workers answer with a short STATUS/ANSWER/CHANGED/UNSURE report, so delegating costs you little context. You keep planning, decisions and verification; see the conductor delegate skill. Available workers:"
echo "$workers"
command -v agy >/dev/null 2>&1 && echo "Images: \`$here/bin/gen-image \"<prompt>\" <out.png>\` (conductor image skill)."
echo "Dashboard (usage, cost, tasks, settings, office): $dash"
exit 0
