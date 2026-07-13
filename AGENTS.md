# AGENTS.md

Ориентир для агентов, впервые попавших в этот репозиторий. Не дублирует спеку — только даёт карту и указывает, куда идти за подробностями.

## Что за проект

Сетевой 2.5D action-игровой движок (Diablo/PoE-стиль): персонаж со способностями (фаербол, щит, рывок, замедление времени), детерминированное ECS-ядро тика. Ядро должно одинаково работать в offline, lockstep-мультиплеере и авторитарном сервере с rollback — отсюда жёсткие требования к детерминизму (fixed-point арифметика, стабильный порядок обхода, никакого I/O внутри тика).

## Архитектура: spec — источник истины

`spec/` — не документация «по мотивам кода», а самостоятельная спецификация, независимая от языка реализации. `ts-impl/` — конкретная TypeScript-реализация этой спеки. Каждая декларация в spec (компонент/событие/система/архетип/ресурс) должна иметь зеркальный TS-файл, и наоборот.

**Правило, которое нельзя нарушать: любое изменение поведения в `ts-impl/src/` обязано сопровождаться правкой соответствующего `spec/**/*.yaml` (или `.md`) в том же коммите/сессии, и наоборот.** Если меняешь логику системы в коде — обнови `logic:` в её spec-файле. Если добавляешь поле компонента — обнови и `components/types.ts`, и `spec/components/*.yaml`.

Три обязательных к прочтению файла перед серьёзными правками spec:
- `spec/topology.md` — структура директорий, правило «один файл — одна декларация», инварианты детерминизма (§7), запреты (§8).
- `spec/conventions.md` — синтаксис `logic:` псевдокода на русском, fixed-point арифметика, RNG, время.
- `spec/glossary.md` — канонический словарь терминов RU↔EN (не изобретать свои переводы).

Контракт физики — отдельная категория (`spec/contracts/physics_v1.md`, `PhysicsContractV1`): внешний провайдер физики (`ts-impl/src/physics/physicsProvider.ts`) — единственный, кто имеет право писать `Position`/`Velocity` у сущностей с `DynamicBody`. Любое отклонение от контракта (кто что читает/пишет, какие события порождает, гарантии порядка) — правь `physics_v1.md`, а не молчаливо в коде.

## Структура репозитория

```
spec/                       # источник истины (YAML + логика на русском)
├── spec.yaml                # корневой манифест (meta: tick_rate=60, fixed_point_scale=65536)
├── topology.md               # правила организации спеки — читать первым
├── conventions.md             # синтаксис logic:, арифметика, время, RNG
├── glossary.md                 # словарь терминов
├── schedule.yaml                # порядок стадий/систем тика (Input→Intent→Simulation→Physics→Reaction→Resolution→Time)
├── resources/                   # TimeState, RngState, GameConfig, InputBuffer, EntityAllocatorState...
├── components/                  # Position, Velocity, Collider, Health, Cooldowns, AttachedTo...
├── events/                      # CastFireball, CastShield, DamageCommand, MoveCommand...
├── systems/                     # по одной системе на файл, с logic: на русском
├── archetypes/                  # Player, Fireball, Shield, Wall
├── contracts/                    # physics_v1.md — контракт с внешним провайдером физики
└── scenarios/                    # data-driven тесты (пока пусто)

ts-impl/                    # TS-реализация спеки (npm workspace game-mvp-impl)
└── src/
    ├── ecs/                      # GameWorld (обёртка над miniplex): spawn/query/with/get/destroy/all
    ├── fixed/                     # fixed.ts (Q32.16 Fixed=bigint, ONE=65536n), vector.ts, trig.ts
    ├── rng/                        # pcg32.ts — детерминированный RNG
    ├── components/types.ts          # все компоненты как TS-классы
    ├── resources/resources.ts        # ресурсы
    ├── archetypes/                    # фабрики сущностей по архетипам спеки
    ├── systems/                        # по одному файлу на систему, зеркалит spec/systems/*.yaml
    ├── physics/                        # physicsProvider.ts + grid.ts (broad-phase) + narrowphase.ts
    ├── schedule.ts                      # регистрация систем по стадиям — зеркалит spec/schedule.yaml
    └── tick.ts                           # next_state = tick(prev_state, inputs)

ts-render/                  # Three.js рендер-клиент (npm workspace game-mvp-render), демо на vite
└── src/
    ├── demo.ts                   # прогон симуляции + ввод с клавиатуры/мыши
    ├── renderer.ts                 # сцена/камера/синхронизация позиций мешей
    ├── entities.ts                  # фабрика мешей по типу сущности
    └── types.ts                      # Entity — то, что рендер видит из ECS (подмножество полей)
```

## Ключевые инварианты (spec/topology.md §7 — нарушение блокирует мердж)

- Никакой плавающей точки — только `Fixed = bigint`, Q32.16, через `ts-impl/src/fixed/fixed.ts`.
- Стабильный порядок обхода — сущности по возрастанию `entity_id`, коллизии по `(min_id, max_id)`.
- Никакого `Date.now()`/`Math.random()` внутри симуляции — время только через `TimeState`, рандом только через `RngState`.
- `Position`/`Velocity` у `DynamicBody`-сущностей — только через физику (стадия `Physics`), кроме инициализации при спавне (это не мутация, см. `physics_v1.md` §4).
- Одна декларация — один YAML-файл в spec; имя файла = имя сущности в snake_case.

## Команды

```
npm run typecheck --workspaces   # tsc --noEmit на ts-impl и ts-render
npm run test --workspace=ts-impl  # vitest run (все тесты живут в ts-impl/test/)
npm run dev:render                 # vite dev-сервер демки на http://localhost:3000
npm run build --workspaces           # сборка обоих workspace
```

## Для новых агентов: с чего начать конкретную задачу

1. **Новая фича/способность** — сначала формализовать в `spec/` (компоненты/события/системы/архетипы по образцу существующих), потом реализовать в `ts-impl/src/`, зеркально. Не изобретать геймплей сверх того, что описано в задаче — пользователь сам формулирует «хотелки», агент их формализует.
2. **Правка бага в физике/системе** — искать причину в `ts-impl/src/`, но после фикса обязательно свериться, не разошлась ли `logic:` в соответствующем `spec/systems/*.yaml` с новым поведением кода.
3. **Изменение рендера (`ts-render/`)** — рендер не часть детерминированного ядра, в spec не отражается; но `ts-render/src/types.ts` должен оставаться подмножеством реальных полей ECS-компонентов (сверяться с `ts-impl/src/components/types.ts`).
4. После любой правки — `npm run typecheck --workspaces` и `npm run test --workspace=ts-impl` должны быть зелёными до отчёта о завершении.
