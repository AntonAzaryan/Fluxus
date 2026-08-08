# Tasks: retarget-editor-to-web-desktop

Кода изменение не касается: у capability `editor` нет реализации под `engine/`, этап 12 roadmap отложен. Вся работа — спека и документы, называющие старый стек.

## 1. Спека `editor`

- [x] 1.1 Дельта `specs/editor/spec.md` этого change'а: `RENAMED` ED-1 (`Kotlin + Compose Multiplatform` → `Редактор на стеке движка`), `MODIFIED` ED-1 (TypeScript поверх пакетов движка; вьюпорт — реализация `rendering`; запрет второй реализации правил ядра), `ADDED` ED-12 (веб и десктоп из одной кодовой базы, паритет возможностей, интерфейс хоста среды)
- [x] 1.2 `## Purpose` в `openspec/specs/editor/spec.md` правится напрямую (дельта его не переносит): убрать «на Compose Multiplatform», оставить суть — визуальный редактор поверх data-driven ядра, единственный выход — валидные JSON
- [x] 1.3 `openspec validate --strict` для change'а и для спек: дельта разбирается, у каждого требования есть сценарий

## 2. Контекст проекта

- [x] 2.1 `openspec/config.yaml`, блок `context`: строка стека перестаёт называть редактор Kotlin + Compose Multiplatform — редактор на TypeScript поверх пакетов движка, запускается в вебе и на десктопе
- [x] 2.2 `CLAUDE.md`: пометка «`editor` (Kotlin + Compose, roadmap stage 12)» — стек обновить, суть («capability без кода под `engine/`, capability ≠ package») сохранить

## 3. Архитектурный обзор

- [x] 3.1 `docs/architecture.md` §1, схема слоёв: верхний блок «Редактор (Compose Multiplatform)» — без Compose
- [x] 3.2 `docs/architecture.md` §2, таблица capability: строка `editor` — описание без Compose, диапазон ID `ED-1..12` вместо устаревшего `ED-1..10`
- [x] 3.3 `docs/architecture.md` §5, roadmap, этап 12: «Editor MVP (Compose)» → без Compose; статус «⏸ Отложен» сохранить, добавить, что стек переустановлен этим change'ом (веб + десктоп поверх `render-ts` и `client-ts`)
- [x] 3.4 Нормативных формулировок в `docs/` не появляется: обзор описывает, спека требует

## 4. Проверка

- [x] 4.1 `grep -ri "kotlin\|compose"` по репозиторию вне `openspec/changes/archive/` и `node_modules/` даёт единственное совпадение — намеренную строку в ED-1, закрывающую вопрос («Kotlin и Compose Multiplatform из требований к редактору исключены»)
- [x] 4.2 `git diff --stat` подтверждает: тронуты только `openspec/`, `docs/`, `CLAUDE.md`; ни одного файла под `engine/` и `content/`
- [x] 4.3 `npm run typecheck` и `npm test` из корня — зелёные (изменение кода не касается, прогон подтверждает это)
