# Разгон: Архитектура рендер-слоя + Fog of War

## Дата
2026-07-28

## Тема / повод
Фокус на рендер-движке (web, three.js): как выстроить архитектуру, какие доп. тех-требования появятся. По ходу всплыли смежные темы — потоки/воркеры для observer'ов, дизайн visual-prefab'ов, загрузка MDX-моделей, связка рендера с редактором, и отдельно — Fog of War (в доках не был предусмотрен).

## Что обсуждали

### Рендер-слой
- **Рендер как `TickObserver` (§2.6)** — рендер читает `TickResult` после `tick()`, не лезет в симуляцию. Развязка sim-loop (fixed 60Hz) и render-loop (rAF/vsync) через double-buffer (prev/curr).
- **Объектная модель, не ECS** — three.js scene graph; связь sim↔render по Entity ID. Ключ мапы = `index:generation` (иначе баг с переиспользованием index при generational IDs, §8).
- **fixed→float конверсия** — единожды за тик в `RenderObserver`, только для визуального среза; симуляция float не видит (DET-2).
- **Интерполяция** prev/curr по alpha; predicted (своя, NET-2) vs interpolated (чужие, NET-3) режимы; visual error smoothing при reconciliation (реализует NET-5 на визуале).
- **Events vs State** — one-time факты (`DamageDealt`, `UltimateCast`) проигрываются раз (VFX/звук), state интерполируется. Дедуп one-time при rewind/replay уже заложен в OBS-5 (`mode`/`isReplay`).

### Observer'ы и потоки (тупики отброшены)
- **Все внешние потребители = `TickObserver`** (рендер, аналитика, звук, replay-log). Различаются только фильтрацией по `mode`/`isReplay` (OBS-5).
- **Отброшено:** observer в отдельном потоке от render-loop — бессмысленно (double-buffer уже развязывает, WebGL всё равно в main thread).
- **Отброшено:** второй воркер под аналитику — оверхед. Аналитика = async I/O (сеть), CPU не жрёт, воркер ничего не разгружает. Единственная осмысленная граница потоков: **sim(+observers) в worker ↔ render-loop в main thread** (WebGL only main). Воркеры под CPU-тяжёлые observer'ы — только по замерам, если доказанно сдвигают `tick()`.

### Prefab / визуал
- **Два prefab'а, не путать:** sim-prefab (компоненты, логика, §3) и visual-prefab (меш/анимации/VFX, рендер). Связь через строку-метку.
- **`visualArchetype` протекает** — визуальный концепт в компоненте симуляции. Договорились: поле инертно для `tick()` (детерминизм не зависит), но честнее назвать **`visualId`** (явно «для представления»), маскировать нейтральным `tag` не надо. Красная линия: **ни одна sim-система не читает `visualId`**.
- **Цепочка ссылок:** `EntityID → visualId (строка в sim) → VisualPrefab (JSON) → assetKey (строка) → загруженный THREE-ресурс (AssetRegistry кэш)`. Каждая стрелка — уровень косвенности (развязывает sim↔render, данные↔файлы, файлы↔размещение).
- **Дизайн visual-prefab:** mesh, material, animations + animBindings (state→клип), attachPoints (кость/offset — «голова/рука» как в WC3), vfxBindings + soundBindings (событие→эффект, `at`=attachPoint), castIndicator (телеграфия окна каста — критично для УТП тайминг-комбо), healthBar, trail, rewindTint.
- **Три категории полей:** статика / state→анимация / событие→эффект — отражает разделение state (интерполируется) vs events (проигрываются раз).

### MDX-модели (WC3/WoW)
- **three.js MDX нативно не грузит.** Решение: **конвертить MDX→glTF на build-time** (Retera Model Studio / war3-model / Blender). Отброшено: рантайм-парсинг через `mdx-m3-viewer` — тянет второй WebGL-движок рядом с three.js.
- **Юридика:** WC/WoW ассеты = только dev-placeholder, на релиз нужны свои/лицензированные. Стиль копировать можно, ассеты — нет.
- **Ловушки three.js:** имена клипов/костей из MDX кривые (`Stand-1`) → маппинг logical→clipName/boneName в prefab; скелетные модели клонировать через `SkeletonUtils.clone()` (обычный `.clone()` ломает скелет).

### Рендер под редактор
- Для тестирования механик нужен **debug-рендер** (примитивы: круги, стрелки aim, кольца радиусов/хитбоксов, маркеры событий, текст HP/mana/tick) — читаемость логики, ноль ассетов.
- Договорились держать **оба слоя параллельно**: `ModelRenderer` (glTF+анимации) + `DebugRenderer` (оверлеи) за интерфейсом `Renderer`. Debug-оверлеи нужны даже с красивыми моделями (радиусы FoW, хитбоксы, окна кастов).
- **Встроенный runner** (ED-9 → фактически обязателен): play/pause/**step-by-tick**/rewind-скраб/reset+seed/inspect компонентов/инъекция инпутов. Step-by-tick критичен для отладки тайминг-механик (~400мс окна). Переиспользует core-API WSM-5 (`pause`/`seekTo`).
- Связка Compose↔three.js: держаться web-стека (Compose Web + three.js canvas в одном браузере), минимум мостов.

