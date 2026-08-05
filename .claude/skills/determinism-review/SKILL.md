---
name: determinism-review
description: Pre-push review checklist for changes to the Fluxus engine core (engine/core-ts). Use before committing or pushing any change that touches core-ts/src, whenever the user asks to review core changes, check determinism, audit the tick path, or mentions floats/RNG/allocation discipline. Catches violations of the non-negotiable core principles that ordinary tests may miss.
compatibility: bash, run from repo root
---

# Ревью изменений ядра на детерминизм и дисциплину

Быстрая проверка диффа `engine/core-ts/src` против ненарушаемых принципов (полный список — `engine/openspec/config.yaml`). Сначала прогони механическую часть, потом пройди чеклист по диффу.

## Механическая часть

```sh
bash .claude/skills/determinism-review/scripts/check.sh
```

Скрипт грепает запрещённые источники недетерминизма и проверяет ноль runtime-зависимостей. Находка — не приговор, а место, куда посмотреть; но в геймплейном пути оправданий у неё почти не бывает.

## Чеклист по диффу (`git diff engine/core-ts/src`)

- **Floats в геймплейной математике.** Вся арифметика симуляции — Q16.16 через `MathApi`; `*`, `/`, `Math.*` над геймплейными значениями напрямую — дефект (DET-2). Дробные литералы (`0.5`) в `src/` — красный флаг.
- **Мутации мимо Command Buffer.** Изменения мира внутри систем — только `ctx.commands`. Новый экспорт мутаторов мира из `src/index.ts` — это side-channel, запрещённый TICK-3.
- **I/O и эффекты в тике.** Внутри `tick()` нет чтения времени, файлов, консоли. Диагностика — только через инъектируемый `DiagnosticsSink`.
- **Порядок итерации.** Обходы `Object.keys`/`Map`/`Set`, влияющие на результат, обязаны сортироваться (ср. ACT-3: ключи полей сортируются). Проверь новые циклы по коллекциям со строковыми ключами.
- **RNG.** Только xorshift-стримы через `ctx.rng`; число обращений к стриму не должно зависеть от того, какие ветки выражений вычислялись.
- **Зависимости.** `core-ts/package.json` — ноль runtime-зависимостей, без исключений (ECS-библиотеки и `json-logic-js` отклонены осознанно).
- **Strip-only ограничения.** В `src/` нельзя parameter properties (`constructor(private x: T)`), `enum`, `namespace` — они валят `bin/sim.mjs` (стерегёт `cli.test.ts`, но проверь глазами раньше).
- **Аллокации в hot path.** Новые аллокации, пропорциональные числу сущностей/систем на тик, — либо убрать, либо пометить `ponytail` с намерением убрать по результатам профилирования.
- **Спека.** Изменение поведения обязано соответствовать требованию в `engine/openspec/specs/`; расхождение — дефект реализации (CORE-3). Нормативный текст в комментарии кода не переносится.

## Финал

`npm test` и `npm run typecheck` из `engine/` (все пакеты). Если поведение менялось намеренно — эталоны через скил `golden-update`, диф эталонов в коммит.
