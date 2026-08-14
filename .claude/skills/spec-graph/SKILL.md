---
name: spec-graph
description: Navigate the Fluxus spec tree lazily and query its reference graph — find a requirement by text, show a single requirement section instead of a whole capability, trace who cites whom (refs/impact), look up where a requirement ID is cited in code (code), view the capability dependency graph, and lint the graph including dangling IDs in code. Use whenever the user asks to find a requirement, quote a requirement ID, see what depends on a requirement, find the code or tests behind a requirement, show the spec dependency graph, or check spec cross-references — and before editing any requirement, to see its blast radius.
compatibility: run from the repository root; Node >= 22.18
---

# Навигация по графу спек

Инструмент: `npm run spec-graph -- <cmd>` (или `node scripts/spec-graph.mjs <cmd>`), stateless — парсит `openspec/specs/` при каждом вызове. На любой команде работает `--json`.

**Ограничение:** видны только main specs. Дельта-спеки активных changes (`openspec/changes/`) не парсятся — до архивации граф показывает состояние «до».

## Команды

```sh
npm run spec-graph -- find "фильтрация"   # поиск → только ID и заголовки
npm run spec-graph -- where NET-12        # capability, файл:строка
npm run spec-graph -- show NET-12         # одна секция + Purpose (не вся спека)
npm run spec-graph -- show NET-12 --capability   # вся спека, если секции мало
npm run spec-graph -- refs NET-12         # кого цитирует / кто цитирует
npm run spec-graph -- impact ECS-3        # транзитивно: кто устареет от правки + цитаты ID в коде
npm run spec-graph -- code TICK-1         # где ID цитируется в коде: src / test / generated
npm run spec-graph -- code                # счётчики цитат по всем требованиям (вход spec-coverage)
npm run spec-graph -- deps netcode        # рёбра capability-уровня
npm run spec-graph -- graph --mermaid     # весь граф с группировкой по слоям
npm run spec-graph -- check               # линт графа (exit 1 при находках; входит в npm run check)
npm run spec-graph -- check --metrics     # диагностика: fan-in, instability, сироты, рёбра «вверх»
```

## Рабочий цикл агента

1. Точка входа — `find` (ID ещё не известен) или сразу `show <ID>`.
2. Контур задачи раскрывается через `refs` — догружай `show` только тех, кто реально в контуре.
3. Capability, которую **правишь**, читай целиком (`openspec spec show <name>`); лениво грузятся чужие.
4. Перед правкой требования — `impact <ID>`: список зависимых, которые могли устареть, проверь их после правки; кодовая часть вывода — файлы, цитирующие ID, их комментарии и тесты тоже могли устареть.
5. От требования к коду — `code <ID>`. Цитата ID — «где упоминается», НЕ «где реализовано»: отсутствие цитат не значит, что реализации нет (карта модулей — CLAUDE.md).

## Линт

`check` — инварианты: висячие ссылки (известный префикс, несуществующий номер), то же для цитат в коде (`dangling-code` — требование удалили/переименовали, а код не догнал), дубли ID, неверная атрибуция capability рядом со ссылкой, требование без SHALL/MUST, ссылка механизма на game-content, capability вне конфига слоёв (`scripts/spec-graph.layers.json`).

Направление ссылок между слоями — не инвариант (ссылки «вверх» — принятая конвенция прозы), оно видно в `check --metrics`. Находки `check` правятся отдельным change через OpenSpec-workflow, не по месту.
