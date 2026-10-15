# Changelog

## 0.2.0

### Added

- **Dashboard** (http://127.0.0.1:4747) in English and Turkish, with pages for Overview,
  Claude usage, Workers, Tasks, Office and Settings.
- **Claude usage index.** Reads Claude Code transcripts incrementally, counts each message id
  once, applies list pricing including cache write tiers and fast mode, and names projects after
  their git repository (worktrees included).
- **Setup checklist** on the Overview page, and the `/conductor:setup` skill.
- **Local worker settings.** Models are loaded from the endpoint's `/v1/models`, any custom id
  is accepted, and a connection test distinguishes Cloudflare blocks from auth errors.
- **Budgets** and **editable prices**.
- **Persistent office characters.** Each worker sits idle at a desk and works while a task runs.
- **Unit tests** (`node --test tests/*.test.js`), `scripts/selftest.sh`, and CI.

### Changed

- The `local` worker is generic: any OpenAI-compatible endpoint, labelled "Local". If no model
  is set, `delegate` uses the first model the endpoint lists.
- Pixel Agents runs on port 4748 inside the dashboard. Conductor enables its "Watch All
  Sessions" setting itself.

### Fixed

- `delegate` hung when stdin was an inherited socket, such as Claude Code's Bash tool.
- `delegate` left the office showing a worker as busy after an early exit.
- Non-JSON replies from the local endpoint (for example a WAF block page) now produce a readable
  error.
- `gen-image` used BSD-only `stat`. It now works on Linux, and converts images with `sips` or
  ImageMagick.

## 0.1.0

- First version: `delegate` (gemini / cursor / copilot / local), `gen-image`, the session-start
  hook, and the delegate and image skills.
