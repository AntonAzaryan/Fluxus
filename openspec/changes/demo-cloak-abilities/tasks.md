# Tasks: demo-cloak-abilities

Порядок — герой, затем босс, затем сборка игры и проверки. Всё — данные и тесты; `engine/` не трогается.

## 1. Сцена: каналы, компоненты, герой

- [ ] 1.1 `duel.scene.json`: `softStealthChannels: [0]`; компоненты `Cloaking { startTick: i32, ticks: i32 }` и `Cloaked { atTick: i32 }`; `StealthSources: {}` у префабов `Hero`, `Boss`, `BossMinion`; сцена грузится (`demoScene.test.ts`)
- [ ] 1.2 Баффы `heroCloakSoft` (60 тиков, `StealthSources` = 1, реакция на `CloakBreak`, `onExpire`: при `dispelled == 0` спавн `heroCloakHard`, иначе снятие `Cloaked`) и `heroCloakHard` (300 тиков, значение 2, реакция на `CloakBreak`, `onExpire` снимает `Cloaked`); префабы `BuffHeroCloakSoft`/`BuffHeroCloakHard`; тест: маска стелса героя 1 на тиках 60–119 и 2 на 120–419 от каста, 0 после
- [ ] 1.3 Способность `cloak` (ввод бит 8, условия как у щита плюс «не под `Cloaking`/`Cloaked`», кулдаун 1200, фаза `fade` 60 тиков с `Cloaking` в `onEnter`, коммит под условием стоящего `Cloaking`, событие `HeroCloak`); слот `SlotCloak` (`slotIndex 7`) в `GrantSlots`; тест: на тиках 0–59 маска 0 и герой таргетируем, на 60-м — 1
- [ ] 1.4 Система `CloakBreak` (design 4): манёвр, фаза чужого слота, события мгновенных кастов → `CloakBreak`, снятие `Cloaking`/`Cloaked`; `order` по шкале сцены; тесты: прыжок, рывок, щит, заряд фаербола, бросок, ульта — каждый снимает в тот же тик; затухание не рвёт само себя; урон и движение не снимают; каст на 30-м тике затухания — баффа нет

## 2. Сцена: босс и миньоны

- [ ] 2.1 Бафф `bossCloak` (240 тиков, значение 1, реакция на `CloakBreak`, `onExpire` снимает `Cloaked`) и префаб `BuffBossCloak`; способность `bossCloak` (триггер `BossCloak`, кулдаун 1200, фаза `fade` 60 тиков с `Cloaking` на боссе и живых миньонах, коммит — бафф и `Cloaked` на всех них, событие `BossCloakStart`); слот `SlotBossCloak` (`slotIndex 6`) в `GrantBossSlots`; тест: босс и два живых миньона под маской 1 с 60-го по 299-й тик, миньон, заспавненный после каста, — без маски
- [ ] 2.2 `bossCharge`: `onEnter` фазы `aim` эмитит `CloakBreak` боссу и каждому миньону и снимает `Cloaking`/`Cloaked`; тест: разгон на 150-м тике невидимости снимает её со всех в тот же тик; удар, топот, поле и атака миньона — не снимают
- [ ] 2.3 Поведение `arenaBoss`: действие `cast` с событием `BossCloak` (слот 6, `abilityReady`, `targetKnown`, дистанция, вес ниже разгона); тест `demoBoss.test.ts`: босс кастует невидимость в прогоне и не делает этого без готового слота
- [ ] 2.4 Тест NPC-10 на сцене: герой под мягким каналом в радиусе `sense` — босс и миньоны без цели и без движения к нему; вышел из невидимости — цель возвращается в окно каденса

## 3. Сборка игры

- [ ] 3.1 `sim.ts`: `ACTION_BITS.cloak`; `bindings.json`: `KeyC`, геймпад `10`, тач-кнопка; `bindings.test.ts` зелёный, коллизий с `confirmBit`/`cancelBit` захвата нет
- [ ] 3.2 `extractor.ts`: статы `cloakStart`/`cloakTicks` из `Cloaking`, состояния `Cloaking`/`Cloaked` в словаре состояний; тест извлечения
- [ ] 3.3 `stealthTint.ts`: доля затухания по доставленному тику и `cloakStart`/`cloakTicks` — непрозрачность идёт к значению вида линейно за фазу; `stealthTint.test.ts`: середина фазы — половина пути, перемотка до каста — обычная подача
- [ ] 3.4 HUD: `content/visuals/icons/cloak.svg`, `ABILITY_ICONS.cloak`, слот в панели; `demoHud.test.ts` видит восьмой слот с иконкой
- [ ] 3.5 Манифест: `HeroCloak → "Spell"` у `Hero`, `BossCloakStart → "Spell Defend"` у `Boss`; `demoDocuments.test.ts` зелёный
- [ ] 3.6 Журнал: `HeroCloak`, `BossCloakStart`, `CloakBreak` в `duel.dictionary.json`; `demoJournal.test.ts`: прогон `demo:debug` не называет неизвестных типов
- [ ] 3.7 Боты: `duel.bots.json` — `cloak: { target: "threat", range: 8 }`; `npm run bots:sync`; `botsSync.test.ts` и `botHints.test.ts` зелёные

## 4. Проверки

- [ ] 4.1 `npm run check` зелёный целиком; `contentBoundary.test.ts` и голдены движка без диффа
- [ ] 4.2 **[вручную]** Арена: `C` — герой гаснет секунду, секунду виден силуэтом, пять секунд невидим; прыжок/рывок/каст снимают; босс уходит в невидимость с миньонами, разгон возвращает всех; после потери героя босс стоит
