# Conductor

**One agent orchestrates; other models do the volume work.**

Conductor is a plugin for **Claude Code** and **Codex**. The agent you are talking to, Claude
Code or Codex, stays the planner and reviewer. Bulk reading, mechanical edits, second-opinion
reviews and text chores go to other agents and models you already pay for, or to models you host
yourself. A local dashboard shows what Claude costs, what the workers did and how they performed.

| Worker | Runs through | Typical use |
|---|---|---|
| `claude` | Claude Code CLI (`claude -p`) | careful reasoning and edits; Codex's worker of choice |
| `codex` | OpenAI Codex CLI (`codex exec`) | hard implementation and debugging |
| `gemini` | [Antigravity CLI](https://antigravity.google) (`agy`): Gemini and Claude models on a Google plan | reading and analysing large codebases |
| `cursor` | [Cursor Agent CLI](https://cursor.com/cli) | well-specified edits, refactors, tests |
| `copilot` | [GitHub Copilot CLI](https://github.com/github/copilot-cli) | independent reviews and second opinions |
| `gemini-cli` | Google Gemini CLI (API key) | 1M-token reading |
| `opencode` | OpenCode (any provider) | edits on any provider/model |
| `qwen` | Qwen Code | coding on Qwen models |
| *your endpoints* | **any number** of OpenAI-compatible APIs: Ollama, LM Studio, vLLM, llama.cpp, OpenRouter… | free or self-hosted text chores |
| *custom CLIs* | any headless CLI, defined in `workers.json` | whatever you configure |

You need only one worker. Each one can be turned on or off, and given its own default model and
role, from the dashboard. The orchestrator never delegates to itself: Claude Code sees Codex,
Cursor and the others, and Codex sees Claude Code and the others.

## How it works

1. A `SessionStart` hook detects the host (Claude Code or Codex). It tells the orchestrator
   which workers are available and what each is good at, excluding the host itself. In Codex it
   also prints the full path of `delegate`.
2. The `conductor:delegate` skill gives Claude the routing table and a protocol: brief the worker
   like a contractor, run it, **verify its work**, escalate when it fails.
3. Claude runs `delegate <worker> "<task>"`. The worker's full transcript goes to a log file;
   only a short `## REPORT` enters Claude's context (`STATUS / ANSWER / CHANGED / UNSURE`, under
   120 words by default), which is where the token savings come from.
4. A `PostToolUse` hook keeps it at that: after several inline file reads since the last
   `delegate` call it reminds Claude, in one line, to hand the next chunk to a worker. How hard
   Claude is pushed (Off, Light, Balanced, Max) is a dashboard setting.
5. A worker can have a **model pool**: e.g. Antigravity with Sonnet 60%, Opus 30%, Gemini 10%.
   Switch models on and off and set their shares on the dashboard's Workers page; `delegate`
   spreads runs in those ratios unless Claude passes `--model`.
6. Workers are **read-only** by default. With `--write` they may edit files, but they can never
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
| **Overview** | what is running now, a timeline of every worker's tasks, today, this month and the last 30 days of Claude cost, cache hit rate, daily cost by model, projects, setup checklist |
| **Claude usage** | 7 days to all time, per-project filter, daily cost and token charts, model, project and session tables |
| **Workers** | turn each worker on or off; set its model (loaded from the CLI or the endpoint) and role; add, edit, test and delete endpoints; per-worker stats |
| **Tasks** | running tasks with a live timer, then delegated tasks by time range (last 7 days first), searchable; open one to see the brief, the report and the full log |
| **Office** | [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) embedded: your sessions and workers as pixel characters (optional) |
| **Settings** | orchestrator (automatic, Claude Code or Codex) and one-click installation into each host; timeout; budgets; prices; office switches |

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

### Codex

To install from GitHub:

```bash
codex plugin marketplace add furkandvrc/conductor
codex plugin add conductor@conductor
```

Or use Dashboard → Settings → Orchestrator → **Install Conductor** next to Codex.

Approve the plugin's hook the first time Codex asks. From then on, Codex starts each session as
the orchestrator and can hand work to Claude Code and the other workers. Codex does not put
plugin executables on PATH, so the hook gives it the full path of `delegate`.

### Endpoints (local or hosted models)

Go to Dashboard → Workers → **Add an endpoint**. You can add as many as you like (Ollama on
another machine, LM Studio, OpenRouter…), each with its own name, URL (with or without `/v1`),
API key or Cloudflare Access token, model and role. **Load models** reads the endpoint's
`/v1/models`; you can also type any model id. **Test connection** tells a Cloudflare block apart
from an auth error.

Secrets are stored in `~/.config/conductor/endpoints.json` with mode 600 and are never sent back
to the browser.

### Custom CLIs

Add any headless CLI to `~/.config/conductor/workers.json`. `{prompt}`, `{model}` and `{dir}` are
substituted per argument, never through a shell. When no model is set, the `{model}` argument and
the flag before it are dropped.

```json
{ "custom": [ { "id": "aider", "label": "Aider", "cmd": "aider",
    "args": ["--message", "{prompt}", "--model", "{model}"],
    "readArgs": ["--dry-run"], "writeArgs": ["--yes-always", "--no-auto-commits"],
    "goodAt": "small, precise edits" } ] }
```

## Commands

| Command | Purpose |
|---|---|
| `delegate <worker> [--write] [--model M] [--timeout S] [--dir D] "<task>"` | run a worker; stdin is appended as context |
| `delegate status` | every known worker: enabled, installed, configured |
| `delegate list [--for claude\|codex]` | usable workers and their roles, excluding the given host |
| `delegate models <worker>` | models a worker offers |
| `gen-image "<prompt>" out.png [--transparent] [--variants N]` | generate an image into the project via Antigravity |
| `conductor-panel [open\|start\|stop\|restart\|status]` | control the dashboard |
| `conductor-panel office [start\|stop\|status]` | control Pixel Agents on port 4748 |
| `claude-account add\|login\|list\|status\|use\|remove [name]` | rotate between Claude accounts when one hits its limit (see below) |

The plugin puts these commands on Claude's PATH. To use them in your own shell, link them, for
example: `ln -s "$PWD/bin/"* ~/.local/bin/`.

## Claude accounts

If you have more than one Claude subscription, Conductor can move Claude Code to the next one
when the active account reaches its 5-hour or weekly limit.

```bash
claude-account add main          # save the account Claude Code is signed in with now
claude-account login second      # sign another account in (browser); the current one stays
claude-account status            # usage of every account, which one is active
claude-account use second        # switch by hand
```

After that it is automatic: every few minutes (`CONDUCTOR_ACCOUNT_POLL`, default 300 s) a hook
on your prompts and the dashboard server in the background read each account's usage, and switch
before the active one runs out; a rate-limit error switches at once. Reading usage costs no
tokens. As soon as the main account (the first one saved; `claude-account primary <name>` to
change it) has room again, it switches back to it, also when its 5-hour or weekly window resets
earlier than announced: conductor refreshes an idle account's sign-in when it expires so its
usage stays current (`CONDUCTOR_ACCOUNT_REFRESH=0` turns that off).

Work that a limit stopped carries on by itself after the switch. A Claude Code session whose turn
stopped on the limit is woken with "continue where you left off" once the account has been
switched (once per session per 10 minutes, so it cannot loop; `CONDUCTOR_ACCOUNT_RESUME=0` turns
it off). A `delegate claude` run that stopped on the limit is run once more on the new account,
told to check what the first run already did. A desktop notification tells you. Only the Claude sign-in changes: MCP server sign-ins, settings, plugins,
history and memory stay the same. New sessions and `delegate` runs use the new account straight
away; a session that was already running picks it up at its next token refresh, or with `/exit`
and `claude --continue`. Saved sign-ins live in the macOS Keychain (elsewhere in
`~/.claude/conductor/accounts/`, mode 600). Turn it off with `CONDUCTOR_ACCOUNTS=0`.

## Configuration

Everything can be set from the dashboard. These are the underlying files:

| Path | Contents |
|---|---|
| `~/.config/conductor/conductor.env` | `CONDUCTOR_ORCHESTRATOR` (auto, claude, codex…), `CONDUCTOR_DELEGATION` (off, light, balanced, max), `CONDUCTOR_REPORT` (brief, full), `CONDUCTOR_TIMEOUT`, `CONDUCTOR_MAX_LINES`, `CONDUCTOR_PIXEL`, `CONDUCTOR_PANEL_AUTOSTART`, `CONDUCTOR_OFFICE_AUTOSTART`, `CONDUCTOR_OFFICE_HIDE`, `CONDUCTOR_BUDGET_DAILY` / `_MONTHLY`, `CONDUCTOR_ACCOUNTS`, `CONDUCTOR_ACCOUNT_THRESHOLD`, `CONDUCTOR_ACCOUNT_RETURN`, `CONDUCTOR_ACCOUNT_POLL`, `CONDUCTOR_ACCOUNT_REFRESH`, `CONDUCTOR_ACCOUNT_RESUME` |
| `~/.config/conductor/workers.json` | per-worker `enabled` / `model` / `goodAt` / `pool` (`[{ model, weight }]`), plus `custom` CLI definitions |
| `~/.config/conductor/endpoints.json` | OpenAI-compatible endpoints with their secrets (mode 600); a 0.2 `local.env` is migrated automatically |
| `~/.config/conductor/pricing.json` | price overrides per model |
| `~/.claude/conductor/` | `logs/`, `runs.jsonl` (one record per task), `usage-index.json`, server logs |

Environment variables: `CONDUCTOR_PANEL_PORT` (4747), `CONDUCTOR_OFFICE_PORT` (4748), and
`CONDUCTOR_PIXEL_CONFIG=0` to stop Conductor from enabling Pixel Agents' "Watch All Sessions".

## Office (optional)

With `pixel-agents` installed, opening the Office page starts it and seats every available worker
at a desk. Each `delegate` run makes that character work; it returns to idle afterwards.

Conductor makes three changes to Pixel Agents:

- It enables `watchAllSessions` in `~/.pixel-agents/config.json`, because workers are external
  sessions.
- It patches the UI so characters are labelled by name (Claude, Gemini, Cursor, Codex, …) instead
  of routine status text. Statuses that need you, "Needs approval" and "Waiting for input", still
  show under the name, and the label moves above a character's speech bubble so both are visible.
- It maps every worker to an office **area** named `Workers`, or `CONDUCTOR_OFFICE_AREA`. Paint
  that area in the layout editor (Layout → Areas) around some desks; workers then sit there,
  while Claude sessions prefer seats outside any area.
- It raises Pixel Agents' request size limit from 64 KB to 16 MB, so large tool calls are not
  dropped.
- It hides background sessions that are not your work. By default these are claude-mem's observer
  sessions; choose the folders with `CONDUCTOR_OFFICE_HIDE` in `conductor.env` (comma-separated,
  or `none`).

The patch is rebuilt from the pristine bundle at every office start, so it survives
`npm update -g pixel-agents`.

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

Conductor, Claude Code ve Codex için bir plugin. Konuştuğun ajan (Claude Code ya da Codex)
yönetici olarak kalır. Çok dosya okuma, toplu düzenleme, ikinci görüş ve commit mesajı gibi
hacimli işler diğer ajanlara gider: Claude Code, Codex, Antigravity, Cursor, Copilot, OpenCode,
Qwen, özel CLI'lar ve istediğin kadar OpenAI uyumlu uç nokta (Ollama, LM Studio, OpenRouter…).
Yönetici kendine iş vermez; Codex'e kurulduğunda altında Claude Code çalışır.

Kurulumdan sonra `/conductor:setup` çalıştır. Dashboard'u açmak için `conductor-panel open`
yaz. Dashboard Türkçe ve İngilizce; Claude maliyetini, devredilen görevleri, worker'ları, ayarları
ve piksel ofisi gösterir.

Birden fazla Claude aboneliğin varsa: `claude-account add main` mevcut hesabı kaydeder,
`claude-account login second` diğer hesaba mevcut oturumu bozmadan giriş yapar. Aktif hesap 5 saatlik
ya da haftalık limite gelince Conductor Claude Code'u sıradaki hesaba geçirir; MCP girişleri ve
ayarlar değişmez. Yeni oturumlar yeni hesabı hemen kullanır; açık oturum bir sonraki token
yenilemesinde ya da `/exit` + `claude --continue` ile geçer.
