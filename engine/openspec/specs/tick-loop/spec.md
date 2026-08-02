# Tick Loop & Observability Specification

## Purpose

Единственная точка входа в симуляцию (`tick`), формат внешних воздействий (`InputFrame`) и контракт наблюдаемости результата тика (`TickResult` / `TickObserver`). Симуляция остаётся чистой: все side-effect'ы живут во внешнем слое после `tick()`.

## Requirements

### Requirement: TICK-1 Единственный вход в симуляцию

Единственным способом прогресса симуляции SHALL быть чистая функция `tick(state, inputs[]) → TickResult`, где `TickResult.state` — новый `state'`.

#### Scenario: Продвижение мира на тик

- **WHEN** внешний слой хочет продвинуть симуляцию
- **THEN** он вызывает `tick(state, inputs)` и получает новое состояние в `TickResult.state`, не мутируя переданный `state`

### Requirement: TICK-2 InputFrame на игрока и тик

Внешние воздействия SHALL передаваться как `InputFrame` на пару (игрок, тик), а не как дискретные события: для непрерывного WASD-движения состояние ввода сэмплится каждый тик.

```json
{ "tick": 1234, "playerId": "p1", "seq": 42,
  "move": { "x": "fixed", "y": "fixed" }, "aimDir": "fixed", "buttons": "u16 bitmask" }
```

Дискретные действия (касты) SHALL передаваться битами в `buttons`; edge-detection SHALL выполнять `InputSystem`. Тик N исполняется, когда пришли фреймы всех игроков ИЛИ по таймауту — тогда генерируется predicted-фрейм (повтор последнего). Predicted-фреймы SHALL записываться в канонический `inputs[]`, чтобы `(seed + inputs[]) → state` оставался воспроизводимым при реплее, reconciliation и rewind.

#### Scenario: Игрок держит клавишу движения

- **WHEN** игрок удерживает W три тика подряд
- **THEN** приходят три `InputFrame` с ненулевым `move`, а не одно событие «начал идти»

#### Scenario: Фрейм игрока не пришёл вовремя

- **WHEN** сервер по таймауту продвигает тик без фрейма игрока
- **THEN** генерируется predicted-фрейм (повтор последнего) и записывается в канонический `inputs[]`; реплей этого потока даёт то же состояние

#### Scenario: Каст способности

- **WHEN** игрок нажимает Q
- **THEN** соответствующий бит взводится в `buttons`, а `InputSystem` детектирует фронт и превращает его в геймплейное действие

### Requirement: TICK-3 Никаких side-channel API

Мир MUST NOT изменяться вне тика. Симуляция MUST NOT инициировать внешние side-effect'ы; наблюдаемость наружу идёт только через `TickResult`.

#### Scenario: Попытка изменить мир между тиками

- **WHEN** внешний код хочет поправить состояние сущности вне `tick()`
- **THEN** такого API не существует — изменение возможно только через `InputFrame` или системы внутри тика

#### Scenario: Система хочет отправить аналитику

- **WHEN** системе нужно сообщить о событии наружу
- **THEN** она эмитит событие в EventBus, а отправку делает внешний observer после `tick()`

### Requirement: TICK-4 Инпуты обрабатываются системами

Инпуты внутри симуляции SHALL обрабатываться системами (например, `InputSystem` конвертирует их в компоненты/события), а не применяться движком напрямую.

#### Scenario: Преобразование ввода в намерение движения

- **WHEN** `InputSystem` исполняется на тике
- **THEN** она читает `InputFrame` и пишет через Command Buffer компоненты намерения, которые дальше читает система движения

### Requirement: OBS-1 TickResult как read-only отчёт

`tick()` SHALL возвращать `TickResult` — read-only отчёт о тике:

```ts
interface TickResult {
  readonly state: WorldState;        // новый state' (идёт в следующий тик)
  readonly tick: number;
  readonly mode: WorldMode;          // Running | Paused | Rewinding
  readonly isReplay: boolean;        // первый честный проход тика или rewind/reconciliation
  readonly events: ReadonlyEventLog; // события этого тика, read-only view
  readonly changes: ChangeSet;       // per-component dirty-tracking, read-only view
}
```

#### Scenario: Рендер запрашивает результат тика

- **WHEN** рендер получает `TickResult`
- **THEN** ему доступны состояние, события и dirty-набор без обращения к внутренностям ядра

### Requirement: OBS-2 Контракт TickObserver

Внешние потребители SHALL реализовывать `TickObserver.onTick(result)` и SHALL вызываться внешним слоем ПОСЛЕ `tick()`. Аналитика, логи, звук, рендер и netcode-фильтр — частные случаи одного контракта.

```ts
interface TickObserver {
  readonly name: string;
  onTick(result: TickResult): void; // side-effect'ы легальны ТОЛЬКО здесь
}
```

#### Scenario: Подключение аналитики

- **WHEN** нужно собирать метрики по урону
- **THEN** добавляется observer, ядро при этом не меняется и о существовании аналитики не знает

### Requirement: OBS-3 Lifecycle read-only view

`TickResult` SHALL быть read-only view на данные ядра без копирования, валидным только синхронно в рамках `dispatch()` сразу после `tick()`. Потребитель MUST NOT сохранять ссылки на view за пределами этого окна; если данные нужно пережить тик (async-отправка), потребитель SHALL сам скопировать только необходимое. Тот же lifecycle-контракт, что у QUERY-3.

#### Scenario: Асинхронная отправка снапшота по сети

- **WHEN** netcode-слой хочет отправить данные асинхронно
- **THEN** он копирует нужный минимум внутри `onTick`, а не удерживает view до завершения отправки

### Requirement: OBS-4 Фильтрация событий — в потребителе

Категоризация и фильтрация событий SHALL выполняться в потребителе, не в ядре. Событие SHALL описывать доменный факт (`DamageDealt`, `UltimateCast`), а не адресата; маркеры вида `analytics: true` MUST NOT появляться в ядре. Per-client фильтрация событий по видимости — тоже в потребителе (netcode-слой).

#### Scenario: Аналитике нужен только урон по игрокам

- **WHEN** observer аналитики получает полный EventLog тика
- **THEN** он сам отбирает интересные события; ядро не помечает события адресатом

### Requirement: OBS-5 Дедуп при rewind/replay — в потребителе

Дедуп против повторной обработки при rewind/replay SHALL выполняться в потребителе по `mode`/`isReplay`; дедуп-стейт SHALL жить вне детерминированного ядра.

#### Scenario: Аналитика во время перемотки

- **WHEN** тик исполняется повторно при rewind (`isReplay === true`)
- **THEN** аналитика игнорирует его, а логгер реплеев наоборот — реагирует именно на такие тики

### Requirement: OBS-6 Единый dirty-tracking

`TickResult.changes` SHALL быть view на ЕДИНЫЙ per-component dirty-tracking, считаемый один раз за тик. Один источник dirty-данных обслуживает копирование dirty TypedArray в снапшот (SNAP-5), delta против last-acked (NET-8) и внешних observer'ов.

#### Scenario: Снапшот и сетевая дельта на одном тике

- **WHEN** на тике одновременно снимается снапшот и формируется сетевая дельта
- **THEN** оба используют один и тот же посчитанный dirty-набор, а не считают его дважды

## Open Questions

Нерешённые дизайн- и фичасибилити-вопросы, не противоречия ядра. Нормой не являются.

### Гранулярность dirty-tracking

Единый dirty-tracking (OBS-6) обслуживает SNAP-5, NET-8 и `TickResult.changes`. Открыто: per-component или per-entity-per-component — решается замерами на реальной сцене. — *перф.*
