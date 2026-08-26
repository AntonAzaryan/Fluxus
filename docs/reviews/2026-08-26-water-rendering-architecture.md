# Вода в Fluxus: архитектура рендера воды для изометрического 2.5D MOBA

## TL;DR
- Делай **один параметризуемый forward-шейдер воды на `ShaderMaterial` + `onBeforeCompile`** (не three.js `Water`/`Water2`, не TSL/WebGPU), с ядром «depth-fade + scrolling/flow normals + Fresnel + specular от единственного directional light», который скинуется в stylized ИЛИ semi-realistic пресет. Отражения (SSR/planar) при фиксированной изометрии **не нужны** — они дают мало и стоят дорого; ставь дешёвый cubemap/analytic Fresnel-tint.
- Интерактив (рябь от юнитов/снарядов) делай **render-only**: ping-pong height-RT (256², обновляется на render-clock), позиции юнитов берутся из интерполированного sim-snapshot (`viewBuffer`) и «штампуются» в RT — **никакой обратной связи в `core-ts`**, ровно как cosmetic-ragdoll. Для MVP хватит аналитической ряби от N ближайших юнитов через uniforms.
- На Steam Deck (8 CU RDNA2, ~1.638 TFLOPS FP32, 16 ROPs, до 28 GP/s pixel fill, 1280×800) главный враг — **fill-rate/overdraw прозрачной воды на весь экран**; держи воду как узкие речные/озёрные меши, refraction/ripple-RT в half-res, лимитируй нормал-семплы. Бюджет воды — порядка 1.5–2.5 ms кадра.

## Key Findings

**Камера решает всё.** При фиксированном высоком угле обзора MOBA (Dota/HotS) вода видна почти сверху. Fresnel при взгляде близко к нормали даёт **низкий** коэффициент отражения (Schlick: R стремится к F0 ≈ 0.02 для воды), т.е. поверхность в основном показывает refraction/цвет глубины, а не небо. Значит:
- Screen-space reflections и planar reflections **малополезны**: отражать сверху почти нечего, а стоимость planar = второй проход сцены. RiME вообще имитирует Fresnel и отражает только простой невидимый кубмап; Wind Waker полностью отказывается от отражений и рисует flat-shaded поверхность.
- Максимальную отдачу дают: **depth-based color gradient**, **shoreline foam по разнице глубин**, **анимированные нормали** (specular-блики + искажение refraction), **Fresnel только как лёгкий rim-tint** к краям/под низкими углами у берега.

**three.js путь.** Встроенные `Water`/`Water2` (Reflector/Refractor) тянут за собой полный reflection/refraction-проход и известны проблемами со смещением отражения при смене зума/угла и с краевыми артефактами refraction. Они плохо стыкуются со строгой forward-дисциплиной, кастомным NeutralToneMapping и LUT-грейдингом. TSL/node-материалы завязаны на `WebGPURenderer` (WebGPU с WebGL2-fallback) — это отдельный renderer-путь, конфликтующий с существующим `WebGLRenderer`-пайплайном; сам three.js помечает WebGPURenderer как экспериментальный и рекомендует `WebGLRenderer` для чистых WebGL2-приложений. Вывод: **кастомный `ShaderMaterial`/`onBeforeCompile`**, где ты контролируешь порядок tone-mapping/grading и transparency-сортировку.

**Depth texture доступен в WebGL2** штатно (`THREE.DepthTexture` + `WebGLRenderTarget.depthTexture`), без расширений; из него линеаризуешь глубину (`perspectiveDepthToViewZ`/`viewZToOrthographicDepth`, `#include <packing>`) и берёшь разницу с глубиной поверхности воды → цвет по глубине и foam-полоса у берега (техника Roystan/Ben Cloward).

**Интерактивная рябь — стандартная техника.** Ping-pong RT решает 2D волновое уравнение на GPU (`h_next = 2·h_cur − h_prev + c²·∇²h`, поглощающие границы), позиции объектов «инжектятся» как всплески в height-map, из градиента высот берутся нормали для возмущения поверхности. Есть готовые ориентиры (UE5-система Isaac McLelland: RT 512² на 81.92×81.92 м вокруг игрока; анимешный ring-ripple на R3F). Дешёвая альтернатива — аналитические кольца от N позиций через uniforms.

## Details

