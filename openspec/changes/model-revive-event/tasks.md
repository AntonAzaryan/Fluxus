# Tasks: model-revive-event

## 1. Спека

- [x] 1.1 Дельта `rendering`: REND-4 — событие возрождения снимает фиксацию последнего кадра клипа смерти, сценарий «Возрождение возвращает модель»
- [x] 1.2 Дельта синхронизирована в `openspec/specs/rendering/spec.md` (блок байт-в-байт)
- [x] 1.3 `openspec validate model-revive-event --strict` и `npm run spec-graph -- check` зелёные

## 2. Рендер

- [x] 2.1 `engine/render-ts/src/model/animation.ts`: опция `reviveEvent`, снятие фиксации общим `releaseDeath` с `onSnap`, состояние копится и под фиксацией
- [x] 2.2 `engine/render-ts/src/subsystems/models.ts`: опция `reviveEvent` подсистемы и проброс в контроллер — тем же путём, что `deathEvent`

## 3. Сборка демо

- [x] 3.1 `game/demo-ts/app/sim.ts`: `RESPAWN_EVENT` — одно имя события сцены на всю сборку
- [x] 3.2 `game/demo-ts/app/main.ts`: `reviveEvent: RESPAWN_EVENT` подсистеме моделей; `app/hud.ts` читает ту же константу

## 4. Тесты

- [x] 4.1 `engine/render-ts/test/animation.test.ts`: возврат в клип состояния, no-op на живом контроллере, неназванное событие ничего не значит
- [x] 4.2 `engine/render-ts/test/models.test.ts`: детальный ярус — геосеты, погашенные концом клипа смерти, возвращаются возрождением
- [x] 4.3 `engine/render-ts/test/batched.test.ts`: VAT-ярус — то же поведение, и событие чужой сущности не оживляет соседа
- [x] 4.4 `game/demo-ts/test/demoAbilities.test.ts`: убийство → 600 тиков → событие возрождения доезжает доставленным видом без `snapAll`
