#!/bin/bash
# SessionStart hook: готовит окружение Claude Code on the web —
# ставит OpenSpec CLI и зависимости engine/core-ts.
set -euo pipefail

# Только для удалённых сессий (claude.ai/code); локально ничего не трогаем.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

OPENSPEC_PKG="@fission-ai/openspec@^1.7.0"

# 1. OpenSpec CLI — глобально, чтобы `openspec ...` работал из любой директории.
if command -v openspec >/dev/null 2>&1; then
  echo "openspec уже установлен: $(openspec --version 2>/dev/null || echo unknown)"
else
  echo "Устанавливаю OpenSpec CLI ($OPENSPEC_PKG)..."
  npm install -g --no-fund --no-audit "$OPENSPEC_PKG"
  echo "openspec $(openspec --version 2>/dev/null || echo '(версия не определена)')"
fi

# Телеметрия OpenSpec — выключена на всю сессию.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export OPENSPEC_TELEMETRY=0' >> "$CLAUDE_ENV_FILE"
fi
export OPENSPEC_TELEMETRY=0

# 2. TypeScript LSP — нужен плагину typescript-lsp@claude-plugins-official
#    (см. enabledPlugins в .claude/settings.json): go-to-definition, find references,
#    диагностика типов без полного tsc.
if command -v typescript-language-server >/dev/null 2>&1; then
  echo "typescript-language-server уже установлен: $(typescript-language-server --version 2>/dev/null || echo unknown)"
else
  echo "Устанавливаю typescript-language-server + typescript (глобально, для LSP-плагина)..."
  npm install -g --no-fund --no-audit typescript-language-server typescript
  echo "typescript-language-server $(typescript-language-server --version 2>/dev/null || echo '(версия не определена)')"
fi

# 3. Зависимости реализации ядра (vitest, typescript) — чтобы тесты и typecheck шли сразу.
if [ -f "$REPO_ROOT/engine/core-ts/package.json" ]; then
  echo "Ставлю зависимости engine/core-ts..."
  npm install --prefix "$REPO_ROOT/engine/core-ts" --no-fund --no-audit
fi

# 4. Санити-чек: спеки читаются.
if [ -d "$REPO_ROOT/engine/openspec" ]; then
  ( cd "$REPO_ROOT/engine" && openspec list --specs >/dev/null && echo "OpenSpec видит спеки в engine/openspec ✓" )
fi

echo "Окружение готово."
