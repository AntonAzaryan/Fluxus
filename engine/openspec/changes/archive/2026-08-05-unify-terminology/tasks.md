# unify-terminology — tasks

## 1. Спеки (sync дельт в главные спеки)

- [x] 1.1 `ecs-foundation`: QUERY-3 (rename + «материализованная выборка»), ID-1 («жёсткий инвариант»)
- [x] 1.2 `data-driven-systems`: SYS-7 (`override` → `replace`), SYS-8 (rename + «эталонный тест»)
- [x] 1.3 `terrain`: TERR-4 (имя `LevelOverride`), TERR-6 («плоская форма»)
- [x] 1.4 `arena`: ARENA-5, ARENA-6 (rename + `LevelOverride`)
- [x] 1.5 `netcode`: NET-12 («авторитетный»)
- [x] 1.6 `netcode-transport`: NTR-2, NTR-3, NTR-8, NTR-11, NTR-13 (rename); Purpose — «с опоздавшим фреймом» (правка напрямую, вне дельты)
- [x] 1.7 `fixed-point-math`: FP-4; `diagnostics`: DIAG-1; `rng`: RNG-8 («жёсткий инвариант»)
- [x] 1.8 `cli-testing`: CLI-2, CLI-5 (rename), CLI-7, CLI-10
- [x] 1.9 `serialization`: SER-2, SER-6 («плоская форма»)
- [x] 1.10 `openspec validate --specs --strict` зелёный

## 2. Код

- [x] 2.1 `core-ts/src/systems/registry.ts`: метод `override` → `replace`, сообщения ошибок
- [x] 2.2 Обновить вызовы и упоминания: тесты core-ts, комментарий в `dsl/evaluatedSystem.ts`, при наличии — net-ts
- [x] 2.3 `npm run typecheck` и `npm test` зелёные; golden-эталоны не изменились (побитово)

## 3. Проверка терминологии

- [x] 3.1 Грепы по главным спекам не находят вытесненных форм: «plain-форм», «жёсткая граница», «жёсткий assert», «golden-эталон», «Golden-file тест», «канонический мир/канонического состояния/канонического baseline» (в NET-12), «кадр» в NTR (кроме кадров рендера), «компонент-override уровня», `override(system)`
