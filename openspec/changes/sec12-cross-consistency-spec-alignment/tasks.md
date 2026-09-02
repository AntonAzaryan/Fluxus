# Tasks: sec12-cross-consistency-spec-alignment

Требования — `specs/rendering/spec.md` (**REND-29**, **REND-32**, **REND-33**, **REND-34**), `specs/determinism-core/spec.md` (**DI-4**), `specs/editor/spec.md` (**ED-9**), `specs/desktop-shell/spec.md` (**DSK-1**); разбор решений — design.md (D1–D7). Гейт локальный: `npm run check` из корня (CI нет).

Изменение заводится по факту сделанной работы: валидация спек (`docs/reviews/spec-validation-2026-09-01/12-cross-consistency.md`) назвала три расхождения между документами, которые чинятся текстом спек; следом за одной из правок переехали комментарии в коде, повторявшие ту же ссылку (раздел 5). Исполняемого кода правка не меняет ни строкой.

## 1. Ссылка «кадр одинаков у всех потребителей» (D1, D2)

- [x] 1.1 `specs/rendering/spec.md`: MODIFIED REND-29 — «тождество кадров (`editor` ED-1)» вместо ED-22. Блок MODIFIED несёт требование ЦЕЛИКОМ со всеми действующими сценариями: MODIFIED заменяет блок, и опущенный сценарий архивация молча выкинула бы.
- [x] 1.2 Там же: MODIFIED REND-32 — «в любом потребителе подсистемы по построению (`editor` ED-1)».
- [x] 1.3 Там же: MODIFIED REND-33 — «получают один свет по построению (`editor` ED-1)».
- [x] 1.4 Там же: MODIFIED REND-34 — «одинаково во всех потребителях рендера (`editor` ED-1)».
- [x] 1.5 Проверено, что ссылки на ED-22 в REND-16 (цвет кадра и служебные наложения) остались нетронутыми: там ED-22 назван по делу (D2).

## 2. Обоснование DI-4 (D3, D4)

- [x] 2.1 `specs/determinism-core/spec.md`: MODIFIED DI-4 — первый абзац называет настоящее основание необязательности навигации со ссылкой на `npc-behavior` NPC-6 и перечисляет факты, которых прежнее обоснование не знало (NPC-1, таблица DET-9, раздел `npc` конфига сцены — `serialization` SER-7). Норма опциональности и второй абзац не двинуты.
- [x] 2.2 Там же: сценарий «Сцена с крипами» распался на «Сцена с крипами без навигации» и «Система, объявившая навигацию обязательной» (D4); сценарий «Тик без навигации» сохранён дословно.

## 3. Диапазоны номеров (D5)

- [x] 3.1 `specs/editor/spec.md`: MODIFIED ED-9 — `client-shell` SHELL-1 вместо `SHELL-1..8`.
- [x] 3.2 `specs/desktop-shell/spec.md`: MODIFIED DSK-1 — имя capability в перечне контрактов и тройка SHELL-1, SHELL-3, SHELL-8 в сценарии «Игровой клиент на десктопе».
- [x] 3.3 `openspec/specs/client-shell/spec.md`, раздел `## Purpose`: `rendering` REND-1 вместо `REND-1..8`. Правка названа в `## Notes` дельты `desktop-shell`.
- [x] 3.4 `openspec/specs/netcode-transport/spec.md`, раздел `## Purpose`: `netcode` без диапазона вместо `NET-1..17`. Правка названа там же.

## 4. Синхронизация и гейт

- [x] 4.1 Перенести дельты в `openspec/specs/{rendering,determinism-core,editor,desktop-shell}/spec.md` побайтово по требованию. Изменение при этом НЕ архивируется: оно остаётся в очереди как запись о принятом решении.
- [x] 4.2 Из корня: `npx openspec validate --specs --strict`, `npx openspec validate --changes --strict`, `npm run spec-graph -- check`.
- [x] 4.3 Из корня: `npm run typecheck`, `npm run lint`, `npm run lint:dead`. Целевые прогоны тестов — в разделе 5: правка в коде комментарная, но файлы затронуты.

## 5. Комментарии в коде, повторявшие ту же ссылку

Ссылка «кадр один у всех потребителей» жила и в коде: `spec-graph code <ID>` — штатный способ дойти от требования до кода, и после правки спеки код указывал бы на ED-22 там, где норма переехала на ED-1.

- [x] 5.1 `engine/render-ts`: `src/index.ts` (экспорт подсистемы освещения), `src/subsystems/lighting.ts` (шапка), `src/subsystems/postprocess.ts` (заголовок раздела и комментарий `render`), `src/subsystems/models.ts` и `src/types.ts` (порт `LightingSink`) — ED-22 → `editor` ED-1.
- [x] 5.2 `engine/integration-ts/test/sceneLighting.test.ts`: шапка, имя `describe` и комментарий о порте — ED-22 → `editor` ED-1.
- [x] 5.3 НЕ тронуты ссылки на ED-22, ведущие по делу: `src/subsystems/overlays.ts` и `test/overlays.test.ts` (наложения не красят кадр — норма ED-22), `editor/core-ts` (состояния валидации), `engine/hud-ts/src/dom/node.ts` (инлайн-стиль у редактора).
- [x] 5.4 Целевые прогоны: `npx vitest run --exclude '**/bench.test.ts'` в `engine/render-ts` (43 файла, 965 тестов) и `npx vitest run test/sceneLighting.test.ts` в `engine/integration-ts` — зелено.
