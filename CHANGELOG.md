# Changelog

## 0.3.1

### Changed

- **The orchestrator now actually delegates.** Usage data showed the session-start note and the
  skill lost to the host's "handle it inline" default. The note and the `delegate` skill now say
  that using `delegate` counts as the user asking (it is not the Agent tool), and leave the
  decision to the orchestrator: delegate whenever checking the result costs less than doing the
  work. The "fewer than three file reads" rule is gone.
- **Worker reports lead with the answer.** The contract asks for the result first (findings with
  file:line references), then files changed and open questions, in up to 300 words.

### Fixed

- A worker's answer was lost when its output passed the line cap: only the `## REPORT` section was
  shown, and that section held no answer. A `## REPORT` longer than the cap now keeps its head
  instead of the output's tail.
- Codex host detection through `PLUGIN_ROOT`, Codex model listing, local-time run ids, a single
  copy of a migrated secret, and parallel version probes.
- Office: alert statuses stay on labels, workers sit in a "Workers" area, labels sit above speech
  bubbles, the Pixel Agents request body limit is 16 MB, and the patch no longer writes to a stray
  file.

## 0.3.0

### Added

- **Worker registry.** Codex, Claude Code, Gemini CLI, OpenCode and Qwen Code join Antigravity,
  Cursor and Copilot. Custom CLIs can be defined in `workers.json`; `{prompt}`, `{model}` and
  `{dir}` are substituted per argument.
- **Multiple OpenAI-compatible endpoints**, each with its own name, URL, secrets, model and role.
  The single `local.env` from 0.2 is migrated automatically.
- **Codex plugin** (`.codex-plugin/plugin.json`). Codex can orchestrate and delegate to Claude
  Code and the other workers. The session-start hook detects the host from the transcript path,
  excludes the host from its own worker list, and gives Codex the full path of `delegate`.
- **Orchestrator setting** (automatic, Claude Code or Codex), with one-click installation into
  each host from Settings.
- **Workers page as a management screen**: turn workers on or off; set model (loaded from the
  CLI or `/v1/models`) and role; add, edit, test and delete endpoints.
- `delegate list`, `delegate models <worker>`, and a "last run failed" warning (for example an
  expired login) in the list given to the orchestrator.

### Changed

- `delegate` is now Node (`lib/delegate.js`) behind the same command. Heartbeats run in-process,
  so no background shell loops remain.
- Nested delegation is refused: a worker cannot call `delegate`, which prevents loops.
- Office labels come from the registry.
- Office labels show "Needs approval" and "Waiting for input" under the name again; the 0.2.1
  label patch had hidden them.
- Speech bubbles (permission, turn done) are visible again. With "Always Show Labels" on, the
  name label covered them; it now moves above a character's bubble.
- Workers are mapped to an office area named `Workers` (`CONDUCTOR_OFFICE_AREA`), so they sit
  together and away from Claude sessions.
- Pixel Agents' 64 KB request limit is raised to 16 MB (localhost only). Its own Claude hook
  posts whole tool inputs, and large ones were rejected with HTTP 413, which lost events.
- The Claude Code worker runs with `--safe-mode`. It loads none of the user's hooks, plugins or
  `CLAUDE.md`, so its context stays lean, and it still uses the signed-in plan.
- The Codex worker lists its models from `codex debug models`.
- Host detection uses `PLUGIN_ROOT` (set only by Codex) and the plugin path. It works in
  ephemeral sessions too. Verified end to end: Codex delegated a task to Claude Code.


## 0.2.1

- The office hides background sessions that are not your work: claude-mem's observer sessions by
  default, configurable with `CONDUCTOR_OFFICE_HIDE`. Their token cost still shows in the
  dashboard.
- The Pixel Agents patch is now rebuilt from the pristine bundle every time, so changes never stack.

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
