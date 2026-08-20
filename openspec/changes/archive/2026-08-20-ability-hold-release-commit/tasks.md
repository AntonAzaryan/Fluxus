## 1. Формат определения и его разбор

- [x] 1.1 Завести код вида перехода `PHASE_RELEASE` в `engine/core-ts/src/systems/abilities/model.ts` рядом с `PHASE_HOLD`/`PHASE_AUTO`/`PHASE_COMMIT` и расширить тип `AbilityPhaseDef.trigger` значением `'release'` (ABIL-4)
- [x] 1.2 Добавить `release` в словарь `PHASE_TRIGGERS` в `engine/core-ts/src/systems/abilities/catalog.ts` — набор остаётся закрытым, неизвестное значение по-прежнему ошибка загрузки, перечисляющая словарь (ABIL-10)
- [x] 1.3 Расширить перечисление `trigger` в JSON-схеме фазы (`engine/core-ts/src/dsl/abilitySchemas.ts`) и перегенерировать `engine/schemas/*.json` через `npm run schemas` из `engine/core-ts/`
- [x] 1.4 Экспортировать `PHASE_RELEASE` из `engine/core-ts/src/index.ts` рядом с существующими кодами и обновить эталон поверхности `engine/core-ts/test/api-surface.golden.json` прогоном `UPDATE_API=1` (CLI-8)

## 2. Накопление шага на прекращении удержания

- [x] 2.1 Вынести в `engine/core-ts/src/systems/abilities/runtime.ts` общий предикат «удержание бита триггера прекращено», чтобы система прицеливания и система фаз считали его ОДНОЙ функцией (design Decision 3)
- [x] 2.2 Разрешить `TargetingCommitSystem` работать в фазах видов `commit` и `release` (`engine/core-ts/src/systems/abilities/targeting.ts`), сохранив запрет для `hold` и `auto` (ABIL-5)
- [x] 2.3 В фазе `release` записывать очередной незаполненный шаг по прекращению удержания в дополнение к фронту бита подтверждения — один сигнал, один шаг (ABIL-5, design Decision 4)

## 3. Завершение фазы и проверка накопленного

- [x] 3.1 Завершать фазу вида `release` в `CastPhaseSystem` (`engine/core-ts/src/systems/abilities/phase.ts`) по тому же условию, что и `hold`, включая гейт `triggerKind === input` (ABIL-4, design Decision 2)
- [x] 3.2 Выполнять проверку накопленных шагов (`stagedStepsValid`) на завершении фазы вида `release` наравне с `commit`; провал — прерывание источника `targetLost` (ABIL-5, ABIL-6)
- [x] 3.3 Не распознавать источник прерывания `release` в фазе вида `release`, как он уже не распознаётся в фазе `hold` (ABIL-6, design Decision 6)
- [x] 3.4 Убедиться, что ветка `timeout` осталась нетронутой и действует на `release` как на прочие виды (ABIL-4, design Decision 7)

## 4. Тесты

- [x] 4.1 Тест: отпускание в фазе `release` записывает шаг и завершает фазу тем же тиком — наблюдаемы `staged`, `phase` и исполненные `effects` (ABIL-4, ABIL-5)
- [x] 4.2 Тест: цель, потерянная к отпусканию, даёт прерывание источника `targetLost` с умолчаниями исхода (ABIL-5, ABIL-6)
- [x] 4.3 Тест: истечение `durationTicks` при всё ещё удерживаемом бите следует `timeout.then` — и на `cancel`, и на переходе в названную фазу (ABIL-4)
- [x] 4.4 Тест: цепочка длиннее одного шага в фазе `release` набирается фронтами подтверждения и закрывается отпусканием (ABIL-5)
- [x] 4.5 Тест: объявленный источник прерывания `release` в фазе `release` не срабатывает (ABIL-6)
- [x] 4.6 Тест компиляции: `trigger: "release"` принимается, неизвестное значение по-прежнему ошибка загрузки со словарём в тексте (ABIL-10)
- [x] 4.7 Тест: путь фронта бита подтверждения в фазе `commit` не изменился — существующие сценарии остаются зелёными без правок

## 5. Гейт

- [x] 5.1 Прогнать `npm run check` из корня и убедиться, что golden- и cost-эталоны НЕ сдвинулись: новое значение не использует ни одно определение, и сдвиг означал бы задетую старую ветку
- [x] 5.2 Прогнать чек-лист `determinism-review` по собственному диффу `engine/core-ts`
