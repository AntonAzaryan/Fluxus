# Design: game-boot-splash-warmup

## Context

- **Прогрев есть, гейта нет.** `game/demo-ts/app/prewarm.ts` уже делает самое тяжёлое (VAT, батчи, `compileAsync` под обе цели кадра, `initTexture`, пул эффектов), но `main.ts` зовёт его `void prewarmPresentation(...)` и тут же `requestAnimationFrame(frame)`. Тест `demoPrewarm.test.ts` фиксирует разделение: подсистемы отдают ЧТО прогревать, сборка решает КОГДА и ПОД КАКУЮ ЦЕЛЬ. Оно сохраняется.
- **Три формы одного результата.** `ModelsSubsystem.prewarm(): Promise<ModelsPrewarm>` (`roots`, `textures`, `anchoredRoots()`, `finish()`), `ParticlesSubsystem.prewarm(): Promise<ParticlesPrewarm>` (`textures`, `texturesReady()`), `EffectsSubsystem.prewarm(): EffectsPrewarm` (синхронно, `roots`, `finish()`); пост-проход тумана компилируется отдельной строкой `prewarm.ts` (`fog.postPass.scene`, только канвас). Единственный потребитель всех трёх типов — демо.
- **Точки готовности сегодня.** `RemoteHostConfig.onReady(hello)` — handshake (SHELL-5); первая доставка применяется в `ViewBuffer.apply` внутри `RemoteHost.onMessage`, наружу не сообщается; первая маска тумана публикуется синхронно на первой доставке (`FogSubsystem`, путь `snapAll`, FOW-11); первая сборка геометрии синхронна (REND-44); отложенные изображения инстансов доезжают кадрами под бюджетом (`PresentationStage.flushBudget()` — синхронная точка REND-44, публичная).
- **Прецеденты политики документом.** Пресеты качества: `app/presets/*.json` + `quality.ts` (`validateAgainst(DEMO_DECLARABLE_SUBSYSTEMS, doc)`, отвергнутый документ → запасной с предупреждением); `bindings.json`; словарь журнала. Валидация адресна, имя владельца = имя подсистемы (QUAL-1).
- **Страница.** `index.html` — статичная разметка с инлайн-стилями; `#notice` (z 30) — сообщения сборки; `#connect`/`#quality`/`#debug`/`#lead` (z 20) — органы страницы; HUD — оверлей внутри `#app`. `main()` ждёт манифест и парный документ, спавнит воркер, `onReady` собирает подсистемы, регистрирует HUD, применяет пресет, зовёт прогрев, стартует кадр.
- **Сеть.** В режиме стенда handshake оболочки идёт по локальной сцене, а первая доставка — по старту матча (ростер собран или бот заполнил слот, `--bot-fill-ms`, SES-4): между ними страница подключена и ничего не рисует. Уточнение при реализации: если в `networkShell.ts` hello выходит только по welcome сервера, `waiting` наступает ДО handshake — машина этого не различает, обе точки ждут без таймаута.
- **Тесты демо** идут в node без jsdom: DOM-слои тестируются мини-фейками (образец — `engine/hud-ts/test/support/fakeDom.ts`, читать из демо нельзя — чужое дерево вне карты влияния CLI-14).
- **Десктоп.** `BrowserWindow({ show: false })` + `once('ready-to-show', show)`: окно показывается с первой готовой отрисовкой страницы, и статичный сплеш разметки в неё уже входит. Правок контейнера нет.
- **Гейт и ID.** `spec-graph check` видит только главные спеки: код, цитирующий BOOT-*/REND-45/SHELL-10 до синка дельт, краснит `npm run check`. Порядок работ это учитывает (tasks §0).

## Goals / Non-Goals

**Goals:**
- Единая форма точки прогрева на контракте подсистемы (REND-45); четыре подсистемы под ней (модели, частицы, эффекты, туман); `prewarm.ts` — исполнитель стадий по именам, а не список вызовов.
- Разовое событие первой применённой доставки у `RemoteHost` (SHELL-10).
- Машина состояний старта без DOM и без таймеров кадра внутри; документ старта с адресной валидацией; DOM-адаптер сплеша над статичной разметкой; раскрытие как синхронная точка REND-44.
- Отчёт `[boot]` и read-only точка наблюдения страницы.

