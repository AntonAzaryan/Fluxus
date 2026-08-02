# game-mvp

Сетевой 2.5D action-игровой движок (Diablo/PoE-стиль) с детерминированным ECS-ядром тика.

Репозиторий разделён на две независимые части:

## `engine/` — актуальное

Требования и проектная документация движка. Источник правды о том, каким движок должен быть.

- `openspec/specs/` — **нормативные требования**, 14 capability, 163 требования (DET-, ECS-, NET-, FOW- …)
- `docs/architecture.md` — обзор слоёв, карта спецификаций, roadmap, открытые вопросы
- `docs/one-pager.md` — что за проект
- `docs/sessions/` — логи проектных сессий (история обсуждений, вне OpenSpec)
- `docs/templates/` — шаблоны ADR и сессий

```sh
cd engine
openspec list --specs               # список capability
openspec spec show netcode          # одна спецификация
openspec validate --specs --strict  # проверка формата
/opsx:propose "<этап roadmap>"      # новое изменение
```

## `draft/` — черновик-песочница

Разведка боем: пробовали, как оно работает. Отдельный npm-workspace, живёт своей жизнью, не является источником правды.

- `AGENTS.md` — карта песочницы для агентов
- `spec/` — YAML-спека ECS (компоненты, системы, события, архетипы)
- `ts-impl/` — TypeScript-реализация ядра + тесты
- `ts-render/` — рендер-прототип на Three.js

```sh
cd draft && npm test        # 84 теста ядра
cd draft && npm run dev:render
```
