---
name: delegate
description: Orchestrate cheaper worker models so Claude spends its tokens on planning, decisions and verification instead of bulk reading or mechanical edits. Use when a task involves reading many files or long logs/docs, exploring an unfamiliar codebase, mechanical multi-file edits, boilerplate, tests from a spec, a second-opinion code review, commit messages or summaries. Workers - gemini (Antigravity CLI), cursor (Cursor Agent CLI), copilot (GitHub Copilot CLI), local (any OpenAI-compatible endpoint such as Ollama or LM Studio). Also trigger on "delegate", "use a cheaper model", "second opinion", "save tokens", "başka modele ver", "ucuz modelle yap", "ikinci görüş", "token tasarrufu".
---

# Delegate: Claude orchestrates, workers execute

You are the orchestrator. You own the plan, every decision and the final verification.
Workers are cheaper models that you drive with the `delegate` command, which this plugin puts
on PATH. Their full transcript goes to a log file; only their `## REPORT` reaches your context.

```bash
delegate <gemini|cursor|copilot|local> [--write] [--model M] [--timeout SEC] [--dir D] "<task>"
git diff --staged | delegate local "write a one-line conventional commit message"   # stdin = context
delegate status                                                                     # which workers work here
```

Read-only is the default. `--write` lets the worker edit files under `--dir` (default: cwd), but it
can never commit or push. After a `--write` run, `delegate` prints `git status --short` for you.

## Routing: who does what

Use only the workers that `delegate status` (or the session-start note) reports as available.

| Work | Worker | Why |
|---|---|---|
| Understand a large or unfamiliar codebase, "where/how is X done", summarise modules, read long logs or docs | `gemini` | Antigravity runs strong models (Claude Sonnet/Opus, Gemini) on the user's Google quota |
| Well-specified implementation: boilerplate, mechanical refactors across files, tests from a spec, migrations | `cursor --write` | Strong at edits; on the user's Cursor plan |
| Independent review of a diff, a second opinion on a design, GitHub/Actions questions | `copilot` | A different model family gives a genuinely independent view |
| Text-only chores on piped input: commit messages, log/diff summaries, translation, naming | `local` | Free or self-hosted; no file access; the least reliable, so never use it for decisions |
| Needs tight back-and-forth, or touches secrets, auth, payments or infrastructure | **Do it yourself** | Not worth the hand-off risk |

Do not delegate when doing it yourself is cheaper: the task needs fewer than about three file reads,
or the brief would be longer than the work. Delegation pays off on volume, not on difficulty.

## Protocol

1. **Brief like a contractor.** The worker has none of your context. State the goal, the exact
   files or directories, the constraints (style, APIs to keep, what not to touch) and the
   acceptance check. Send one task per call. For edits, name the files it may change.
2. **Run.** Run independent tasks as parallel `delegate` calls with `run_in_background: true`;
   you are notified when each finishes.
3. **Verify. Never relay a worker's claim as fact.** For `--write`, read the `git diff` of the
   touched files, run the project's tests and linters, and fix or revert what is wrong. For
   read-only answers, spot-check one or two of the cited locations before building on them.
4. **Escalate instead of looping.** If a worker fails twice on the same task, do it yourself or
   hand it to a stronger model, for example `--model` with a larger Cursor or Antigravity model.
5. **Tell the user** which parts were delegated, to whom, and what you verified.

## Rules

- Workers must not see secrets. Never pipe `.env` files, keys, tokens or `secrets/` into
  `delegate`, and do not delegate tasks whose subject is credentials.
- Run only one `--write` worker per directory at a time. Parallel `--write` work needs separate
  git worktrees (`--dir <worktree>`).
- The full transcript is at the `log=` path on the first output line. Read it only when the
  REPORT is not enough.
- Exit codes: `0` means done; `5` means the worker said nothing (for example a tool was denied in
  headless mode); `3` means the worker is not installed or not configured; `130` means interrupted.
- The `gemini` worker (Antigravity) cannot run shell commands headless, and it returns nothing if
  it tries. Give it reading, analysis and editing tasks, not "run the tests".
- Defaults (models, timeout, report line cap) come from `~/.config/conductor/conductor.env`, which
  the dashboard's Settings page edits. Explicit flags win.
- For images, use `gen-image` (skill `conductor:image`), not these workers.
- If the user asks what workers did or what usage costs, point them to the dashboard:
  `conductor-panel open`, or http://127.0.0.1:4747.