**Non-Goals:**
- Главное меню как экран: только зарезервированное назначение и его валидация.
- Блокировка ввода под сплешем: указатель съедает сам слой, клавиатура остаётся сэмплеру — мир серверный и игрока не ждёт; ввод под сплешем безвреден и не предмет старта.
- Звук сплеш-видео, «нажмите любую клавишу», пропуск сплеша кликом.
- Прогрев воркер-половины (навигация запекается в `worldInit`, до первой доставки по построению) и сети.
- Стадия чтения документов сцены и матча — придёт со стабом `sec09-client-content-from-tree`.
- Правки `desktop-shell`, `match-hud`, `render-quality`; интеграция отчёта старта в `bench:demo`.
- Своя графика сплеша: демо отгружает `kind: "none"`; `image`/`video` — поддержаны документом и проверены фейком.

## Decisions

### D1. Слои: механизм в движке, политика в игре

- **Механизм (`engine/render-ts`, REND-45):** `RenderSubsystem.prewarm?(): Promise<SubsystemPrewarm>`. Типы в `types.ts`:

  ```ts
  export interface PrewarmBatch {
    /** Корни, которые кадр рисует в мир: компилировать с освещением сцены под цели кадра. */
    readonly roots: readonly THREE.Object3D[];
    /** Корни экранных проходов (полноэкранный квад тумана): компилировать на канвас, без света. */
    readonly screenRoots: readonly THREE.Object3D[];
    /** Текстуры к заливке на GPU (`renderer.initTexture`). */
    readonly textures: readonly THREE.Texture[];
  }
  export interface SubsystemPrewarm {
    /** Первая ступень — из того, что уже есть. */
    readonly first: PrewarmBatch;
    /** Вторая — по доезду входов первой недостававших; нет второй — разрешённый пустой батч. */
    readonly settled: Promise<PrewarmBatch>;
    /** Возврат тёплых объектов владельцу; идемпотентно. */
    finish(): void;
  }
  ```
  Модели: `first = {roots, screenRoots: [], textures}`, `settled = anchoredRoots → {roots}`. Частицы: `first = {textures}`, `settled = texturesReady → {textures}`. Эффекты: `first = {roots}`, `settled = пустой`. Туман: `first = {screenRoots: [postPass.scene]}`. Старые типы `ModelsPrewarm`/`ParticlesPrewarm`/`EffectsPrewarm` уходят из `index.ts`; внутренние модули (`models/prewarm.ts`, `particlePrewarm.ts`, `effectsPrewarm.ts`) остаются — меняется только оболочка результата.
  Альтернатива «движок оркеструет компиляцию» отвергнута: цель кадра, порядок ступеней и то, чего ждать, — знание сборки (существующая позиция `demoPrewarm.test.ts`); движок компилировал бы под чужую цель. Альтернатива «оставить три формы» отвергнута: стадия по имени невозможна без единой формы, и четвёртая подсистема снова добавила бы строку в `prewarm.ts`.
- **Механизм (`engine/client-ts`, SHELL-10):** `RemoteHostConfig.onFirstDelivery?: () => void`, зовётся из `onMessage` один раз — после применения первого конверта состояния в `ViewBuffer` и до возврата (то есть до любого `frame()` с этим состоянием). Флаг «уже сообщено» сбрасывается только новым `connect` (которого у хоста нет — порт один); `snapAll` флага не трогает. Промис вместо коллбэка отвергнут ради симметрии с `onReady`/`onPause`.
- **Политика (`game/demo-ts/app/boot/`):** документ, машина, DOM-адаптер, исполнитель стадий. Ни одно число (таймаут, `minMs`, `fadeMs`, `warmFrames`) не живёт в коде иначе как документированное умолчание.

### D2. Словарь стадий и валидация (BOOT-3)

