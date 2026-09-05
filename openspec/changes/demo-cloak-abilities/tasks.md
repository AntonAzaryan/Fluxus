# Tasks: demo-cloak-abilities

Порядок — герой, затем босс, затем сборка игры и проверки. Всё — данные и тесты; `engine/` не трогается.

## 1. Сцена: каналы, компоненты, герой

- [x] 1.1 `duel.scene.json`: `softStealthChannels: [0]`; компоненты `Cloaking { startTick: i32, ticks: i32 }` и `Cloaked { atTick: i32 }`; `StealthSources: {}` у префабов `Hero`, `Boss`, `BossMinion`; сцена грузится (`demoScene.test.ts`)
- [x] 1.2 Баффы-звенья `cloakFade` (60 тиков, без правок, страж `Cloaking`, на предпоследнем тике заводит `cloakSoft`, истекая — снимает `Cloaking` и кладёт `Cloaked`), `cloakSoft` (60 тиков, `StealthSources` = 1, страж `Cloaked`, заводит `cloakHard`) и `cloakHard` (300 тиков, значение 2, страж `Cloaked`, `onExpire` снимает `Cloaked`); префабы `BuffCloakFade`/`BuffCloakSoft`/`BuffCloakHard`; тест `demoCloak.test.ts`: маска 0 на затухании, 1 на силуэте, 2 на полной, 0 после — семь секунд от каста, звенья сменяются без просвета маски
- [x] 1.3 Способность `cloak` (мгновенная: ввод бит 10, условия как у щита плюс «не под `Cloaking`/`Cloaked`», кулдаун 1200, кладёт `Cloaking`, спавнит `cloakFade`, событие `HeroCloak`); слот `SlotCloak` (`slotIndex 7`) в `GrantSlots`; тест: на затухании маска 0 и герой виден врагу, на силуэте виден (мягкий канал), в полной — нет (NET-15), себе — всегда
- [x] 1.4 Система `CloakBreak` (order 200, design 4): манёвр, смерть, фаза чужого слота, события мгновенных кастов → снятие маркеров и `CloakBreak`; тесты: прыжок, рывок, щит, купол, заряд фаербола, ульта, смерть — каждый снимает; движение и урон не снимают; каст на затухании — силуэта нет, кулдаун потрачен; повторный каст под невидимостью не проходит

## 2. Сцена: босс и миньоны

- [x] 2.1 Баффы `bossCloakFade` (60 тиков, заводит `bossCloak`) и `bossCloak` (240 тиков, значение 1, страж `Cloaked`, `onExpire` снимает `Cloaked`); префабы; способность `bossCloak` (мгновенная по просьбе `BossCloak`, кулдаун 1200, `Cloaking` и затухание на боссе и живых миньонах без маркеров, событие `BossCloakStart`); слот `SlotBossCloak` (`slotIndex 6`) в `GrantBossSlots`, `BossBusy` держит и его; тесты: босс в силуэте пять секунд от каста без жёсткой фазы; живые на момент каста миньоны уходят вместе с ним; призванный после — без маски
- [x] 2.2 `bossCharge`: `onEnter` фазы `aim` снимает маркеры с босса и каждого миньона и эмитит им `CloakBreak`; тесты: разгон снимает со всех; удар из силуэта не снимает
- [x] 2.3 Поведение `arenaBoss`: действие `cast` с событием `BossCloak` (слот 6, `abilityReady`, `targetKnown`, константа 0.7); `demoBoss.test.ts` (списки слотов ротации дополнены) и `demoCloak.test.ts`: босс просит невидимость сам
- [x] 2.4 `BossTarget` уважает стелс (design 6): скрытый герой — не цель и не кандидат жребия, потеряв всех — `hunted` = −1; тест NPC-10 на сцене: на затухании босс идёт к герою, на силуэте стоит без цели и жертвы, по концу — снова находит

## 3. Сборка игры

- [x] 3.1 `sim.ts`: `ACTION_BITS.cloak: 10`, `ABILITY_SLOTS.cloak: 7`, кулдаун-источник и восьмая кнопка панели; `bindings.json`: `KeyC`, геймпад `10`, тач-кнопка; `bindings.test.ts` и `demoHud.test.ts` зелёные
- [x] 3.2 `extractor.ts`: статы `cloakStart`/`cloakTicks` из `Cloaking` (состояния CAM-6 не заводятся — биты колонки исчерпаны, design 8); `demoAbilities.test.ts`/`demoHud.test.ts` зелёные
- [x] 3.3 `stealthTint.ts`: доля затухания по доставленному тику и `cloakStart`/`cloakTicks` — непрозрачность идёт к значению вида линейно за фазу; `main.ts` отдаёт тик доставки; `stealthTint.test.ts`: середина фазы — половина пути, конец — значение вида, перемотка до каста — обычная подача, без тика доставки затухание не ведётся
- [x] 3.4 HUD: `content/visuals/icons/cloak.svg`, `ABILITY_ICONS.cloak`, действие `hero.cloak`; `demoHud.test.ts` видит восьмую кнопку
- [x] 3.5 Манифест: `HeroCloak → "Spell"` у `Hero`, `BossCloakStart → "Spell Defend"` у `Boss`; `demoDocuments.test.ts` зелёный
- [x] 3.6 Журнал: `HeroCloak`, `CloakBreak`, `BossCloak`, `BossCloakStart` в `duel.dictionary.json`; `demoJournal.test.ts` зелёный
- [x] 3.7 Боты: аннотации нет — кулдаун определения за диапазоном профиля (design 9); `botContract.test.ts` и `botsSync.test.ts` зелёные без правок профилей

## 4. Проверки

- [x] 4.1 `npm run check` зелёный целиком; `contentBoundary.test.ts` и голдены движка без диффа
- [ ] 4.2 **[вручную]** Арена: `C` — герой гаснет секунду, секунду виден силуэтом, пять секунд невидим; прыжок/рывок/каст снимают; босс уходит в невидимость с миньонами, разгон возвращает всех; после потери героя босс стоит
