---
name: golden-update
description: Handle failing or outdated golden baseline tests in the Fluxus engine (engine/tests/golden) — behaviour goldens, match recordings, cost baselines (*.cost.json) and the core API-surface baseline. Use whenever golden.test.ts, matchGolden.test.ts, cost.test.ts or apiSurface.test.ts goes red, whenever behavior of the simulation changed and baselines need regeneration, whenever the user mentions golden files, baselines, эталоны, match recordings, cost baselines, or asks to run npm run golden / npm run record / npm run golden:cost / npm run schemas. Also use before committing any change that touches simulation behavior.
compatibility: Run from the repository root workspace
---

# Обновление golden-эталонов

`engine/tests/golden/` — пары `*.scenario.json` / `*.golden.json`: побайтовые эталоны прогона сценария (`viewpoint = ALL`, без FoW-фильтрации). Красный golden — это **сигнал, а не помеха**. Никогда не перезаписывай эталоны, чтобы «починить тест».

## Развилка при красном golden

1. **Поведение менялось намеренно и по спеке?** Сначала ответь на этот вопрос. Изменение должно соответствовать требованию в `openspec/specs/` (или идущему change'у). Если нет — это регрессия: чини код, эталоны не трогай.
2. **Диф объясним?** Прогони сценарий и посмотри, *что именно* поплыло: `npx vitest run test/golden.test.ts` из `engine/core-ts/` печатает диф. Расхождение `worldInitHash` — поплыли начальные данные/формат мира; расхождение с какого-то тика N — поведение системы с этого тика. Диф в полях, которых твоё изменение касаться не должно (RNG-значения, чужие компоненты), — почти всегда регрессия детерминизма, а не «шум».
3. Только после «да» на оба вопроса — перезаписывай.

## Как перезаписывать

Единственная правильная команда — из корня репозитория:

```sh
npm run golden
```

Она делает **два шага в правильном порядке**: сначала `npm run record -w @fluxus/integration` (UPDATE_MATCHES=1 — переигрывает loopback-матчи и переписывает `match-*.scenario.json`, CLI-10), затем `npm run golden -w @fluxus/core` (UPDATE_GOLDEN=1 — переписывает все `*.golden.json`, включая пары к свежезаписанным match-сценариям). Запуск только core-части при изменившемся сетевом слое оставит `match-*` рассинхронизированными.

После перезаписи:

- **Просмотри диф эталонов глазами** (`git diff engine/tests/golden/`) — он обязан объясняться твоим изменением, строка в строку с ожиданием. Незнакомые дифы — назад к пункту 2.
- Прогони полный набор: `npm test` из корня репозитория — golden-тесты дополнительно сверяют, что два прогона дают одни байты (DET-1).
- **Диф эталонов входит в тот же коммит**, что и изменение поведения, — с объяснением в сообщении коммита.

## Смежное: схемы

Если менялась форма компонентов/сцены/сценария — регенерируй JSON-схемы: `npm run schemas` из `engine/core-ts/` (UPDATE_SCHEMAS=1). `engine/schemas/*.json` руками не редактируются никогда — только генерацией. Диф схем тоже идёт в коммит.

## Красный cost.test отдельно (эталоны стоимости)

`*.cost.json` рядом с golden-парами — детерминированные счётчики работы (PERF-3/PERF-4): тик, `extract`, `syncTick`, `frame` по тем же записанным матчам, секции на пресет качества; `scaling`/`npc-stress`/`nav-path` — оси масштабирования в двух размерах (PERF-6). Машинно-независимы: красный диф — **реальное изменение стоимости**, не шум.

- `npm run golden` их **не** переписывает — намеренно. Принятие удорожания — отдельное решение с диффом на ревью: `npm run golden:cost` из корня (UPDATE_COST=1).
- Перезапись матчей (`npm run record` внутри `npm run golden`) меняет и нагрузку — тогда `golden:cost` идёт следом **в том же коммите**.
- Подешевело — тоже перепиши: эталон фиксирует значение, не потолок.
- Рост выше линейного по оси (отношение L/S) — повод посмотреть код, а не принять.

## Красный apiSurface.test отдельно

`engine/core-ts/test/api-surface.golden.json` — перечень рантайм-экспортов `src/index.ts` (CLI-8). Красный означает: поверхность ядра изменилась. Новый экспорт мутатора мира — это side-channel мимо Command Buffer (TICK-3), и краснеть он обязан здесь. Если расширение осознанное и не мутатор: `UPDATE_API=1 npx vitest run test/apiSurface.test.ts` из `engine/core-ts/`, диф в коммит.

## Красный matchGolden отдельно

Красный `integration-ts/test/matchGolden.test.ts` при зелёном core-golden означает: сетевой слой стал записывать матч иначе (пейсинг, подстановка predicted-кадров, порядок канонического лога). Принятие — то же `npm run golden` из корня репозитория, и диф `match-*.scenario.json` смотрится на ревью так же внимательно.
