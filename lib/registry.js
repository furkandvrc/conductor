'use strict';
// Built-in worker adapters. Each adapter turns a task into a command line for one headless agent CLI.
// `build()` must stay side-effect free: it is unit-tested and also used to show commands in the dashboard.
//
//   build({ prompt, model, write, dir, timeout, outFile }) → { cmd, args, stdin?, outFile?, env? }
//     stdin    the prompt is piped instead of passed as an argument
//     outFile  the CLI writes its final answer there (read instead of stdout)
//
// Shared rules for every worker: read-only unless `write`, never commit or push.

const NO_SHELL = 'Shell/terminal commands are NOT available in this session (they will be denied): use only your built-in file view, list, search and edit tools. Do not try to run, compile or test anything.\n';

const ADAPTERS = [
  {
    id: 'gemini', label: 'Gemini', aliases: ['agy', 'antigravity'], cli: 'agy', host: 'antigravity',
    via: 'Antigravity CLI (agy)', install: 'https://antigravity.google — then run `agy` once to sign in',
    goodAt: 'reading and analysing large codebases, explaining modules, long logs and docs',
    defaultModel: 'claude-sonnet-5-5-medium',
    listModels: { args: ['models'], re: /^([a-z0-9][\w.-]+)\s/i },
    notes: 'cannot run shell commands headless; give it reading, analysis and editing tasks',
    build({ prompt, model, write, dir, timeout }) {
      const args = ['--print-timeout', `${timeout}s`, '--add-dir', dir];
      if (model) args.unshift('--model', model);
      if (write) args.push('--mode', 'accept-edits');
      return { cmd: 'agy', args: [...args, '-p', NO_SHELL + prompt] };
    },
  },
  {
    id: 'cursor', label: 'Cursor', aliases: ['cursor-agent'], cli: 'cursor-agent', host: 'cursor',
    via: 'Cursor Agent CLI', install: 'curl https://cursor.com/install -fsS | bash — then `cursor-agent login`',
    goodAt: 'well-specified edits: boilerplate, refactors across files, tests from a spec',
    defaultModel: 'composer-2.5',
    listModels: { args: ['--list-models'], re: /^([a-z0-9][\w.-]+)\s+-\s/i },
    build({ prompt, model, write }) {
      const args = ['-p', prompt, '--output-format', 'text', '--trust'];
      if (model) args.push('--model', model);
      if (!write) args.push('--mode', 'ask');
      return { cmd: 'cursor-agent', args };
    },
  },
  {
    id: 'copilot', label: 'Copilot', aliases: [], cli: 'copilot', host: 'copilot',
    via: 'GitHub Copilot CLI', install: 'npm install -g @github/copilot — then `copilot` and /login',
    goodAt: 'independent code review and second opinions, GitHub and Actions questions',
    defaultModel: 'auto',
    build({ prompt, model, write }) {
      const args = ['-p', prompt, '-s', '--no-ask-user', '--deny-tool', 'shell(git push)', '--deny-tool', 'shell(git commit)'];
      if (model) args.push('--model', model);
      args.push(write ? '--allow-tool' : '--deny-tool', 'write');
      return { cmd: 'copilot', args };
    },
  },
  {
    id: 'codex', label: 'Codex', aliases: ['openai'], cli: 'codex', host: 'codex',
    via: 'OpenAI Codex CLI', install: 'npm install -g @openai/codex — then `codex login`',
    goodAt: 'hard implementation and debugging tasks, careful multi-step edits',
    defaultModel: '',
    // the catalog the signed-in account can use (`visibility: list`)
    listModels: { args: ['debug', 'models'], parse: out => { try { const d = JSON.parse(out); return (d.models || d).filter(m => m.visibility === 'list').map(m => m.slug); } catch { return []; } } },
    build({ prompt, model, write, dir, outFile }) {
      const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', write ? 'workspace-write' : 'read-only', '-C', dir, '-o', outFile];
      if (model) args.push('-m', model);
      args.push('-');
      return { cmd: 'codex', args, stdin: prompt, outFile };
    },
  },
  {
    id: 'claude', label: 'Claude Code', aliases: ['claude-code'], cli: 'claude', host: 'claude',
    via: 'Claude Code CLI', install: 'npm install -g @anthropic-ai/claude-code — then `claude` once to sign in',
    goodAt: 'careful reasoning, reviews and edits that need judgement (uses the Claude plan)',
    defaultModel: 'sonnet',
    build({ prompt, model, write }) {
      // --safe-mode: the worker loads none of the user's hooks, plugins, skills or CLAUDE.md
      // (a lean context; the brief is all it needs) but still uses the signed-in plan
      const args = ['-p', '--safe-mode', '--output-format', 'text', '--no-session-persistence'];
      if (model) args.push('--model', model);
      if (write) args.push('--permission-mode', 'acceptEdits', '--disallowedTools', 'Bash(git commit:*)', 'Bash(git push:*)');
      else args.push('--permission-mode', 'default', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash');
      return { cmd: 'claude', args, stdin: prompt };
    },
  },
  {
    id: 'gemini-cli', label: 'Gemini CLI', aliases: [], cli: 'gemini', host: 'gemini',
    via: 'Google Gemini CLI (API key or Workspace account)', install: 'npm install -g @google/gemini-cli — set GEMINI_API_KEY',
    goodAt: 'reading large codebases with a 1M-token context',
    defaultModel: '',
    build({ prompt, model, write }) {
      const args = ['-p', prompt, '--approval-mode', write ? 'auto_edit' : 'default', '-o', 'text'];
      if (model) args.push('-m', model);
      return { cmd: 'gemini', args, env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' } };
    },
  },
  {
    id: 'opencode', label: 'OpenCode', aliases: [], cli: 'opencode', host: 'opencode',
    via: 'OpenCode CLI (any provider)', install: 'npm install -g opencode-ai — then `opencode auth login`',
    goodAt: 'edits with whichever provider/model you configure in OpenCode',
    defaultModel: '',
    build({ prompt, model, write, dir }) {
      const args = ['run', '--dir', dir];
      if (model) args.push('--model', model);
      if (!write) args.push('--agent', 'plan');
      return { cmd: 'opencode', args: [...args, prompt] };
    },
  },
  {
    id: 'qwen', label: 'Qwen', aliases: ['qwen-code'], cli: 'qwen', host: 'qwen',
    via: 'Qwen Code CLI', install: 'npm install -g @qwen-code/qwen-code',
    goodAt: 'coding tasks on Qwen models',
    defaultModel: '',
    build({ prompt, model, write }) {
      const args = ['-p', prompt, '--approval-mode', write ? 'auto-edit' : 'default', '--output-format', 'text'];
      if (model) args.push('--model', model);
      return { cmd: 'qwen', args };
    },
  },
];

// A user-defined CLI from workers.json: { id, label, cmd, args: [...], readArgs: [...], writeArgs: [...],
// promptVia: "arg" | "stdin" }. Placeholders {prompt} {model} {dir} are substituted per argument
// (never through a shell); arguments that contain {model} are dropped when no model is set.
function customAdapter(c) {
  return {
    id: c.id, label: c.label || c.id, aliases: [], cli: c.cmd, host: null, custom: true,
    via: `custom CLI (${c.cmd})`, install: '', goodAt: c.goodAt || '', defaultModel: c.model || '',
    build({ prompt, model, write, dir }) {
      const fill = a => String(a).replace(/\{prompt\}/g, prompt).replace(/\{model\}/g, model || '').replace(/\{dir\}/g, dir);
      // with no model, drop every argument containing {model} and the flag right before it
      const pick = list => {
        const out = [];
        for (const a of list || []) {
          if (!model && String(a).includes('{model}')) { if (out.length && /^-/.test(out[out.length - 1].raw)) out.pop(); continue; }
          out.push({ raw: String(a) });
        }
        return out.map(x => fill(x.raw));
      };
      const args = [...pick(c.args), ...pick(write ? c.writeArgs : c.readArgs)];
      return c.promptVia === 'stdin' ? { cmd: c.cmd, args, stdin: prompt } : { cmd: c.cmd, args };
    },
  };
}

// An OpenAI-compatible endpoint from endpoints.json.
function endpointAdapter(e) {
  return {
    id: e.id, label: e.label || e.id, aliases: [], cli: null, host: null, endpoint: true,
    via: 'OpenAI-compatible endpoint', install: '', goodAt: e.goodAt || 'text-only chores on piped input: commit messages, summaries, translation',
    defaultModel: e.model || '', url: e.url,
  };
}

const findBuiltin = id => ADAPTERS.find(a => a.id === id || a.aliases.includes(id));

module.exports = { ADAPTERS, customAdapter, endpointAdapter, findBuiltin, NO_SHELL };
