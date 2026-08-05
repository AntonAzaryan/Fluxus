# game-mvp

Сетевой 2.5D action-игровой движок (Diablo/PoE-стиль) с детерминированным ECS-ядром тика.

## `docs/`

- `docs/one-pager.md` — что за проект
- `docs/architecture.md` — обзор слоёв, карта спецификаций, roadmap, открытые вопросы

## `openspec/`

**Нормативные требования** — источник правды о том, каким движок должен быть.
`openspec/specs/` разложены по capability (DET-, ECS-, NET-, NTR-, NAV-, FOW- …);
список и объём — `openspec list --specs`. Спека шире TS-пакетов: `editor` —
capability без кода в `engine/`.

## `content/`

**Игровой контент** — политика, которую движок исполняет, но не содержит (CONT-1):
`scenes/` и `matches/` — sim-документы, `visuals/` — манифест визуалов, модели и
текстуры. ID ассета — путь от корня дерева (ASSET-2). Тестовые фикстуры движка
контентом не являются и живут в `engine/` (CONT-4).

## `engine/`

Рабочая реализация движка — пакеты `*-ts`.

### Пакеты

Пакеты — участники npm workspace, корень которого лежит в корне репозитория; один
`npm install` оттуда ставит всё. Зависимости направлены в одну сторону: ядро не знает
ни о сети, ни о рендере.

- `core-ts/` — **ядро** (TypeScript): `src/math`, `src/ecs`, `src/dsl`, `src/systems`,
  `src/sim`; `bin/sim.mjs` — CLI прогона сценария. Рантайм-зависимостей нет вовсе —
  это принцип, а не совпадение
- `net-ts/` — **сетевой слой**: сервер матча, протокол, клиент, транспорты
  (loopback и WebSocket). Зависит от `core-ts` односторонне (NTR-1)
- `assets-ts/` — **реестр ассетов**: загрузчики MDX и PNG, манифест, сервис.
  О three.js не знает — построение сцены живёт в рендере (ASSET-5)
- `render-ts/` — **рендер** на three.js: extractor, host, модели и их подсистемы, viewBuffer
- `client-ts/` — **shell веб-клиента** (SHELL-1..7): ядро в воркере, канал поверх
  transferable-буферов; демо на vite
- `integration-ts/` — **кросс-слойная сюита** (CLI-9): вертикальный прогон, фазз,
  запись golden-матчей

Рядом с пакетами:

- `tests/golden/` — пары `*.scenario.json` / `*.golden.json`, побитовые эталоны прогона;
  `match-*` — записанные loopback-матчи (CLI-10)
- `schemas/` — JSON-схемы, генерируются из ядра; руками не редактируются

### Команды

Node >= 22.18, всё из корня репозитория:

```sh
npm install
npm test          # тесты всех пакетов
npm run typecheck # tsc --noEmit всех пакетов
npm run golden    # перезаписать golden-эталоны (сначала матчи, затем ядро)

openspec list --specs               # список capability
openspec spec show netcode          # одна спецификация
openspec validate --specs --strict  # проверка формата
/opsx:propose "<этап roadmap>"      # новое изменение
```

Команды отдельных пакетов — из их директорий (либо `npm run <script> -w @game-mvp/<name>`
из корня):

```sh
cd engine/core-ts
npm run sim -- ../tests/golden/movement.scenario.json   # прогон сценария через CLI
npm run schemas     # обновить JSON-схемы (UPDATE_SCHEMAS=1)

cd ../client-ts
npm run dev         # демо веб-клиента (vite)

cd ../net-ts
npm run serve ../../content/matches/duel.match.json -- --port 8080        # сервер матча
npm run play  ../../content/matches/duel.match.json -- --player p1 --keys # клиент (второй — p2)
```

Локальный матч на двух игроков — три процесса; что смотреть в счётчиках и какие
величины отвечают на «вяло ли ощущается дэш», описано в `engine/net-ts/README.md`.
