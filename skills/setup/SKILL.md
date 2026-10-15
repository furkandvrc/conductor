---
name: setup
description: First-run setup and health check for the Conductor plugin. Detect which worker CLIs are installed, configure the local OpenAI-compatible endpoint, start the dashboard and the optional Pixel Agents office, and fix what is missing. Use on "/conductor:setup", "set up conductor", "conductor doesn't work", "configure workers", "conductor kurulum", "worker'ları ayarla".
---

# Conductor setup

Work through these steps in order. Report a short checklist to the user at the end. Install
nothing, and never touch credentials, without the user's go-ahead.

1. **Requirements.** Check that `node` (version 18 or later), `python3`, `curl` and `bash` are on
   PATH. Report anything missing with the install command for the user's OS.

2. **Workers.** Run `delegate status`. For each worker that is missing, tell the user what it
   needs and that it is optional; at least one worker is enough.

   | Worker | Install | First run |
   |---|---|---|
   | gemini | Antigravity CLI `agy` (https://antigravity.google) | `agy` once, interactively, to sign in |
   | cursor | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
   | copilot | `npm install -g @github/copilot` | `copilot`, then `/login` (or an authenticated `gh`) |
   | local | any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, llama.cpp server, OpenRouter…) | dashboard → Settings → Local model |

   Commands that need an interactive login must be run by the user. Suggest the `! <command>`
   prefix so the output lands in the session.

3. **Local model (optional).** Never ask the user to paste an API key into the chat. Send them to
   the dashboard instead: Settings → Local model. There they enter the URL and the key, then use
   **Load models** and **Test connection**. The dashboard stores secrets in
   `~/.config/conductor/local.env` (mode 600). After they confirm, check the endpoint with
   `delegate local "Reply with exactly: OK"`.

4. **Dashboard.** Run `conductor-panel start`, then give the user http://127.0.0.1:4747. Its
   Overview page shows a setup checklist with whatever is still missing.

5. **Office (optional).** The office needs Pixel Agents: `npm install -g pixel-agents`. Opening the
   Office page starts it. Pixel Agents asks for one-time approval to add hooks to
   `~/.claude/settings.json`. Only the user can approve that, from the Office page; do not click
   it for them.

6. **Smoke test.** Run one cheap read-only task on an available worker, for example
   `delegate cursor "In one sentence, what does README.md describe?"`. Confirm that it appears on
   the dashboard's Tasks page.
