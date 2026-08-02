# Time & Tween System Specification

## Purpose

Управление симуляционной скоростью отдельных сущностей (time-манипуляции как геймплейная фича) и интерполяции значений. Tick rate при этом остаётся фиксированным — замедление живёт в данных, а не в частоте тика.

## Requirements

### Requirement: TIME-1 Фиксированный tick rate

Tick rate SHALL быть фиксированным (60 Hz базово) и MUST NOT меняться от time scale.

#### Scenario: Замедление зоны времени

- **WHEN** в мире активна зона замедления
- **THEN** симуляция по-прежнему тикает 60 раз в секунду, а замедление выражается через `TimeScale` сущностей

### Requirement: TIME-2 Компонент TimeScale

`TimeScale { value: fixed }` SHALL быть компонентом, влияющим на симуляционную скорость сущности внутри тика.

#### Scenario: Снаряд в зоне замедления

- **WHEN** снаряду выставлен `TimeScale.value = 0.5`
- **THEN** за тик он проходит половину обычной дистанции

### Requirement: TIME-3 getEffectiveDelta

Ядро SHALL предоставлять `getEffectiveDelta(entity, globalDelta)` = `globalDelta * TimeScale.value`, где значение по умолчанию — 1.0.

#### Scenario: Сущность без компонента TimeScale

- **WHEN** система запрашивает effective delta для сущности без `TimeScale`
- **THEN** возвращается `globalDelta` без изменений

### Requirement: TIME-4 Opt-in per-system

Системы SHALL явно выбирать, учитывать ли TimeScale. Глобальный override MUST NOT применяться.

#### Scenario: Добавление новой системы

- **WHEN** пишется система, работающая со временем
- **THEN** автор явно решает, брать `getEffectiveDelta` или `globalDelta`; движок за него не решает

### Requirement: TIME-5 Типичное применение TimeScale

TimeScale SHALL применяться к движению снарядов, физике и `LifetimeSystem` (по решению автора системы) и MUST NOT применяться к cooldown'ам, глобальным таймерам и animation speed.

#### Scenario: Замедленный игрок кастует способность

- **WHEN** игрок под `TimeScale.value = 0.5` использует способность с cooldown 10 с
- **THEN** cooldown идёт в обычном темпе, а движение и снаряды — замедленно

### Requirement: TIME-6 Замедление персонажа через параметры

Замедление персонажа SHALL выражаться через параметры (`MoveSpeedModifier`, `AttackSpeedModifier` и т.п.) на геймплейном слое, а не через core-механизм TimeScale.

#### Scenario: Дизайнер добавляет слоу-эффект

- **WHEN** нужно замедлить передвижение цели на 30%
- **THEN** это делается модификатором скорости, а не подкруткой `TimeScale`

### Requirement: TIME-7 Стакинг через sources

`TimeScaleModifiers { sources: [{id, value}] }` SHALL быть core-контрактом стакинга, где:

- reducer = произведение всех `sources[].value`;
- итог SHALL клампиться в `[0.05, 4.0]` — техническая защита от деления на ~0 в `getEffectiveDelta`, не балансный кап;
- композиционная политика (стак / «берём сильнейший» / аддитив) SHALL жить вне core, на геймплейном слое, через управление списком `sources`.

Пример: «сильнейший слоу» = система-владелец держит в `sources` один источник с минимальным `value`; core перемножает список из одного элемента. Тот же паттерн переиспользуется для `VisionModifier`.

#### Scenario: Два независимых замедления

- **WHEN** на сущность действуют источники 0.5 и 0.5
- **THEN** core перемножает их в 0.25; хочет ли дизайн такого стакинга — решается управлением списком `sources`, а не изменением reducer'а

#### Scenario: Источник с околонулевым значением

- **WHEN** произведение источников даёт 0.001
- **THEN** результат клампится в 0.05, деления на ~0 не происходит

### Requirement: TIME-8 Управление источниками из систем

Источники SHALL добавляться и сниматься системами (например, `TimeDomeSystem`).

#### Scenario: Выход из зоны замедления

- **WHEN** сущность покидает купол
- **THEN** система-владелец удаляет свой источник из `sources`, и скорость восстанавливается

### Requirement: TIME-9 TimeScale игнорируется во время Rewinding

Во время `Rewinding` компоненты TimeScale SHALL игнорироваться — темп задаёт rewind-механизм. Это следствие того, что обычные системы во время Rewinding выключены.

#### Scenario: Перемотка мира с замедленными сущностями

- **WHEN** мир перематывается, а часть сущностей была под `TimeScale`
- **THEN** перемотка идёт единым темпом rewind-механизма, без учёта индивидуальных скоростей

### Requirement: TWEEN-1 Компонент Tween

Твин SHALL описываться компонентом `Tween { target, from, to, duration, elapsed, easing, onComplete }`.

#### Scenario: Плавное восстановление здоровья

- **WHEN** способность лечит цель за 2 секунды
- **THEN** создаётся `Tween` с `target: "Health.value"` и нужной длительностью

### Requirement: TWEEN-2 Набор easing

Easing SHALL включать минимум `linear` и `instant` и SHALL быть расширяемым.

#### Scenario: Мгновенное применение значения

- **WHEN** нужен скачок без интерполяции
- **THEN** используется `instant`, а не твин нулевой длительности со спецобработкой

### Requirement: TWEEN-3 target как путь к полю

`target` SHALL быть путём к полю компонента (например, `"Health.value"`).

#### Scenario: Твин по полю вложенного компонента

- **WHEN** задаётся `target: "TimeScale.value"`
- **THEN** твин пишет именно в это поле, без специального кода под каждый компонент

### Requirement: TWEEN-4 onComplete как action

`onComplete` SHALL быть action и SHALL исполняться по завершении твина.

#### Scenario: Взрыв по окончании подлёта

- **WHEN** твин перемещения снаряда завершился
- **THEN** исполняется `onComplete`-action, порождающий взрыв через Command Buffer

### Requirement: TWEEN-5 Создание через addTween

Твины SHALL создаваться через action `addTween`.

#### Scenario: Создание твина из JSON-системы

- **WHEN** JSON-система хочет анимировать значение
- **THEN** она вызывает `addTween`, порождающий команду; прямого создания компонента `Tween` в обход буфера нет

### Requirement: TWEEN-6 Нативный TweenSystem

`TweenSystem` SHALL тикать нативно, не через JSON.

#### Scenario: Продвижение всех активных твинов

- **WHEN** наступает очередь `TweenSystem` в тике
- **THEN** она обновляет `elapsed` и целевые поля напрямую, без прохода через evaluator

### Requirement: TWEEN-7 Учёт TimeScale настраивается per-tween

Учёт TimeScale SHALL настраиваться отдельно для каждого твина.

#### Scenario: UI-анимация на замедленной сущности

- **WHEN** твин помечен как игнорирующий TimeScale
- **THEN** он идёт в обычном темпе, даже если сущность замедлена
