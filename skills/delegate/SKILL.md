---
name: delegate
description: Orchestrate cheaper or specialised worker models so the orchestrator (Claude Code or Codex) spends its tokens on planning, decisions and verification instead of bulk reading or mechanical edits. Use when a task involves reading many files or long logs/docs, exploring an unfamiliar codebase, mechanical multi-file edits, boilerplate, tests from a spec, a second-opinion review, commit messages or summaries. Workers include Claude Code, Codex, Antigravity (Gemini), Cursor, GitHub Copilot, Gemini CLI, OpenCode, Qwen Code, custom CLIs and any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter…). Also trigger on "delegate", "use a cheaper model", "second opinion", "save tokens", "başka modele ver", "ucuz modelle yap", "ikinci görüş", "token tasarrufu".
---

# Delegate: you orchestrate, workers execute

You are the orchestrator. You own the plan, every decision and the final verification. Workers
are other agents and models that you drive with the `delegate` command. Their full transcript
goes to a log file; only their `## REPORT` reaches your context.

**Which `delegate`:** in Claude Code, `delegate` is on PATH. In Codex and other hosts, use the
full path printed at session start (`…/bin/delegate`).

```bash
delegate <worker> [--write] [--model M] [--timeout SEC] [--dir D] "<task>"
git diff --staged | delegate <worker> "write a one-line conventional commit message"   # stdin = context
delegate list            # usable workers and what each is good at (you are excluded)
delegate status          # every known worker: enabled / installed / configured
delegate models <worker> # models a worker offers
```

Read-only is the default. `--write` lets the worker edit files under `--dir` (default: cwd), but it
can never commit or push. After a `--write` run, `delegate` prints `git status --short` for you.

## Routing

The session-start note lists the workers available here and what each is good at; the user sets
these on the dashboard's Workers page. If you lack that note, run `delegate list`. Pick by the
"good at" line, then by cost: free or self-hosted endpoints for text chores, the user's
subscriptions for agentic work. A worker marked "last run failed" may have an expired login, so
check its log before relying on it.

Typical fits:
- **Reading and analysis:** reading many files, mapping a codebase, summarising modules, long logs
  or docs.
- **Implementation (`--write`):** well-specified, mechanical edits across files, tests from a
  spec, migrations.
- **Review:** an independent review or second opinion from a different model family.
- **Endpoints (text only, no file access):** commit messages, summaries, translation. They are the
  least reliable, so never use them for decisions.
- **Do it yourself** when the task needs tight back-and-forth, or touches secrets, auth, payments
  or infrastructure.

Do not delegate when doing it yourself is cheaper: the task needs fewer than about three file
reads, or the brief would be longer than the work. Delegation pays off on volume, not on
difficulty.

## Protocol

1. **Brief like a contractor.** The worker has none of your context. State the goal, the exact
   files or directories, the constraints (style, APIs to keep, what not to touch) and the
   acceptance check. Send one task per call. For edits, name the files it may change.
2. **Run.** Run independent tasks as parallel `delegate` calls in the background when your host
   supports it.
3. **Verify. Never relay a worker's claim as fact.** For `--write`, read the `git diff` of the
   touched files, run the project's tests and linters, and fix or revert what is wrong. For
   read-only answers, spot-check one or two of the cited locations before building on them.
4. **Escalate instead of looping.** If a worker fails twice on the same task, do it yourself or
   use a stronger worker or model (`--model`).
5. **Tell the user** which parts were delegated, to whom, and what you verified.

## Rules

- Workers must not see secrets. Never pipe `.env` files, keys, tokens or `secrets/` into
  `delegate`, and do not delegate tasks whose subject is credentials.
- Run only one `--write` worker per directory at a time. Parallel `--write` work needs separate
  git worktrees (`--dir <worktree>`).
- Workers cannot delegate further: nested `delegate` calls are refused with exit code 4.
- Exit codes:

  | Code | Meaning |
  |---|---|
  | 0 | done |
  | 2 | usage error or unknown worker |
  | 3 | the worker is disabled, not installed or not configured |
  | 5 | the worker said nothing (for example a tool was denied in headless mode) |
  | 124 | timeout |
  | 130 | interrupted |

- The full transcript is at the `log=` path on the first output line. Read it only when the
  REPORT is not enough.
- For images, use `gen-image` (the `image` skill), not these workers.
- If the user asks what workers did or what usage costs, point them to the dashboard at
  http://127.0.0.1:4747.
