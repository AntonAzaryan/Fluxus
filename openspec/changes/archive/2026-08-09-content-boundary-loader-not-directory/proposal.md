# Proposal: content-boundary-loader-not-directory

## Why

Архивация `presentation-scene-layer` положила в sim-поддерево `scenes/` presentation-документ: парный документ сцены лежит рядом с её конфигом и парен ему именем (`presentation-scene` PRES-1), а грузится модулем ассетов. CONT-2 об этом не знает: presentation-контент перечислен в нём как «манифест визуалов, модели, текстуры», и формулировка «два поддерева» читается как «presentation-файл живёт только в presentation-поддереве» — то есть как противоречие PRES-1, которого на деле нет. Границу sim/presentation держит канал загрузки (sim — загрузчик конфига сцены SER-7, presentation — модуль ассетов), а не директория, и CONT-2 должен говорить это прямо.

## What Changes

- Правка CONT-2: перечисление presentation-контента пополняется парным presentation-документом сцены со ссылкой на `presentation-scene` PRES-1; граница слоёв формулируется каналом загрузки, а не расположением файла; соседство парного документа с конфигом сцены в `scenes/` фиксируется как законное — оно куплено парностью именем (PRES-1) и запрет ASSET-1 не ослабляет.
- Сценарий на новый случай: presentation-документ в sim-поддереве — не нарушение CONT-2.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `game-content`: CONT-2 (MODIFIED) — граница sim/presentation задана каналом загрузки; парный presentation-документ сцены внесён в перечисление presentation-контента.

## Impact

Только текст спеки `game-content`; код, тесты и контент не меняются — требование описывает уже действующее положение (PRES-1 реализован). Конкурирующих дельт на `game-content` в очереди нет (проверено по `openspec/changes/*/specs/`).
