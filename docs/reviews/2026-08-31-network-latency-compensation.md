# Компенсация сетевых задержек в многопользовательских играх: технический разбор и вердикт для движка Fluxus

## TL;DR

- **Твой баг — не про спавн, а про то, что клиент метит ввод на тик, которого сервер уже достиг.** `estimatedTick = тик последнего снапшота` без half-RTT-компенсации структурно неверен: пакет всегда прибывает «в прошлое» сервера. Но half-RTT — только половина решения. `inputDelay=2` (33 мс при 60 Гц) физически меньше RTT через Cloudflare (60–200 мс), поэтому **input delay обязан быть функцией измеренного RTT+джиттера, а не константой из JSON.** Твоя догадка верна, но недостаточна.
- **Для боёвки Dota+Warcraft тебе НЕ нужен полный rollback и НЕ нужен server-side rewind хитбоксов.** Таргетные абилки и юниты решаются моделью «мгновенный локальный визуально-звуковой отклик + серверный авторитет над результатом + windup-анимации» (как WoW и Dota) поверх adaptive input delay. Rewind — только для хитскана, которого у тебя нет.
- **Немедленные шаги:** (1) почини оценку тика — синхронизируй часы через application-level ping/pong с seq+timestamp и sliding-window-минимумом RTT; (2) сделай input delay динамическим с гистерезисом; (3) замени repeat-fill (`{...last, tick}`) на политику, где held-кнопки сохраняются, а вектор движения затухает/обнуляется; (4) уводи игровой трафик с Cloudflare edge на прямой VPS. Заложи в wire protocol input redundancy (последние N кадров ввода в каждом пакете) уже сейчас.

## Key Findings

1. **Существует три семейства netcode, и они не взаимозаменяемы.** Детерминированный lockstep (Age of Empires, WC3, SC2) шлёт только ввод и исполняет его в будущем тике; deterministic rollback (GGPO) — тот же lockstep, но с предсказанием и откатом; client-side prediction + reconciliation + interpolation + server rewind (Source, Overwatch, Valorant, CS2) — серверный авторитет с локальным предсказанием. Fiedler прямо рекомендует чистый lockstep только для 2–4 игроков.

2. **Твоя архитектура (fixed-point детерминированное ECS-ядро в воркере) — это ровно тот фундамент, на котором строится rollback.** Детерминизм — обязательное предусловие GGPO и Overwatch. Ты его уже оплатил (Q16.16). Вопрос лишь в том, нужен ли тебе полный rollback или хватит более дешёвой модели.

3. **Half-RTT-компенсация — необходимое, но не достаточное условие.** Стандартная формула, повторяющаяся у Fiedler, Overwatch и Rocket League: клиент бежит впереди сервера на `RTT/2 + буфер`. По транскрипции доклада Тима Форда (GDC 2017): «The client's clock is always ahead of the server by half round-trip time plus one buffered command frame. At 160ms RTT, that's about 96ms of lead time.» Если твой input delay 33 мс < RTT/2, кадр не успеет физически — никакая арифметика тика это не спасёт без увеличения бюджета.

4. **Ключ к играбельности на высоком пинге — не предсказание, а маскировка задержки дизайном.** WC3/SC2 прячут input latency под анимацию отклика юнита («Yes, sir!») и звук. WoW при 300 мс играбелен, потому что урон и абилки считаются сервером, клиент авторитетен только над своей позицией, а spell queueing буферизует следующее действие. Это твой путь.

5. **Repeat-fill (`{...last, tick}`) — известный антипаттерн для непрерывного движения.** Cone (Rocket League) прямо называет повтор последнего ввода при пустом буфере причиной десинков; Overwatch борется с этим time dilation'ом и input redundancy. Для held-кнопок повтор допустим, для вектора движения — нет: герой «убегает».

## Details

### 1. Таксономия моделей netcode

**(A) Детерминированный lockstep.** Изобретён для RTS. Bettner & Terrano, «1500 Archers on a 28.8» (GDC 2001): вместо передачи состояния 1500 юнитов передаются только команды игроков, и каждая машина исполняет идентичную симуляцию. [Game Developer](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond) Дизайн-цели: 8 игроков, target-платформа «16Mb Pentium 90 с 28.8 модемом», и система должна «оставаться жизнеспособной даже при флуктуациях задержки от 20 до 1000 мс». Механика: команды исполняются «через два коммуникационных хода в будущем» — то есть ставятся в очередь на «текущий тик + round-trip + 1». Пока не пришли команды всех игроков за тик X, симуляция ждёт.
- **Что компенсирует:** полосу (bandwidth ∝ размеру ввода, не числу объектов).
- **Чем платит:** input latency = задержке доставки; стойл при потере пакета (все ждут самого лагающего).
- **Когда ломается:** Fiedler по TCP при 250 мс / 5% потерь показывает постоянные хитчи; рекомендует lockstep только для 2–4 игроков.
- **Детерминизм:** обязателен и bit-exact.
- **При 200 мс:** играбельно для RTS (маскируется анимацией), неиграбельно для экшена.

