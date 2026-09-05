# Tasks: game-boot-splash-warmup

## 0. Спеки в главное дерево (design «Migration Plan»)

- [x] 0.1 Синк дельт change'а в главные спеки (сделано при предложении change'а; `game-boot` вписан слоем `editor-content` — сторона политики — в `scripts/spec-graph.layers.json`) (`/opsx:sync game-boot-splash-warmup`): `openspec/specs/game-boot/spec.md` появился с `## Purpose`, REND-45 и SHELL-10 стоят в своих спеках; проверить: `openspec validate --specs --strict` зелёный и `npm run spec-graph -- show BOOT-4` печатает требование

## 1. Точка прогрева подсистемы (REND-45, design D1)

- [ ] 1.1 `engine/render-ts/src/types.ts`: типы `PrewarmBatch`, `SubsystemPrewarm` и необязательный `RenderSubsystem.prewarm?(): Promise<SubsystemPrewarm>` с doc-комментарием по образцу `updateBudgeted`/`quality`; экспорт из `index.ts`, старые `ModelsPrewarm`/`ParticlesPrewarm`/`EffectsPrewarm` из экспортов убраны; проверить: `npm run typecheck` в `engine/render-ts` зелёный после 1.2–1.5
- [ ] 1.2 `subsystems/models.ts` + `models/prewarm.ts`: `prewarm()` отдаёт единую форму (`first` — корни и VAT-текстуры, `settled` — образцы под якорями, `finish` идемпотентен и делает идущую `settled` no-op); проверить: `engine/render-ts/test/prewarm.test.ts` переписан на новую форму и зелёный, сценарий «Две ступени моделей» покрыт (застрявшая текстура не отменяет первой)
- [ ] 1.3 `subsystems/particles.ts`: `first` — текстуры документов, `settled` — `texturesReady`; проверить: `test/particles.test.ts` зелёный на новой форме
- [ ] 1.4 `subsystems/effects.ts`: `prewarm()` асинхронной формы над `warmEffectNodes` (`first` — корни, `settled` — пустой батч, `finish` возвращает узлы в пул); проверить: тест эффектов утверждает `activeCount` до/после `finish`
- [ ] 1.5 `subsystems/fog.ts`: точка прогрева с экранным корнем пост-прохода (сценарий «Экранный корень тумана»); проверить: тест утверждает `screenRoots` содержит сцену пост-прохода, `roots` пуст
- [ ] 1.6 Инвариант «прогрев не меняет наблюдаемого» (сценарий «Прогрев и кадр»): тест в `render-ts` — состав сцены кадра и счётчики стоимости после прогрева + `finish` равны прогону без прогрева, `dispose` обнуляет живые ресурсы прогрева (`lifetime.test.ts` или новый); проверить: тест зелёный

## 2. Готовность оболочки (SHELL-10, design D1)

- [ ] 2.1 `engine/client-ts/src/remoteHost.ts`: `RemoteHostConfig.onFirstDelivery`, вызов один раз после применения первого конверта состояния и до возврата из `onMessage`; `snapAll` не повторяет; проверить: тест хоста в `engine/client-ts/test` — событие ровно один раз, до первого `frame()` с состоянием, не наступает без доставок, не повторяется на разрыве истории

## 3. Документ старта (BOOT-3, BOOT-1, design D2)

- [ ] 3.1 `game/demo-ts/app/boot/bootDocument.ts`: тип документа, `DEFAULT_BOOT_DOCUMENT`, умолчания полей, `validateBootDocument(doc, { declared, declarable, destinations })` с адресными ошибками (незнакомая стадия, `timeoutMs` у `handshake`/`firstDelivery`, незарегистрированное назначение — `menu` отдельно словом «зарезервировано»), `notWarmed` для объявленных, но не названных; проверить: `test/bootDocument.test.ts` покрывает сценарии BOOT-3 (незнакомая стадия, туман объявляемый на сцене без тумана → `skipped`, не названная стадия → `notWarmed`, отвергнутый документ → умолчание) и BOOT-1 (`menu` без регистрации → адресный отказ и `scene`, незнакомое назначение)
- [ ] 3.2 `game/demo-ts/app/boot/boot.json`: документ демо — стадии `handshake`, `prewarm.models`, `prewarm.particles`, `prewarm.effects`, `prewarm.fog`, `scene`, `firstDelivery`, `warmFrames`; `splash: { kind: "none", title, minMs, fadeMs }`, `warmFrames: 2`, `after: "scene"`; проверить: `test/demoBoot.test.ts` валидирует отгружаемый документ против реестра сборки демо (объявляемые — та же константа, что у качества) без единой ошибки и без `notWarmed`

