# Инфраструктура игровых серверов для indie-игры уровня Dota/HotS на Fluxus: production-путь

## TL;DR
- **Транспорт:** оставайтесь на WebSocket (wss) для MVP; production-цель — **Steam Datagram Relay (SDR) через ISteamNetworkingSockets**, но ни один зрелый Node/Electron-биндинг сегодня не даёт SDR-relay сокеты «из коробки»: `ceifa/steamworks.js` экспонирует только устаревший ISteamNetworking P2P (v0.4.0, ~2 года без релиза на npm) и не умеет быть game server; `steamworks-ffi-node` (Koffi FFI) заявляет полноценный Networking Sockets Manager, но это молодой проект. Реалистичный production-стек: **raw UDP (Node `dgram`) + свой reliability-слой (по образцу netcode.io/reliable.io) на dedicated, и SDR P2P для listen-режима через FFI-биндинг**.
- **Хостинг:** для соло-разработчика в ЕС при EU+NA-запуске оптимум — **свой тонкий allocator + пул VPS на Hetzner** (EU: Falkenstein/Helsinki, NA: Ashburn/Hillsboro), с **Edgegap как burst/скейл-платформой без коммитмента** ($0.00115/vCPU-min, дробление до 1/4 vCPU). Hathora закрыл game-hosting 5 мая 2026 — из шорт-листа исключён; AWS GameLift и Agones избыточны и дороги для соло-дева.
- **Латентность:** для MOBA цель — **server tick 30–60 Hz + интерполяция 50–100 ms**; Dota 2 matchmaking работает на ~30 Hz. Двух регионов (EU+NA) достаточно для запуска. Ключевой первый шаг — не транспорт и не хостинг, а **инструментирование метрик (tick p99, broadcast lag, snapshot bytes/client) и тестовая матрица через tc/netem**.

## Key Findings

1. **SDR — это то, что вам нужно, но путь к нему из Node тернист.** SDR даёт бесплатное сокрытие IP, DDoS-защиту, шифрование и часто лучший пинг через backbone Valve — идеально для server-authoritative игры. Но SDR-relay для dedicated-серверов у Valve всё ещё beta и «не для всех партнёров». Из Node зрелого пути к ISteamNetworkingSockets+SDR нет: главный биндинг (`ceifa/steamworks.js`) даёт только legacy P2P и не поддерживает game server.
2. **Hathora мертва (для игр).** Объявлено 4 марта 2026, платформа заморожена немедленно, окончательное закрытие 5 мая 2026; команда ушла в Fireworks AI, официальный рекомендованный путь миграции — GameFabric by Nitrado. Первая заметная жертва — Stormgate (Frost Giant Studios). Не закладывайтесь на Hathora.
3. **Экономика в вашу пользу.** При матче 10 игроков на ~10–20% одного vCPU себестоимость compute мизерна; доминирует egress. На Hetzner (20 TB включено в EU-тарифы, overage €1/TB) вы платите практически только за инстансы; на managed-платформах egress ($0.10/GB у Edgegap) может составлять 30–60% счёта.
4. **Node.js справится с 60 Hz-симуляцией на 10 игроков**, но требует гигиены аллокаций (typed arrays, переиспользование буферов) и мониторинга event-loop lag. Ваша детерминированная ECS на fixed-point и SoA typed arrays — правильная архитектура именно под это.
5. **Anti-cheat: ваша server-authoritative + FoW-фильтрация модель уже закрывает главные классы читов** (maphack, teleport, speed). Kernel-anti-cheat соло-деву не нужен и вреден.

## Details

### 1. Транспорт для production (наивысший приоритет)

