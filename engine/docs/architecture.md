# Архитектурный обзор движка

> Требования переехали в `openspec/specs/` — это документ «как всё устроено целиком» и «в каком порядке строим». Нормативные формулировки живут только в спеках; здесь их дублировать нельзя.

## 1. Слои

```text
┌─────────────────────────────────────────────────┐
│  Редактор (Compose Multiplatform)                │
│  Визуальные триггеры / Data-Driven логика        │
└───────────────┬──────────────────────────────────┘
                │ генерирует JSON (компоненты, системы, prefabs)
┌───────────────▼──────────────────────────────────┐
│  Deterministic Core (TS, позже Rust)             │
│  ┌────────────────────────────────────────────┐  │
│  │ System Evaluator (JSON → pipeline)         │  │
│  │ Action Executor / Expression (JsonLogic)   │  │
│  │ ECS foundation + Query API                 │  │
│  │ Time / Tween / Snapshot / RNG              │  │
│  │ Visibility (нативная система FoW)          │  │
│  └────────────────────────────────────────────┘  │
│           ▲ DI              ▲ DI                 │
│      Math API          Physics API (обяз. при FoW)│
└───────────────▲──────────────────────────────────┘
                │ tick(state, inputs) → TickResult
        ┌───────┴────────────────┐
        │  External Observers     │  ← аналитика / логи / звук / рендер
        │  Netcode snapshot filter│  ← per-client фильтрация (viewpoint)
        │  CLI (golden-file)      │  ← cross-language sync
        └─────────────────────────┘
```

## 2. Карта спецификаций

| Capability | Что покрывает | ID требований |
|---|---|---|
| `determinism-core` | Гарантии детерминизма, языки реализации, DI | DET-1..7, CORE-1..4, DI-1..3 |
| `fixed-point-math` | Q16.16, умножение, округление, overflow | FP-1..4 |
| `tick-loop` | `tick()`, `InputFrame`, `TickResult`, observers | TICK-1..4, OBS-1..6 |
| `ecs-foundation` | ECS, Query API, Entity IDs, Command Buffer | ECS-1..5, QUERY-1..3, ID-1..5, CMD-1..5 |
| `data-driven-systems` | System/Action/Expression DSL, Event Bus | SYS-1..8, ACT-1..3, EXPR-1..5, EVT-1..4 |
| `time-system` | TimeScale, стакинг, твины | TIME-1..9, TWEEN-1..7 |
| `rng` | PRNG, именованные стримы | RNG-1..7 |
| `snapshot-rewind` | Снапшоты, перемотка, машина состояний мира | SNAP-1..6, REW-1..11, WSM-1..6 |
| `serialization` | JSON / MessagePack, `Serializer` | SER-1..5 |
| `physics` | Коллизии, детерминированный raycast | PHYS-1..7 |
| `cli-testing` | CLI, golden-file, cross-language сверка | CLI-1..6 |
| `netcode` | Server-auth, предсказание, per-client фильтрация | NET-1..15 |
| `fog-of-war` | `Vision`/`Visibility`/`Stealth`, `VisibilitySystem` | FOW-1..9 |
| `editor` | Compose-редактор геймплея | ED-1..9 |

Требование ищется по ID: `openspec spec show <capability>` либо grep по `openspec/specs/`.

## 3. Механизм против политики

Сквозное разделение, которое легко потерять при реализации:

| Механизм (core) | Политика (evaluator / геймплей) |
|---|---|
| Переходы WSM + `HistoryProvider.seekTo(tick)` | Ульта отката: глубина, cooldown, стоимость, автостоп |
| `TimeScaleModifiers.sources` + произведение с клампом | Как стакаются слоу: сильнейший / аддитив / мультипликатив |
| `VisionModifier.sources` | Правила баффов обзора |
| Фильтр снапшота с параметром `viewpoint` | Кто авторизован получать `viewpoint = ALL` |

Правило: core никогда не знает баланса. Если в ядро просится число, которое может поменять геймдизайнер, — оно живёт в JSON.

## 4. LLM-friendly dev workflow

Не требования к системе, а следствие JSON-first архитектуры — почему она выбрана:

- JSON-first упрощает генерацию контента агентом.
- Строгие JSON-схемы → агент генерит валидные компоненты и системы.
- Документированные Action DSL и JsonLogic-операции — контекст для few-shot.
- Cross-language парность поддерживается агентом (генерация Rust-версии по TS-спецификации), включая нативные системы вроде `VisibilitySystem`; сверка — golden-файлами.

## 5. Roadmap

Фокус: полностью рабочий data-driven тик + детерминизм с самого начала. Единый интерфейс `System` появляется рано, чтобы подменяемость JSON↔код проверялась не в конце, а в момент появления evaluator'а.

