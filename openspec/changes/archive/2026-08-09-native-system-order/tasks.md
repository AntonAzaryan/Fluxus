## 1. Реестр систем

- [x] 1.1 `engine/core-ts/src/systems/registry.ts`: проверку занятого `order` привязать к DET-9 вместо DET-3; сообщение об ошибке SHALL называть значение и обе системы (имя уже зарегистрированной и имя регистрируемой)
- [x] 1.2 Там же: комментарий про равные `order` привести к норме — уникальность и запрет tie-break'а по имени теперь записаны требованием, а не пояснением в коде
- [x] 1.3 Проверить, что `override` (SYS-7) продолжает требовать совпадения `order`, и что его сообщение отличимо от сообщения о конфликте

## 2. Якоря нативных систем

- [x] 2.1 `engine/core-ts/src/systems/inputSystem.ts`: `order` уходит из `InputSystemOptions` и из `DEFAULTS`; якорь −1000 остаётся константой со ссылкой на DET-9
- [x] 2.2 `engine/core-ts/src/systems/time.ts`: `order` уходит из `TimeScaleSystemOptions`; якорь −900, комментарий заменить ссылкой на DET-9
- [x] 2.3 `engine/core-ts/src/systems/tween.ts`: то же, якорь 50
- [x] 2.4 `engine/core-ts/src/systems/physics.ts`: то же, якорь 100
- [x] 2.5 `engine/core-ts/src/systems/arena.ts`: то же, якорь 110
- [x] 2.6 `engine/core-ts/src/systems/visibility.ts`: `order` уходит из `VisibilityOptions`; якорь 900
- [x] 2.7 `engine/core-ts/src/sim/scene.ts` и прочие места регистрации (SER-7: загрузчик регистрирует `TimeScaleSystem`, `TweenSystem`, `ArenaSystem`): убедиться, что `order` никуда не передаётся и передать его нечем
- [x] 2.8 Пройти по `engine/client-ts`, `engine/integration-ts`, `engine/core-ts/bin/sim.mjs`: вызовов с `order` у нативных систем быть не должно

## 3. Тесты ядра

- [x] 3.1 Тест на таблицу DET-9: собранный реестр со всеми шестью нативными системами даёт ровно последовательность `InputSystem`, `TimeScaleSystem`, `TweenSystem`, `PhysicsSystem`, `ArenaSystem`, `VisibilitySystem` — тест обязан краснеть от правки любой из констант
- [x] 3.2 Тест на конфликт: регистрация второй системы с занятым `order` падает, сообщение называет значение и обе системы
- [x] 3.3 Тест на отсутствие tie-break'а: две системы с равным `order` не упорядочиваются по имени ни в каком порядке — регистрация до этого не доходит
- [x] 3.4 Тест на независимость от порядка регистрации (DET-3): один набор систем, зарегистрированный двумя разными последовательностями, даёт один и тот же порядок исполнения
- [x] 3.5 Тест на вставку контента между якорями: JSON-система с `order` из промежутка (100, 110) исполняется после физики и до арены

## 4. Контент и фикстуры на якорных значениях

- [x] 4.1 `content/scenes/duel.scene.json`: сдвинуть `FireballImpact` с `order: 50` (якорь `TweenSystem`) на значение вне якорей; система в сцене последняя, относительный порядок сохраняется
- [x] 4.2 `engine/tests/golden/modifier-stack.scenario.json`: сдвинуть `Slows` с `order: -1000` (якорь `InputSystem`); система в сценарии единственная
- [x] 4.3 Пройти по остальным сценам `content/` и сценариям `engine/tests/golden/` на попадание в якорные значения таблицы DET-9

## 5. LocomotionSystem под шкалой

- [x] 5.1 Дельта `determinism-core`: седьмая строка таблицы DET-9 — `LocomotionSystem`, якорь 0, требование-владелец `locomotion` LOC-1, LOC-2; в перечне оснований — почему интервал (−1000, 100) и почему 0, а не исторические 10
- [x] 5.2 `engine/core-ts/src/systems/locomotion.ts`: `order` уходит из `LocomotionOptions` и из `DEFAULTS`; якорь 0 — константа со ссылкой на DET-9, комментарий о снятии `LevelOverride` до проверки пола арены переведён на якоря
- [x] 5.3 Пройти по местам конструирования `LocomotionSystem` (`sim/scenario.ts`, `net-ts/src/match/world.ts`, демо `client-ts`, тесты, `content/matches/duel.match.json`): `order` не передаёт никто
- [x] 5.4 Тест таблицы DET-9 в `engine/core-ts/test/system.test.ts` — семь систем, `Locomotion` на 0 между `TimeScale` и `Tween`
- [x] 5.5 `engine/schemas/scenario.schema.json`: поле-включатель `locomotion` в схеме отсутствовало вовсе, хотя `ScenarioDef` его поддерживает, — добавлено в генератор `dsl/schemas.ts` (без `order`) и перегенерировано `npm run schemas`
- [x] 5.6 Бандлы редактора: описания полей `schema.scenario.locomotion.*` (ED-28 требует описание на каждое поле схемы), спутник отпечатков пересобран

## 6. Проверка

- [x] 6.1 `npm run typecheck` и `npm test` из корня — зелено
- [x] 6.2 `npm test` из корня: эталоны `engine/tests/golden/` не двинулись — `worldInitHash` от состава и порядка систем не зависит (DET-1), и это проверка того, что change ничего не сдвинул
- [x] 6.3 `openspec validate --change native-system-order --strict` — зелено
- [x] 6.4 Демо запускается на изменённой сцене дуэли: движение, каст, взрыв, разрушение пола — как до change