**(B) Lockstep с динамическим turn length / input delay.** Age of Empires измерял пинг и частоту кадров всех игроков и плавно (маленькими шагами) подстраивал длину «хода» и число команд на ход. Это прямой предок adaptive input delay. Neon Marble Rust (2024) строит поверх lockstep двухстейтовый rollback. [itch](https://veterannewb.itch.io/neon-marble-rust/devlog/764800/rollback-in-rts)

**(C) Deterministic rollback (GGPO).** Тони Кэннон, 2006; MIT-лицензия с 2019. Идея: локальный игрок управляется без задержки, ввод оппонента предсказывается, при расхождении — откат к последнему верному состоянию и ре-симуляция вперёд. Требует детерминизма bit-exact. Работает хорошо до ~150 мс. Кэннон (Capcom-Unity, апрель 2010) о тесте Final Fight: Double Impact: «We started off playing Final Fight on the Playstation 3 with 0, 120, and 200 milliseconds of introduced latency at the default of 3 frames of input delay... The game performed like a champ in all 3 scenarios... the game passed all of these tests with flying colors.» Frame delay в GGPO статичен (`ggpo_set_frame_delay`), игры сами мапят RTT→кадры.

**(D) Client-side prediction + reconciliation + interpolation + server rewind (Source-модель).** Бернье (Valve, 2001): авторитетный сервер, клиент предсказывает своё движение и стрельбу, разделяя общий код движения (`pm_shared`); при расхождении — коррекция за один RTT (заметный «shift»). Прочие сущности — через interpolation (рендер «в прошлом»). Server-side lag compensation откатывает мир на сервере к моменту выстрела игрока.

### 2. Как это сделано в конкретных играх

**Source / Dota 2 / CS2.** Дефолт Source: сервер шлёт ~20 снапшотов/с, [GitHub](https://gist.github.com/CoolOppo/fe0586836de3fb2f90f9) интерполяция `cl_interp 0.1` (100 мс), чтобы пережить потерю одного пакета (2 валидных снапшота всегда в буфере). [Valve Developer Community](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking) `cl_interp_ratio/cl_updaterate = cl_interp`. Dota 2: тикрейт 30, `cl_cmdrate` клампится в 25, `cl_updaterate` — в 30; [steamcommunity](https://steamcommunity.com/discussions/forum/1/624075036409239295) при ratio 1 интерп ~33 мс. Урон считает сервер — «нажал абилку, она сработала через N мс» решается тем, что клиент даёт мгновенный визуальный отклик каста, а результат подтверждает сервер. CS2 subtick: сервер штампует точное время каждого ввода и прикладывает его в пределах тика, но симуляция всё равно дискретна; официальные серверы остались 64-тик. Реакция комьюнити на subtick смешанная — s1mple публично жаловался.

**World of Warcraft.** Spell batching: любое действие одного юнита над другим до Warlords of Draenor обрабатывалось батчами каждые 400 мс [WoWisClassic](https://www.wowisclassic.com/en/news/spell-batching-impact-ptr/) ; действия над собой — мгновенно. [GitHub](https://github.com/magey/classic-warrior/wiki/Spell-batching) Celestalon (Blue Post, июнь 2014): «Any action that one unit takes on another different unit used to be processed in batches every 400ms... We no longer batch them up like that. We just do it as fast as we can, which usually amounts to between 1ms and 10ms later.» Отсюда «двойной Polymorph». В Classic 400 мс вернули ради аутентичности, позже патч 1.13.7 снизил до 10 мс. [WoWisClassic](https://www.wowisclassic.com/en/news/spell-batching-impact-ptr/) Почему WoW играбелен при 300 мс: нет клиентского предсказания урона, клиент авторитетен только над своей позицией (с серверной античит-проверкой скорости), а GCD и spell queueing прячут RTT.

**Warcraft III / StarCraft II.** Детерминированный lockstep. Input latency от клика до реакции юнита — минимум следующий SimTick (0–100 мс), маскируется мгновенным UI-откликом (подсветка), звуком юнита («Zug Zug») и анимацией начала действия. [Forrestthewoods](https://www.forrestthewoods.com/blog/synchronous_rts_engines_and_a_tale_of_desyncs/) SC2 может десинкнуться (значит, тот же lockstep). [Forrestthewoods](https://www.forrestthewoods.com/blog/synchronous_rts_engines_and_a_tale_of_desyncs/) Input latency >100 мс в конкурентной игре заметен (по наблюдениям игроков форумов), но играть можно.

**Overwatch (Tim Ford, GDC 2017).** ECS; из ~46 клиентских систем и 103 типов компонентов геймплейного netcode касаются только 3 (movement, weapon, state script). Симуляция — фикс 16 мс командные кадры (~60 Гц), в турнирном режиме 7 мс (~128 Гц). **Клиент всегда впереди сервера на half-RTT + 1 командный кадр; при 160 мс RTT это ~96 мс лида.** Time dilation: при input starvation сервер сигналит клиенту, тот трактует шаг как ~15.2 мс вместо 16 (ускоряется ~на 5%), наполняя серверный буфер; при стабилизации — плавно назад. Input redundancy из Quake World: каждый пакет несёт все вводы с последнего подтверждённого состояния. «Predict everything, including rockets». Server rewind с bounding-volume culling (~последние полсекунды движения сущности); выше ~220 мс RTT предсказание попадания отключается, переход на экстраполяцию. Fixed sim rate «non-negotiable»; при отставании сервера — «death spiral».

**Rocket League (Jared Cone, GDC 2018).** Bullet Physics, фикс тик 120 Гц / 8.33 мс. «Input delay is not an option» — вместо задержки: сервер буферизует ввод клиента, клиент предсказывает всё. Upstream throttle (явно со ссылкой на Overwatch на слайде): буфер пуст → клиент бежит лишние физ-кадры; полон → меньше. Downstream throttle: сервер потребляет 0/1/2 ввода за кадр («Effective but with minor desyncs»). «Predict everything»: при 200 мс/120 Гц — 24 кадра ре-симуляции. Пустой буфер = повтор прошлого ввода = «minor desyncs». [Hone](https://hone.gg/blog/fix-lag-in-rocket-league/)

**Valorant (Riot).** 128-тик серверы, фикс 128 Гц симуляция, decoupled от рендера. [Riot Games](https://technology.riotgames.com/news/peeking-valorants-netcode) Hit registration: позиции и animation state в историческом буфере, сервер откатывает при выстреле; анимация считается каждый 4-й кадр (−75% стоимости), между — lerp. [Riot Games](https://www.riotgames.com/en/news/valorants-128-tick-servers) Peeker's advantage (Matt deWet & David Straily, tech blog, июль 2020): базовый при target 35 мс RTT, ~2 кадра серверного + ~3 кадра клиентского буфера ≈ **141 мс** преимущества атакующего; Riot Direct + 128-тик + урезанный буфер (полкадра на сервере, 1 кадр на клиенте) закрывают ~40 мс (28%), остаётся **~101 мс**; при 144 fps редукция достигает ~49%, остаток **~71 мс**.

### 3. Ключевой вопрос: оценка тика прибытия и синхронизация часов

**Почему `estimatedTick = тик последнего снапшота` неверен.** Снапшот, который клиент видит, был сгенерирован сервером ~half-RTT назад. Пока клиент его получил, сервер ушёл вперёд ещё на ~half-RTT (пока долетит новый ввод). Значит, чтобы ввод клиента исполнился на сервере вовремя, он должен метиться на тик **впереди** серверного «сейчас», а серверное «сейчас» = `последний_виденный_тик + RTT/(2·tickDuration)`. Метить на `последний_виденный_тик + inputDelay` — гарантированно опоздать на ~RTT.

**Правильная формула target-тика для ввода:**
```
serverNowTick   ≈ lastSnapshotTick + ceil( (RTT/2) / tickDurationMs )
targetInputTick = serverNowTick + inputDelayTicks
inputDelayTicks = clamp( ceil( (RTT/2 + jitterMargin) / tickDurationMs ), MIN, MAX )
```
При RTT=120 мс, tick=16.67 мс: RTT/2=60 мс → 4 тика только на долёт, плюс jitterMargin. `inputDelay=2` (33 мс) физически недостаточен — это подтверждает твою гипотезу: **input delay в тиках обязан быть функцией измеренного RTT, а не константой.**

**Синхронизация часов — Cristian's algorithm.** Клиент шлёт запрос в `t0`, сервер отвечает своим временем `T`, клиент получает в `t1`. [Wikipedia](https://en.wikipedia.org/wiki/Cristian%27s_algorithm) Оценка: `serverTime ≈ T + (t1−t0)/2`, [Wikipedia](https://en.wikipedia.org/wiki/Cristian%27s_algorithm) offset = серверное − локальное. Точность зависит от симметрии маршрута; асимметрия даёт систематическую ошибку. [Unstop](https://unstop.com/blog/cristians-algorithm) Улучшение (стандартное для NTP и игр): бери **минимум RTT из скользящего окна** многих проб — минимум наименее зашумлён, тем самым фильтруются выбросы и джиттер. [University at Buffalo](https://cse.buffalo.edu/~stevko/courses/cse486/spring13/lectures/08-time.pdf) Поверх — экспоненциальное сглаживание offset (EWMA, α≈0.1–0.2).

**Замер RTT в браузере без нативного ping.** Нативный WebSocket ping/pong из JS недоступен. Решение — application-level ping/pong: слать `{seq, tClientSend}`, сервер эхает `{seq, tClientSend, tServerRecv}`, на возврате считать `RTT = performance.now() − tClientSend` и offset по Cristian. У тебя уже есть `inputToVisibleMs` через эхо seq — это тот же механизм, доведи его до полноценного clock-sync. Точность таймеров: `performance.now()` монотонен, но в браузере кламплится (обычно 0.1–1 мс, с Spectre-mitigations — грубее). Для суб-мс точности и для `SharedArrayBuffer` (симуляция в воркере) нужен **cross-origin isolation**: заголовки `COOP: same-origin` + `COEP: require-corp`; [Andrew Lock](https://andrewlock.net/understanding-security-headers-part-3-cross-origin-embedder-policy/) тогда `performance.now()` возвращает высокое разрешение и открывается `SharedArrayBuffer`. [Rivendellweb](https://publishing-project.rivendellweb.net/a-deep-dive-into-cross-origin-isolation/) В Electron это контролируемо. `Date.now()` не монотонен (скачет при коррекции системных часов) — для дельт использовать только `performance.now()`; `performance.timeOrigin` даёт привязку к wall-clock при необходимости.

**Adaptive input delay + time dilation (clock drift smoothing).** Нельзя телепортировать локальный тик — это визуальный скачок и рассинхрон буфера. Вместо этого — biasing timestep: держи целевую глубину серверного буфера (2–3 ввода) и плавно меняй локальный шаг на ±несколько процентов (Overwatch: 16↔15.2 мс). Сервер сигналит starvation/overflow (upstream throttle Rocket League). Формально из Photon Quantum, промышленный аналог твоей задачи: input offset динамический на клиента, растёт с RTT; параметры — `InputDelayMin/Max` (0…60 тиков), `InputDelayPingStart=100 мс` (ниже — не трогаем), и **`MinOffsetCorrectionDiff=1 кадр` — это гистерезис**: применяем новый offset только если он отличается от текущего ≥ этого порога. Time-dilation-ветка: `TimeScalePingMin=100 мс`, `TimeScalePingMax=300 мс`, коррекция часов только при расхождении ≥1 кадра, сервер шлёт time-correction ~4×/с.

**Input buffer на сервере: starvation, overflow, fill-политика.** Держи 2–3 кадра. Недобор → time dilation (клиент ускоряется) ИЛИ, как крайняя мера, downstream throttle (1 ввод на 2 кадра). Переполнение → клиент замедляется / 2 ввода за кадр. **Почему `{...last, tick}` (repeat-fill) плох именно для движения:** повтор последнего кадра сохраняет вектор движения → герой «вечно бежит» в последнем направлении (ровно твой баг). Правильные политики по типу ввода:
- **Held-buttons (движение зажато, каналинг):** можно repeat — но с **decay**: сохраняй факт «кнопка зажата» ограниченное число кадров, затем обнуляй, чтобы не убегал бесконечно.
- **Вектор направления/движения:** **zero-fill** (обнуление) при недоборе — юнит останавливается, а не убегает. Это консервативно и легко откатывается серверным подтверждением.
- **Edge-triggered действия (каст абилки, клик):** **никогда не повторять** — иначе абилка «зафантомит» повторно. Такие события идемпотентны по seq и исполняются один раз.
Отдельно храни held-state и edge-events в кадре ввода. Твой `{...last, tick}` смешивает их — в этом корень.

### 4. Компенсация для детерминированного ядра с фиксированной точкой

**Rollback совместим с fixed-point ECS в воркере — детерминизм ты уже оплатил.** Нужно: snapshot/restore состояния мира, ring buffer состояний за окно предсказания, дешёвая ре-симуляция N тиков. При 60 Гц и RTT 200 мс окно — до ~24 тиков (цифра Rocket League). В JS/TS это ощутимо, но выполнимо, если снапшот дешёвый.

**Дешёвый снапшотинг ECS:** держи компоненты как **structure-of-arrays** в типизированных массивах (`Int32Array` под Q16.16). Снапшот = `slice`/`set` типизированных массивов (копирование памяти, не structured clone). Оптимизации: копирование только «грязных» чанков, дельта-снапшоты (xor к предыдущему), memory pooling ring-буфера, чтобы не аллоцировать. Ре-симуляция 10–15 тиков = 10–15 прогонов чистой интовой симуляции без рендера — при копеечной симуляции это доли миллисекунды на тик (замерь на худшем сценарии, см. Caveats).

**Гибрид own-entity prediction (твоя дорожная карта — верное решение).** Предсказывай только свою сущность, сервер авторитетен над остальным миром; чужие сущности — через interpolation. Это стыкуется с детерминизмом: локальный прогон своей сущности через тот же fixed-point код, что и на сервере, коррекция при расхождении. Это дешевле полного rollback (не ре-симулируешь весь мир) и достаточно для MOBA-боёвки.

**Разделяй три частоты.** Simulation rate (держи 60 Гц для отзывчивости и точной физики), snapshot rate (сетевой тик — можно 20–30 Гц, как Source/Dota, экономит полосу), input rate (обычно = sim rate, с redundancy). Снижение snapshot rate при 60 Гц симуляции — стандарт и правильный выбор.

**Rollback + воркер + рендер в основном потоке.** Синхронизируй снапшот в рендер через `SharedArrayBuffer` (double-buffering: воркер пишет в буфер A, рендер читает B, атомарный своп индекса), чтобы избежать стоимости `postMessage`/structured clone каждого кадра. Требует cross-origin isolation (см. п.3). Рендер интерполирует между двумя последними симуляционными состояниями — задержка на 1 sim-кадр допустима и косметична.

### 5. Интерполяция и сглаживание чужих сущностей

Держи interpolation buffer размером как функцию джиттера: `interpDelay ≈ snapshotInterval + k·jitterStdDev` (Source по умолчанию 2 интервала снапшота — переживает потерю одного). [Valve Developer Community](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking) Snapshot interpolation (рендер в прошлом) предпочтительнее extrapolation/dead reckoning: Бернье отмечает, что экстраполяция движения игроков часто неверна (высокий jerk, мгновенные повороты), QuakeWorld лимитировал её 100 мс. Экстраполяция — только как fallback при пропуске пакета, ограниченная по времени. «Резиновость» лечится: (1) достаточным буфером; (2) флагом «телепорт» в снапшоте, чтобы не интерполировать через большие дистанции. **Коррекцию своей сущности после реконсиляции не телепортируй** — накапливай position error и гаси его косметически за несколько кадров рендера (position error smoothing). Это ложится ровно на твою архитектуру: детерминированная симуляция в `core-ts` даёт «истинную» позицию, а сглаживание ошибки живёт в `render-ts` и не трогает симуляцию — симуляция остаётся bit-exact.

### 6. Lag compensation на сервере (server-side rewind)

Как работает (Бернье): перед исполнением команды игрока сервер вычисляет его латентность, находит снапшот, который игрок реально видел, откатывает всех остальных на тот момент (с учётом и латентности, и interp delay игрока), делает ray-cast, возвращает всех обратно. Окно отката у Valve ~ до 1 с (`sv_maxunlag`), но по факту ограничивается разумными 200–250 мс (Overwatch режет предсказание выше 220 мс). Цена — «убит из-за угла»: низкопинговый игрок, забежавший за угол, всё равно ловит пулю от высокопингового. Favor-the-shooter спорен, потому что перекладывает несправедливость на защищающегося; Valorant поэтому давит peeker's advantage тикрейтом, [Riot Games](https://www.riotgames.com/en/news/valorants-128-tick-servers) а не rewind'ом.

**Применимо ли к твоей боёвке? Нет, и это хорошая новость.** Rewind хитбоксов нужен для хитскана (мгновенный луч, нужно попасть в движущуюся цель). У тебя таргетные абилки (цель уже выбрана, попадание гарантировано выбором), юниты/крипы и, возможно, снаряды с временем полёта. Для таргетных способностей достаточно: **клиент предсказывает старт каста (анимация+звук), сервер подтверждает валидность (дальность, LoS, мана, жив ли таргет) и считает результат.** Rewind не нужен. Для снарядов с временем полёта — тоже: снаряд живёт на сервере, время полёта само по себе маскирует RTT (Бернье прямо отмечает, что projectile lag compensation проблематичен, и Valve его не делает). Это сознательный дизайн: увеличивай время полёта, избегай хитскана — и проблема rewind'а исчезает.

### 7. Отклик без предсказания (что делает WoW и Dota играбельными)

Это твой основной путь, позволяющий остаться на lockstep-подобной модели без полного rollback:
- **Мгновенный локальный визуально-звуковой отклик** на ввод при серверном авторитете над результатом: подсветка кнопки, анимация замаха, звук каста — сразу; урон/эффект — по подтверждению сервера. Так делают WC3/SC2 («Zug Zug») [Forrestthewoods](https://www.forrestthewoods.com/blog/synchronous_rts_engines_and_a_tale_of_desyncs/) и Dota.
- **Ability/spell queueing:** буферизуй следующее действие в конце текущего (окно очереди). WoW этим живёт — игрок «прожимает» следующую абилку заранее, сервер исполняет в нужный момент.
- **Windup-фазы анимаций**, скрывающие RTT: у абилки есть фаза замаха длиной ≥ ожидаемого RTT, за которую приходит подтверждение. Патент Sony (US 2014/0213367) прямо описывает удлинение анимации атаки для маскировки латентности в melee. [justia](https://patents.justia.com/patent/20140213367)
- **Дизайн, устойчивый к задержке:** нет требований к точности по кадрам, нет хитскана, увеличенное время полёта снарядов, нет парирования по кадрам. GCD в WoW (обычно 1.5 с) делает 300 мс несущественными.

Эти приёмы позволяют держать серверно-авторитетную lockstep-подобную модель с own-entity prediction и БЕЗ дорогого полного rollback.

### 8. Конкретные рекомендации для Fluxus

**Вердикт по твоему «правильному» пути.** Half-RTT-компенсация в `advance()`/`resyncTick` при `inputDelay=2` — **это тоже полумера, и твоя собственная догадка это подтверждает.** 33 мс бюджета физически меньше RTT/2 через Cloudflare. Half-RTT-компенсация чинит *смещение* (куда метить), но не чинит *бюджет* (хватает ли времени долететь). Нужны обе вещи: (1) правильная оценка серверного «сейчас» через clock sync; (2) **динамический** input delay из измеренного RTT+джиттера. Константа в JSON неверна концептуально.

**Формула target input delay (с гистерезисом):**
```
// раз в кадр:
halfRTT      = rttMinWindow / 2                 // минимум RTT из скользящего окна
jitterMargin = k * rttJitterStdDev              // k ≈ 2 (покрыть ~95% джиттера)
rawDelay     = ceil( (halfRTT + jitterMargin) / tickDurationMs )
target       = clamp(rawDelay, MIN_DELAY=2, MAX_DELAY=20)

// гистерезис: меняем только при значимом расхождении
if (abs(target - currentInputDelay) >= HYSTERESIS=2) {
    // не прыгаем сразу: двигаем на 1 тик за N кадров через time dilation
    desiredInputDelay = target
}
// приближение к desired — плавным biasing локального timestep, не скачком
```
Гистерезис `HYSTERESIS≥2` тика + требование стабильности несколько кадров (по образцу Quantum `MinOffsetCorrectionDiff` и confirmation window) не дают значению дёргаться каждый кадр.

**Протокол handshake для clock sync (стартовые значения):**
1. При коннекте — burst из 5–10 ping/pong `{seq, tClientSend}` → эхо `{seq, tClientSend, tServerRecv, tServerSend}`.
2. Клиент считает RTT по каждому, берёт медиану/минимум, offset по Cristian.
3. Дальше — 1 ping/с в стабильном режиме, скользящее окно последних ~20 проб, минимум RTT как основа, EWMA offset (α=0.1).
4. Стартовые: `tickRate=60`, `snapshotRate=30`, `interpDelay=2·snapshotInterval≈66 мс`, начальный `inputDelay` из первого burst RTT, `MIN_DELAY=2`, буфер сервера target=3.

**Cloudflare edge — уводи игровой трафик.** WebSocket через CDN добавляет прокси-хопы и джиттер (CDN оптимизирован под HTTP-кэш, не под latency-sensitive UDP-подобный трафик). Твой RTT 60–200 мс через edge — вероятно, частично артефакт маршрутизации (подтверди A/B-замером, см. Caveats). Прямое подключение к Hetzner VPS (у тебя уже план pool) даст меньший и стабильнее RTT/джиттер. Для WebSocket-фазы: терминируй WS прямо на VPS рядом с игроками, не через Cloudflare. Аналогичный урок с SDR: игроки Enshrouded жалуются, что форсированный Steam Datagram Relay гонит трафик в чужой POP и раздувает <10 мс LAN до ~100 мс. [Feature Upvote](https://enshrouded.featureupvote.com/suggestions/704248/forced-steam-datagram-relay-sdr-is-killing-performance-for-locallan-dedicated-se) SDR полезен для DDoS-защиты [Valve Developer Community](https://developer.valvesoftware.com/wiki/Steam_Datagram_Relay) и NAT-панчинга, но требует, чтобы твой VPS был рядом с SDR-POP; иначе релейный маршрут медленнее прямого (Valve прямо предупреждает об этом в документации). Вывод: **прямой VPS для игрового трафика, SDR/CDN — опционально и только если POP близко.**

**Телеметрия (снимай с первого дня):** гистограмма RTT (min/median/p95/p99), jitter (stddev RTT), счётчики applied/predicted/late на слот, глубина input buffer на сервере (в кадрах, min/avg/max), длина ре-симуляции (если пойдёшь в rollback), rate коррекций позиции и их амплитуда, частота starvation/overflow буфера, текущий inputDelay и timescale. Твой стенд уже считает «опоздало/применено» — расширь до полной картины.

**Дорожная карта.**
- *Сейчас (WebSocket):* почини clock sync и оценку серверного тика (убери `estimatedTick=lastSnapshot`); сделай input delay динамическим; замени repeat-fill на per-input-type политику (zero-fill для движения, decay для held, single-shot для edge); включи cross-origin isolation в Electron для `SharedArrayBuffer` и точного таймера; уведи WS с Cloudflare на прямой VPS.
- *Заложить в wire protocol уже сейчас (чтобы не переделывать):* (1) **input redundancy** — каждый пакет несёт последние N=3–5 кадров ввода (стандарт GGPO/Overwatch, чинит потерю без ретрансмита); (2) **last-one-wins снапшоты** — снапшоты не надёжные, только свежайший важен, старые дропаются; (3) seq+timestamp в каждом пакете; (4) явное разделение held-state / edge-events в структуре кадра ввода; (5) серверный tick и offset в каждом снапшоте.
- *После миграции на UDP (netcode.io/reliable.io порт на TS + Steam SDR):* input redundancy становится ещё дешевле (нет head-of-line blocking TCP); [GitHub](https://github.com/vvanders/netcode.io) добавь unreliable-канал для снапшотов и reliable-канал для критичных событий (yojimbo-модель); рассмотри own-entity prediction с откатом, раз детерминизм уже есть.

**Про внешние TS-библиотеки (ты пишешь своё — правильно, но знай ориентиры):** `@geckos.io/snapshot-interpolation` — компактная, чистая реализация snapshot interpolation, [npm](https://www.npmjs.com/package/@geckos.io/snapshot-interpolation) хороший референс по API (Vault, `CreateSnapshot`, percentage). [GitHub](https://github.com/geckosio/snapshot-interpolation) geckos.io сам делает UDP через WebRTC [Geckosio](https://geckosio.github.io/) DataChannel — альтернатива твоему netcode.io-порту, но тянет WebRTC-стек. colyseus — room-ориентированный, state sync через бинарный дифф, не заточен под fixed-point rollback. lance-gg — включает prediction/reconciliation, но на floating-point и с своим циклом, конфликтует с твоим детерминизмом. Moddio/taro — MIT, snapshot interp + reconciliation на WebSocket, [github](https://github.com/moddio/taro2) MOBA-подобные механики, но floating-point. **Вывод: ни одна не совместима с твоим fixed-point детерминизмом из коробки; бери из geckos.io идеи snapshot interpolation, остальное пиши сам.**

### Конфликты с детерминизмом fixed-point и Steam Deck (ARM)

- **`performance.now()` для clock sync и biasing timestep — только в косметическом/сетевом слое, НИКОГДА в симуляции.** Симуляция advance'ится целым числом тиков; time dilation меняет, *когда* вызывается тик, а не *содержимое* тика. Иначе x86/ARM разойдутся.
- **Position error smoothing — только в `render-ts`.** Симуляция bit-exact; сглаживание ошибки не пишет обратно в состояние. [CPP Cat](https://cppcat.com/deterministic-physics-engine/) Это ты уже архитектурно разделил — держи границу жёстко.
- **Steam Deck (ARM) vs x86 паритет:** твой Q16.16 это решает, но следи за: целочисленным делением/модуло (поведение при отрицательных — фиксируй явно), [Gaffer On Games](https://gafferongames.com/post/floating_point_determinism/) sqrt/trig через lookup-таблицы [Game Developer](https://www.gamedeveloper.com/programming/cross-platform-rts-synchronization-and-floating-point-indeterminism) (одинаковые таблицы на обеих платформах), порядком итерации по ECS (детерминированный порядок сущностей). НИ ОДИН float не должен попасть в симуляцию — включая случайный `Math.random()` (нужен детерминированный integer PRNG, seed из сервера).
- **`SharedArrayBuffer` между воркером и рендером** требует cross-origin isolation, но сам по себе детерминизму не угрожает — данные из симуляции идут в рендер односторонне.

## Recommendations

**Этап 0 — почини баг (дни).** Убери `estimatedTick = lastSnapshotTick`. Введи clock sync (Cristian + sliding-window min RTT + EWMA offset) через уже имеющийся seq-echo. Метить ввод на `serverNowTick + inputDelayTicks`, где `serverNowTick = lastSnapshotTick + ceil(halfRTT/tickDur)`. Замени `{...last, tick}`: движение → zero-fill, held → repeat с decay (≤ N кадров), edge-события → single-shot по seq. **Бенчмарк смены решения:** счётчик «опоздало» на слоте гостя должен упасть до ~0 при RTT 150 мс, «применено» — расти монотонно.

**Этап 1 — динамический input delay (недели).** Внедри формулу с гистерезисом (выше). Реализуй time dilation: держи серверный буфер на 2–3 кадрах, гони его через biasing timestep ±5%, upstream-throttle-сигнал от сервера. **Порог:** при RTT до 200 мс и джиттере до 30 мс не должно быть ни starvation, ни visible input lag > (RTT/2 + 1 тик).

**Этап 2 — транспорт и own-entity prediction (недели).** Уведи трафик на прямой Hetzner VPS. Заложи wire protocol с input redundancy и last-one-wins. Внедри own-entity prediction с откатом только своей сущности + position error smoothing в render-ts. **Порог перехода к полному rollback:** только если геймплей потребует предсказания чужих сущностей (быстрые снаряды-хитскан, точный ближний бой по кадрам) — тогда SoA-снапшоты + ring buffer + ре-симуляция. Пока боёвка таргетная — НЕ делай полный rollback.

**Этап 3 — UDP-миграция.** Портируй netcode.io/reliable.io, добавь unreliable-снапшоты + reliable-события, интегрируй SDR только если POP близко к твоим VPS. **Бенчмарк:** p99 RTT и джиттер на UDP должны быть ≤ WebSocket-фазе; иначе не мигрируй.

**Что изменит рекомендации:** если решишь добавить хитскан или парирование по кадрам — придётся вводить server-side rewind и, вероятно, полный rollback; тогда inputDelay-модель уступает место предсказанию всего мира. Если целевой RTT удастся удержать <60 мс прямым VPS — можно снизить MAX_DELAY и агрессивнее предсказывать.

## Caveats

- **Точные внутренние числа Overwatch (16↔15.2 мс, ~96 мс лид при 160 мс RTT) взяты из транскрипции доклада Форда (Edgegap deep-dive), а не из дословных слайдов GDC Vault** (видео за paywall). Значение «96 мс при 160 мс RTT» подтверждено дословной цитатой транскрипции; направление и порядок величин надёжны и подтверждаются формулой half-RTT+1 кадр из независимых источников.
- **CS2 subtick «~4096 Гц»** — оценка из сторонних разборов, не официальная спецификация Valve; Valve формулирует лишь «время действия прикладывается к тику». Официальные серверы 64-тик — по данным Wireshark-замеров комьюнити, не подтверждено Valve напрямую.
- **Photon Quantum-параметры** (`InputDelayMax=60`, `InputDelayPingStart=100`, `MinOffsetCorrectionDiff=1`) — из официальной API-документации Photon и приведены как промышленный ориентир; твои значения нужно калибровать под свою боёвку и тикрейт.
- **Cloudflare как причина джиттера** — сильная инженерная гипотеза (CDN не оптимизирован под игровой трафик), но твой RTT 60–200 мс может частично идти и от географии/last-mile; подтверди A/B-замером edge vs прямой VPS перед окончательным выводом.
- **Оценка стоимости ре-симуляции 10–15 тиков «доли мс»** зависит от размера мира и числа сущностей; замерь на своём худшем сценарии (макс. юнитов), прежде чем полагаться на rollback.
- **Числа тикрейтов** (Dota 2 = 30, Source дефолт 20 снапшотов/с, Valorant 128, Rocket League 120) актуальны на момент источников; Valve/Riot могут менять их патчами.

---

### Первоисточники

- **Yahn Bernier**, «Latency Compensating Methods in Client/Server In-game Protocol Design and Optimization» (Valve, 2001) — developer.valvesoftware.com/wiki/Latency_Compensating_Methods... ; «Source Multiplayer Networking» — developer.valvesoftware.com/wiki/Source_Multiplayer_Networking
- **Glenn Fiedler / Gaffer On Games**: Deterministic Lockstep, Snapshot Interpolation, State Synchronization, Floating Point Determinism, Fix Your Timestep — gafferongames.com ; **netcode.io / reliable.io** — github.com/networkprotocol
- **Gabriel Gambetta**, «Fast-Paced Multiplayer» (Client-Server Architecture / Client-Side Prediction & Server Reconciliation / Entity Interpolation / Lag Compensation) — gabrielgambetta.com
- **Bettner & Terrano**, «1500 Archers on a 28.8» (GDC 2001) — gamedeveloper.com / zoo.cs.yale.edu PDF
- **Tim Ford**, «Overwatch Gameplay Architecture and Netcode» (GDC 2017) — gdcvault.com/play/1024001 ; разбор — edgegap.com/blog/game-backend-deep-dive-overwatch
- **Jared Cone**, «It IS Rocket Science! The Physics and Networking of Rocket League» (GDC 2018) — media.gdcvault.com/gdc2018/presentations/Cone_Jared_It_Is_Rocket.pdf
- **Tony Cannon**, «Fight the Lag! The Trick Behind GGPO» (Game Developer, 2012) + GGPO (github.com/pond3r/ggpo) ; тест FFDI — news.capcomusa.com
- **Riot Games**, «Peeking into VALORANT's Netcode» и «VALORANT's 128-Tick Servers» — technology.riotgames.com
- **Blizzard / Celestalon**, spell batching Blue Post (2014) ; WoW Classic spell batching
- **CS2 subtick** — cs.money, key-drop.com (сторонние разборы 2023–2026)
- **Photon Quantum** DeterministicSessionConfig — doc-api.photonengine.com
- **Cristian's algorithm** — Cristian (1989), «Probabilistic clock synchronization» ; **Steam Datagram Relay** — partner.steamgames.com/doc/features/multiplayer/steamdatagramrelay ; **cross-origin isolation / performance.now()** — web.dev/articles/why-coop-coep ; **@geckos.io/snapshot-interpolation** — github.com/geckosio