### 1. Anatomy ядра шейдера (параметризуемый core)
Единый материал с блоками, каждый включается через `#define`/uniform-флаг:

- **Depth-based color.** Sample scene `depthTexture` в screen-space, линеаризация, `depthDiff = sceneZ − surfaceZ`; `lerp(shallowColor, deepColor, saturate(depthDiff/maxDepth))`. Даёт «поглощение с глубиной» — самый сильный по отдаче эффект для вида сверху.
- **Shoreline foam.** Порог по `depthDiff` (тонкая полоса у берега) + модуляция по углу нормали дна (dot нормалей), чтобы foam был ровным и у пологого берега, и у вертикальных камней. Cutoff по noise → cel-foam; `smoothstep` для anti-alias края. Для semi-realistic — мягкий градиент вместо жёсткого cutoff.
- **Нормали.** Две-три scrolling normal maps с разными скоростями/масштабами; либо **flow map** (Valve Portal 2/L4D2: RG-текстура направлений, две фазы блендятся через `frac(time)` со смещением 0.5, шум-текстура прячет пульсацию) для рек с направленным течением. Оригинальная техника — Alex Vlachos, «Water Flow in Portal 2», SIGGRAPH 2010: рассчитана на минимум `ps2.0b` (6-летнее на тот момент железо) и Xbox 360; в плейтесте течение-как-навигация дало «17% fewer wrong turns» и ускорило прохождение уровня.
- **Волны (вершинные).** Sine — дёшево и достаточно для стилизованной ряби; **Gerstner** (trochoidal) — острые гребни/плоские впадины, горизонтальное смещение вершин, нужно 3–4 суммируемых волны с разными направлениями; нормали пересчитывать аналитически (cross tangent/binormal) или finite-difference, иначе свет ложится как на плоскость. Для вида сверху крупные волны почти не читаются → на статичной воде часто хватает **чисто нормальной** ряби без вершинного смещения (дешевле).
- **Fresnel.** Schlick `F0 + (1−F0)·(1−dot(N,V))^5`, F0≈0.02. При изометрии — почти всегда малый вклад; использовать как rim-подсветку и слабый blend к тонированному отражению, не как основной reflection-driver.
- **Specular.** Blinn-Phong / GGX-glint от единственного directional light по возмущённой нормали; для «sparkle» — высокий exponent + порог, либо отдельный glint-слой. HemisphereLight даёт ambient-tint.
- **Refraction.** Grab-pass: рендер сцены (без воды) в RT, семпл с UV-искажением по нормали воды (screen-space refraction). Работает и сверху (в отличие от reflection), даёт «дрожание» дна. Держать RT в half-res.

### 2. Отражения — вердикт для изометрии
| Подход | Стоимость | Отдача при виде сверху | Вердикт |
|---|---|---|---|
| Planar reflection (Reflector) | Высокая (2-й проход сцены) | Низкая (сверху нечего отражать) | ❌ не делать |
| SSR | Средняя-высокая, артефакты на краях экрана | Низкая, много leaking | ❌ не делать |
| Cubemap (статичный/скайбокс) | Низкая | Средняя (небо у пологих углов берега) | ✅ опционально |
| Без отражений + Fresnel-tint | ~0 | Достаточно (Wind Waker путь) | ✅ базовый выбор |

### 3. three.js реализация в forward-пайплайне
- Материал: `ShaderMaterial` (или `MeshStandardMaterial` + `onBeforeCompile` если нужен встроенный lighting) с `transparent:true`, `depthWrite:false`.
- **Transparency sorting.** Вода — один-два больших меша; в forward прозрачные объекты сортируются по расстоянию и рисуются после opaque. Держи воду в отдельном render-order, следи за пересечением с другими прозрачными VFX (three.quarks). `depthWrite:false` + аккуратный `renderOrder`.
- **Tone mapping / LUT.** Кастомный NeutralToneMapping и LUT применяются как post; цвета воды подбирать в линейном пространстве **до** tone-map, иначе стилизованные пресеты «поплывут». Выводить из шейдера линейный цвет, не применять tone-map внутри.
- **Selective bloom.** Sparkle-блики можно поднять в bloom через layer-mask — это уже есть в пайплайне.
- Depth/refraction RT создаются один раз, переиспользуются; `DepthTexture` формата `DEPTH_COMPONENT24`.

