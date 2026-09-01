## 1. Дельта спеки match-hud

- [x] 1.1 HUD-2: две формы мирового действия (фронт и удержание), форма объявляется композицией, обе идут тем же сборщиком ввода и доступны и указателем, и клавиатурой, удержание начинает только основной орган, автоповтор не нажатие, утрата органа (включая уход фокуса окна) снимает удержание, кнопка-заглушка запрещена — проверка: `npx openspec validate sec08-hud-actions-and-icons --type change --strict` зелёный

## 2. HUD-2: форма «удержание» в контракте действий

- [x] 2.1 `engine/hud-ts/src/actions.ts`: множество удерживаемых семантических действий, `held()` контракта `InputSource`, методы `hold`/`release`; удержание не-мирового действия — названная ошибка; `stop()` снимает всё — проверка: новые тесты в `engine/hud-ts/test/actions.test.ts`
- [x] 2.2 `engine/hud-ts/src/widget.ts`: порт действий виджета получает `hold(slot)`/`release(slot)` рядом с `trigger` — проверка: типы собираются, стенды тестов обновлены
- [x] 2.3 `engine/hud-ts/src/runtime.ts`: `portFor` разрешает слот в имя одним путём для всех трёх методов — проверка: `npx vitest run test/runtime.test.ts` (или `host.test.ts`) зелёный
- [x] 2.4 `engine/hud-ts/src/widgets/cooldowns.ts`: параметр записи `hold`; кнопка формы «удержание» берётся ОСНОВНЫМ органом (`pointerdown` с `button === 0` и `isPrimary`) и клавишами активации элемента (Space/Enter, автоповтор не в счёт), отпускается по `pointerup`/`pointerleave`/`pointercancel`/`keyup`/`blur` и по уходу фокуса ОКНА, `click` не слушает вовсе; `dispose` отпускает всё и отписывается от окна — проверка: тесты «кнопка удержания даёт бит все тики и гаснет отпусканием», «не-основная кнопка удержания не начинает», «клавиатурный путь», «уход фокуса снимает удержание» (HUD-2, INP-5)
- [x] 2.5 Демо: `hero.rewind` становится обычным мировым действием, запись панели получает `hold: true`; `HOLD_ONLY_ABILITIES`, `markHoldOnlyAbilities` и её вызов в `main.ts` удалены — проверка: `npx vitest run test/demoHud.test.ts -w @fluxus/demo`

## 3. HUD-4: иконки тем же слоем ассетов, что у рендера

- [x] 3.1 `engine/hud-ts/src/icons.ts`: вид ассета «иконка HUD» и его загрузчик (байты → `src`), регистрируемый в ОБЩЕМ реестре загрузчиков (ASSET-3) — проверка: тест загрузчика в `engine/hud-ts/test/icons.test.ts`
- [x] 3.2 `engine/hud-ts/src/icons.ts`: `HudIcons` — подписка на готовность иконки поверх переданного `AssetService` (класс, а не интерфейс: вторую адресацию контента реализовать нечем); второго кэша нет (ASSET-2, HUD-7) — проверка: тест «повторный запрос того же ID не грузит файл дважды»
- [x] 3.3 `engine/hud-ts/src/widgets/cooldowns.ts`: `src` проставляется по готовности, состояние иконки видно атрибутом `data-icon` (`loading`/`ready`/`failed`), подписки снимаются на `dispose` — проверка: тест на все три состояния
- [x] 3.4 `game/demo-ts/app/hud.ts`: источник иконок — тот же `AssetService`, что у рендера арены и портрета; склейка `'/' + assetId` удалена — проверка: `npx vitest run test/demoHud.test.ts -w @fluxus/demo`
- [x] 3.5 Таблица «идентификатор из симуляции → asset ID» и отказ от URL в композиции остаются как были (HUD-4) — проверка: прежние тесты `icons.test.ts` зелёные

## 4. Ворота

- [x] 4.1 Пакетные тесты `@fluxus/hud`, `@fluxus/client`, `@fluxus/assets`, `@fluxus/demo` зелёные
- [x] 4.2 `npm run typecheck`, `npm run lint`, `npm run lint:dead`, `npm run spec-graph -- check`, `npx openspec validate --specs --strict` и `--changes --strict` зелёные
- [x] 4.3 Дельта слита в основные спеки (`openspec/specs/match-hud/spec.md`) — change остаётся незаархивированным