**Steam Datagram Relay / ISteamNetworkingSockets.**
SDR — виртуальная приватная игровая сеть Valve. Дословно из документации Steamworks: «Relaying the traffic protects your servers and players from DoS attack, because IP addresses are never revealed. All traffic you receive is authenticated, encrypted, and rate-limited. Furthermore, for a surprisingly high number of players, we can also find a faster route through our network, which actually improves player ping times.» Для P2P (listen-режим) достаточно `ISteamNetworkingSockets::CreateListenSocketP2P` / `ConnectP2P` — «all you need to do to take advantage of SDR» — Valve берёт на себя NAT-traversal и сокрытие IP хоста. Для dedicated используется `CreateHostedDedicatedServerListenSocket` + `SDR_LISTEN_PORT`, но Valve прямо предупреждает: «Carrying traffic to your dedicated servers over SDR is a beta feature, and is not a Steamworks feature we can offer to all partners at this time.» [Valve Developer Community](https://developer.valvesoftware.com/wiki/Steam_Datagram_Relay) Cross-platform-доступ к relay-сети также «might not be available to all partners and all games», а open-source-версия GameNetworkingSockets «does not support accessing the relay network».

**Критическая проблема Node/Electron-биндингов (по итогам целевого исследования):**
- **`ceifa/steamworks.js`** экспонирует только namespace `networking` c функциями `sendP2PPacket / isP2PPacketAvailable / readP2PPacket / acceptP2PSession` — это устаревший ISteamNetworking. Современный ISteamNetworkingSockets/Messages и SDR-relay listen-сокеты **не поддерживаются**. Последний релиз на npm — **v0.4.0, ~2 года назад**; ~52 открытых issue; **нет поддержки ISteamGameServer** (только клиент). PR #179 с NetworkingSockets закрыт, не влит (мейнтейнер: цель библиотеки — «good apis in js… not a 1:1 api bindings»). [GitHub](https://github.com/ceifa/steamworks.js/pull/179) Ремарка: main-ветка на GitHub свежее npm (PR мёржатся в 2025), но релиз не публикуется.
- **`steamworks-ffi-node`** (ArtyProf, Koffi FFI, SDK v1.64) заявляет «Networking Sockets Manager — P2P connections, reliable messaging (34 functions)» [GitHub](https://github.com/ArtyProf/steamworks-ffi-node) и активно развивается в 2025–2026. Но заявления о покрытии — маркетинг автора; зрелость в бою не подтверждена, поддержка game-server-сокетов не подтверждена. Плюс: Koffi FFI не привязан к Node/Electron ABI (вызывает `steam_api64.dll` напрямую).
- Под капотом legacy `sendP2PPacket` всё равно авто-релеится через SDR — то есть для **listen-режима «доверенным сторонам»** даже `ceifa/steamworks.js` технически скрывает IP хоста и проходит NAT. Это делает его приемлемым для listen-MVP.

**Raw UDP через Node `dgram` + свой reliability-слой.**
Что нужно минимальному протоколу: sequence numbers, ack/ack-bitfield, фрагментация >MTU, last-one-wins для снапшотов (новый снапшот отменяет старый), input redundancy (клиент шлёт последние N инпутов в каждом пакете для устойчивости к потерям). Эталон — статьи и библиотеки Glenn Fiedler: **netcode.io** (безопасное connection-ориентированное соединение поверх UDP с connect-token'ами — «perfect for a game where you perform matchmaking in a web backend then send clients to connect to a server») [GitHub](https://github.com/mas-bandwidth/netcode) и **reliable.io** (acks, фрагментация, оценка RTT/loss). [github](https://github.com/maximegmd/reliable.io) Node-биндинги ENet существуют, но нишевые и слабо поддерживаемые (`enet-js` — старый, на `node-waf`; growtopia-ориентированный биндинг). Практичнее портировать протокол netcode.io/reliable.io на TypeScript поверх `dgram` — это укладывается в ваш «transport behind an interface».

**WebTransport (HTTP/3/QUIC datagrams).**
В Node всё ещё **нет нативной поддержки**; де-факто стандарт — `@fails-components/webtransport` (libquiche-биндинг, C++), [npm](https://www.npmjs.com/package/@fails-components/webtransport) автор сам называет HTTP/3-часть «duct tape-style solution until a bull [npm](https://www.npmjs.com/package/@fails-components/webtransport) etin». Требует TLS-сертификатов (ограничение валидности ≤2 недель для serverCertificateHashes) и UDP, который часто блокируется в корпоративных/отельных сетях. Для Electron-клиента (не браузер) выгода QUIC-datagram над raw UDP отсутствует — вы и так можете открыть UDP-сокет. **Не рекомендуется.**

**WebRTC DataChannel (`node-datachannel` / `werift` / geckos.io).**
Имеет смысл почти исключительно для браузерных клиентов. `node-datachannel` (libdatachannel, N-API 8, Node ≥18.20) [GitHub](https://github.com/murat-dogan/node-datachannel) заметно быстрее чистых JS/wrtc-реализаций (в бенчмарках ~1320 ops/sec против ~186 у node-webrtc [GitHub](https://github.com/dguenther/js-datachannel-benchmarks) и ~1.26 у `werift` на throughput-тесте). geckos.io — удобная обёртка «socket.io-подобного» API поверх WebRTC для HTML5-игр. Но операционная сложность (ICE/STUN/TURN, DTLS-сертификаты, сигналинг) не оправдана, когда клиент — Electron. **Пропустить, пока нет браузерного клиента.**

**Вердикт по транспорту для вашего случая (порядок миграции):**
1. **MVP:** остаёмся на WebSocket (wss) — уже есть, TLS «из коробки», достаточно для интерполяции без prediction.
2. **Production dedicated:** raw UDP (`dgram`) + TS-порт netcode.io/reliable.io за вашим transport-интерфейсом. Полный контроль, отсутствие HOL-блокировки, last-one-wins снапшоты.
3. **Listen-режим (доверенные стороны):** SDR P2P через `steamworks-ffi-node` (если подтвердите зрелость) либо legacy P2P через `ceifa/steamworks.js` — оба скрывают IP хоста и проходят NAT бесплатно.
4. **DDoS-защита dedicated:** когда/если Valve даст SDR-dedicated доступ — включить его как ещё одну реализацию транспорта; до тех пор — сетевой фильтр провайдера + rate-limiting на границе.

**Флаг для пересмотра архитектуры:** ваш тезис «новые транспорты добавляются как реализации без изменения protocol» верен только если протокол изначально спроектирован под ненадёжную доставку (last-one-wins, идемпотентные снапшоты). WebSocket (надёжный, упорядоченный) «прощает» протоколу зависимость от порядка/гарантий доставки; при переходе на UDP это вылезет. **Проектируйте wire-протокол под UDP уже сейчас, даже гоняя его поверх WS.**

### 2. Хостинг и оркестрация dedicated-серверов

**Managed-платформы (2026):**

| Платформа | Модель цены | Free tier | Egress | Регионы EU+NA | Node/контейнеры | Замечания для соло-дева |
|---|---|---|---|---|---|---|
| **Edgegap** | $0.00115/vCPU-min (дробление до 1/4 vCPU → $0.0002875/min); RAM отдельно (~$0.0051/GB-hr) | Free-аккаунт без карты | $0.10/GB сверху | 615 локаций, 17+ провайдеров | Контейнеры, no SDK | Нет коммитмента; Private Fleet Performance $250/мес (16 vCPU, 32 GB, 5 TB egress включён) |
| **Gameye** | $0.07/vCPU-hr on-demand, $0.027 reserved | Sandbox за 24ч | **Включён** | 18+ bare-metal провайдеров | Контейнеры, no SDK | Только целые vCPU; egress включён — плюс |
| **AWS GameLift** | Per-instance-hour + FlexMatch; egress бесплатен на gen6+ | Anywhere: 3000 сессий + 500k conn-min/мес 12 мес | Бесплатен gen6+ | 26 регионов | Контейнеры/Anywhere/Realtime | Сложность, IPv4 $0.005/ч, lock-in |
| **Hathora** | — | — | — | — | — | **ЗАКРЫТ 5 мая 2026** — не использовать (миграция → GameFabric by Nitrado) |
| **PlayFab MPS** | Per-core-hour (Azure) | Кредиты Azure | Отдельно | Azure-регионы | Контейнеры/процессы | Тяжёлая интеграция, экосистема Azure |

**Self-managed:**
- **Agones (k8s):** мощно, но операционно тяжело для соло-дева. Требует `sdk.Ready()/Allocate()/Shutdown()` в каждом билде, провижининг кластера, тюнинг флитов, multi-region routing, on-call. Оценки: 3-региональный кластер на 5000 CCU — порядка $8,000–$15,000/мес только на compute-нодах, работающих 24/7. **Избыточно.**
- **Пул VPS + тонкий allocator:** для вашего масштаба оптимально. Hetzner CX/CPX (после апрельского 2026 подорожания на 30–37% CPX22 = 2 vCPU/4 GB ≈ €7.99/мес, ранее €5.99; 20 TB egress включено в EU, overage €1/TB). Регионы Hetzner: Falkenstein/Nuremberg/Helsinki (EU) + Ashburn/Hillsboro (NA) — идеально покрывают EU+NA. Архитектура: control plane (лобби, matchmaking, аллокатор, version gate) на 1 маленьком VPS в EU + пул match-процессов; аллокатор спавнит process-per-match и возвращает адрес/порт.

**Конкретное моделирование стоимости (матч 10 игроков, ~15% vCPU, ~1 час):**
- **VPS-путь (Hetzner):** CPX22 (2 vCPU) при ~15% на матч вмещает ~10–13 одновременных матчей. €7.99/мес ÷ ~10 матчей ÷ 720ч ≈ **~€0.001 за матч-час на compute**; egress в EU-тарифе включён. При CCU=100 (10 матчей) хватает ~1 CPX22 → **~€8/мес всего**.
- **Edgegap:** 1/4 vCPU × $0.00115/min × 60 = **$0.0173/матч-час** compute + egress. Матч 10 игроков при ~20 KB/s/игрока ≈ 200 KB/s ≈ 0.7 GB/час → $0.07 egress → **~$0.09/матч-час**. При 100 CCU (10 матчей, ~50% средняя загрузка) ≈ **$30–60/мес**.
- **Break-even:** VPS-пул дешевле в разы при стабильной загрузке; managed выигрывает при рваном/непредсказуемом трафике и в дальних регионах, где у вас нет своих машин. **Гибрид: базовая нагрузка на Hetzner, всплески/новые регионы — Edgegap.**

**Что реально используют мелкие indie:** практика — VPS-флот с самописным аллокатором либо контейнерная managed-платформа без коммитмента; k8s/Agones — прерогатива средних+ студий из-за TCO.

**Вердикт для вашего случая:** старт — **1 control-plane VPS + пул Hetzner в EU и NA + Edgegap как overflow**. Не берите Agones/GameLift/PlayFab на старте.

### 3. Latency engineering для no-prediction (затем own-entity-prediction) MOBA

**Что делают эталоны:**
- **Dota 2:** matchmaking-серверы ~30 Hz. Важно: Valve **официально не публиковал** эту цифру для матчмейкинга Dota 2 (в отличие от CS2 с subtick) — это «well-supported community consensus, not an official spec sheet number»; клиентский `cl_updaterate` по умолчанию 30 (макс. 40), кастомные лобби могут выше. Source-движок: server tick + client prediction + interpolation, `cl_interp` даёт постоянный «лаг» отображения ~100 ms по умолчанию. [Valve Developer Community](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking)
- **Общее правило (Source):** «Interpolation adds a deliberate window, often 50 to 100 ms.» Пример: 30 Hz сервер + 40 ms one-way + 66 ms буфер интерполяции ≈ 106 ms display delay [PulseGeek](https://pulsegeek.com/articles/network-tick-rate-interpolation-vs-extrapolation/) — движение стабильно, hit-confirmation чуть запаздывает.
- **Конкурентный ориентир по пингу:** Riot Games для киберспорта League of Legends установил «ceiling of 40 ms for play to be considered viable at the highest competitive level with an acceptable variance of +/- 5 ms» (Riot Games Tech Blog). Это — потолок для про-уровня; массовый игрок толерантен к заметно большему (обычно <30–50 ms считается «отлично», >150 ms — ощутимый лаг).

**Целевая раскладка input-to-photon для вашей игры (MVP, без prediction):** RTT (server region) + interpolation buffer + input delay. При EU+NA с правильным регион-матчмейкингом RTT ~20–50 ms внутри региона; буфер 66–100 ms; итого ~120–180 ms до prediction. Для MOBA это **играбельно** (жанр толерантнее шутеров — важнее тайминг способностей, чем twitch-aim), но верхний край. **Own-entity prediction с reconciliation** — обязательный второй слой: он убирает input delay для собственного героя (клик → мгновенный отклик), что для Dota-like критично субъективно.

**Регион-матчмейкинг:** для запуска минимально жизнеспособны **2 региона — EU и NA-East**; ping-based выбор сервера (клиент пингует кандидатов, matchmaker выбирает минимальный RTT). NA-West добавить при росте West-Coast аудитории. Внутри EU одна точка (Falkenstein/Helsinki) покрывает Западную/Центральную Европу с RTT <40 ms.

**Методология тестирования:** `tc`/`netem` (Linux) для инъекции latency/jitter/loss на сервере или между процессами; `toxiproxy` для программного управления в CI. Рекомендуемая тестовая матрица:
- Latency: 0 / 30 / 60 / 100 / 150 / 250 ms one-way.
- Jitter: ±5 / ±20 / ±50 ms.
- Loss: 0 / 1 / 3 / 5 / 10 %.
- Reorder/duplication: 1–2 %.
- Сценарии: rewind-ult (7 s) под 150 ms+loss; массовый teamfight (пик snapshot bytes) под jitter; reconnect в окне переподключения.

**Флаг:** ваш rewind-the-world ult (7 s, server-driven) требует хранить 7 s истории мирового состояния (при 60 Hz = 420 тиков) для bit-exact отмотки. Это нагрузка на память и на детерминизм — canonical match log (worldInit, seed, inputs[]) здесь ваш друг: отматывайте реплеем инпутов, а не снапшотами полного состояния.

### 4. Steam-специфичная инфраструктура

**Steam Auth Session Tickets (аутентификация игрока на dedicated из Node-бэкенда):**
Поток: клиент вызывает `ISteamUser::GetAuthTicketForWebApi` (именно web-API вариант, не старый `GetAuthSessionTicket`), передаёт ticket на ваш сервер; сервер вызывает Web API `GET https://partner.steam-api.com/ISteamUserAuth/AuthenticateUserTicket/v1/` с **publisher API key** (только с защищённого сервера, «MUST be called from a secure server, and can never be used directly by clients») → получает 64-битный SteamID при валидности. Далее `GET .../ISteamUser/GetPlayerBans/v1/` возвращает `VACBanned`, `NumberOfVACBans`, `NumberOfGameBans`, `EconomyBan` и т.д. — проверка банов. Запросы rate-limited. [Steam](https://partner.steamgames.com/doc/webapi/isteamuserauth) Это ложится на ваш handshake: version gate (build id + content-pack hash) → Steam ticket validation → SteamID → ban check → worldInit hash → первый тик.

**Флаг по «no auth в MVP»:** для listen-режима «доверенным сторонам» отсутствие auth приемлемо. Для **dedicated с публичным матчмейкингом** отсутствие auth = невозможность банить, античит бессмыслен, возможны имперсонация и spoofing. Рекомендация: Steam ticket auth — обязателен до первого публичного dedicated-запуска, но может быть после MVP.

**Steam-лобби как rendezvous для listen-режима:** ISteamMatchmaking (`CreateLobby`/`InviteUserToLobby`, `+connect_lobby <id>` при cold-launch, `GameLobbyJoinRequested_t` [Steam](https://partner.steamgames.com/doc/api/isteammatchmaking) при running). Rich Presence `connect`-ключ включает кнопку «Join Game». [Steam](https://partner.steamgames.com/doc/api/isteamfriends) Важно: «Any user in a Steam lobby is already fully authenticated with the Steam back-end» [Steamworks](https://partner.steamgames.com/doc/features/multiplayer/matchmaking) — лобби бесплатно даёт вам аутентифицированный rendezvous без своего брокера. Это идеально ложится на ваш «broker behind an interface, never carries match traffic»: **Steam-лобби = брокер, SDR P2P = транспорт матча**.

**Remote Play Together:** для вашего жанра (каждому игроку нужен свой экран с FoW) RPT **нерелевантен** — он стримит один экран host'а нескольким геймпадам, что несовместимо с per-client FoW-фильтрацией.

**Steam Deck как listen-host:** Deck (4-ядерный Zen 2, 15 W TDP) технически потянет sim (60 Hz на 10 сущностей-игроков + способности) + render + N≤10 snapshot-фильтраций, но это тройная нагрузка на скромный бюджет. Рекомендация: на Deck-хосте ограничить N (например, listen только для 2–4 игроков), либо снизить broadcast до 20 Hz, либо не позиционировать Deck как listen-host для полных 10-игровых матчей. Тестировать отдельно.

### 5. Операционные практики Node.js game-server

**Process-per-match vs worker_threads:** для вас — **process-per-match**. Плюсы: полная изоляция (краш одного матча не роняет остальные), простой IPC с control plane (stdio/сокет/HTTP), чистое освобождение памяти при завершении, естественный fit к canonical match log. Минус — RSS на процесс (Node 22 базово ~40–80 MB на пустой процесс; с вашей SoA-ECS на 10 игроков — плюс небольшие typed-array буферы). worker_threads экономят память (общий V8-рантайм), но краш/утечка в одном воркере угрожают соседям и усложняют детерминизм. При десятках матчей на VPS RSS-оверхед процессов терпим; при сотнях — рассмотрите worker_threads-пулы, но не на старте.

**GC и гигиена аллокаций для 60 Hz:**
- Ваша архитектура (fixed-point Q16.16, SoA typed arrays, no runtime deps) уже минимизирует аллокации в hot path — это главный фактор.
- Переиспользуйте буферы сериализации (pre-allocated `Buffer`/`DataView`, пишите снапшоты in-place, не создавайте объекты на тик).
- Мониторьте event-loop lag (`perf_hooks.monitorEventLoopDelay`, `prom-client`); порог тревоги — если p99 tick duration приближается к бюджету тика (16.6 ms при 60 Hz).
- `--max-old-space-size` держите скромным на match-процессе (например 128–256 MB) — большой heap [Medium](https://medium.com/@techWithAditya/the-secret-to-lightning-fast-node-js-reducing-event-loop-latency-4cbfcfdb60cf) = долгие full-GC паузы, фатальные для 60 Hz-цикла; лучше частый минорный GC на маленьком heap.
- Когда уводить hot path из Node: если tick p99 стабильно >8–10 ms на 10 игроков — профилируйте; кандидаты на вынос (WASM/native) — сериализация и FoW-видимость, но ваша детерминированная TS-ECS скорее всего справится.

**Reference-архитектуры:** изучить **Colyseus** (rooms как процессная модель, matchmaker с `selectProcessIdToCreateRoom`, [Colyseus](https://docs.colyseus.io/server) `setSimulationInterval` дефолт 16.6 ms/60fps, [Colyseus](https://docs.colyseus.io/room) graceful shutdown с `onBeforeShutdown`, presence/driver-абстракции, `simulateLatency()` для локальных тестов). Даже не принимая его, паттерны rooms/matchmaking/IPC напрямую применимы. Colyseus по умолчанию на WebSocket и не даёт вашей FoW-фильтрации и детерминизма, поэтому как фреймворк не подходит, но как источник дизайн-решений — да.

**Observability (метрики на матч, которые важны):** tick duration p99, broadcast lag (время от конца тика до отправки последнему клиенту), snapshot bytes/client (растёт в teamfight — контролируйте под FoW), число активных соединений, RSS процесса, event-loop delay. Crash handling: при краше match-процесса control plane обязан сохранить canonical match log (worldInit, seed, inputs[]) для bit-exact replay и постмортема — это ваше главное преимущество для отладки.

### 6. Security/abuse baseline для запуска

- **Input rate limiting и валидация на границе:** жёстко ограничьте частоту и размер входящих пакетов на клиента (например ≤ sim-rate инпутов/сек + burst); валидируйте, что инпут синтаксически корректен и относится к сущности игрока — не доверяйте ничему от клиента (это уже суть server-authoritative).
- **DDoS-posture:** без SDR — полагайтесь на фильтрацию провайдера (Hetzner включает базовую DDoS-защиту) + rate-limiting + сокрытие IP dedicated (не публикуйте IP, раздавайте через matchmaker). С SDR — IP вообще не раскрывается, трафик authenticated/encrypted/rate-limited на стороне Valve. [Valve Developer Community](https://developer.valvesoftware.com/wiki/Steam_Datagram_Relay) Для listen-режима SDR P2P **обязателен** (иначе IP хоста-игрока раскрывается пирами).
- **TLS (wss) vs relay encryption:** на WS-этапе — wss (TLS) обязателен. При переходе на UDP raw — своё шифрование (netcode.io даёт per-packet шифрование и connect-token'ы); при SDR — шифрование Valve. Не гоняйте игровой трафик по открытому UDP без auth-токенов.
- **Reconnect windows:** держите слот игрока живым N секунд после дисконнекта (canonical log позволяет доиграть/переподключить без потери детерминизма); окно 30–60 s разумно.
- **Anti-cheat реалистично для соло-дева:** ваша server-authoritative + FoW-фильтрация модель уже убивает maphack (клиент физически не получает скрытые данные), teleport, speedhack, item-injection — «server authority kills entire exploit classes outright». [Crux](https://crux.supercraft.host/blog/server-authoritative-anti-cheat-backend/) Что делать: server-side валидация + телеметрия (детект рассинхронов, аномальных паттернов) + «invisible ban» (собирать сигналы, матчить подозреваемых вместе). [GameDev.net](https://www.gamedev.net/forums/topic/709319-anti-cheat-for-online-indie-games/) **Что пропустить:** kernel-anti-cheat (EAC/BattlEye) — это гонка вооружений и operational burden не для соло-дева; для listen-режима kernel-AC вообще бесполезен.

## Recommendations

**Этап 0 (сейчас, до нового кода):** Инструментируйте то, что есть. Добавьте метрики tick p99, broadcast lag, snapshot bytes/client в текущий WS-сервер. Постройте тестовую матрицу tc/netem (latency/jitter/loss из раздела 3). **Порог перехода к следующему этапу:** вы измеряете реальную latency-раскладку и видите tick p99 < 8 ms на 10 игроков.

**Этап 1 (MVP-запуск):** WebSocket (wss) + process-per-match + 1 control-plane VPS + пул Hetzner (EU: Falkenstein/Helsinki). Steam-лобби как rendezvous для listen. Без auth для listen-«доверенным». Реализуйте reconnect-окно и rate-limiting на границе. **Не строить** свой UDP, SDR, GameLift, Agones на этом этапе.

**Этап 2 (own-entity prediction + NA):** Добавьте client-side prediction с reconciliation для собственного героя (снимает input delay). Разверните NA-регион (Hetzner Ashburn). Ping-based регион-матчмейкинг. **Порог:** стабильные жалобы на «отзывчивость» героя или RTT>120 ms у заметной доли игроков.

**Этап 3 (production dedicated транспорт):** Спроектируйте wire-протокол под ненадёжную доставку (last-one-wins снапшоты, input redundancy, sequence/ack) и внедрите raw UDP (`dgram`) + TS-порт netcode.io/reliable.io за transport-интерфейсом. Добавьте Edgegap как overflow/новые регионы. **Порог:** WS-латентность/HOL становится узким местом, либо нужен регион без своих машин.

**Этап 4 (публичный матчмейкинг + защита):** Steam ticket auth (`GetAuthTicketForWebApi` → `AuthenticateUserTicket`) + ban-check (`GetPlayerBans`) в handshake. SDR P2P для listen (через `steamworks-ffi-node` после проверки зрелости). Серверная телеметрия читов + invisible ban. SDR-dedicated — если Valve откроет доступ. **Порог:** первый публичный dedicated-матчмейкинг-запуск.

## Caveats
- **SDR-dedicated — beta и «не для всех партнёров»** по документации Valve; не закладывайте его в критический путь, пока не получите подтверждённый доступ под свой AppID.
- **Node/Electron-биндинги Steam networking незрелы:** `ceifa/steamworks.js` — только legacy P2P, нет game-server, npm-релиз ~2 года; `steamworks-ffi-node` — молодой, покрытие заявлено автором, в бою не проверено. Прежде чем строить на них SDR-транспорт — сделайте PoC и проверьте под вашими версиями Node/Electron ABI.
- **Тик-рейт Dota 2 (~30 Hz) — community consensus, не официальная цифра Valve.** Ваш выбор 60 Hz sim / 30 Hz broadcast разумен и консервативен. Riot-овские 40 ms — потолок для про-киберспорта, не требование к массовому игроку.
- **Цены VPS/managed волатильны:** Hetzner поднял тарифы на 30–37% с 1 апреля 2026 (анонс 19 февраля 2026; учтите июньскую реноминацию SKU — старый CPX11 стал CPX22); Edgegap-ставки указаны на Q1/Q2 2026. Пересчитайте перед коммитом.
- **Оценки RSS Node-процесса и «10–13 матчей на CPX22» — расчётные ориентиры**, не измерения вашего билда; провалидируйте нагрузочным тестом до масштабирования.
- **Steam Deck как full-10-listen-host не подтверждён замерами** — требует отдельного профилирования CPU-бюджета.
- Свежие официальные цифры по PlayFab Multiplayer Servers 2026 из первичного источника получить не удалось; строки таблицы по PlayFab даны на основе общей модели ценообразования Azure и могут устареть — уточните перед выбором.