### 4. Интерактивная рябь (render-only)
**Поток данных (детерминизм):** `core-ts` тикает в Web Worker, отдаёт snapshot через transferable-буферы; `render-ts` (`extractor`→`viewBuffer`) держит интерполированные косметические позиции. Система воды **читает** позиции юнитов/снарядов из `viewBuffer`, но **никогда не пишет обратно** — тот же паттерн, что cosmetic-ragdoll (рендер-сайд, не мутирует sim). Анимация воды идёт от render-clock (`performance.now`/`THREE.Clock`), а не от sim-tick.

**MVP (аналитический):** N ближайших движущихся объектов передаются как uniforms (`vec3 ripples[N]` = xz+age); в фрагментном шейдере суммируешь затухающие кольца `sin(dist*k − t)·decay(age)·decay(dist)`. Лимит: WebGL2 гарантирует минимум **224 fragment uniform vectors** (это vec4-слоты, уплотняются алгоритмом упаковки), и минимум **16 varying vectors** — Steam Deck/RDNA2 сильно выше, но проектируй на минимум для переносимости, т.е. N≈16–24 безопасно. Ноль дополнительных проходов.

**Polish (ping-pong height-RT):** RT 256² (при необходимости 128²), покрывает область вокруг камеры; два прохода — (a) inject: ортокамера сверху штампует всплески по позициям из `viewBuffer`; (b) wave-update: волновое уравнение + затухание/поглощающие границы. Из height-RT берёшь нормали (Sobel/градиент) и подмешиваешь в нормаль воды + опционально вершинное смещение. Trail'ы затухают естественно. Ориентир масштаба: 512² на ~82 м из UE5-практики; для MOBA-камеры бери меньший регион и 256².

**Splashes:** three.quarks (`vfx-ts`) — burst партиклов в точке входа снаряда/шага, `RenderMode.Trail` для брызг; события генерятся render-сайд по тем же snapshot-позициям.

### 5. Стилизованный vs semi-realistic — общий core, разные пресеты
| Компонент | Stylized (Wind Waker/HotS) | Semi-realistic |
|---|---|---|
| Цвет | 2–3 плоских бэнда, hard step по нормали/глубине | плавный depth-gradient, absorption |
| Foam | Voronoi-текстура, кольца, cel-cutoff | depth-fade мягкий, sparkle |
| Нормали | few scrolling + flow map, крупные | detail+medium normal maps, flow |
| Каустика | нарисованные линии (Wind Waker caustic lines), scrolling | проекция scrolling-текстуры на дно / light cookie |
| Fresnel | почти нет, tint | Schlick, blend к cubemap |
| Отражение | нет | статичный cubemap |
| Волны | sine, малая амплитуда | Gerstner 3–4 |

Dota 2 (Source 2) исторически — простая река: scrolling normal + flow, дешёвая вода с cubemap-envmap; «expensive water» с realtime reflect/refract Valve держит опциональным. Для рек хорошо ложится flow-map подход (Vlachos, SIGGRAPH 2010).

### 6. Semi-realistic дёшево
Screen-space refraction (grab-pass, half-res); depth-fade прозрачности; sparkle/glint (порог по specular); **fake caustics** — scrolling voronoi/caustic-текстура на меше речного дна или через light cookie у directional light (проекция), а не физический расчёт.

### 7. Бюджет Steam Deck
Железо: 8 CU RDNA2, 512 SP, ~1.638 TFLOPS FP32 (boost 1.0–1.6 GHz), 16 ROPs, до 28 GP/s pixel fill / 56 GT/s texture fill, 32 TU, 16 ГБ unified LPDDR5 (LCD: 5500 MT/s → 88 ГБ/с; OLED-ревизия: 6400 MT/s → 102.4 ГБ/с), экран 1280×800@60. По бенчам класс ~86% GTX 1050 / ~95% RX 560.
- **Fill-rate — главный риск.** Прозрачная вода не пишет z, overdraw неизбежен; вода на весь экран + refraction-RT + ripple-RT легко съедают кадр. Держи воду геометрически ограниченной (реки/озёра), не полноэкранным quad.
- RT: refraction half-res (640×400), ripple 256². Избегай лишних full-screen проходов.
- Нормал-семплы: 2 вместо 3, где можно; Gerstner только там, где реально видно.
- Целевой бюджет воды: **~1.5–2.5 ms** при 60 FPS (кадр 16.6 ms), деградация: отключить ripple-RT → аналитическая рябь → статичные нормали.

