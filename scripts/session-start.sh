#!/usr/bin/env bash
# Prints a few lines into Claude's context at session start: which workers are usable.
# Kept deliberately short — it is paid for in every session. Also makes sure the dashboard is
# running (CONDUCTOR_PANEL_AUTOSTART=0 to opt out); the office (Pixel Agents) starts when its
# dashboard page is opened, or here when CONDUCTOR_OFFICE_AUTOSTART=1.
here="$(cd "$(dirname "$0")/.." && pwd)"
conf="${CONDUCTOR_CONFIG:-$HOME/.config/conductor/conductor.env}"
# shellcheck disable=SC1090
[ -r "$conf" ] && . "$conf"
if [ "${CONDUCTOR_PANEL_AUTOSTART:-1}" != 0 ]; then
  ( "$here/bin/conductor-panel" start >/dev/null 2>&1 </dev/null & )
fi
if [ "${CONDUCTOR_OFFICE_AUTOSTART:-0}" = 1 ]; then
  ( "$here/bin/conductor-panel" office start >/dev/null 2>&1 </dev/null & )
fi
have() { command -v "$1" >/dev/null 2>&1; }
w=()
have agy && w+=("gemini")
have cursor-agent && w+=("cursor")
have copilot && w+=("copilot")
[ -r "${CONDUCTOR_LOCAL_ENV:-$HOME/.config/conductor/local.env}" ] && w+=("local")
dash="http://127.0.0.1:${CONDUCTOR_PANEL_PORT:-4747}"
if [ ${#w[@]} -eq 0 ]; then
  echo "conductor: no worker models are set up yet. If the user wants to delegate work to cheaper models, suggest /conductor:setup. Dashboard: $dash"
  exit 0
fi
img=""; have agy && img=" Images: conductor:image (\`gen-image\`)."
echo "conductor: you are the orchestrator. Cheaper workers available via the \`delegate\` command: ${w[*]}."
echo "Before reading many files, bulk-editing, reviewing a large diff or writing commit messages, load the conductor:delegate skill and hand the volume work off; you plan and verify.$img Dashboard (usage, cost, tasks, settings, office): $dash (\`conductor-panel open\`)."
exit 0
