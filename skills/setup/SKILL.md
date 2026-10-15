---
name: setup
description: First-run setup and health check for the Conductor plugin in Claude Code or Codex. Detect which worker CLIs are installed, add OpenAI-compatible endpoints, choose the orchestrator, start the dashboard and the optional Pixel Agents office, and fix what is missing. Use on "set up conductor", "conductor doesn't work", "configure workers", "add a local model", "conductor kurulum", "worker'ları ayarla".
---

# Conductor setup

Work through these steps in order. Report a short checklist to the user at the end. Install
nothing, and never touch credentials, without the user's go-ahead.

1. **Requirements.** Check that `node` (version 18 or later), `python3`, `curl` and `bash` are on
   PATH. Report anything missing with the install command for the user's OS.

2. **Workers.** Run `delegate status`. In Codex, use the full path to `bin/delegate` printed at
   session start. You only need one worker; the rest are optional.

   | Worker | Install | Sign in |
   |---|---|---|
   | claude | `npm install -g @anthropic-ai/claude-code` | `claude` |
   | codex | `npm install -g @openai/codex` | `codex login` |
   | gemini (Antigravity) | https://antigravity.google | `agy` |
   | cursor | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
   | copilot | `npm install -g @github/copilot` | `copilot`, then `/login` |
   | gemini-cli | `npm install -g @google/gemini-cli` | `GEMINI_API_KEY` |
   | opencode | `npm install -g opencode-ai` | `opencode auth login` |
   | qwen | `npm install -g @qwen-code/qwen-code` | first run |

   Sign-ins are interactive, so the user must run them. In Claude Code, suggest the
   `! <command>` prefix. A worker that is installed but signed out fails at run time; it shows
   "last run failed" in `delegate list`.

3. **Endpoints (optional).** For any OpenAI-compatible API (Ollama, LM Studio, vLLM, llama.cpp
   server, OpenRouter…), send the user to the dashboard: Workers → **Add an endpoint**. They can
   add as many as they like, each with its own key and model. Never ask for API keys in the chat.

4. **Custom CLIs (optional).** To add another headless CLI, the user adds it to
   `~/.config/conductor/workers.json` under `custom`. Arguments are substituted per argv item,
   never through a shell:

   ```json
   { "custom": [ { "id": "aider", "label": "Aider", "cmd": "aider",
       "args": ["--message", "{prompt}", "--model", "{model}"],
       "readArgs": ["--dry-run"], "writeArgs": ["--yes-always", "--no-auto-commits"],
       "goodAt": "small, precise edits" } ] }
   ```

5. **Orchestrator.** On the dashboard, open Settings → Orchestrator. There the user can install
   Conductor into Claude Code and/or Codex (one click each) and choose who orchestrates;
   "Automatic" detects it per session. The orchestrator never delegates to itself. In Codex, the
   user must approve the plugin's hook once when Codex asks.

6. **Dashboard and office.** Run `conductor-panel start` and give the user
   http://127.0.0.1:4747. The Office page needs `npm install -g pixel-agents`. Pixel Agents' own
   hook approval is for the user to give in its UI.

7. **Smoke test.** Run one cheap read-only task on an available worker, for example
   `delegate <worker> "In one sentence, what does README.md describe?"`. Confirm that it appears on
   the Tasks page.
