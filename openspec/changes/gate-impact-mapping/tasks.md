# Tasks: gate-impact-mapping

## 1. Расписание гейта (CLI-13, D1, D2, D6)

- [ ] 1.1 `scripts/typecheck.mjs`: параллельный `tsc --noEmit` по `workspaces` корневого манифеста, `--jobs` (умолчание — число ядер), список пакетов аргументами, префиксный вывод, ненулевой код при любом красном; `npm run typecheck` переключён на него; проверка — `npm run typecheck` зелёный за ~40 с против 93, намеренная ошибка типов в одном пакете краснит с именем пакета, `npm run typecheck -w @fluxus/core` работает как прежде
- [ ] 1.2 `vitest.projects.ts` (15 проектов, включая `desktop/shell-ts`) + `vitest.gate.config.ts`; `vitest.coverage.config.ts` берёт список оттуда без десктопа; `npm test` → `vitest run --config vitest.gate.config.ts`; проверка — 331 файл зелёный одним пулом, `npm test -w @fluxus/demo` работает как прежде, `npm run coverage` показывает тот же охват, что до change
- [ ] 1.3 Инвариант стадий (CLI-13): тест в `integration-ts`, что обычный прогон гейта не пишет в отслеживаемое дерево — `git status --porcelain` до и после `npm test` совпадает; проверка — тест зелёный, а `UPDATE_GOLDEN=1` в нём не участвует

## 2. Карта влияния и выборка (CLI-14, D3)

- [ ] 2.1 `scripts/impact.mjs`: база (`--base`, merge-base с `origin/main`, fallback `main`, неразрешимая → предупреждение и полный план), дифф от базы ∪ staged ∪ unstaged ∪ untracked; экспорт `classify`, `closure`, карты; проверка — юнит-тесты `impact.test.ts` на классификацию каждого класса путей: широкие ворота → full, документы → docs, путь пакета → pkg, неизвестный корень → full
- [ ] 2.2 Обратное замыкание: зависимости из манифестов workspace + `TEST_EDGES` (`desktop/shell-ts ← editor/ui-ts, game/demo-ts, game/server-agent-ts, game/server-manager-ts`; `game/server-agent-ts ← game/demo-ts`) + `engine/integration-ts` в любой непустой выборке; проверка — тесты замыкания: `engine/core-ts` → все пакеты; `editor/ui-ts` → `editor/ui-ts`, `desktop/shell-ts`, `engine/integration-ts`; `game/demo-ts` → `game/demo-ts`, `desktop/shell-ts`, `game/server-agent-ts`, `engine/integration-ts`
- [ ] 2.3 План и исполнение: typecheck выбранных через 1.1, `eslint <dirs>`, `vitest --project`, глобальные проверки целиком, документный план (`spec-graph check` + тест формата спек); флаги `--dry-run` (JSON-план), `--explain` (путь → правило, пакет → кем выбран), `--full`, `--timings`; скрипты `check:impact` и `check:timings`; проверка — `--dry-run` на диффе из одних документов даёт документный план; на пустом диффе — только глобальные проверки; `--explain` на правке `game/demo-ts` называет тест-ребро для `desktop/shell-ts`; ручной прогон на ветке зелёный
- [ ] 2.4 Сценарии спеки как тесты на фикстурных диффах: правка контента → full; листовой пакет → пакет + integration; пакет, читаемый чужим тестом → плюс читающий; документный дифф → docs; неизвестный корень → full; проверка — по тесту на каждый сценарий CLI-14 в `impact.test.ts`

## 3. Сторож полноты карты (CLI-14, D4)

- [ ] 3.1 `engine/integration-ts/test/impactMap.test.ts`: каждый `workspaces`-пакет известен карте; каждый отслеживаемый корень дерева (`git ls-files` до первого `/`) подходит под правило; проверка — тест зелёный на текущем дереве, временно добавленный отслеживаемый корень краснит с его именем
- [ ] 3.2 AST-скан литералов путей чужих деревьев в `test/**` и `bin/**` каждого пакета машинерией `engine/tests/guard/scanner.ts` (строки, не комментарии) против `TEST_EDGES`, широких ворот и зависимостей манифеста; точечные исключения с причиной; проверка — тест зелёный на текущем дереве (сегодняшние рёбра покрыты), литерал `game/demo-ts/bin/demo-serve.mjs` во временном тесте `engine/hud-ts` краснит с файлом и строкой
- [ ] 3.3 `--timings` на полном плане: таблица секунд по стадиям, без порога и без влияния на код выхода; проверка — `npm run check:timings` на чистом дереве печатает семь стадий, вердикт совпадает с `npm run check`

## 4. Интеграция в цикл и документы (D5)

- [ ] 4.1 `scripts/git-hooks/pre-push` — без изменений (полный `check` на `main`); `.claude/agents/implementer.md` шаг 7 — `npm run check:impact` как targeted-шаг перед полным гейтом; `.claude/agents/reviewer.md` — `check:impact` для подтверждения находки; проверка — `git diff --stat` не содержит pre-push, тексты агентов обновлены
- [ ] 4.2 CLAUDE.md — блок команд: `check:impact`, `check:timings`, фраза «выборка не ворота `main`», `typecheck`/`test` — параллельно и одним пулом; `docs/architecture.md` — строка roadmap; проверка — `npm run spec-graph -- check` зелёный, цитаты CLI-13/CLI-14 в коде разрешаются
- [ ] 4.3 Полный гейт: `npm run check` зелёный; `npm run check:timings` приложен в описание коммита числами по стадиям