Стадия документа: `{ "stage": "<имя>", "required": boolean, "timeoutMs": number }`. Имена: встроенные `handshake`, `firstDelivery`, `scene`, `warmFrames`; подсистемные `prewarm.<RenderSubsystem.name>`. Реестр объявленных стадий собирается в `onReady` после регистрации всех подсистем — тем же моментом, что реестр ручек качества, — обходом `PresentationStage.watchRegistrations` (подсистемы с `prewarm`). Валидация `validateBootDocument(doc, { declared: Set<string>, declarable: DEMO_DECLARABLE_SUBSYSTEMS, destinations: Set<string> })` возвращает `{ ok, errors[] }` с именами; `fog` — единственный объявляемый владелец, тот же константой, что у QUAL-1 (второго списка нет). Отказ → `DEFAULT_BOOT_DOCUMENT` (константа модуля: все объявленные стадии `required` с одним таймаутом, `none`, `after: scene`) + предупреждение. Объявленные, но не названные документом — в отчёт списком `notWarmed`.

Умолчания: `required: true`, `timeoutMs: 10000`, `warmFrames: 2`, `splash: { kind: 'none', minMs: 0, fadeMs: 400 }`, `after: 'scene'`. `firstDelivery` и `handshake` таймаута не имеют по построению (BOOT-4): `timeoutMs` у них отвергается валидацией адресно — иначе документ обещал бы то, что машина не исполняет.

### D3. Машина состояний (BOOT-1, BOOT-4)

`bootSequence.ts` — чистый TS: `createBootSequence({ document, clock, stages: StageRunner[] })` со входами `stageSettled(name, outcome)`, `handshake()`, `firstDelivery()`, `frame()` (счёт тёплых кадров), `fadeEnded()`; выходами `state`, `progress` (стадии в порядке документа с исходом), `report()`. Переход в `revealing` — единственная точка, где машина зовёт `flushBudget` (передан как коллбэк `onReveal`) и запрашивает угасание у адаптера (`onFade(fadeMs)`); `minMs` соблюдается таймером через `clock`+`schedule` (инъекция, в тестах — ручные часы). `waiting` — производное: локальные стадии (все, кроме `firstDelivery`/`warmFrames`) завершены, `firstDelivery` не наступил. Таймауты стадий — `schedule` той же инъекцией; `required` с таймаутом → исход `timeout`, машина идёт дальше; отказ раннера → `failed`. Никаких `requestAnimationFrame`/`setTimeout` внутри модуля.

Раннеры стадий (`bootStages.ts`): `prewarm.<name>` — обёртка над `SubsystemPrewarm` и общей процедурой сборки (D4); `scene` — `compileForFrameTargets(scene)` + пост-обработка; `handshake`/`firstDelivery`/`warmFrames` — маркеры, которые закрывают события машины, а не промисы.

### D4. Исполнитель прогрева поверх REND-45 (`prewarm.ts`)

`prewarm.ts` перестаёт знать имена подсистем: получает `readonly { name: string; prewarm: () => Promise<SubsystemPrewarm> }[]` и `PrewarmTargets` (renderer, сцена света, камера, `worldTarget` 1×1 при тумане). Процедура одной стадии: `first` → `initTexture` текстур, `compileForFrameTargets(roots)` под обе цели, `compileAsync(screenRoots)` на канвас; затем `settled` → то же; `finish` в `finally`. Порядок ступеней между подсистемами не фиксируется (каждая стадия — своё обещание); прежняя гарантия «застрявшая текстура не отнимает прогрев батчей» сохраняется внутри ступеней одной подсистемы. Тёплая сцена — одна на стадию: `compileAsync` даёт попадание в кэш программ на повторных корнях. `demoPrewarm.test.ts` переписывается на стадии: те же утверждения о целях (канвас против цели кадра) и порядке ступеней.

### D5. Разметка и DOM-адаптер (BOOT-2)

