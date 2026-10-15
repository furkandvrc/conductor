# Sourced by bin/gen-image: show the run as a worker character in Pixel Agents (lib/pixel.js).
# usage: conductor_event start|end [text]      reads: worker write (set by the caller)
_conductor_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
conductor_event() {
  [ "${CONDUCTOR_PIXEL:-1}" = 0 ] && return 0
  local label="Gemini"
  ( node "$_conductor_root/lib/pixel.js" "$1" "$label" "${write:-0}" "${2:-}" ) >/dev/null 2>&1 </dev/null &
  return 0
}
