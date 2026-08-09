# spec-validation-fixes

## Why

Аудит после мерджа редактора в main (отчёт `docs/reviews/2026-08-09-spec-validation.md`) нашёл 18 противоречий между нормами, 20 протухших межспековых ссылок, ~20 терминологических расхождений и 5 расхождений спека↔код/докам. Механический контур (`openspec validate --strict`, `spec-graph check`) всё это не ловит — конфликтуют содержания требований, а не форма. Часть находок уже закрывается pending-изменениями (`filter-ownership`, `entity-id-state`, `rewind-epoch`, `net-event-delivery`, `spec-terminology`, `terminology-sweep`) и здесь не трогается; остальное чинится этим change.

## What Changes

- Противоречащие пары норм приводятся к ground truth реализации (CORE-3 здесь не применим — конфликтуют два спековых текста; выбирается прочтение, которое поддерживает код и замысел): пятое состояние `Window` в locomotion (LOC-3/LOC-4, REND-4), `levelOf`/override вместо `levelAt` в FOW-5, взаимодополняющие слои подмены ввода (TICK-2/TICK-4), масочная модель вместо тега `blocksMovement` (TERR-5/PHYS-10/FOW-5), и далее по списку отчёта.
- Нормы без владельца получают владельца: **CORE-5** — ноль runtime-зависимостей ядра, **DI-6** — ядро о сети не знает; ложные цитаты (DI-3, CORE-1) перевешиваются на них.
- Протухшие ссылки перевешиваются на реальных владельцев цитируемых норм (полный список — разделы С отчёта).
- Терминология сводится к одному имени на понятие (Fly/облёт, handshake, кадр/фрейм, знак/иконка и пр.).
- Харнесс и доки догоняют дерево спек: исключения `spec-graph.layers.json`, карта §2 `docs/architecture.md`, пункт о Command Buffer в CLAUDE.md.
- Код редактора приводится к ED-16/PRES-5: парный presentation-документ возникает при первой decoration-правке (PRES-1 запрещает документ «ради пустого слоя», а не документ ради правки).
- Швы трёх сетевых pending-изменений (`filter-ownership` × `net-event-delivery` × `rewind-epoch`) фиксируются в их артефактах: эпоха у `Events`, закрытие утечки шины.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `determinism-core` (CORE-5, DI-6 — новые требования; правки DET-9, TICK-подвязки)
- `tick-loop`, `time-system`, `rng`, `data-driven-systems`, `diagnostics`
- `netcode`, `netcode-transport`, `net-session`, `snapshot-rewind`, `cli-testing`
- `terrain`, `physics`, `locomotion`, `arena`, `pathfinding`, `fog-of-war`, `input-devices`
- `editor`, `camera`, `presentation-scene`
- `rendering`, `assets`, `serialization`

## Notes

Спеки правятся в main напрямую этим change (правки — исправления дефектов текста, поведения симуляции не меняют; golden-эталоны не двигаются). Дельты pending-изменений, чей текст задет правками main, ребейзятся в том же проходе (прецедент — bb22726). Разбиение работ и полный маппинг находок — `tasks.md` и отчёт.
