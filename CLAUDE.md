# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Язык документации и общения в репозитории — русский (модальность требований в спеках — английская: SHALL / MUST NOT).

## Две части репозитория

- `engine/` — **актуальное**: OpenSpec-спецификация движка + рабочая реализация ядра `core-ts/`.
- `draft/` — историческая песочница (свой npm-workspace, своя карта в `draft/AGENTS.md`). **Не источник правды**; трогать только если задача явно про неё.

## Источник правды — спека

`engine/openspec/specs/` (16 capability, ~192 требования) нормативно описывает, каким движок должен быть. При расхождении реализации и спеки дефект — в реализации (CORE-3). Нормативные формулировки живут **только** в спеках — не дублировать их в docs или коде.

- Требования имеют исторические ID (`DET-1`, `NET-15`, `FOW-4`…) в заголовках `### Requirement:` — сохранять их; новое требование получает следующий свободный номер своего префикса.
- Изменения проходят через OpenSpec-workflow: команды `/opsx:propose`, `/opsx:apply`, `/opsx:archive` и т.д. (скиллы `openspec-*` из `engine/.claude/skills/`). Не менять спеки в обход этого процесса.
- Контекст и правила оформления спек — `engine/openspec/config.yaml`.
- Обзор слоёв, roadmap, разделение «механизм vs политика», открытые вопросы — `engine/docs/architecture.md`.

```sh
cd engine
openspec list --specs               # список capability
openspec spec show netcode          # одна спецификация
openspec validate --specs --strict  # проверка формата
```

## Команды (engine/core-ts)

Node >= 22.18. Все команды из `engine/core-ts/`:

```sh
npm test                                 # vitest, все тесты
npx vitest run test/physics.test.ts      # один файл
npx vitest run -t "имя теста"            # один тест по имени
npm run typecheck                        # tsc --noEmit
npm run sim -- <scenario.json>           # CLI-прогон сценария (bin/sim.mjs)
npm run golden                           # перегенерация golden-эталонов (UPDATE_GOLDEN=1)
npm run schemas                          # перегенерация engine/schemas/*.json (UPDATE_SCHEMAS=1)
```

`engine/tests/golden/` — пары `*.scenario.json` / `*.golden.json`, побитовые эталоны прогона. Тест `golden.test.ts` сверяет их точно; если поведение изменено **осознанно и по спеке** — перегенерировать через `npm run golden` и включить диф эталонов в коммит. JSON-схемы в `engine/schemas/` порождаются из ядра — руками не править, только `npm run schemas`.

Для `draft/`: `cd draft && npm test` (тесты ядра), `npm run dev:render` (Three.js-прототип).

## Неснимаемые принципы ядра

Нарушение любого из них — дефект, а не компромисс (полный список — `engine/openspec/config.yaml`):

- Единственный вход в симуляцию — `tick(state, inputs) → TickResult`; никакого I/O и side-effect'ов внутри тика, внешние потребители читают `TickResult` после.
- Fixed-point Q16.16 везде в симуляции; float в геймплейных расчётах запрещён.
- Мутации ECS — только через Command Buffer; мутаторы мира намеренно не экспортируются из `src/index.ts` (это и есть запрещённый side-channel, TICK-3).
- JSON-система и нативная TS-система взаимозаменяемы за единым интерфейсом `System`.
- Server-authoritative netcode; снапшот клиенту фильтруется по видимости (FoW — часть симуляции, не рендера).
- У ядра **ноль** runtime-зависимостей — не добавлять библиотеки в `engine/core-ts` (сознательно отказались и от ECS-библиотек, и от `json-logic-js`).
- Механизм vs политика: core не знает баланса. Число, которое может поменять геймдизайнер, живёт в JSON-системах, не в ядре (таблица примеров — `engine/docs/architecture.md` §3).

## Устройство core-ts

`engine/core-ts/src/`, вся симуляция детерминированная:

- `math/` — Q16.16 (`fixed.ts`), векторы, `mathApi` (DI), xorshift128-RNG с именованными стримами.
- `ecs/` — собственное SoA-хранилище на TypedArray (`world.ts`), битовые маски, Query API, Command Buffer (`commands.ts`), Event Bus, generational entity IDs. Per-component dirty-tracking наполняет `TickResult.changes`.
- `dsl/` — data-driven слой: JsonLogic-совместимый evaluator выражений (`expr.ts`, свой обход AST), исполнитель действий (`actions.ts`), `EvaluatedSystem` (JSON-система в общем реестре), генерация схем.
- `systems/` — нативные TS-системы: terrain, physics (broad-phase сетка, raycast), visibility/FoW, time/tween/modifiers, arena, input; общий `registry.ts`.
- `sim/` — `tick.ts`, worldInit, сериализация (канонический JSON, plain-форма мира), конфиг сцены, `HistoryProvider` (ring buffer снапшотов), rewind/replay, per-client фильтр снапшота (`filter.ts`), `contentPackHash`.
- `bin/sim.mjs` — CLI прогона сценария (основа golden-тестов и будущей cross-language сверки с Rust-портом).
