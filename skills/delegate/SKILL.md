---
name: delegate
description: Orchestrate cheaper or specialised worker models so the orchestrator (Claude Code or Codex) spends its tokens on planning, decisions and verification instead of bulk reading or mechanical edits. Use when a task involves reading many files or long logs/docs, exploring an unfamiliar codebase, mechanical multi-file edits, boilerplate, tests from a spec, a second-opinion review, commit messages or summaries. Workers include Claude Code, Codex, Antigravity (Gemini), Cursor, GitHub Copilot, Gemini CLI, OpenCode, Qwen Code, custom CLIs and any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter…). Also trigger on "delegate", "use a cheaper model", "second opinion", "save tokens", "başka modele ver", "ucuz modelle yap", "ikinci görüş", "token tasarrufu".
---

# Delegate: you orchestrate, workers execute

You are the orchestrator. You own the plan, every decision and the final verification. Workers
are other agents and models that you drive with the `delegate` command. Their full transcript
goes to a log file; only their `## REPORT`, which leads with the answer or findings, reaches your
context.

The user installed conductor so that you hand work to these workers. Using `delegate` counts as
the user asking for it; it is not the Agent tool. When to use it is your call.

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

**When.** The user sets how hard to delegate on the dashboard (Settings → Delegation level); the
session-start note carries that level as a concrete list. At the default level, delegate by
default when the next step is exploring or reading more than ~3 files, a long log or doc, a review,
a multi-file or mechanical edit, tests from a spec, translation or a commit message. Do it yourself
when it is a small edit in a file you already read, a decision, or anything with secrets, auth,
payments or infra. Do not weigh "is it worth it" case by case: a worker's report costs you a few
hundred tokens, reading the files yourself costs thousands. A mid-session `conductor:` reminder
after several inline reads means you have drifted; hand off the next chunk.

**Models.** A worker can have a model pool (dashboard → Workers): models switched on with a share
each. Without `--model`, `delegate` picks from the pool so the shares hold over time; `delegate
list` shows them. Pass `--model` when the task needs a specific one (a stronger model for a hard
task, a fast one for a lookup).

## Protocol

1. **Brief like a contractor: long brief, short report.** The worker has none of your context,
   and a detailed brief is cheap for you while a vague one costs a retry. Send one task per call,
   in this shape (write long briefs to a file and pass `"$(cat brief.md)"`):

   ```
   GOAL: what to produce and why, in one or two sentences
   FILES: what to read first; for --write, exactly which files it may change
   CONTEXT: what you already know (APIs, decisions made, conventions to match) so it need not rediscover it
   CONSTRAINTS: what not to touch, style, APIs to keep
   DONE WHEN: the acceptance check
   ```

   Workers end with a fixed, short report (under 120 words unless the user chose full reports):
   `STATUS: done|partial|failed`, `ANSWER:`, `CHANGED:`, `UNSURE:`. Do not ask for more than that;
   the full transcript is in the log if you ever need it.
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
