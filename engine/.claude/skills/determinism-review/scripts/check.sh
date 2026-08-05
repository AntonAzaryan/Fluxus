#!/usr/bin/env bash
# Механическая часть ревью ядра: запрещённые источники недетерминизма,
# strip-only ограничения и ноль runtime-зависимостей. Находка = место, куда
# посмотреть глазами; контекст решает (см. SKILL.md).
set -u
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"   # engine/
SRC="$ROOT/core-ts/src"
fail=0

report() { # $1 — заголовок, $2 — вывод grep
  if [ -n "$2" ]; then
    echo "== $1"
    echo "$2"
    echo
    fail=1
  fi
}

report "Недетерминированные источники (DET-2, TICK-3)" \
  "$(grep -rnE 'Math\.random|Date\.now|new Date\(|performance\.now|process\.hrtime|crypto\.' "$SRC" || true)"

report "Дробные литералы вне math/ (подозрение на float-математику)" \
  "$(grep -rnE '[^A-Za-z0-9_."][0-9]+\.[0-9]+' "$SRC" --include='*.ts' | grep -v "^$SRC/math/" | grep -vE ':[0-9]+:\s*(\*|//|/\*)|Q16\.16|[0-9]+\.[0-9]+\.[0-9]+' || true)"

report "Strip-only: parameter properties / enum / namespace (валят bin/sim.mjs)" \
  "$(grep -rnE 'constructor\s*\(\s*(private|public|protected|readonly)\b|^\s*(export\s+)?(const\s+)?enum\s|^\s*(export\s+)?namespace\s' "$SRC" || true)"

deps="$(node -e "const d=require('$ROOT/core-ts/package.json').dependencies; if (d && Object.keys(d).length) console.log(Object.keys(d).join('\n'))")"
report "Runtime-зависимости в core-ts (должно быть ноль)" "$deps"

if [ "$fail" -eq 0 ]; then
  echo "OK: механические проверки чисты. Чеклист по диффу — вручную (SKILL.md)."
else
  echo "Есть находки — каждую оценить по чеклисту SKILL.md."
fi
exit "$fail"
