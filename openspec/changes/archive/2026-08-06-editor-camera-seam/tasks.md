# Tasks: editor-camera-seam

## 1. Спеки

- [x] 1.1 Дельта `specs/camera/spec.md`: `RENAMED` CAM-1 (убрать «клиентский» из заголовка), `MODIFIED` CAM-1 (presentation-состояние любого потребителя; применение позы — одна общая реализация в `rendering`), `ADDED` CAM-7 (конвейер без матча: nullable follow-цель, инжектируемые поверхность и границы, опциональные эффекты)
- [x] 1.2 Дельта `specs/editor/spec.md`: `ADDED` ED-13 (вьюпорт использует конвейер `camera`, своего контроллера нет, игровой кадр — тем же конфигом) и ED-14 (авторинг манифеста визуалов, включая секцию эффектов камеры ASSET-8)
- [x] 1.3 `## Purpose` в `openspec/specs/camera/spec.md` правится напрямую (дельта его не переносит): «Клиентская камера изометрической арены» → конвейер позы для потребителей presentation-слоя, игрового клиента и редактора
- [x] 1.4 `openspec validate --strict` для change'а и для спек

## 2. Код: одна точка применения позы

- [x] 2.1 Перенести `applyPose` из `engine/client-ts/demo/main.ts` в `engine/render-ts/src/camera/` как публичную функцию над `THREE.PerspectiveCamera` и `CameraPose` (CAM-1, design §1)
- [x] 2.2 Экспортировать её из `engine/render-ts/src/index.ts` рядом с остальным API камеры
- [x] 2.3 Демо `client-ts` зовёт общую функцию; локальная копия и её вспомогательный `lookTarget` удаляются
- [x] 2.4 `npm run typecheck` и `npm test` из корня — зелёные; golden-файлы не меняются (камера симуляции не касается)

## 3. Дрейф документов после merge камеры

- [x] 3.1 `docs/architecture.md` §2, таблица capability: добавить строку `camera` (CAM-1..7)
- [x] 3.2 `docs/architecture.md` §2: строка `rendering` — диапазон `REND-1..10` вместо устаревшего `REND-1..8`; строка `assets` — сверить диапазон с фактическим (ASSET-8)
- [x] 3.3 `docs/architecture.md` §1, схема слоёв: камера видна как presentation-слой рядом с рендером
- [x] 3.4 `docs/architecture.md` §5, roadmap: этап камеры отражён в таблице
- [x] 3.5 `CLAUDE.md`: «23 capabilities» → фактическое число

## 4. Проверка

- [x] 4.1 `openspec validate --specs --strict` — все capability проходят
- [x] 4.2 `git diff --stat`: тронуты `openspec/`, `docs/`, `CLAUDE.md`, `engine/render-ts`, `engine/client-ts/demo`; ядро, netcode, контент и `engine/tests/golden/` не тронуты