`index.html`: `<div id="boot" data-state="splash">` сразу после `#app` — заголовок, строка состояния, полоса прогресса, слот медиа; инлайн-стили: `position: fixed; inset: 0; z-index: 15; opacity: 1; transition: opacity var(--boot-fade)`; `[data-state="done"] { display: none }`. z-index 15 — ниже органов страницы (20) и `#notice` (30), выше `#app` и HUD внутри него: дорога со сломанной страницы видна, сцена — нет. `splash.ts`: `bindSplash(root: SplashElement, document)` — ставит `data-state`, текст ожидания/прогрева, `--boot-fade`, медиа (`<img>`/`<video muted autoplay playsinline>` по `src`, URL через тот же корень, что `assetSource` — `/${id}`; `onerror` → `kind: none` + отчёт); `fade()` — `data-state="revealing"`, `opacity: 0`, `transitionend` или запасной таймер `fadeMs + 50` → `data-state="done"`. Тестируется мини-фейком элемента (свой, в `test/`, без jsdom).

### D6. Проводка в `main.ts`

- `#boot` находится ДО `loadManifest()` (как `wireConnectButton`): сплеш из разметки уже виден, адаптер лишь берёт его в руки; документ `boot.json` импортируется статически, как пресеты.
- `onReady`: после регистрации подсистем и пресета — сбор реестра стадий, валидация, `createBootSequence`, старт раннеров; `requestAnimationFrame(frame)` как сегодня; в `frame` — `boot.frame()` пока `state !== 'done'` (один вызов метода, без ветвления по состояниям в `main.ts`).
- `RemoteHost`: `onFirstDelivery: () => boot?.firstDelivery()`; handshake закрывает `boot.handshake()` в начале `onReady`.
- Раскрытие: `onReveal: () => remote.stage.flushBudget()`; назначения — `{ scene: () => {} }` (сцена и так под сплешем; назначение `scene` — ничего сверх раскрытия). Меню — незарегистрированное имя словаря.
- Отчёт: `console.info('[boot] …')` на `done` и `window.demoBoot = () => boot.report()` (прецедент `demoCameraFocus`).
- `showNotice` не меняется: `#notice` выше сплеша.

### D7. Диагностика (BOOT-5)

`report()` — `{ state, entered: {state: ms}, stages: [{name, required, outcome, ms}], rejected: string[], notWarmed: string[], media: 'ok'|'failed'|'none' }`. Форматирование в строку `[boot]` — отдельная чистая функция (тестируется без DOM). В эталоны не входит по построению: ни один тест не пишет его в `engine/tests/golden/`.

## Risks / Trade-offs

- [Тёплые кадры не пусты: кадровый цикл под сплешем шлёт ввод и рисует] → приемлемо и названо Non-Goal; рисование под непрозрачным слоем — та самая работа, ради которой кадры и тёплые.
- [`flushBudget` на раскрытии может стоить один долгий кадр] → это последний кадр под сплешем, а не первый видимый; альтернатива (ждать нулевого отложенного естественно) не имеет верхней границы.
- [Вторая ступень моделей ждёт текстур скина неограниченно (ASSET-4)] → таймаут стадии документа; `finish` в `finally` возвращает тёплое и при таймауте; идущая `settled` после `finish` обязана быть no-op (проверить в `models/prewarm.ts`).
- [В режиме стенда handshake может ждать welcome сервера] → машина ждёт `handshake` и `firstDelivery` без таймаута; `waiting` показывается по завершении локальных стадий независимо от того, какая из двух точек не наступила. Уточнить при реализации и отразить в тесте `bootSequence`.
- [Пересечение с `sec09-client-content-from-tree`] → реестр стадий расширяем именем; стадия чтения документов добавится тем change'ем, здесь не заводится.
- [Смена экспортов `@fluxus/render`] → потребитель один (демо); `knip` (`lint:dead`) подтвердит отсутствие мёртвых экспортов.
- [Медиа `video` в node-тестах] → адаптер ставит атрибуты и слушает `error`; воспроизведение не тестируется, только контракт разметки.

## Migration Plan

1. Синк дельт в главные спеки (`/opsx:sync`) — до кода, иначе `spec-graph check` красный по dangling ID.
2. Движок (REND-45, SHELL-10) с тестами → демо (`boot/`, `prewarm.ts`, `index.html`, `main.ts`) с тестами → документация.
3. Откат — ревёрт коммита: эталонов и схем change не трогает.

## Open Questions

Нет: всё, что меняло бы спеку или разбивку задач, решено выше; уточнения по `networkShell.ts` (момент hello в режиме стенда) не меняют ни спеки, ни задач — только текст одного теста.
