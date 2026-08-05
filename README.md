# game-mvp

Сетевой 2.5D action-игровой движок (Diablo/PoE-стиль) с детерминированным ECS-ядром тика.

## `engine/`

Требования, проектная документация и реализация ядра движка. Спека — источник правды о том,
каким движок должен быть; `core-ts/` — его текущая рабочая реализация.

- `openspec/specs/` — **нормативные требования**, 18 capability, 212 требований (DET-, ECS-, NET-, NTR-, NAV-, FOW- …)
- `docs/architecture.md` — обзор слоёв, карта спецификаций, roadmap, открытые вопросы
- `docs/one-pager.md` — что за проект
- `docs/sessions/` — логи проектных сессий (история обсуждений, вне OpenSpec)
- `docs/templates/` — шаблоны ADR и сессий
- `core-ts/` — **реализация ядра** (TypeScript): `src/math`, `src/ecs`, `src/dsl`,
  `src/systems`, `src/sim`; `bin/sim.mjs` — CLI прогона сценария. 385 тестов, 25 файлов.
- `tests/golden/` — 10 пар `*.scenario.json` / `*.golden.json`, побитовые эталоны прогона
- `net-ts/` — **сетевой слой** (TypeScript): сервер матча, протокол, клиент, транспорт
  (loopback и WebSocket). Зависит от `core-ts` односторонне — ядро о сети не знает.
  70 тестов, включая парность отыгранного матча с прогоном сценария ядром.

```sh
cd engine
openspec list --specs               # список capability
openspec spec show netcode          # одна спецификация
openspec validate --specs --strict  # проверка формата
/opsx:propose "<этап roadmap>"      # новое изменение

cd core-ts
npm test            # vitest, 385 тестов
npm run typecheck   # tsc --noEmit
npm run sim         # прогон сценария через CLI
npm run golden      # обновить golden-эталоны (UPDATE_GOLDEN=1)
npm run schemas     # обновить JSON-схемы (UPDATE_SCHEMAS=1)

cd ../net-ts
npm test            # vitest, 70 тестов
npm run serve examples/duel.match.json -- --port 8080   # сервер матча
npm run play  examples/duel.match.json -- --player p1 --keys   # клиент (второй — p2)
```

Локальный матч на двух игроков — три процесса; что смотреть в счётчиках и какие
величины отвечают на «вяло ли ощущается дэш», описано в `engine/net-ts/README.md`.
