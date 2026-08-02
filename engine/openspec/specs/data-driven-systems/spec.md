# Data-Driven Systems Specification

## Purpose

Геймплейная логика описывается JSON, ядро — универсальный evaluator. Ключевое проектное решение: система — чёрный ящик за единым интерфейсом, поэтому JSON-система и нативная TS-система взаимозаменяемы, и переписывание системы в код ради скорости не требует изменений вокруг.

Три уровня DSL:

| Уровень | Описывает | Пример |
|---|---|---|
| **System** | Что и когда исполнять | `{query, forEach, order}` |
| **Action** | Побочные эффекты | `modifyComponent`, `spawnEntity`, `forEach`, `if`, `let` |
| **Expression** | Чистые вычисления | JsonLogic |

## Requirements

### Requirement: SYS-1 Система как JSON-описание

Система SHALL описываться JSON с полями `name`, `order`, `query`, `forEach`/`do`.

#### Scenario: Создание системы в редакторе

- **WHEN** геймдизайнер собирает систему визуально
- **THEN** на выходе — валидный JSON с этими полями, готовый к регистрации в ядре

### Requirement: SYS-2 Детерминированное упорядочивание scheduler'ом

Scheduler SHALL упорядочивать системы по `order` детерминированно.

#### Scenario: Регистрация в произвольном порядке

- **WHEN** системы регистрируются в порядке, отличном от их `order`
- **THEN** исполнение всё равно идёт по `order`

### Requirement: SYS-3 Регистрация и валидация на старте

Компоненты-данные и системы SHALL регистрироваться на старте и SHALL валидироваться при регистрации.

#### Scenario: Система ссылается на неизвестный компонент

- **WHEN** JSON-система запрашивает компонент, которого нет в реестре
- **THEN** регистрация падает на старте, а не в середине матча

### Requirement: SYS-4 Единый интерфейс System

Любая реализация системы SHALL удовлетворять единому интерфейсу:

```ts
interface System {
  readonly name: string;   // = имя RNG-стрима, ключ в реестре для подмены
  readonly order: number;
  execute(ctx: SystemContext): void;
}
```

#### Scenario: Scheduler исполняет систему

- **WHEN** приходит очередь системы в тике
- **THEN** scheduler вызывает `execute(ctx)`, не зная, JSON-система это или нативная

### Requirement: SYS-5 SystemContext как контракт границы core↔геймплей

`SystemContext` SHALL быть публичным контрактом границы core↔геймплей:

```ts
interface SystemContext {
  readonly world: WorldView;        // снапшот на начало системы, read-only (QUERY-3)
  readonly commands: CommandBuffer; // единственный канал мутаций (CMD-1..4)
  readonly events: EventBus;        // EVT-1..3
  readonly rng: { stream(sub?: string): RngStream }; // стрим по name системы (RNG-4)
  readonly time: TimeContext;       // tick, globalDelta (TIME-1..3)
  readonly physics: PhysicsApi;     // raycast/коллизии, обязателен при FoW
}
```

#### Scenario: Системе нужен доступ к чему-то вне контекста

- **WHEN** реализации системы требуется ресурс, отсутствующий в `SystemContext`
- **THEN** это изменение публичного контракта — оформляется явно, а не обходится через импорт модуля напрямую

### Requirement: SYS-6 Две реализации за одним контрактом

`EvaluatedSystem` (исполняет JSON через Action Executor + Expression Evaluator) и нативная TS-система SHALL иметь идентичные границы поведения: обе читают через `WorldView` и пишут только в `CommandBuffer`. У нативной системы физически нет способа обойти TICK-3/CMD-4.

Часть систем проектируется нативно сразу (перф-критичные, интенсивно работающие с Physics API) — например `VisibilitySystem` с raycast-LoS каждый тик.

#### Scenario: Нативная система оптимизирует горячий цикл

- **WHEN** система переписана на прямые вычисления ради скорости
- **THEN** она по-прежнему читает через `WorldView` и пишет через `CommandBuffer`, детерминизм не страдает

### Requirement: SYS-7 SystemRegistry и подмена по name

`SystemRegistry` SHALL хранить системы по `name` и SHALL позволять подменить реализацию через `override(system)` с тем же `name`/`order`, не затрагивая scheduler, Command Buffer, события и RNG-стримы.

```ts
registry.registerFromJson(dashSystemJson); // из редактора
registry.override(new NativeDashSystem()); // оптимизированная версия, тот же name/order
registry.register(new VisibilitySystem()); // сразу нативная, тот же контракт
```

#### Scenario: Оптимизация системы переписыванием в код

- **WHEN** JSON-система заменяется нативной с тем же `name` и `order`
- **THEN** вокруг не меняется ничего: ни scheduler, ни имя RNG-стрима, ни порядок команд

### Requirement: SYS-8 Golden-file не меняется при переписывании системы

Golden-file тест SHALL оставаться неизменным при переписывании системы из JSON в код; расхождение снапшотов нативной и JSON-версии SHALL считаться красным тестом. Для изначально нативных систем golden-file фиксирует эталон напрямую.

#### Scenario: Оптимизация изменила поведение

- **WHEN** нативная версия системы даёт снапшот, отличный от JSON-версии
- **THEN** golden-file тест краснеет — оптимизация сломала детерминизм и не принимается

