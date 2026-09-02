---
name: spec-coverage
description: Build a requirement-to-implementation coverage report for the Fluxus engine — map OpenSpec requirement IDs (DET-1, NET-15, FOW-4, …) to the code and tests that implement them. Use whenever the user asks how well the implementation matches the spec, which requirements are untested or unimplemented, to refresh a spec-compliance/spec-alignment report, or before large refactors to know what is pinned down.
compatibility: openspec CLI, run from the repository root
---

# Отчёт покрытия спеки реализацией

Задача: свежая карта «требование → код → тест» по всем capability из `openspec/specs/` (список и счётчики — `openspec list --specs`, сейчас порядка сорока capability и пятисот требований; число в скилл не зашивай). Отчёт пиши по-русски и датируй в имени файла.

## Сбор данных

1. Список требований: `openspec list --specs` из корня репозитория, затем по каждой capability — `openspec spec show <name>` (ID лежат в заголовках `### Requirement:`).
2. Упоминания ID в реализации и тестах — ID цитируются в комментариях и именах тестов, это рабочая конвенция репы. Индекс отдаёт spec-graph (не грепай вручную — логика извлечения одна):
   ```sh
   npm run spec-graph -- code --json   # счётчики src/test/generated по каждому требованию
   npm run spec-graph -- code NET-15   # конкретные файлы:строки по одному ID
   ```
   `src` — реализация, `test` — проверка, `generated` — схемы из `engine/schemas/` (в покрытие не считаются).
3. Валидация формата спек заодно: `openspec validate --specs --strict` и `npm run spec-graph -- check` (висячие ID в коде — `dangling-code` — это тоже находка покрытия: код цитирует требование, которого нет).
4. Дельта-спеки активных changes (`openspec list`) в индекс не входят — требования, которые ещё в `changes/`, в отчёте отдельной строкой «в работе», не как пробел.

## Классификация каждого требования

- ✅ реализовано и проверено (есть и код, и тест);
- 🟡 реализовано, теста нет (или тест только косвенный — golden без адресного assert'а);
- ⏸ осознанно отложено (сверься с roadmap в `docs/architecture.md` §5 — «Будущее» этапы и открытые вопросы §6);
- ❌ расхождение: код противоречит требованию — по CORE-3 это дефект **реализации**, фиксируй как баг, не как «спека устарела».

Отсутствие упоминания ID в коде ≠ нереализовано: проверь подозрительные ID чтением соответствующего модуля (карта модулей — CLAUDE.md, «core-ts layout»), прежде чем записать в пробелы.

## Отчёт

Пиши в `docs/reviews/<YYYY-MM-DD>-spec-coverage.md` — так лежат все отчёты репозитория (образец формы и шапки: `docs/reviews/2026-08-08-editor-coverage.md` — «ненормативный документ», ссылка на норму, дата). Содержание: сводная таблица по capability (счётчики по четырём статусам), затем секции только по 🟡/⏸/❌ с конкретикой (ID, файл, что именно не покрыто). ✅-требования в детали не разворачивай — отчёт про пробелы, а не про инвентарь. Нормативный текст требований в отчёт не копируй — только ID и краткую суть своими словами (нормативные формулировки живут только в спеках).