### Fog of War (новая тема, в доках не было)
- Тип: **геймплейный** (невидимость, дебафы видимости, укрытия/LoS).
- Разделение слоёв: симуляция считает видимость сущностей (булево per-entity), netcode скрывает данные, рендер рисует серую заливку.
- **Отброшено:** «скрывать только в рендере» — данные долетают до клиента → wallhack через патч рендера / чтение памяти. В competitive PvP недопустимо. Нужен per-client снапшот.

## К чему пришли

### Рендер
- Рендер = чистый потребитель `TickResult` (RenderObserver), объектная модель, связь по `EntityKey` = `index:generation` → правка в core-engine.md §RND (новый раздел рендера).
- `visualArchetype` → переименовать в **`visualId`**, оставить в компоненте, запретить чтение sim-системами → ADR (протечка контролируемая).
- Цепочка `EntityID → visualId → VisualPrefab → assetKey → AssetRegistry`; три реестра (PrefabRegistry / AssetRegistry / SceneManager).
- Дизайн visual-prefab зафиксирован (см. выше).
- MDX→glTF на build-time; маппинг имён клипов/костей в prefab; `SkeletonUtils.clone` для скелетов → ADR + новые RND-требования.
- `Renderer` интерфейс с двумя реализациями (ModelRenderer + DebugRenderer); runner-панель со step-by-tick.

### Потоки/observer'ы
- Все внешние потребители за контрактом `TickObserver`; единственная граница потоков — sim(+observers, worker) ↔ render-loop (main). Воркеры под observer'ы — по замерам. → зафиксировано, правок в спеку не требует (уже согласуется с §2.6).

### FoW — новые якоря (см. ниже), детали в session-note по FoW

## Затронутые якоря
§2.6 (OBS-1..6), TICK-3, DET-2, §8 (ID-1..5), §3/QUERY-1, TIME-6, §5.3, NET-2/NET-3/NET-5/NET-8, REW-3, SNAP-1, WSM-5, ED-9, PHYS-4
Новые: **RND-1..16**, **PHYS-6**, per-client snapshot filtering (расширение §15), **FOW-*** (Vision/Visibility/Stealth), визуальный prefab-контракт

## Открытые вопросы
- [ ] Ортографика vs перспектива для камеры (читаемость vs картинка) — прототип
- [ ] Гранулярность visual error smoothing при reconciliation (сколько кадров гасить, баланс с NET-5) — netcode-прототип
- [ ] Reverse-анимации во время Rewind (полноценный reverse дорого; может хватит freeze + rewind-postfx) — замеры/арт
- [ ] InstancedMesh vs отдельные меши для проджектайлов — профиль сцены
- [ ] Per-client delta-компрессия (NET-8 baseline на игрока) — как считать эффективно при FoW
- [ ] LoS-обрезка круга тумана за углами (2D shadow-cast) — нужна ли, или хватит sim-скрытия врагов
- [ ] Обязательность Physics (PHYS-6 делает его non-optional для этой игры) — подтвердить в спеке

## Дельта к источнику истины
- [ ] создать ADR: `visualArchetype → visualId`, инертность для tick, запрет чтения sim-системами
- [ ] создать ADR: MDX→glTF build-time pipeline (отказ от рантайм mdx-m3-viewer), юридический disclaimer по WC/WoW ассетам
- [ ] создать ADR: per-client snapshot filtering для геймплейного FoW (сдвиг сетевой модели §15)
- [ ] обновить docs/spec/core-engine.md — новый раздел §RND (Render Layer): RND-1..16, контракт `Renderer`, RenderObserver, AssetRegistry, VisualPrefab, SceneManager, runner
- [ ] обновить docs/spec/core-engine.md §13 Physics — PHYS-6 (raycast/LoS), пометить Physics обязательным для этой игры
- [ ] обновить docs/spec/core-engine.md §15 Netcode — per-client filtered snapshot, per-client delta
- [ ] добавить раздел FoW-компонентов (Vision/Visibility/Stealth) + VisibilitySystem как пример evaluator-системы
- [ ] отдельная session-note по FoW уже суммирована (см. предыдущий вывод), перенести в docs/sessions/2026-07-28-fow-visibility.md
- [ ] обновить AGENTS.md — добавить навигацию по §RND (Render Layer)