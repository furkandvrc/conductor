#!/usr/bin/env bash
# SessionStart hook (Claude Code and Codex). Prints a few lines into the orchestrator's context:
# which workers it can delegate to and what each is good at. Kept short: it is paid for in every
# session. Also starts the dashboard (CONDUCTOR_PANEL_AUTOSTART=0 to opt out) and, with
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
workers="$(node "$here/lib/delegate.js" list --for "$host" 2>/dev/null)"
if [ -z "$workers" ]; then
  echo "conductor: no worker models are set up yet. If the user wants to delegate work to cheaper models, suggest the conductor setup skill. Dashboard: $dash"
  exit 0
fi
echo "conductor: you are the orchestrator. The user installed conductor so you hand work to other models: using \`$dcmd <worker> \"<task>\"\` counts as the user asking (it is not the Agent tool). Delegate whenever checking the result costs less than doing the work (reading many files, translation, reviews, mechanical edits, commit messages); keep planning, decisions and verification yourself; see the conductor delegate skill. Available workers:"
echo "$workers"
command -v agy >/dev/null 2>&1 && echo "Images: \`$here/bin/gen-image \"<prompt>\" <out.png>\` (conductor image skill)."
echo "Dashboard (usage, cost, tasks, settings, office): $dash"
exit 0
