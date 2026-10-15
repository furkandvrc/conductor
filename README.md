# Conductor

**Claude orchestrates; cheaper models do the volume work.**

Conductor is a [Claude Code](https://code.claude.com) plugin. It keeps Claude (Opus) as the
planner and reviewer, and hands bulk reading, mechanical edits, second-opinion reviews and text
chores to the coding agents and models you already pay for, or to a model you host yourself.
A local dashboard shows what Claude costs, what the workers did and how they performed.

| Worker | Runs through | Good at |
|---|---|---|
| `gemini` | [Antigravity CLI](https://antigravity.google) (`agy`): Gemini and Claude models on a Google plan | reading and analysing large codebases |
| `cursor` | [Cursor Agent CLI](https://cursor.com/cli) (`cursor-agent`) | well-specified edits, refactors, tests |
| `copilot` | [GitHub Copilot CLI](https://github.com/github/copilot-cli) (`copilot`) | independent reviews and second opinions |
| `local` | any **OpenAI-compatible endpoint**: Ollama, LM Studio, vLLM, llama.cpp server, OpenRouter… | free text chores: commit messages, summaries |

You need only one of them. Conductor detects what is installed and tells Claude at the start of
every session.

## How it works

1. A `SessionStart` hook tells Claude which workers are available and that it is the
   orchestrator.
2. The `conductor:delegate` skill gives Claude the routing table and a protocol: brief the worker
   like a contractor, run it, **verify its work**, escalate when it fails.
3. Claude runs `delegate <worker> "<task>"`. The worker's full transcript goes to a log file;
   only a short `## REPORT` enters Claude's context, which is where the token savings come from.
4. Workers are **read-only** by default. With `--write` they may edit files, but they can never
   commit or push.

```bash
delegate gemini "Where is authentication handled? List files and entry points."
delegate cursor --write "Add unit tests for src/cart.ts covering discounts; no other files."
git diff --staged | delegate local "Write a one-line conventional commit message."
gen-image "flat green sprout icon" assets/icons/sprout.png --transparent
```

## Dashboard

`conductor-panel open` opens <http://127.0.0.1:4747>. The dashboard starts in the background
with every Claude Code session, listens on localhost only, and nothing it reads leaves your
machine. The interface is in English and Turkish.

| Page | What you get |
|---|---|
| **Overview** | today, this month and the last 30 days of Claude cost, cache hit rate, daily cost by model, projects, delegated work, setup checklist |
| **Claude usage** | 7 days to all time, per-project filter, daily cost and token charts, model, project and session tables |
| **Workers** | status, version, default model, success rate, run time and model usage per worker |
| **Tasks** | every delegated task, searchable; open one to see the brief, the report and the full log |
| **Office** | [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) embedded: your sessions and workers as pixel characters (optional) |
| **Settings** | worker models; the local endpoint (models loaded from its `/v1/models`, or a custom id) with a connection test; budgets; prices; switches |

**About the cost figures:** they come from Claude Code's own transcripts (`~/.claude/projects`),
priced at Anthropic API list rates. They are an *API-equivalent* figure, useful for comparison,
and not your subscription bill. Each message is counted once, even though Claude Code writes it
on several transcript lines. Prices are editable under Settings → Pricing.

## Install

From GitHub:

```text
/plugin marketplace add furkandvrc/conductor
/plugin install conductor@conductor
/conductor:setup
```

From a local clone:

```bash
git clone https://github.com/furkandvrc/conductor
claude plugin marketplace add ./conductor
claude plugin install conductor@conductor
```

Then, in Claude Code, run `/conductor:setup`. It checks the requirements, shows which workers are
missing and how to install them, and starts the dashboard.

**Requirements:**
- macOS or Linux
- `bash`, `curl`, `python3`, and Node.js 18 or later
- At least one worker: `agy`, `cursor-agent` or `copilot`, signed in once interactively; or an
  OpenAI-compatible endpoint
- Optional: `uv` for transparent PNGs, ImageMagick for image conversion on Linux, and
  `npm install -g pixel-agents` for the office

### Local model

Open Dashboard → Settings → Local model. Enter the endpoint URL (with or without `/v1`), an API
key or Cloudflare Access token if your endpoint needs one, then **Load models** and pick one, or
type any model id. **Test connection** checks that it works.

Secrets are stored in `~/.config/conductor/local.env` with mode 600 and are never sent back to
the browser. If you leave the model empty, `delegate` uses the first model the endpoint lists.

## Commands

| Command | Purpose |
|---|---|
| `delegate <worker> [--write] [--model M] [--timeout S] [--dir D] "<task>"` | run a worker; stdin is appended as context |
| `delegate status` | show which workers are usable |
| `gen-image "<prompt>" out.png [--transparent] [--variants N]` | generate an image into the project via Antigravity |
| `conductor-panel [open\|start\|stop\|restart\|status]` | control the dashboard |
| `conductor-panel office [start\|stop\|status]` | control Pixel Agents on port 4748 |

The plugin puts these commands on Claude's PATH. To use them in your own shell, link them, for
example: `ln -s "$PWD/bin/"* ~/.local/bin/`.

## Configuration

Everything can be set from the dashboard. These are the underlying files:

| Path | Contents |
|---|---|
| `~/.config/conductor/conductor.env` | `CONDUCTOR_MODEL_GEMINI` / `_CURSOR` / `_COPILOT`, `CONDUCTOR_TIMEOUT`, `CONDUCTOR_MAX_LINES`, `CONDUCTOR_PIXEL`, `CONDUCTOR_PANEL_AUTOSTART`, `CONDUCTOR_OFFICE_AUTOSTART`, `CONDUCTOR_BUDGET_DAILY` / `_MONTHLY` |
| `~/.config/conductor/local.env` | `LOCAL_URL`, `LOCAL_MODEL`, `LOCAL_API_KEY`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` |
| `~/.config/conductor/pricing.json` | price overrides per model |
| `~/.claude/conductor/` | `logs/`, `runs.jsonl` (one record per task), `usage-index.json`, server logs |

Environment variables: `CONDUCTOR_PANEL_PORT` (4747), `CONDUCTOR_OFFICE_PORT` (4748), and
`CONDUCTOR_PIXEL_CONFIG=0` to stop Conductor from enabling Pixel Agents' "Watch All Sessions".

## Office (optional)

With `pixel-agents` installed, opening the Office page starts it and seats every available worker
at a desk. Each `delegate` run makes that character work; it returns to idle afterwards.

Conductor makes two changes to Pixel Agents. It enables `watchAllSessions` in
`~/.pixel-agents/config.json`, because workers are external sessions. It also re-applies a small,
idempotent label patch, so characters read Claude / Gemini / Cursor / Copilot / Local instead of
status text.

Pixel Agents asks for a one-time approval before it adds its hooks to `~/.claude/settings.json`.
That approval is yours to give in its UI.

## Security and privacy

- **Network:** the dashboard binds to 127.0.0.1 and rejects foreign `Host` headers (DNS
  rebinding). State-changing requests need a same-origin custom header (CSRF).
- **Settings files:** values written to the env files are validated against a strict character
  set, because `delegate` sources them.
- **Logs:** they are served only from the plugin's log directory.
- **What workers see:** workers get your task text and whatever files they read, and their
  providers' terms apply. The delegate skill tells Claude never to pass secrets to workers.

## Development

```bash
scripts/selftest.sh   # syntax checks, unit tests, plugin validation
```

The dashboard has no build step and no dependencies: `dashboard/server.js` plus `dashboard/lib/*`
(Node) serve `index.html`, `app.js`, `app.css` and `i18n.js`. To add a UI language, add a
dictionary in `dashboard/i18n.js`.

## License

MIT. Pixel Agents is a separate MIT project by its authors; Conductor only talks to it.

---

### Türkçe özet

Conductor, Claude Code için bir plugin. Claude (Opus) yönetici olarak kalır. Çok dosya okuma,
toplu düzenleme, ikinci görüş ve commit mesajı gibi hacimli işler senin zaten kullandığın daha
ucuz modellere gider: Antigravity, Cursor, Copilot ya da OpenAI uyumlu herhangi bir uç nokta
(Ollama, LM Studio…).

Kurulumdan sonra `/conductor:setup` çalıştır. Dashboard'u açmak için `conductor-panel open`
yaz. Dashboard Türkçe ve İngilizce; Claude maliyetini, devredilen görevleri, worker'ları, ayarları
ve piksel ofisi gösterir.
