#!/usr/bin/env bash
# Syntax checks, unit tests and plugin validation. Needs bash, node >= 18, python3.
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0
step() { printf '%-46s' "$1"; shift; if out="$("$@" 2>&1)"; then echo ok; else echo FAIL; echo "$out" | tail -20; fail=1; fi; }

for f in bin/delegate bin/gen-image bin/conductor-panel scripts/*.sh; do step "bash -n $f" bash -n "$f"; done
for f in dashboard/server.js dashboard/app.js dashboard/i18n.js dashboard/lib/*.js lib/*.js; do step "node --check $f" node --check "$f"; done
for f in scripts/*.py; do step "python3 compile $f" python3 -I -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$f"; done
for f in .claude-plugin/*.json .codex-plugin/*.json hooks/hooks.json package.json; do step "json $f" python3 -I -m json.tool "$f"; done
step "i18n: en/tr have the same keys" node -e '
  const src = require("fs").readFileSync("dashboard/i18n.js", "utf8");
  const I18N = new Function("localStorage", "navigator", "location", src + "; return I18N;")({ getItem: () => null }, { language: "en" }, {});
  const en = Object.keys(I18N.en), tr = Object.keys(I18N.tr);
  const miss = en.filter(k => !tr.includes(k)).concat(tr.filter(k => !en.includes(k)));
  if (miss.length) { console.error(miss.join("\n")); process.exit(1); }'
step "unit tests" node --test tests/*.test.js
step "delegate status runs" bin/delegate status
if command -v claude >/dev/null 2>&1; then step "claude plugin validate" claude plugin validate .; fi
[ $fail -eq 0 ] && echo "selftest: all good" || { echo "selftest: failures above"; exit 1; }
