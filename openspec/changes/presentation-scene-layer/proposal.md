# Proposal: presentation-scene-layer

## Why

По ED-17 decorations существуют только в presentation-слое: парный к сцене документ расстановки, не входящий в `worldInit`, снапшоты и сетевой трафик. Обязанность редактора вести слой нормирована (`scene-editor`), формата документа нет.

## What Changes

- Формат парного presentation-документа сцены: расстановка decorations (ссылка на визуал, позиция, поворот, масштаб), связь с манифестом визуалов, привязка к сим-сцене по имени/пути.
- Загрузка через модуль ассетов (ASSET-1..4): типизированный handle, «правка не меняет `worldInit`, снапшоты и golden» — по образцу карты кривизны ASSET-7.
- Рендер decorations: инстансы из тех же разделяемых ассетов (REND-3), без записи в снапшот — источник не `TickResult`, а документ.

## Capabilities

### New Capabilities

Нет (ожидается: `assets` + `rendering`; возможно, `game-content` — место документа в дереве `content/`).

### Modified Capabilities

- `assets`: формат и загрузка парного документа сцены — следующий свободный ASSET-номер.
- `rendering`: отрисовка decorations из документа — следующий свободный REND-номер.

## Impact

Пакеты `assets-ts`, `render-ts`; `content/`. Симуляция не затрагивается; конфиг сцены не меняется.

## Notes

Стаб: артефакты specs/design/tasks пусты намеренно, продолжение — `/opsx:update presentation-scene-layer`. Решить в design: как рендер получает документ вне `TickResult` (REND-1 нормирует вход от симуляции — decorations входом симуляции не являются; вероятно, параметр инициализации подсистемы, как терраин-грид); нужна ли decorations посадка по нормали REND-10; deterministic-инвариант «сцена с decorations и без байт-в-байт равны в golden» — тестом. Блокирует реализацию ED-14/ED-17 в части decorations; спеку `scene-editor` не блокирует.
