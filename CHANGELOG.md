# Changelog

## 0.7.0

### Added

- **Claude account rotation goes back to the main account.** When conductor has moved to a spare
  account and the main one has room again (its 5-hour or weekly window reset), it switches back
  at the next check instead of staying on the spare until that one runs out too. The main account
  is the first one saved; change it with `claude-account primary <name>` or the dashboard's
  "Make main" button. When the main account is free it is also the first choice whenever the
  active one hits its limit. An account picked by hand (`claude-account use`, the dashboard) is
  kept until it reaches its own limit. `CONDUCTOR_ACCOUNT_RETURN=0` (dashboard: "Go back to the
  main account") keeps the old behaviour.

## 0.6.1

### Fixed

- **Worker model lists counted banner and error lines as models.** `agy models` prints
  "Fetching available models..." first, which showed up as a model, so an Antigravity CLI that
  was not signed in (or could not reach its service) reported "1 model". Model ids are now
  matched strictly for Antigravity and Cursor, Codex's JSON is parsed from stdout only and
  survives warning lines, and an empty list is reported as an error with the CLI's own output
  (dashboard and `delegate models`) instead of a silent count.
- OpenCode now lists its models (`opencode models`) in the dashboard.

## 0.6.0

### Added

- **Claude account rotation.** Keep several Claude subscriptions signed in; when the active one
  reaches its 5-hour or weekly limit, Conductor moves Claude Code to the next account that still
  has room. `claude-account add <name>` saves the current sign-in, `claude-account login <name>`
  signs another account in without touching the current one, `claude-account list|status|use|
  remove` manage them. A background `UserPromptSubmit` hook checks usage (at most every 5
  minutes) and a `StopFailure` hook reacts to a rate-limit error at once; a desktop notification
  says when it switched. Only the `claudeAiOauth` field of Claude Code's credential store and
  `oauthAccount` in `~/.claude.json` change; MCP sign-ins and every other setting stay as they
  are. New sessions and `delegate` runs use the new account immediately; a running session picks
  it up at its next token refresh, or with `/exit` + `claude --continue`.
- Dashboard → Settings: a Claude accounts card with usage per account and a switch button.
- Settings `CONDUCTOR_ACCOUNTS` (0 turns rotation off), `CONDUCTOR_ACCOUNT_THRESHOLD` (usage %
  that counts as limited, default 98), `CONDUCTOR_ACCOUNT_POLL` (seconds between checks, 300).

## 0.5.0

### Added

- **Running tasks are visible.** `delegate` keeps a marker in `running/` while a worker runs, so the
  dashboard shows it the moment it starts, with a live timer: in the top bar, on Overview and on
  Tasks. A marker whose process has died is removed by the dashboard.
- **Worker activity timeline on Overview:** one row per worker, one mark per task, over 24 hours,
  7 or 30 days. Click a mark for the task, report and log.

### Changed

- **New dashboard design:** a top bar instead of the sidebar, a plain sentence saying what is
  happening now, light and dark themes built on one palette.
- **Tasks opens on the last 7 days** (24 hours, 30 days and All are one click away), and Recent
  tasks on Overview covers 7 days. Records from before task text was kept only show under All.
  Nothing is deleted.
- Overview and Tasks refresh when a task starts or ends, and an open tab reloads itself when the
  dashboard is updated.

### Fixed

- A dashboard left running by an older install kept serving its old pages after a plugin update;
  `conductor-panel start` (run at session start) now replaces an older one.
- The Workers and Tasks pages re-rendered every minute, discarding unsaved edits and search focus.
- Switching pages quickly could paint the slower page over the one you had opened.
- A worker's colour changed when another worker was switched off.
- Durations could read "1 min 60 s".
- `/api/runs` would fail on a very large `runs.jsonl`; it is also no longer re-parsed on every request.

## 0.4.0

### Added

- **Delegation level** (dashboard → Settings, `CONDUCTOR_DELEGATION`: off, light, balanced, max).
  The session-start note now gives the orchestrator a concrete list of what to delegate at that
  level instead of a cost judgement it made case by case (and almost always answered "inline":
  no `delegate` run in the week after 0.3.1).
- **Mid-session reminder.** A `PostToolUse` hook counts inline file reads (Read/Grep/Glob and
  `cat`/`grep`/`sed -n`/… through Bash) since the last `delegate` call and, every 20/8/4 of them
  (light/balanced/max), adds one line to the context naming the workers. Silent otherwise.
- **Model pools.** Each worker can list models with an on/off switch and a weight (dashboard →
  Workers). Without `--model`, `delegate` picks the model furthest below its share over the last
  14 days, so a 60/30/10 split holds even over a few runs. `delegate list` shows the shares.

### Changed

- **Brief reports by default** (`CONDUCTOR_REPORT=brief`): workers end with
  `STATUS / ANSWER / CHANGED / UNSURE` in under 120 words, and the default report cap is 30 lines.
  `full` restores the 300-word report and 60 lines.
- The delegate skill has a brief template (goal, files, context, constraints, done-when): long
  brief, short report.

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
