# spec-ref-attribution

## Why

Первый прогон линта `spec-graph check` (change `spec-graph-tool`) нашёл два дефекта атрибуции перекрёстных ссылок, пропущенных ручной сплошной сверкой в `spec-modality-and-refs`: имя capability в бэктиках рядом с ID называет не тот дом, где требование определено. Читатель уходит в чужую спеку — тот же класс дефекта, что уже исправленные RNG-8 и TERR-4. `openspec validate --specs --strict` этого не видит; после правки `spec-graph check` становится зелёным, что открывает шаг 4 порядка ввода гейта (архив `spec-graph-tool`, design D7): включение линта в `npm run check`.

## What Changes

- `ARENA-5`: ссылка на DI-3 называет `determinism-core`, а не `ecs-foundation` — DI-принцип сборки без Physics API определён в determinism-core.
- `LOC-1`: ссылка на SYS-4 называет `data-driven-systems`, а не `ecs-foundation` — общий контракт `System` определён в data-driven-systems.

Текст требований не меняется ни в чём, кроме имени capability в двух ссылках; ID, сценарии и модальность нетронуты.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `arena`: ARENA-5 — имя capability в ссылке на DI-3.
- `locomotion`: LOC-1 — имя capability в ссылке на SYS-4.

## Impact

- Только текст двух главных спек; `engine/`, `content/`, `docs/`, эталоны и схемы не затрагиваются — реализация ссылками между спеками не связана.
- После архива `spec-graph check` по дереву зелёный — это условие включения его в корневой `npm run check` (отдельный коммит вне этого change, по D7 архива `spec-graph-tool`).
