## 1. Контент

- [x] 1.1 Написать `content/scenes/duel.scene.json`: компоненты и prefab'ы демо-сцены, `Movement` по `Velocity` (order 10), `KillSwitch` (20), `Cast` с эмитом `CastFireball { entity, slot, tick }` и `not: ["Dead"]` (30), `FireballFlight` (40), террейн демо; удалить `duel-net.scene.json` и `duel-demo.scene.json`
- [x] 1.2 `content/matches/duel.match.json`: `contentPack` → `../scenes/duel.scene.json`, добавить `"physics": {}`

## 2. Сетевой слой: зависимости сборки из файла матча (NTR-14)

- [x] 2.1 `engine/net-ts/bin/serve.mjs`: передавать `match.physics` в `MatchServer`
- [x] 2.2 `engine/net-ts/bin/play.mjs`: передавать `match.physics` в `MatchClient`

## 3. Демо

- [x] 3.1 `engine/client-ts/demo/worker.ts`: импорт `duel.scene.json`, `aimEvents: ['FireballAimed']`
- [x] 3.2 `engine/client-ts/demo/sim.ts`: нативный спавн (`FireballLaunch`, order 35) читает события `CastFireball` тика вместо собственного фронта кнопки, спавнит снаряд по распакованному `aimDir`, эмитит `FireballAimed { entity, dirX, dirY }`; собственный эмит `CastFireball` убран

## 4. Интеграционная вертикаль и эталоны

- [x] 4.1 `engine/integration-ts/test/fixtures.ts`: `duelScene()` — `Velocity`+`Collider` у Hero, `Movement` демо-версии; `duelConfig()` — `physics: {}`; `RenderBridge` передаёт `physics` в `buildMatchWorld`
- [x] 4.2 Перезаписать эталоны: `npm run record`, затем `npm run golden` из корня; дифф `engine/tests/golden/match-*` — в коммит
- [x] 4.3 Зелёные `npm test` и `npm run typecheck` из корня
