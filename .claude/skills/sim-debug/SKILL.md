---
name: sim-debug
description: Reproduce and localize simulation bugs in the Fluxus engine core with a minimal scenario and the JSONL trace. Use whenever a determinism bug, desync, wrong tick behavior, physics/visibility/RNG anomaly or a golden divergence needs diagnosis — whenever the user says a system behaves wrongly, two runs diverge, or asks to trace/debug a tick. Prefer this over adding console.log to core code (side effects in the tick are forbidden).
compatibility: Node >= 22.18, run from engine/core-ts
---

# Диагностика симуляции сценарием и трейсом

Отладка ядра идёт **снаружи**: минимальный сценарий + потиковые снапшоты + JSONL-трейс. `console.log` внутри тика не добавляется — I/O в тике запрещён (TICK-3); всё, что нужно, уже видно через снапшоты и `DiagnosticsSink` (DIAG-1..7).

## Шаг 1: минимальный сценарий

Сведи баг к `*.scenario.json` (формат — `ScenarioDef`, `src/sim/scenario.ts`; примеры — `engine/tests/golden/*.scenario.json`): минимум компонентов, одна-две системы, `ticks` — ровно столько, чтобы баг проявился. Клади во временную директорию, не в `tests/golden/`. Числа — сырой Q16.16 (65536 = 1.0), детали DSL — скил `json-system`.

## Шаг 2: прогон

```sh
npm run sim -- <scenario.json>                # снапшот каждого тика в stdout
npm run sim -- <scenario.json> --trace=systems --trace-out=/tmp/t.jsonl
npm run sim -- <scenario.json> --trace=full  --trace-out=/tmp/t.jsonl
```

- stdout — документ прогона: `scenario`, `seed`, `worldInitHash`, `ticks[]` (тик 0 — состояние **до** первого `tick()`). События каждого тика входят в снапшот.
- Трейс идёт в stderr либо в файл (`--trace-out`), в stdout — никогда. `systems` — по записи на систему; `full` — плюс поток Command Buffer (каждая команда с источником). Строки — канонический JSON, отсортированные ключи: два прогона сравниваются построчно (`diff`).

## Шаг 3: локализация

Порядок сравнения при расхождении двух прогонов/реализаций — сверху вниз:

1. **`worldInitHash`** — первым делом. Разошёлся — проблема в начальных данных/загрузке сцены, потиковую сверку делать бессмысленно.
2. **Первый разошедшийся тик** — `diff` по снапшотам stdout. Снапшот включает состояние RNG-стримов: если поплыл RNG — какая-то система стала тянуть другое число значений (см. счётчики стримов).
3. **Внутри тика** — `--trace=full` двух прогонов, `diff` построчно: видно, какая система поставила какую команду и где потоки разошлись. Это субтиковое разрешение, ради которого трейс существует (DIAG-6): golden локализует только до тика.

## Типовые причины

- Расходятся два запуска одного сценария → недетерминизм: чтение времени/`Math.random`/итерация по незасортированному, мутация мимо Command Buffer (см. скил `determinism-review`).
- Расходится с эталоном после правки → это ветка скила `golden-update`, не отладка.
- Система «не видит» изменения этого же тика → так и задумано: команды видимы после flush её собственного исполнения (CMD-1); события живут один тик.
- Значение «в 65536 раз» больше/меньше ожидаемого → перепутан масштаб Q16.16 ↔ i32 (`fromInt`/`toInt`).

Если минимальный сценарий стоит закрепить регресс-тестом — оформи его golden-парой через `npm run golden` (скил `golden-update`).
