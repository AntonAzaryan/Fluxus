---
name: spec-coverage
description: Build a requirement-to-implementation coverage report for the Fluxus engine — map OpenSpec requirement IDs (DET-1, NET-15, FOW-4, …) to the code and tests that implement them. Use whenever the user asks how well the implementation matches the spec, which requirements are untested or unimplemented, to refresh a spec-compliance/spec-alignment report, or before large refactors to know what is pinned down.
compatibility: openspec CLI, run from engine/
---

# Отчёт покрытия спеки реализацией

Задача: свежая карта «требование → код → тест» по 19 capability из `engine/openspec/specs/`. Прошлые отчёты — `engine/docs/spec-compliance-*.md`, `spec-alignment-*.md`: держи их формат и язык (русский), новый отчёт датируй в имени файла.

## Сбор данных

1. Список требований: `openspec list --specs` из `engine/`, затем по каждой capability — `openspec spec show <name>` (ID лежат в заголовках `### Requirement:`).
2. Упоминания ID в реализации и тестах — ID цитируются в комментариях и именах тестов, это рабочая конвенция репы:
   ```sh
   grep -rnoE '\b[A-Z]{2,6}-[0-9]+\b' engine/core-ts/src engine/net-ts/src engine/integration-ts \
     engine/assets-ts engine/render-ts --include='*.ts' | sort | uniq
   ```
   Разделяй вхождения в `src/` (реализация) и в `test/` (проверка).
3. Валидация формата спек заодно: `openspec validate --specs --strict`.

## Классификация каждого требования

- ✅ реализовано и проверено (есть и код, и тест);
- 🟡 реализовано, теста нет (или тест только косвенный — golden без адресного assert'а);
- ⏸ осознанно отложено (сверься с roadmap в `engine/docs/architecture.md` §5 — «Будущее» этапы и открытые вопросы §6);
- ❌ расхождение: код противоречит требованию — по CORE-3 это дефект **реализации**, фиксируй как баг, не как «спека устарела».

Отсутствие упоминания ID в коде ≠ нереализовано: проверь подозрительные ID чтением соответствующего модуля (карта модулей — CLAUDE.md, «core-ts layout»), прежде чем записать в пробелы.

## Отчёт

Пиши в `engine/docs/spec-coverage-<YYYY-MM-DD>.md`: сводная таблица по capability (счётчики по четырём статусам), затем секции только по 🟡/⏸/❌ с конкретикой (ID, файл, что именно не покрыто). ✅-требования в детали не разворачивай — отчёт про пробелы, а не про инвентарь. Нормативный текст требований в отчёт не копируй — только ID и краткую суть своими словами (нормативные формулировки живут только в спеках).
