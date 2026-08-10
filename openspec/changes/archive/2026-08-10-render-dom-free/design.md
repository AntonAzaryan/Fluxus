## Context

См. proposal.md — Why. Рантайм-код `engine/render-ts` уже не обращается к DOM; единственное, что связывает пакет с DOM, — `lib: ["ES2022", "DOM"]` в его `tsconfig.json`. Гейт `npm run check` включает `typecheck` каждого пакета, значит правильная точка охраны — типовое окружение компилятора.

## Goals / Non-Goals

**Goals**

- Зафиксировать REND-19 и сделать его нарушение красным `typecheck`'ом.
- Ничего не менять в рантайм-коде: свойство уже выполняется.

**Non-Goals**

- Перенос рендера в воркер / `OffscreenCanvas` — размещение по потокам остаётся за `client-shell` SHELL-1; это изменение лишь сохраняет опцию дешёвой.
- Чистка DOM из других пакетов (`client-ts`, `editor/ui-ts`, `integration-ts`) — DOM там легален.

## Decisions

**Охрана — удаление `"DOM"` из `lib` tsconfig пакета, а не lint-правило.** Отсутствие деклараций ловит и глобалы (`document`, `window`), и DOM-типы в сигнатурах (`HTMLCanvasElement`, `PointerEvent`) — оба канала регрессии. Альтернатива `eslint no-restricted-globals` отвергнута: она не видит типов и требует ручного списка имён.

**`skipLibCheck: true` остаётся и делает удаление возможным.** Декларации three.js упоминают DOM-типы (`WebGLRenderer(canvas)` и т.п.); `skipLibCheck` уже включён в tsconfig пакета, поэтому чужие `.d.ts` не проверяются, а собственный код пакета этих API не использует. Если когда-нибудь понадобится DOM-тип в узкой точке — это сигнал вынести точку за пакет, а не вернуть `lib: DOM`.

**`@types/node` в devDependencies остаётся.** Он даёт `console`/`setTimeout` тестам и не даёт DOM; требование — про DOM, не про таймеры.

## Risks / Trade-offs

- [Типы three, просочившиеся в наши сигнатуры, могут тянуть DOM] → typecheck после удаления покажет такие места сразу; по текущему grep'у их нет.
- [Тесты vitest могли неявно полагаться на DOM-окружение] → тесты render-ts бегут в node-окружении без DOM; прогон `npm test -w @game-mvp/render` подтверждает.

## Migration Plan

Одно изменение tsconfig + delta-спека; откат — `git revert`. Ничего не деплоится.
