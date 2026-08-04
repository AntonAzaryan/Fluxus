# game-mvp

Сетевой 2.5D action-игровой движок (Diablo/PoE-стиль) с детерминированным ECS-ядром тика.

Репозиторий разделён на две независимые части:

## `engine/` — актуальное

Требования, проектная документация и реализация ядра движка. Спека — источник правды о том,
каким движок должен быть; `core-ts/` — его текущая рабочая реализация.

- `openspec/specs/` — **нормативные требования**, 17 capability, 199 требований (DET-, ECS-, NET-, FOW- …)
- `docs/architecture.md` — обзор слоёв, карта спецификаций, roadmap, открытые вопросы
- `docs/one-pager.md` — что за проект
- `docs/sessions/` — логи проектных сессий (история обсуждений, вне OpenSpec)
- `docs/templates/` — шаблоны ADR и сессий
- `core-ts/` — **реализация ядра** (TypeScript): `src/math`, `src/ecs`, `src/dsl`,
  `src/systems`, `src/sim`; `bin/sim.mjs` — CLI прогона сценария. 385 тестов, 25 файлов.
- `tests/golden/` — 10 пар `*.scenario.json` / `*.golden.json`, побитовые эталоны прогона

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
```

## `draft/` — черновик-песочница

Разведка боем: пробовали, как оно работает. Отдельный npm-workspace, живёт своей жизнью, не является источником правды.

- `AGENTS.md` — карта песочницы для агентов
- `spec/` — YAML-спека ECS (компоненты, системы, события, архетипы)
- `ts-impl/` — TypeScript-реализация ядра + тесты
- `ts-render/` — рендер-прототип на Three.js

```sh
cd draft && npm test        # 85 тестов ядра (ts-impl)
cd draft && npm run dev:render
```