### Requirement: ACT-1 Набор actions

Action DSL SHALL поддерживать набор действий:

- `modifyComponent`, `addComponent`, `removeComponent`
- `spawnEntity`, `destroyEntity`
- `emitEvent`
- `forEach { query, do }` — итерация с телом-actions
- `if { cond, then, else }`
- `let { bindings, do }` — локальные переменные
- `addTween`, `addModifier`

#### Scenario: Условный эффект способности

- **WHEN** способность бьёт сильнее по целям ниже 30% HP
- **THEN** это выражается через `if` с JsonLogic-условием, без написания кода

### Requirement: ACT-2 Все ECS-меняющие actions через Command Buffer

Все actions, меняющие ECS, SHALL работать через Command Buffer. В частности `addTween` и `addModifier` тоже SHALL создавать команды (создание/модификация компонентов `Tween`/модификаторов), а не мутировать ECS напрямую.

#### Scenario: Твин, созданный внутри forEach

- **WHEN** `addTween` вызывается для каждой найденной сущности
- **THEN** создаются команды, применяемые на flush, — итерация остаётся стабильной

### Requirement: ACT-3 Детерминированный порядок commands

Порядок применения команд, созданных actions, SHALL быть детерминированным.

#### Scenario: Несколько actions меняют одну сущность

- **WHEN** внутри одной системы к сущности применяется несколько модификаций
- **THEN** итоговое состояние однозначно определяется порядком создания команд

### Requirement: EXPR-1 JsonLogic в MVP

Expression Evaluator в MVP SHALL использовать JsonLogic через библиотеку; выражения SHALL храниться как JSON-AST.

#### Scenario: Хранение формулы урона

- **WHEN** формула урона задана в редакторе
- **THEN** она сериализуется как JSON-AST, пригодный для валидации и диффа, а не как строка-код

### Requirement: EXPR-2 Собственные расширения JsonLogic

Evaluator SHALL расширять JsonLogic: fixed-point арифметика вместо float, `getComponent`, `hasComponent`, векторная математика через Math API.

#### Scenario: Расчёт дистанции в выражении

- **WHEN** выражение считает расстояние между двумя сущностями
- **THEN** расчёт идёт в fixed-point через Math API, результат детерминирован

### Requirement: EXPR-3 Sandboxed выражения

Выражения SHALL быть sandboxed: никаких side-effects.

#### Scenario: Попытка изменить компонент из выражения

- **WHEN** выражение пытается что-то записать
- **THEN** такой операции в языке выражений нет — мутации доступны только actions

### Requirement: EXPR-4 Абстракция ExpressionEvaluator

Evaluator SHALL быть скрыт за интерфейсом `ExpressionEvaluator` — для последующей замены JsonLogic на собственный AST. Точка абстракции живёт внутри `EvaluatedSystem`; нативной системе она не нужна.

#### Scenario: Замена JsonLogic на собственный AST

- **WHEN** производительность JsonLogic перестаёт устраивать
- **THEN** меняется реализация за интерфейсом, JSON-описания систем и остальной код не трогаются

### Requirement: EXPR-5 Никаких циклов в выражениях

Циклы MUST NOT поддерживаться в expressions; итерация доступна только в actions через `forEach`.

#### Scenario: Нужна агрегация по набору сущностей

- **WHEN** требуется просуммировать значение по нескольким сущностям
- **THEN** это делается через action `forEach` с накоплением в `let`, а не циклом внутри выражения

### Requirement: EVT-1 Детерминированная очередь событий

Event Bus SHALL быть детерминированной очередью.

#### Scenario: Несколько систем эмитят события на одном тике

- **WHEN** события публикуются из разных систем
- **THEN** их порядок в очереди воспроизводится при каждом прогоне

### Requirement: EVT-2 Потребление в порядке публикации

События SHALL потребляться системами в порядке публикации.

#### Scenario: Цепочка реакций

- **WHEN** событие `DamageDealt` порождает `EntityDied`
- **THEN** подписчики видят их в порядке публикации, а не в произвольном

### Requirement: EVT-3 События — часть snapshot

События SHALL входить в snapshot (для rewind/rollback).

#### Scenario: Rewind на тик с необработанными событиями

- **WHEN** мир откатывается на тик, где в шине лежали события
- **THEN** они восстанавливаются вместе с миром, и продолжение симуляции идентично честному реплею

### Requirement: EVT-4 Разграничение Event Bus и Command Buffer

> Источник: врезки «Разграничение с Command Buffer / Event Bus» из tech-requirements.md §4.5 и §9; выделено в отдельное требование при конвертации.

EventBus SHALL нести факт («что-то произошло», broadcast нескольким системам-подписчикам), Command Buffer SHALL нести мутацию (адресное изменение ECS). Событие само по себе мир не меняет — реакция систем-слушателей проводит мутации через Command Buffer. События снапшотятся и могут пережить границу тика; команды — нет (flush per-система, буфер пуст на границе тика). Слить их в один механизм MUST NOT быть допущено: событие не должно мутировать world напрямую (сломает детерминированный flush), команда не имеет подписчиков.

#### Scenario: Реакция нескольких систем на смерть сущности

- **WHEN** эмитится `EntityDied`
- **THEN** каждый подписчик реагирует своим набором команд; само событие мир не меняет