### 8. Размещение в кодовой базе
Новый модуль-подсистема **внутри `render-ts`** (не отдельный пакет): `render-ts/src/water/` — `WaterMaterial.ts` (core-шейдер + пресеты), `RippleSim.ts` (ping-pong RT), `WaterSystem.ts` (читает `viewBuffer`, инжектит позиции, гоняет анимацию от render-clock). Splash-VFX — в `vfx-ts` через three.quarks. Игровые «водные зоны» (речной спидбуст как в Dota 2 патч 7.38 «Wandering Waters», релиз 18–19 фев 2025: течение ускоряет движение по направлению потока и не влияет против него) живут в `core-ts` как **data-only регионы** в sim, без всякой зависимости от визуальной воды.

## Recommendations

**Этап 0 — MVP (декоративная статичная вода):**
1. `ShaderMaterial` core: depth-color gradient + 2 scrolling normal maps + Fresnel-tint + directional specular. Без отражений, без refraction-RT.
2. `DepthTexture` в WebGL2, shoreline foam по depthDiff.
3. Один пресет (выбери stylized как дефолт — дешевле и прощает арт-недоделки).
Порог перехода дальше: держит бюджет <1.5 ms на Deck, foam/цвет читаются при MOBA-камере.

**Этап 1 — интерактив (аналитический):**
4. Пробрось N≤16 позиций юнитов из `viewBuffer` в uniforms, аналитические затухающие кольца.
5. Splash-партиклы three.quarks на входе снарядов.
Порог: если N ближайших не хватает (много юнитов в реке одновременно) → RT.

**Этап 2 — polish:**
6. Ping-pong height-RT 256², нормали из height, опц. вершинное смещение.
7. Grab-pass refraction half-res (для semi-realistic пресета).
8. Flow map для рек с течением; fake caustics на дне.
9. Второй арт-пресет (semi-realistic), переключаемый через uniform-флаги на том же core.

**Что НЕ делать:** three.js `Water`/`Water2`, planar reflection, SSR, TSL/WebGPU-путь, физический caustics-raytrace, FFT-океан (не нужен для рек/озёр сверху).

**Триггеры пересмотра:** если арт-дир решит камеру опускать ниже (косой угол) → Fresnel/отражения снова становятся значимыми, добавить cubemap-reflection. Если Deck не тянет ripple-RT → откат на аналитику.

## Caveats
- **Часть «известного контекста» движка не удалось подтвердить из репозитория напрямую.** Подтверждено из README: `render-ts` содержит `extractor, host, models, viewBuffer` и построен на three.js; [github](https://github.com/AntonAzaryan/Fluxus) `core-ts` без runtime-зависимостей; [github](https://github.com/AntonAzaryan/Fluxus) связь слоёв однонаправленная (ядро не знает о рендере); [github](https://github.com/AntonAzaryan/Fluxus) канал `client-ts`↔ядро поверх transferable-буферов; ядро в Web Worker; [github](https://github.com/AntonAzaryan/Fluxus) спеки по capability с префиксами `DET-, ECS-, NET-, NTR-, NAV-, FOW-…`. [github](https://github.com/AntonAzaryan/Fluxus) **НЕ подтверждено дословно из спеков** (файлы `render-ts/README.md`, `docs/architecture.md`, `openspec/specs/*` были недоступны для чтения — GitHub subpages не отдаются fetch-инструменту и не индексируются поиском): точный ID render-capability (предположительно `RND-`/`RENDER-`), нормативные правила про forward-only/no-deferred, baked lightmaps/AO, NeutralToneMapping, blob shadows, selective bloom, LUT, и формулировка «cosmetic ragdoll». Эти пункты взяты из брифа пользователя как вводные — сверь с актуальными спеками перед реализацией (через `openspec spec show` локально).
- Steam Deck-бюджет 1.5–2.5 ms — инженерная оценка из класса железа, не замер; финальную цифру бери профайлером на самом Deck.
- Цифры лимитов WebGL2 (224 fragment uniform vectors, 16 varying) — гарантированные минимумы спецификации; реальный RDNA2 выше, но проектировать безопаснее на минимум для переносимости.
- three.quarks — активный проект (0.17.x), но фактически единственный three.js-партикл-движок такого класса; закладывай риск поддержки одного мейнтейнера.