| Этап | Задача | Результат |
|---|---|---|
| 0 | Формальная спецификация core | ✅ `openspec/specs/` + JSON-схемы (схемы ещё нет) |
| 1 | Fixed-point Math API | Библиотека + тесты (mul/div/overflow, truncate toward zero) |
| 2 | ECS foundation + Query API + Command Buffer | Детерминированный обход, deferred-мутации, flush per-system |
| 3 | Entity IDs + RNG streams | Generational IDs; именованные стримы от world seed |
| 4 | `System` / `SystemContext` + `SystemRegistry` | Контракт зафиксирован до первого tick loop |
| 5 | Event Bus + Scheduler + Tick loop | `tick()` на нативных системах |
| 6 | Expression Evaluator | Fixed-point в выражениях, `getComponent`, sandbox |
| 7 | Action Executor | Все actions через Command Buffer |
| 8 | System Evaluator = `EvaluatedSystem` | JSON-система в том же реестре — подменяемость проверена |
| 9 | Serialization + Snapshot ring buffer + dirty-tracking | Reproducible state; `TickResult.changes` наполняется |
| 10 | CLI + golden-file test suite | Побитовая сверка (`viewpoint = ALL`) |
| 11 | Time system + Tween system | Time scaling, интерполяции |
| 12 | World state machine + Rewind | Механика перемотки; `mode`/`isReplay` в `TickResult` |
| 13 | Physics + raycast/LoS | Примитивные коллизии + детерминированный raycast |
| 14 | Editor MVP (Compose) | Визуальный геймплей |
| 15 | Netcode: server-auth + предсказание + per-client фильтрация | Мультиплеер с FoW-транспортом |
| 16 | FoW: компоненты + `VisibilitySystem` + fog-mask | Туман войны; зависит от 13 и 15 |
| 17 | (Будущее) Rust-порт ядра | Cross-language парность, включая LoS |

Заглушки в `TickResult`: поле `changes` присутствует в контракте с шага 5, но до шага 9 — пустой `ChangeSet`. Поля `mode`/`isReplay` присутствуют с шага 5, но до шага 12 — константы `Running` / `false`.

Каждый этап заводится как change: `/opsx:propose "<этап>"`.

## 6. Открытые вопросы

Не противоречия ядра, а нерешённые дизайн/фичасибилити-вопросы. Каждый помечен слоем, на котором решается.

1. **Пейс глобальной перемотки** (геймплей). Механизм решён, но в FFA до 10 игроков перемотка одного игрока замораживает мир всем на до 7 с. Открыт баланс: как часто доступна ульта, не убивает ли динамику 20-минутного матча.
2. **Модель отзывчивости** (решается прототипом). Ядро детерминированное → работают обе схемы: lockstep-relay + input-delay либо server-auth с предсказанием. Выбор зависит от того, насколько вялы дэши при input-delay. Не блокер спеки: ядро от выбора не зависит.
3. **Гранулярность dirty-tracking** (перф). Per-component или per-entity-per-component — по замерам на реальной сцене, этап 9.
4. **Суб-стримы RNG** (контент/редактор). Дефолт — один стрим на систему. Нужны ли именованные суб-стримы и как их объявлять в редакторе — по мере появления систем с несколькими источниками случайности.
5. **Стоимость per-client фильтрации** (netcode/перф). 10 игроков × 30 Гц = до 10 фильтраций снапшота на тик, при delta — ещё и 10 baseline-diff'ов. Замерить; при упоре — снизить частоту рассылки или отложить per-client delta.
6. **Гранулярность видимости** (дизайн/перф). MVP — per-team битмаска. Per-entity потребует другой структуры и ломает дешёвый dirty. Решать только если потребует дизайн.
7. **Кто получает `viewpoint = ALL`** (netcode). Фильтр обязан отключаться, иначе реплеи слепые. Открыто: кто авторизован на полный поток и как защитить это от читеров в живом матче.
8. **Политика видимости событий и снарядов** (геймплей). Точная политика при разной видимости источника и цели. Отдельно: видны ли снаряды/VFX от невидимой сущности — у снаряда может быть своя видимость, независимая от кастера.
9. **LoS-обрезка тумана в рендере** (рендер). Нужен ли 2D shadow-casting в MVP или достаточно круга-radius.
10. **FoW × глобальный rewind** (геймдизайн/netcode). Во время перемотки, инициированной одним игроком: все видят мир глазами инициатора или каждый свою историческую видимость?

## 7. Технические риски

- **Time-манипуляции + сетевой реалтайм-синк на таймингах** — наиболее рискованная связка (риск из one-pager). Механизм заложен через глобальный `Rewinding` и авторитетный сервер, но пейс и ощущение проверяются только прототипом.
