# Система анимации для Fluxus: архитектура, инструменты, рекомендации

## TL;DR
- **Строй тонкий кастомный слой поверх three.js `AnimationMixer`** в отдельном пакете `anim-ts`, зависящем только от `render-ts` (зеркало паттерна `vfx-ts`): FSM + матрица переходов + длительности crossfade + аддитивные слои, управляемые enum'ами состояния из снапшотов симуляции. Не тащи ozz (нет готового npm-пакета, надо самому компилировать C++/WASM и писать glue) и не адаптируй тяжёлые графовые движки.
- **Для косметического ragdoll на смерть** используй `@dimforge/rapier3d-compat` (Apache-2.0, 3 933 802 загрузок/нед по npm, последний релиз 0.19.3 от 5 ноября 2025): отдельный локальный физический мир на клиенте, спавнится только в момент смерти, никогда не касается детерминированной симуляции. Jolt — сильная альтернатива, но крупнее и сложнее в интеграции.
- **Главные подводные камни**: foot sliding (лечится привязкой скорости воспроизведения к скорости из снапшота, а не enum'у), «попы» на переходах (reset+fadeIn, синхронизация фаз, не делать stopAllAction), и рассинхрон анимации с интерполированными снапшотами (рендерить с задержкой ~100 мс и гнать crossfade по событию смены enum, а не покадрово).

## Key Findings

**three.js `AnimationMixer` полностью достаточен для party-brawler на 4–8 персонажей.** Актуальная версия three.js — r185 (npm `three@0.185.1`; типы `@types/three@0.185.4`, обновлены 4 августа 2026). Система (`AnimationMixer` → `AnimationAction` → `AnimationClip`) поддерживает crossfade (`crossFadeTo`), веса (`setEffectiveWeight`), аддитивный блендинг (`AdditiveAnimationBlendMode`), `timeScale`, `LoopOnce`/`clampWhenFinished`. Узкое место three.js — CPU-стоимость обновления множества `SkinnedMesh`, но проблемы начинаются на десятках-сотнях персонажей, а не на 4–8.

**ozz-animation НЕ turnkey для браузера.** Нет опубликованного npm-пакета, который поставляет ozz скомпилированным в WASM с JS-биндингами (все похожие имена на npm — коллизии, напр. `ooz-wasm` — это декомпрессор Kraken/Mermaid, не ozz). Сам C++-проект (MIT, последний релиз 0.16.0 от 19 января) официально тестируется под WebAssembly (README: «ozz-animation is tested on WebAssembly, Linux, macOS and Windows»), но чтобы его использовать, нужно самому собирать через emscripten и писать Embind/JS-glue, плюс прогонять оффлайн-тулчейн ozz для конвертации в `.ozz`. Rust-переписка `ozz-animation-rs` (MPL-2.0) детерминирована (спроектирована под lockstep) и умеет WASM, но тоже требует самостоятельной сборки через wasm-pack и оффлайн-тулчейна ozz для ассетов. Готового примера ozz + three.js не существует. Для соло-разработчика это неоправданные накладные расходы под задачу, где `AnimationMixer` справляется.

**Физика для ragdoll — только Rapier или Jolt.** cannon-es фактически заброшен (Snyk: maintenance «Inactive», нет новых релизов на npm больше года, последняя содержательная активность ~2022). Ammo.js не поддерживается и имеет самый большой бандл (~750 КБ gzip). Oimo без разработки с 2016. Живые варианты: Rapier (`@dimforge/rapier3d-compat`, Apache-2.0) и Jolt (`jolt-physics`, MIT, движок из Horizon Forbidden West и Death Stranding 2). У three.js есть встроенные аддоны `RapierPhysics.js` и `JoltPhysics.js`.

## Details

### 1. Базовые концепции и как это ложится на архитектуру Fluxus

**Разделение sim/render уже решает главный вопрос.** В Fluxus движение принадлежит детерминированной симуляции (core-ts, Q16.16), рендер получает снапшоты. Значит: **root motion исключён** — позицию задаёт sim, анимации должны быть in-place (на месте), а мировую трансформацию задаёт интерполированная позиция из снапшота. Это стандартная практика для сетевых игр: анимация локомоции проигрывается in-place, а перемещение накладывается отдельно. Root motion потребовал бы, чтобы анимация влияла на позицию, что нарушило бы детерминизм — прямо противоречит заявленному ограничению.

**State machine + матрица переходов.** Каждой сущности — конечный автомат, состояния которого мапятся на enum'ы из снапшота (idle/run/attack/hit/death). При смене enum'а запускается crossfade с заранее заданной длительностью перехода (матрица «из состояния X в состояние Y за N мс»). Это ровно модель PlayCanvas Anim State Graph (states + transitions + blend trees + layers + masks) и Unity Animator — бери её как дизайн-референс, но реализуй тонко.

**Blend trees для локомоции.** Idle→walk→run — это 1D blend tree по параметру «скорость». В Fluxus параметр скорости бери из `velocity` снапшота (его модуль), а не из дискретного enum'а. Это критично против foot sliding: скорость воспроизведения walk/run-цикла должна соответствовать реальной скорости перемещения.

**Слои и маски (upper body attack + lower body run).** Здесь у three.js реальное ограничение: встроенного механизма bone-маскирования как в PlayCanvas (Anim Layer Masks) или Unity (Avatar Mask) нет. Варианты: (а) авторить в Blender отдельные клипы для верхней/нижней части тела; (б) использовать аддитивный блендинг (`AnimationUtils.makeClipAdditive`) для наложения атаки поверх базовой позы; (в) вручную назначать action на поддерево скелета через `localRoot` в `mixer.clipAction(clip, root)`. Для brawler'а проще всего аддитивные клипы атаки/hit-реакций поверх локомоции.

**Аддитивные анимации.** three.js поддерживает `AdditiveAnimationBlendMode`, но есть известный баг: прямая установка `blendMode` на action даёт неверный результат (перемасштабирование костей) — нужно готовить клип через `AnimationUtils.makeClipAdditive()`. [Three.js](https://discourse.threejs.org/t/changing-animationactions-blendmode-to-additiveanimationblendmode-leads-to-incorrect-results/46994) Учти это в пайплайне.

**IK (foot placement, look-at).** В three.js есть `CCDIKSolver`, но для арены с плоским полом и видом сверху foot IK почти не нужен. Look-at (поворот головы к цели) можно сделать дёшево вручную поворотом кости. Не встраивай IK в первую версию.

**Animation events.** three.js `AnimationMixer` эмитит `'finished'` и `'loop'`. Для «events по времени» (удар в кадре N → триггер VFX) отслеживай `action.time` в апдейте или используй суб-клипы. События анимации должны триггерить только косметику (звук, vfx-ts particles) — никогда не sim.

### 2. Как сетевые игры гонят чисто визуальную анимацию из реплицированного состояния

**Snapshot interpolation — твой случай.** Классика (Gaffer On Games, «Snapshot Interpolation»; Unity Netcode for Entities docs): клиент буферизует снапшоты и рендерит с намеренной задержкой (interpolation buffer, обычно ~100 мс / 2–3 серверных тика), интерполируя между двумя известными снапшотами. Позиции/повороты — lerp/slerp; анимационное состояние — по интерполированному значению. Для JS есть готовый `@geckos.io/snapshot-interpolation` (буфер по умолчанию 3 кадра) как референс реализации, но у тебя свой net-ts, так что бери из него концепцию, не пакет.

**Overwatch (GDC 2017).** Два доклада Blizzard прямо релевантны: Tim Ford, «'Overwatch' Gameplay Architecture and Netcode» (GDC Vault #1024001; ECS + детерминизм; симуляция идёт на фиксированных 16-мс командных кадрах, в турнирном режиме до 7 мс) и Dan Reed (senior software engineer, Blizzard), «Networking Scripted Weapons and Abilities in 'Overwatch'» (GDC Vault #1024653; проприетарный визуальный язык Statescript исполняет высокоуровневые state-машины для оружия и способностей героев, server-authoritative + client prediction + rollback). Ключевой вывод: высокоуровневые state-машины гонят и геймплей, и анимацию, а синхронизация решается репликацией дискретных состояний по командным кадрам. Для Fluxus это подтверждает: реплицируй enum состояния, а crossfade/блендинг делай локально на клиенте.

**Как анимация цепляется к интерполяции.** Дискретные смены enum'а (idle→attack) должны триггерить crossfade **в момент прихода нового состояния в буфере рендер-времени**, а не в момент приёма пакета. Иначе анимация опередит визуальную позицию. Непрерывные параметры (скорость для blend tree) бери из интерполированного `velocity`. Для «пропущенных» коротких состояний (быстрый hit между снапшотами) полезно, чтобы sim держал состояние минимум N тиков, либо чтобы снапшот нёс «событийный» флаг, гарантированно доживающий до клиента.

### 3. Готовые решения в этом стеке

**three.js built-in (рекомендуется как основа).** MIT, идёт с движком. Плюсы: ноль новых зависимостей, TypeScript-типы в `@types/three`, полный контроль. Минусы: линейный блендинг (без сглаживания кривых переходов), нет графового редактора, нет bone-масок из коробки, T-pose-мигание при неправильном crossfade (лечится `reset().fadeIn()` вместо `stopAllAction`).

**Библиотеки-надстройки — не нужны.** На npm нет зрелой, поддерживаемой, MIT/TS библиотеки state-machine+blend-tree именно для three.js с хорошим bus factor. Подход через XState (есть статья «Using XState to coordinate Three.js character animations») рабочий, но XState — тяжёлая универсальная библиотека; для brawler'а твоя матрица переходов проще и предсказуемее. `ecctrl` — это character controller (движение/камера), не анимационный State Graph, и он привязан к R3F, которого у тебя нет.

**glTF specifics (Blender → glTF).** Несколько клипов в одном файле: экспортируй через NLA-треки (каждый NLA-strip → отдельный `AnimationClip`). Сжатие анимаций: `gltf-transform` (`resample()` для удаления избыточных кадров + `quantize()`), либо `gltfpack`/meshoptimizer с `EXT_meshopt_compression` (three.js поддерживает с r122+, нужно вызвать `GLTFLoader.setMeshoptDecoder`) и `KHR_mesh_quantization` (r111+). Для вращений спецификация `EXT_meshopt_compression` рекомендует 16-битное нормализованное квантование с фильтром кватернионов. Decoder быстрый (WASM SIMD, ~1 ГБ/с). Важно: сжатие уменьшает размер загрузки/памяти, но не ускоряет рантайм-рендер напрямую.

**Skinning performance.** three.js: жёсткий лимит 4 кости на вершину (Mixamo-модели с 5+ весами загрузятся с обрезкой и сломанным ригом — перебей в Blender). GPU skinning по умолчанию; при числе костей выше uniform-лимита (~64) three.js автоматически кодирует матрицы костей в `DataTexture` (bone texture). Для party-brawler'а: держи ~20–30 костей на персонажа, тогда 4–8 персонажей — тривиальная нагрузка. На форуме three.js падение fps на скиннед-меша начинается примерно с дюжины персонажей при неоптимизированной сцене — у тебя запас большой.

**Другие движки как референс дизайна.** PlayCanvas Anim State Graph (states/transitions, blend trees 1D и 2D cartesian/directional, layers, layer masks, additive vs overwrite blend) — самый близкий образец того, что тебе нужно, изучи его модель. Babylon.js Animation Groups — тоже полезно как API-референс. Оба — только для дизайна, рендер остаётся three.js.

### 4. Ragdoll на смерть (в стиле Heroes of the Storm)

**Техника.** На событие death в снапшоте клиент локально: (1) отключает `AnimationMixer` для этой сущности, (2) переключает скелет с kinematic на dynamic-физику, (3) инициализирует rigid bodies костей текущей позой и, важно, текущими скоростями костей из анимации — иначе будет рывок (velocity discontinuity). Общепринятые данные (напр. гайд MoCap Online, Unity/Unreal форумы): плавный переход анимация→ragdoll делается блендом веса 0→1 за 0.1–0.3 с; [MoCap Online](https://mocaponline.com/blogs/mocap-news/ragdoll-physics-animation-guide) для косметической смерти допустим и жёсткий мгновенный переход («direct ragdoll on death» — самый чистый быстрый вариант). «Powered ragdoll»/active ragdoll (постоянный физ.-привод суставов к целевой позе, как в Gang Beasts/Party Animals) — сложнее и тебе не нужен, так как геймплей у тебя НЕ физический; для простой смерти достаточно пассивного ragdoll.

**Выбор движка (только косметика, клиент-сайд):**
- **Rapier (`@dimforge/rapier3d-compat`, Apache-2.0)** — рекомендация. Rust→WASM, быстрый, активно поддерживается (последний релиз 0.19.3 от 5 ноября 2025, 3 933 802 загрузок/нед по npm), стабильный API, встроенный аддон в three.js. Есть готовый пример ragdoll на Rapier+three.js (mattvb91/rapierjs-ragdoll: каждая часть тела — dynamic rigid body, суставы — spherical joints, кости синхронизируются с телами каждый кадр). Вариант `-compat` встраивает WASM как base64 [Rapier](https://rapier.rs/docs/user_guides/javascript/getting_started_js/) (проще для бандлера, чуть больше размер; после gzip разница нивелируется). Есть deterministic-сборка, [npm](https://www.npmjs.com/package/@dimforge/rapier2d?activeTab=code) но она тебе не нужна (ragdoll косметический). В 2025 dimforge добавили SIMD-сборки (`-simd`), которые в 2–5× быстрее версий 2024 года.
- **Jolt (`jolt-physics`, MIT)** — топовый движок (Jorrit Rouwé, Guerrilla Games; доклад GDC 2022 «Architecting Jolt Physics for Horizon Forbidden West»; используется в Horizon Forbidden West и Death Stranding 2), в нём ragdoll — первоклассный кейс (в репо есть демо «ragdoll pile»). Минусы: биндинги повторяют C++ API (multi-flavour сборки wasm/wasm-compat/asm/multithread), крупнее и многословнее, требуется ручной `Jolt.destroy()` для heap-объектов. Бери, если Rapier по качеству ragdoll не устроит.
- **Не бери:** cannon-es (заброшен), Ammo.js (не поддерживается, самый большой бандл ~750 КБ gzip), Oimo (мёртв с 2016).

**Изоляция.** Ragdoll живёт целиком в рендере/клиенте: отдельный `RAPIER.World`, спавнится по death-событию, деспавнится при респавне/очистке. Ноль сети, ноль детерминизма, ноль обратной связи в sim. Это архитектурно то же, что `vfx-ts` — чистая косметика.

### 5. Build vs Buy: рекомендация по архитектуре

**Строй тонкий кастомный слой `anim-ts`.** Реалистичный объём DIY-слоя невелик:
- Реестр состояний (enum sim → имя клипа/blend tree).
- Матрица переходов: `{from, to} → {duration, curve?}`.
- Раннер FSM per-entity, дергающий `crossFadeTo`/`setEffectiveWeight` на `AnimationMixer`.
- Blend tree по скорости (линейная интерполяция весов walk/run по `|velocity|`).
- Опционально аддитивный слой для атак/hit-реакций.
- Мост для ragdoll (переключение mixer→Rapier по death).

Это сотни, не тысячи строк. Адаптация ozz или графового движка стоит дороже (сборка WASM, glue, свой формат ассетов) и не окупается для 4–8 персонажей.

**Поток данных:**
```
core-ts (sim, Q16.16, worker)
   → снапшот {pos, velocity, action-enum}
   → net-ts (WebSocket)
   → render-ts: extractor/viewBuffer (интерполяция снапшотов, render-time = now − ~100мс)
   → anim-ts: per-entity FSM (enum→state, |velocity|→blend param, death→ragdoll)
   → three.js AnimationMixer (crossfade, additive) + Rapier (только ragdoll)
```
`anim-ts` зависит **только** от `render-ts` (как `vfx-ts`), не знает о core-ts/net-ts, никогда не пишет в sim.

## Recommendations

**Этап 1 (MVP анимации):**
1. Пайплайн Blender → glTF: in-place клипы (idle/run/attack/hit/death), NLA-треки → отдельные `AnimationClip`. Держи ≤30 костей, ≤4 веса/вершину.
2. Пакет `anim-ts`: FSM + матрица переходов + `AnimationMixer`-раннер. Crossfade по смене enum, длительности 0.1–0.25 с. Используй `reset().fadeIn().play()`, не `stopAllAction`, чтобы не ловить T-pose-мигание.
3. Blend tree локомоции по `|velocity|`; синхронизируй `timeScale` цикла со скоростью против foot sliding.
4. Аддитивный слой атак/hit через `AnimationUtils.makeClipAdditive`.

**Этап 2 (косметическая смерть):**
5. Добавь `@dimforge/rapier3d-compat`, локальный `RAPIER.World`, ragdoll по death-событию с инициализацией скоростей костей. Начни с жёсткого перехода, при необходимости добавь бленд веса 0→1 за 0.15–0.25 с.

**Этап 3 (полировка/масштаб):**
6. Сжатие ассетов: `gltf-transform resample()+quantize()`, при росте размера — `EXT_meshopt_compression` (`setMeshoptDecoder`).
7. LOD анимации (снижение частоты апдейта mixer'а вдали) — для арены с фиксированной камерой почти не нужно; внедряй только если профайлер на Steam Deck покажет CPU-боттлнек.

**Пороги для смены решения:**
- Если персонажей на экране станет >30 или появится CPU-боттлнек на Steam Deck → рассмотри instanced skinned meshes и снижение частоты сэмплирования mixer'а.
- Если качество ragdoll на Rapier не устроит → мигрируй на `jolt-physics` (тот же паттерн изоляции).
- Если понадобится сложный граф состояний с 2D blend trees и bone-масками, дорого поддерживаемый вручную → тогда (и только тогда) рассмотри портирование модели PlayCanvas Anim State Graph.

## Caveats
- **three.js не имеет bone-масок из коробки** — upper/lower split решается авторингом клипов или аддитивным блендингом, не «слоями с масками» как в PlayCanvas/Unity. Заложи это в пайплайн Blender.
- **Блендинг в three.js линейный** — на резких переходах возможны артефакты; смягчается синхронизацией фаз клипов и короткими длительностями.
- **Foot sliding** — фундаментально возникает из-за рассогласования скорости анимации и sim-перемещения; единственное надёжное лечение — привязка скорости воспроизведения к `velocity` из снапшота.
- **Рассинхрон с интерполяцией** — гони crossfade по render-time (с задержкой буфера), не по времени приёма пакета; иначе анимация опережает позицию.
- **Ragdoll velocity discontinuity** — обязательно сей rigid bodies скоростями костей, иначе труп «дёргается» в момент смерти.
- **Детерминизм** — любой физический ragdoll (Rapier/Jolt) держи строго вне sim; даже «deterministic»-сборка Rapier не должна попадать в детерминированное ядро — это косметика на клиенте.
- **Названия/версии на дату отчёта (22.08.2026):** three.js r185 (`three@0.185.1`, `@types/three@0.185.4`); `@dimforge/rapier3d-compat@0.19.3`, Apache-2.0, 3 933 802 загрузок/нед; `jolt-physics` (MIT); `cannon-es` — заброшен (Snyk: Inactive); ozz-animation 0.16.0 (MIT, но нет npm/WASM-пакета — сборка вручную); `ozz-animation-rs` (MPL-2.0, WASM, детерминизм — тоже сборка вручную). Перепроверь версии перед внедрением.