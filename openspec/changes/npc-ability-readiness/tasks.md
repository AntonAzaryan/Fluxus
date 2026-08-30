# npc-ability-readiness — tasks

## 1. Предикат готовности в модуле abilities

- [ ] 1.1 Экспортировать из `engine/core-ts/src/systems/abilities/runtime.ts` предикат готовности слота (`phase < 0 && cooldownRemaining === 0`) и перевести гейт `tryStart` в `phase.ts` на него (или на его слагаемые из одного места); проверка — существующие `abilities.test.ts` зелёные без правок ожиданий.

## 2. Вход `abilityReady` в словаре NPC

- [ ] 2.1 Добавить `abilityReady` в `NPC_INPUTS` (в конец набора, существующие коды не переставлять) и `INPUT_ABILITY_READY` в `model.ts`; отразить в `INPUT_CODES` в `tables.ts`; проверка — `npx vitest run test/npc.test.ts` падает на exhaustive-словаре, пока не сделаны 2.2–2.4 (typecheck-гейт словаря сработал).
- [ ] 2.2 Форма и валидация документа: `slot?: number` у `NpcConsiderationDef`, `slot: number` (−1 = не назван) у `CompiledConsideration`; в `document.ts` — `slot` обязателен и целый ≥ 0 у `abilityReady`, находка у любого другого входа (зеркало ботовской валидации `BotConsideration.slot`); проверка — новые кейсы валидации в `npc.test.ts`.
- [ ] 2.3 Вычисление входа в `NpcDecider.inputValue` (`decide.ts`): поиск слота агента линейным обходом выборки `AbilitySlot` (design Decision 3), значение через предикат из 1.1, слот не найден → 0; handles полей — через `handles.ts`, разрешение имён один раз; проверка — пара «срабатывает/не срабатывает» в exhaustive-покрытии `npc.test.ts` (готовый слот → `FIXED_ONE`; кулдаун > 0, активная фаза, чужой слот, отсутствующий `slotIndex` → 0).
- [ ] 2.4 JSON Schema: условная ветка по входу в `dsl/npcSchemas.ts` (у `abilityReady` поле `slot` обязательно, у прочих запрещено), регенерация `npm run schemas`; проверка — диф `engine/schemas/*.json` в коммите и зелёный schema-тест.
- [ ] 2.5 Прогнать `npm run check` от корня после движковой части; golden-эталоны не должны измениться (новый вход существующими документами не используется) — красный golden здесь означает дефект, а не регенерацию.

## 3. Босс демо-арены на новом входе

- [ ] 3.1 Переписать `npc.behaviors[0]` в `content/scenes/duel.scene.json` по design Decision 6: одно состояние ротации, `seekTarget` + три `cast`-действия с осями `abilityReady` (реальные `slotIndex` слотов босса из prefab'а) и `targetDistance` (пороги 5.0 / 1.8 из сенсора); проверка — сцена валидна, `demoScene.test.ts` зелёный.
- [ ] 3.2 Снести систему `BossReady` и события `Boss{Slam,Strike,Charge}Ready` из сцены; busy-подавление (даш/стаггер) — по design Decision 7, если debug-прогон покажет деградацию боя; проверка — в сцене не осталось упоминаний `BossReady`/`*Ready`-событий (grep), `npm test -w @fluxus/demo` зелёный после 3.4.
- [ ] 3.3 Обновить словарь журнала `game/demo-ts/app/journal/duel.dictionary.json` и прочие упоминания снесённых событий (extractor, манифест — если ссылаются); проверка — `demoJournal.test.ts` зелёный, grep по `SlamReady|StrikeReady|ChargeReady` пуст вне openspec/.
- [ ] 3.4 Переписать `game/demo-ts/test/demoBoss.test.ts` на новую структуру: сенсора нет, cast-действия несут ось `abilityReady` с существующим `slotIndex` босса, дистанционные оси зеркалят пороги; шапка-комментарий теста — про новый механизм; проверка — тест зелёный и падает при возврате сенсора/потере оси.
- [ ] 3.5 Прогнать `npm run demo:debug` и прочитать журнал: касты всех трёх способностей случаются, boss не замирает, событий готовности в трейсе нет как класса; ориентир частоты — порядка досенсорной (~39 кастов/3600 тиков), не эталон; итог прогона — в описание коммита контентной части.

## 4. Гейт и синхронизация

- [ ] 4.1 `npm run check` от корня целиком (lint:all + spec-graph check + test) зелёный; упоминания NPC-7/ABIL-7 в новом коде — там, где код их реализует (spec-graph видит citing code).
- [ ] 4.2 `npm run bots:sync -- --check` либо соответствующий demo-тест зелёный (правка сцены не должна была тронуть таблицу `abilities`, но верификация BOT-13 входит в гейт).