## 4. Машина состояний старта (BOOT-1, BOOT-4, design D3)

- [ ] 4.1 `game/demo-ts/app/boot/bootSequence.ts`: состояния `splash → warming → (waiting) → revealing → done`, входы `stageSettled`/`handshake`/`firstDelivery`/`frame`/`fadeEnded`, таймауты и `minMs` через инъецированные `clock`/`schedule`, `onReveal` (синхронная точка) и `onFade`; никаких таймеров кадра и DOM внутри; проверить: `test/bootSequence.test.ts` покрывает сценарии BOOT-1 «Обычный старт», BOOT-2 «Быстрая машина и minMs», BOOT-4 «Обязательная стадия по таймауту», «Ожидание соперника» (waiting до firstDelivery, затем тёплые кадры и раскрытие), «Тёплые кадры и отложенное» (`onReveal` зовётся после ровно `warmFrames` кадров и до `onFade`), «Необязательная стадия ещё идёт»
- [ ] 4.2 `game/demo-ts/app/boot/bootStages.ts`: раннеры стадий — `prewarm.<name>` над `SubsystemPrewarm` и общей процедурой сборки, `scene` над компиляцией сцены кадра; исходы `done`/`failed`/`skipped` (подсистема не построена); проверить: тест раннеров — отказ раннера даёт `failed`, а не исключение наружу; `finish` зовётся и при отказе

## 5. Исполнитель прогрева поверх REND-45 (design D4)

- [ ] 5.1 `game/demo-ts/app/prewarm.ts`: без имён подсистем — принимает список `{ name, prewarm }` и цели кадра; процедура ступени (`initTexture` → мировые корни под обе цели → экранные на канвас), `finish` в `finally`; проверить: `test/demoPrewarm.test.ts` переписан на стадии — те же утверждения о целях (канвас против цели кадра) и порядке ступеней зелёные

## 6. Сплеш в разметке и DOM-адаптер (BOOT-2, design D5)

- [ ] 6.1 `game/demo-ts/app/index.html`: `#boot` после `#app` с заголовком, строкой состояния, полосой прогресса и слотом медиа; инлайн-стили (fixed, inset 0, z-index 15, непрозрачный фон, `transition: opacity var(--boot-fade)`, `[data-state="done"] { display: none }`); проверить: визуально в `npm run demo` сплеш виден до загрузки модулей, `#notice` и `#connect` — поверх него
- [ ] 6.2 `game/demo-ts/app/boot/splash.ts`: `bindSplash(element, document)` — `data-state`, тексты прогрева/ожидания, `--boot-fade`, медиа `image`/`video` (muted, autoplay, playsinline; `error` → `none` + отчёт), `fade()` с `transitionend` и запасным таймером, после `done` — ни обработчиков, ни отрисовки; проверить: `test/splash.test.ts` на мини-фейке элемента — атрибуты по состояниям, медиа-атрибуты, отказ медиа → `none`, после `done` слой скрыт

## 7. Проводка в демо (design D6, D7)

- [ ] 7.1 `game/demo-ts/app/main.ts`: адаптер берёт `#boot` до `loadManifest()`; в `onReady` после подсистем и пресета — реестр стадий из `watchRegistrations`, валидация, машина, раннеры; `onFirstDelivery` → `boot.firstDelivery()`, `boot.handshake()` в начале `onReady`, `boot.frame()` в `frame`, `onReveal` → `remote.stage.flushBudget()`, назначения `{ scene }`; `void prewarmPresentation` убран; проверить: `npm run demo` — сплеш угасает после старта матча, первый видимый кадр без монтажей; `?server=` без второго игрока — состояние ожидания, `#notice` виден
- [ ] 7.2 Отчёт BOOT-5: `formatBootReport(report)` — чистая функция → строка `[boot] …`; `console.info` на `done`, `window.demoBoot()` read-only; проверить: тест форматирования — каждая стадия с исходом и длительностью, `rejected`/`notWarmed`/`media` присутствуют; `grep -r "\[boot\]" engine/tests/golden` пуст

## 8. Документация и гейт

- [ ] 8.1 `CLAUDE.md`: абзац о старте демо (документ `boot.json`, стадии по именам, `[boot]` — сторож), счётчик capabilities/требований в «The spec is the source of truth»; `docs/architecture.md`: строка `game-boot` в карте спецификаций (§2), этап 66 в roadmap (§5); `game/demo-ts/app/README.md`: раздел о сплеше и документе старта; проверить: `npm run spec-graph -- check` зелёный
- [ ] 8.2 `npm run check` из корня зелёный (typecheck, eslint, knip — старые типы прогрева не остались мёртвыми экспортами, jscpd, depcruise, spec-graph, тесты)
