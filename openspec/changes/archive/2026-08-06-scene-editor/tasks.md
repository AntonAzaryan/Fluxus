# Tasks: scene-editor

Кода изменение не касается: у capability `editor` нет реализации под `engine/`. Вся работа — спека, стабы очереди и документы.

## 1. Спека `editor`

- [x] 1.1 Дельта `specs/editor/spec.md` этого change'а: `ADDED` ED-13..ED-19 (вьюпорт, расстановка, выделение, undo/redo, таксономия unit/prop/decoration, просмотрщик ассетов, round-trip), `MODIFIED` ED-9 (встроенный runner MAY → SHALL, реализация — `client-shell`, явное разделение режимов правки и превью)
- [x] 1.2 `openspec validate --strict` для change'а и спек: дельта разбирается, у каждого требования есть сценарий

## 2. Стабы очереди prerequisite-задач

- [x] 2.1 Change `terrain-texturing`: `proposal.md` с `## Notes` — tileset + splatmap по образцу пары ASSET-7 + ED-11 (формат presentation-ассета, подсистема рендера, кисть заливки в `editor`); артефакты specs/design/tasks пустые намеренно
- [x] 2.2 Change `viewport-services`: `proposal.md` с `## Notes` — picking, подсветка выделения, gizmo и overlay-сервисы `rendering` для вьюпорта (ED-15); артефакты пустые намеренно
- [x] 2.3 Change `presentation-scene-layer`: `proposal.md` с `## Notes` — формат парного presentation-документа сцены (decorations, ED-17), связь с манифестом визуалов; артефакты пустые намеренно

## 3. Документы

- [x] 3.1 `docs/architecture.md` §2, таблица capability: строка `editor` — диапазон ID `ED-1..19`
- [x] 3.2 `docs/architecture.md` §5, roadmap, этап 12: спека редактора сцен готова этим change'ем; реализация — последующие change'и, блокеры записаны стабами (2.1–2.3)
- [x] 3.3 Нормативных формулировок в `docs/` не появляется: обзор описывает, спека требует

## 4. Проверка

- [x] 4.1 `openspec list` показывает четыре change'а: `scene-editor` с полными артефактами и три стаба со статусом no-tasks
- [x] 4.2 `git diff --stat` подтверждает: тронуты только `openspec/` и `docs/`; ни одного файла под `engine/` и `content/`
- [x] 4.3 `npm run typecheck` и `npm test` из корня — зелёные (изменение кода не касается, прогон подтверждает это)
