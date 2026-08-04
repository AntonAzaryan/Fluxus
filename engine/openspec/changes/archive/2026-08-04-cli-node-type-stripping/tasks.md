## 1. Разведка

- [x] 1.1 Воспроизвести дефект: `npm run sim ../tests/golden/visibility.scenario.json` на Node v22.22.2 падает с `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` на `src/systems/visibility.ts:131`
- [x] 1.2 Найти **все** parameter properties в `core-ts/src/` и `net-ts/src/`, а не только первый, на котором споткнулся Node — ровно два: `src/systems/visibility.ts:131` и `src/systems/time.ts:69`, оба параметр `modifiers: ModifierList`
- [x] 1.3 Проверить остальной синтаксис, не поддержанный strip-only: `enum` и `namespace` — не найдено ни одного вхождения ни в одном пакете
- [x] 1.4 Зафиксировать базу до правки: `core-ts` 403 теста зелёные

## 2. Правка ядра

- [x] 2.1 `src/systems/visibility.ts`: `VisibilitySystem` — явное поле `private readonly modifiers` плюс присваивание первой строкой конструктора
- [x] 2.2 `src/systems/time.ts`: `TimeScaleSystem` — то же
- [x] 2.3 Комментарии по-русски со ссылкой на CLI-1: объяснено, **почему** здесь нельзя сахар, а не что делает код
- [x] 2.4 `bin/sim.mjs`: в шапке зафиксировано ограничение на `src/` (parameter properties, enum, namespace) и почему выбран не флаг

## 3. Регрессия

- [x] 3.1 Новый `test/cli.test.ts`: `bin/sim.mjs` запускается подпроцессом через `process.execPath` — импорт вместо подпроцесса дефект не ловит
- [x] 3.2 `NODE_OPTIONS: ''` в окружении подпроцесса, иначе внешний `--experimental-transform-types` маскирует поломку
- [x] 3.3 Тест: вывод разбирается как JSON, `scenario` совпадает, `worldInitHash` сверяется с эталоном на диске (а не захардкожен) и имеет форму из 8 hex-цифр
- [x] 3.4 Тест: stderr пуст — это проверка «без экспериментальных флагов», предупреждения рантайма идут именно туда
- [x] 3.5 Тест: stdout совпадает с эталоном побайтно (CLI-4, DET-1)
- [x] 3.6 Тест: запуск без аргумента даёт код 2 и `usage:` в stderr
- [x] 3.7 Проверить, что тест **краснеет** на дефекте: временно вернуть parameter property в `time.ts` — 3 из 4 тестов упали; правка откачена

## 4. Снятие флага с net-ts

- [x] 4.1 Проверить, что `net-ts` грузится штатным `node` после правки ядра — да, `serve.mjs` поднимается без ошибок
- [x] 4.2 `net-ts/package.json`: `--experimental-transform-types` убран из скриптов `serve` и `play`
- [x] 4.3 `net-ts/bin/serve.mjs`, `net-ts/bin/play.mjs`: shebang приведён к `#!/usr/bin/env node`
- [x] 4.4 Прогон связки штатным `node`: сервер поднят, клиент подключился по WebSocket, `worldInit` совпал (`b6e5ead5`), `ExperimentalWarning` в выводе ноль

## 5. Проверки

- [x] 5.1 `core-ts`: `npx vitest run` — 407 тестов зелёные (403 базовых + 4 новых)
- [x] 5.2 `net-ts`: `npx vitest run` — 70 тестов зелёные
- [x] 5.3 `core-ts`: `npx tsc --noEmit` — чисто
- [x] 5.4 `net-ts`: `npx tsc --noEmit` — чисто
- [x] 5.5 Все 10 golden-сценариев прогнаны через `bin/sim.mjs`: у каждого выход совпал с эталоном побайтно, stderr пуст
- [x] 5.6 `git status engine/tests/golden` пуст — эталоны не тронуты, то есть поведение не изменилось
- [x] 5.7 `openspec validate cli-node-type-stripping --strict` проходит
