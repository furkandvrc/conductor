# Sourced by bin/delegate and bin/gen-image: mirror each worker run into Pixel Agents as a
# character (see scripts/pixel-bridge.py). Everything runs detached and never fails the caller.
# usage: conductor_event start|end [text] [rc] [secs]
# reads: ev_id worker write (set by the caller)
_conductor_bridge="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pixel-bridge.py"
_conductor_label() {
  case "$1" in gemini) echo Gemini ;; cursor) echo Cursor ;; copilot) echo Copilot ;; local) echo Local ;; *) echo "$1" ;; esac
}
conductor_event() {
  [ "${CONDUCTOR_PIXEL:-1}" = 0 ] && return 0
  local label; label="$(_conductor_label "${worker:-}")"
  local beat="${CONDUCTOR_HOME:-$HOME/.claude/conductor}/.beat-${ev_id:-$$}"
  case "$1" in
    start)
      ( python3 -I "$_conductor_bridge" start "$label" "${write:-0}" "${2:-}" ) >/dev/null 2>&1 &
      # keep the character busy while the worker runs; the marker file is the stop signal
      : >"$beat"
      # hard cap: the loop never outlives the worker's timeout, even if the end event is lost
      local beats=$(( (${timeout_s:-900} + 120) / 15 ))
      ( n=0; while [ -e "$beat" ] && [ $n -lt $beats ]; do sleep 15; n=$((n+1)); [ -e "$beat" ] && python3 -I "$_conductor_bridge" beat "$label" "${write:-0}"; done; rm -f "$beat" ) >/dev/null 2>&1 </dev/null &
      ;;
    end)
      rm -f "$beat"
      # back to idle at the desk (the character stays in the office)
      ( python3 -I "$_conductor_bridge" end "$label" "${write:-0}" ) >/dev/null 2>&1 </dev/null &
      ;;
  esac
  return 0
}
