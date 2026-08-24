# Pathfinding для Fluxus: use vs build — детерминированный fixed-point A*

## TL;DR
- **Строить своё.** Для Fluxus оптимально — собственный детерминированный grid A* (позже JPS) на целочисленных costs / Q16.16 в новом пакете `nav-ts`, зависящем только от `core-ts`. Ни одна из готовых JS/WASM-библиотек (pathfinding.js, easystar.js, recast-navigation-js, three-pathfinding, yuka) не даёт кросс-платформенного детерминизма: все на float, а recast/detour и ORCA ломают lockstep.
- **Grid, не navmesh, на первом этапе.** Dota 2 использует grid-навигацию (GridNav: long pather по сетке 64×64 + short pather «wall-tracing» в непрерывном пространстве); StarCraft 2 использует navmesh (constrained Delaunay) + funnel + steering, но генерация navmesh на float плохо ложится на детерминизм. При ~10 агентах производительность вторична, детерминизм и простота — первичны. Эталон для копирования — двухуровневый fixed-point пасфайндер 0 A.D.
- **Локальное избегание отложить.** ORCA/RVO во float недетерминированы; детерминированные fixed-point RVO существуют (Photon Quantum, форк DotsNav), но это отдельный крупный модуль. На первом этапе — модель Dota: юниты блокируют друг друга collision-hull'ами, репасинг при блокировке; steering/avoidance добавить позже отдельным слоем.

## Key Findings

1. **Жёсткий фильтр — детерминизм, а не производительность.** Fluxus — детерминированное lockstep-ядро на Q16.16 без float в симуляции, sim в Web Worker, golden-эталоны прогонов (побитовое сравнение), границы пакетов через dependency-cruiser, `core-ts` без рантайм-зависимостей «как принцип». Это исключает любую библиотеку с float-внутренностями из sim-слоя.
2. **Integer grid A* тривиально детерминирован**; navmesh-генерация и float-steering — нет. Целочисленные costs + фиксированное tie-breaking дают побитовую воспроизводимость на всех платформах бесплатно.
3. **Готовых детерминированных JS/TS-решений нет.** Все обследованные библиотеки используют float (JS `number` = f64) и/или недетерминированные структуры; ни одна не рассчитана на fixed-point lockstep.
4. **Эталон существует и открыт — 0 A.D.** Двухуровневый fixed-point пасфайндер (long-range grid A*+JPS, short-range vertex/visibility) на типе `CFixed` (15.16) с целочисленным `PathCost`. Прямой референс архитектуры для Fluxus.
5. **Индустрия MOBA/RTS расходится в представлении карты**, но сходится в двухуровневости: глобальный поиск маршрута (grid или navmesh) + локальное следование/избегание.

## Details

### 1. Ограничения движка (из репозитория)

Из README и структуры репозитория Fluxus:
- **Ядро `core-ts`**: `src/math`, `src/ecs`, `src/dsl`, `src/systems`, `src/sim`; «рантайм-зависимостей нет вовсе — это принцип». Q16.16 fixed-point, детерминированный ECS-тик.
- **Односторонние зависимости**: `net-ts` → `core-ts` (NTR-1); `render-ts` (three.js) и `assets-ts` не знают друг о друге; `client-ts` запускает ядро в воркере поверх transferable-буферов.
- **Спеки OpenSpec** по capability: DET-, ECS-, NET-, NTR-, **NAV-**, FOW- (то есть NAV — уже выделенная capability в спеке). Нормативные требования лежат в `openspec/specs/`.
- **Golden-тесты**: `tests/golden/` — пары `*.scenario.json`/`*.golden.json`, побитовые эталоны; `integration-ts` пишет golden-матчи и фаззит. Любой пасфайндер обязан проходить эти побитовые эталоны кросс-платформенно.
- **Контент** (`content/`): sim-документы сцен/матчей, манифест визуалов, модели/текстуры; ID ассета = путь. Карта навигации должна авторизоваться как sim-контент (детерминированные данные), а не как косметика.

Вывод: пасфайндер должен жить в sim-слое, быть на Q16.16/целых числах, без рантайм-зависимостей, проходить golden-детерминизм-тесты и укладываться в границы dependency-cruiser.

### 2. Ландшафт алгоритмов (что реально используют MOBA/RTS)

- **Dota 2 (GridNav)**: два пасфайндера одновременно. GridNav включён по умолчанию, навигационная сетка генерируется автоматически при компиляции карты и состоит из ячеек 64×64 юнита, покрывающих всю карту (Valve Developer Community). «Long pather» — классический RTS-алгоритм по фиксированной сетке, учитывает только статические блокеры (террейн, деревья), юниты игнорируются. [Liquipedia](https://liquipedia.net/dota2/Pathfinding) «Short pather», по Liquipedia Dota 2 Wiki, — «более сложный алгоритм избегания, который не работает на сетке и учитывает стоячих юнитов как блокеры… использует "wall-tracing", работающий с препятствиями в непрерывном пространстве». Юниты блокируют друг друга collision-hull'ами (стандартизованные размеры); lane-крипы не обходят препятствие, а упираются в него; управляемые игроком юниты обходят. Pathing-блокеры — невидимые сущности с collision size.
- **Warcraft III**: grid-навигация; сообщество считает, что использовался вариант иерархического A* (HPA*) + локальный репасинг при блокировке (обрезка недостижимых узлов очереди и перепланирование).
- **StarCraft 2** (доклад James Anhalt, GDC): navmesh на constrained Delaunay triangulation по террейну и зданиям, A* по navmesh + funnel-фильтр с учётом радиуса юнита, затем steering и collision. Динамической памяти в пасфайндере нет. [github](https://howtorts.github.io/2014/01/06/pathing-literature-review.html) Динамические препятствия: базовый navmesh со статикой + пересборка при добавлении/удалении препятствий. Steering: following, flocking, grouping, separation, avoidance, arrival. По конспекту доклада (howtorts.github.io): «Avoidance was hard to get right. Они игнорируют тех, кто движется в вашем общем направлении, и тех, кто стоит (их можно растолкать). Смотрят на то, что перед вами, и целятся в ближайший к центру просвет».
- **Supreme Commander 2 / Planetary Annihilation**: flow field tiles (Elijah Emerson, Game AI Pro) — A* по секторам (10×10) с порталами + интеграция eikonal-волны в flow field для крупных групп. [Gameaipro](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter23_Crowd_Pathfinding_and_Steering_Using_Flow_Field_Tiles.pdf) Эффективно для сотен-тысяч агентов, избыточно для ~10.
- **Spring RTS**: собственный grid-пасфайндер + улучшения группового движения.
- **Funnel / string pulling** (Simple Stupid Funnel Algorithm, Mikko Mononen): стандарт для сглаживания пути по navmesh — «протягивание нитки» через порталы (общие рёбра треугольников). [DIVA-Portal](https://liu.diva-portal.org/smash/get/diva2:1560399/FULLTEXT01.pdf) Только для navmesh; на grid — отдельные алгоритмы сглаживания (Theta*, string-pulling по grid).
- **Локальное избегание**: RVO → ORCA (van den Berg; референс-реализация RVO2). ORCA решает малую LP-задачу на полуплоскостях; децентрализовано, но склонно к дедлокам [Gameaipro](https://www.gameaipro.com/GameAIPro3/GameAIPro3_Chapter19_RVO_and_ORCA_How_They_Really_Work.pdf) и оперирует float. Dota умышленно не использует «жёсткую» физику: юниты блокируют телами, при потере phased movement расталкиваются на фикс. дистанцию.

### 3. Фильтр детерминизма (ключевой)

- **Что детерминированно-дружественно**: целочисленный/fixed-point grid A* с фиксированным tie-breaking. Costs — целые; порядок раскрытия узлов задаётся детерминированной очередью с приоритетом и стабильным вторичным ключом (например, индекс ячейки). Эвристика — октайл/манхэттен без sqrt (диагональ аппроксимируется целым). Точная схема из исходников 0 A.D. (`source/simulation2/helpers/Pathfinding.h`): `PathCost(u16 hv, u16 d) : data(hv * 65536 + d * 92682) // 2^16 * sqrt(2) == 92681.9`.
- **Что проблемно**:
  - float в cost/эвристике → расхождение x86 vs ARM (Steam Deck!) vs разные браузеры/движки JS.
  - неупорядоченная итерация (Map/Set по вставке хэша, `for..in`) → недетерминированный порядок раскрытия.
  - tie-breaking по float или по адресу объекта.
  - `Math.sqrt`, `Math.hypot`, тригонометрия — не гарантируют побитовую идентичность между платформами.
- **Как Q16.16 ложится на подходы**: расстояния/costs — целые (не нужен даже Q16.16 для самого A*, достаточно integer PathCost). Sqrt для эвристики не нужен (октайл). Для локального избегания в fixed-point нужен fixed-point sqrt/деление (детерминированные целочисленные реализации существуют, напр. алгоритмы на сдвигах).
- **Fixed-point RVO/navmesh в чужих движках**:
  - **Photon Quantum** — по заявлению разработчика (photonengine.com/quantum), «единственный на рынке 100% детерминированный многопользовательский игровой движок»; использует fixed-point тип FP (Q48.16), который «полностью заменяет все использования float и double для обеспечения кросс-платформенного детерминизма»; встроены navmesh/flowfield-пасфайндинг и avoidance. [Photon Engine](https://www.photonengine.com/quantum) Критично: конвертация из float в FP «недетерминирована из-за ошибок округления и никогда не должна выполняться внутри симуляции — такая конверсия в симуляции вызовет десинк в 100% случаев» (doc.photonengine.com). Поэтому navmesh пекётся оффлайн (Unity-пайплайн) и/или BakeData генерируется детерминированно на каждом клиенте; runtime-генерации navmesh детерминированно между клиентами нет.
  - **DotsNav** (Unity DOTS) — динамический navmesh + порт RVO2, но использует адаптивные float-предикаты (не fixed-point), [GitHub](https://github.com/dotsnav/dotsnav) т.е. не для lockstep из коробки.
  - **Bannermen** (Photon+UE) — написали собственную fixed-point математику и на ней собственные navmesh, pathfinding, collision. [Photonengine](https://blog.photonengine.com/bannermen-a-classic-rts-game-using-lockstep-with-photon-and-unreal-engine/)
  - **libfixmath** — референс Q16.16 [CPP Cat](https://cppcat.com/deterministic-physics-engine/) для порта cost-функций.

### 4. Обзор готовых библиотек (JS/TS + WASM)

| Библиотека | Лицензия | Тип | Внутренности | Детерминизм для lockstep | Web Worker | Зависимости | Вердикт для sim-ядра |
|---|---|---|---|---|---|---|---|
| **pathfinding.js** (qiao) | MIT | grid A*/JPS/etc | float/JS number | Нет (float, не для fixed-point) | Да (чистый JS) | нет | Не для sim; можно как референс алгоритмов |
| **easystar.js** (prettymuchbryce) | MIT | async grid A* | JS number, ~7 КБ, TS-типы | Нет | Да | нет | Прототип рендер-слоя, не sim |
| **astar-typescript** (digitsensitive) | MIT | grid A* | JS number | Нет | Да | нет | Референс TS-структуры |
| **navmesh** (mikewesthad) | MIT | navmesh + funnel | float | Нет | Да | нет | Нет (float navmesh) |
| **three-pathfinding** (donmccurdy) | MIT | navmesh (PatrolJS) | float, требует three | Нет | зависит от three | three | Нет — cosmetic-слой, нарушает границы core |
| **recast-navigation-js** (isaac-mason) | MIT | Recast/Detour navmesh + crowd | float (WASM C++) | Нет (crowd недетерминирован, avoid var-timestep) | Да (генерация в воркере) | WASM | Нет для sim; только офлайн-инструмент |
| **yuka** (Mugen87) | MIT | game AI: navmesh, A*, steering | float, standalone | Нет | Да (нода) | нет | Нет (float) |
| **l1-path-finder** (mikolalysenko) | MIT | grid, быстрый | JS number | Нет | Да | ndarray | Референс перфа |

Общий вывод: все — MIT (лицензионно чисто), но **все на float**; ни одна не даёт кросс-платформенного побитового детерминизма и не вписывается в правило «`core-ts` без рантайм-зависимостей». recast-navigation-js (WASM) пригоден максимум как **офлайн-инструмент запекания** navmesh, но float-запросы Detour во время матча сломают lockstep.

### 5. Эталонная архитектура — 0 A.D. (детальный референс)

0 A.D. (движок Pyrogenesis, Wildfire Games) — открытый детерминированный lockstep-RTS на fixed-point; ближайший рабочий аналог того, что нужно Fluxus.

- **Тип fixed-point**: `CFixed` / `fixed` = `CFixed_15_16` (15 целых + 16 дробных бит поверх 32-битного int). Явные режимы округления (`ToInt_RoundToZero/RoundToInfinity/RoundToNegInfinity/RoundToNearest`), именованный `Multiply`, `MulDiv`, `Square`, `Sqrt`. [sathyam](http://sathyam.me/0adblog/docs/classCFixed.html) Координаты — `entity_pos_t` (fixed). `ToFloat` помечен «может терять точность» [sathyam](http://sathyam.me/0adblog/docs/classCFixed.html) — float в симуляции запрещён по дизайну.
- **Два уровня + иерархический помощник** (сам dev называет «пасфайндер — это 5 компонентов»): long-range, short-range/vertex, hierarchical, obstruction manager, unit motion. Файлы `LongPathfinder.cpp`, `VertexPathfinder.cpp`, `HierarchicalPathfinder.cpp`, `CCmpPathfinder.cpp`.
- **Long-range** = uniform-cost grid A* (+JPS) по navigation grid: «uniform-cost 2D passability grid, с горизонтально/вертикальной (не диагональной) связностью… на основе passability тайлов террейна плюс растеризованные формы obstructions, расширенные наружу на радиус юнитов». [github](https://github.com/0ad/0ad/blob/master/source/simulation2/helpers/Pathfinding.h) Возвращает `WaypointPath` (waypoints в обратном порядке). [github](https://github.com/0ad/0ad/blob/master/source/simulation2/helpers/Pathfinding.h) Юниты игнорируются.
- **Short-range** = vertex/visibility-graph A* в непрерывном пространстве вокруг углов obstruction-боксов, с проверками line-of-sight; учитывает движущиеся юниты (`ShortPathRequest.avoidMovingUnits`, `group`, `clearance`, `range`).
- **Grid**: `NAVCELL_SIZE = 1`; navcell мельче террейн-тайла (`NAVCELLS_PER_TERRAIN_TILE`, 4 navcell на ребро тайла). `NavcellData = u16`, 1 бит на passability class (`PASS_CLASS_BITS = 16`). [github](https://github.com/0ad/0ad/blob/master/source/simulation2/helpers/Pathfinding.h) Passability = глубина воды, наклон, «лесистость», «застроенность». [github](https://github.com/0ad/0ad/blob/master/source/simulation2/helpers/Pathfinding.h) Obstructions растеризуются: `CCmpObstructionManager::Rasterize()`.
- **Детерминизм costs**: `struct PathCost` — целочисленный, `PathCost(hv, d) = hv*65536 + d*92682` (2^16·√2 ≈ 92681.9); сравнения по одному `u32`. [github](https://github.com/0ad/0ad/blob/master/source/simulation2/helpers/Pathfinding.h) «Максимальная длина пути до переполнения ~45K шагов». [github](https://github.com/0ad/0ad/blob/master/source/simulation2/helpers/Pathfinding.h) Индексация navcell — `ToInt_RoundToNegInfinity()` (фиксированное правило округления). Over-rasterization: `CLEARANCE_EXTENSION_RADIUS = fixed::FromInt(1)` — long-range строже short-range. [github](https://github.com/0ad/0ad/blob/master/source/simulation2/helpers/Pathfinding.h)
- **Известные проблемы**: vertex-пасфайндер — узкое место по перфу (Debian bug #985489: выход из `ComputeShortPath` занимал минуты при массе юнитов, заблокированных закрытыми воротами); [Debian](https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=985489) визибилити-граф растёт квадратично; «юнит застревает / идёт к углу и обратно»; obstruction manager без пространственной подгонки тормозил (trac #4713). Для Fluxus при ~10 агентах эти проблемы неактуальны, но подтверждают: **не начинать с navmesh/visibility-графа**.

## Recommendations

### Вердикт: BUILD (собственный fixed-point grid A* в новом пакете)

Обоснование: (1) детерминизм — жёсткое требование, готовые решения на float его не дают; (2) grid A* мал и полностью понятен (~сотни строк), легко покрывается golden-тестами; (3) вписывается в правило «core-ts без зависимостей»; (4) при ~10 агентах перф не проблема; (5) есть прямой открытый эталон (0 A.D.) для копирования решений по детерминизму.

Не брать библиотеку: экономия времени мнимая — потом всё равно переписывать под fixed-point и ловить рассинхроны на Steam Deck (ARM) vs десктоп (x86) vs браузер.

### Предлагаемая архитектура для Fluxus

- **Пакет**: новый `nav-ts`, зависит **только** от `core-ts` (математика Q16.16, ECS-типы). Прописать границу в dependency-cruiser. Альтернатива — подпапка `core-ts/src/nav`, если не хочется плодить пакеты; но отдельный пакет чище тестировать и соответствует NAV-capability в OpenSpec. Пасфайндер вызывается системами внутри sim-воркера, ничего косметического не тянет.
- **Представление карты**:
  - Passability grid как целочисленный typed-array (`Uint8Array`/`Uint16Array`, бит/значение на passability class: ходибельно/обрыв/вода/рампа). SoA-дружественно, transferable.
  - Авторить в существующем пайплайне Blender→glTF: экспортировать сетку проходимости через glTF extras (как sim-контент в `content/`), запекать в grid детерминированно при загрузке сцены. Рампы/обрывы — отдельные passability-классы или связи между уровнями (off-mesh links позже).
  - Разрешение grid мельче логической клетки (по образцу 0 A.D. navcell < tile), чтобы учесть радиусы юнитов через over-rasterization на радиус (clearance).
- **Алгоритм**: A* на 8-связной сетке, октайл-эвристика, **целочисленный `PathCost`** по схеме 0 A.D. (`hv*65536 + d*92682`) — никакого sqrt/float. Позже — JPS для ускорения (тоже полностью целочисленный, детерминированный, uniform-cost).
- **Детерминизм — правила**:
  - Open list — бинарная куча; вторичный ключ tie-break строго детерминированный: сначала меньший f, затем больший g (или меньший h), затем меньший линейный индекс ячейки `y*W+x`. Никаких хэш-порядков.
  - Никаких `Map`/`Set`-итераций в горячем пути; closed/visited — typed-array по индексу ячейки.
  - Соседи раскрываются в фиксированном порядке (например, N,E,S,W,NE,SE,SW,NW).
  - Запрет float в `nav-ts` — добавить в существующие determinism-линты (аналогично запрету float в core).
- **API surface**:
  - `requestPath(entity, startCell, goalCell, passClass) -> ticket` (асинхронно, как в 0 A.D./easystar).
  - Тайм-слайсинг: бюджет N раскрытий узлов на тик; долгие запросы продолжаются на следующих тиках. Результат доставляется системе-подписчику детерминированно (по ticket, в фикс. порядке).
  - Результат — список waypoint'ов в клетках/Q16.16-координатах; следование по пути — отдельная ECS-система (seek к следующему waypoint).
  - Кэш путей по (start,goal,passClass,версия карты); инвалидация при изменении obstruction-грида.
- **Юнит-против-юнита (первый этап)**: модель Dota — юниты блокируют collision-hull'ами, long-range их игнорирует; при блокировке следующего waypoint — репасинг (обрезать недостижимые waypoint'ы, перепланировать к ближайшему достижимому). Расталкивание при перекрытии — детерминированное, на фикс. дистанцию.
- **Динамические препятствия** (здания, призванные юниты, варды): помечают клетки obstruction-грида; версия карты инкрементируется; активные пути валидируются и перестраиваются при пересечении с новыми блокерами.
- **Тестирование**: golden-реплеи фиксированных сценариев путей (start/goal/карта → побитово идентичный список waypoint'ов и costs); кросс-платформенные determinism-тесты в CI (x86 desktop + ARM/Steam Deck-класс) поверх существующего фаззинга `integration-ts`.

### Фазовый план (грубая оценка)

- **Фаза 0 — базовый grid A*** (~1–2 недели): passability grid из glTF-extras, целочисленный A* + октайл, тайм-слайсинг, click-to-move для игрока и ботов, golden-тесты. Достаточно для играбельной навигации на плоском террейне с обрывами.
- **Фаза 1 — сглаживание** (~несколько дней): grid string-pulling / line-of-sight сглаживание пути в непрерывные Q16.16-координаты (детерминированный LOS-проход по grid), чтобы юниты не шли «по клеткам». Опционально JPS для ускорения.
- **Фаза 2 — динамические препятствия и репасинг** (~1 неделя): версионирование obstruction-грида, инвалидация путей, обход зданий/вардов, обрезка/перепланирование.
- **Фаза 3 — локальное избегание** (по потребности геймплея): либо простое детерминированное расталкивание (Dota-модель), либо fixed-point RVO/ORCA отдельным слоем (крупная работа, порт с fixed-point sqrt/деления). Не начинать, пока геймплей не потребует.

### Что явно отложить (геймплей не определён)
- Navmesh (constrained Delaunay) и funnel — только если появятся большие открытые пространства/переменные размеры юнитов, где grid неэффективен.
- Flow fields / continuum crowds — только при переходе к сотням+ юнитов на группу.
- Иерархический A* (HPA*) — только если карты станут очень большими и grid A* перестанет укладываться в тик-бюджет.
- Полноценный ORCA — пока хватает блокировки телами + репасинга.
- Формации/групповое движение — после стабилизации одиночной навигации.

## Caveats
- Структуру `openspec/specs/` (в т.ч. точный текст NAV-спеки) не удалось прочитать напрямую через веб — выводы о constraints основаны на README, структуре репозитория и общих правилах OpenSpec; перед реализацией сверить с `openspec spec show nav` (или как называется capability) и `docs/architecture.md` (открытые вопросы/roadmap).
- «Q16.16» в задаче vs «15.16» у 0 A.D. — разница в 1 бите знака/целой части; для integer-cost A* формат fixed-point вообще не критичен (costs целые), важен лишь для координат/локального избегания.
- «В симуляции 0 A.D. float запрещён» — вывод из дизайна (весь sim на `CFixed`, `ToFloat` помечен lossy); прямой цитаты из wiki получить не удалось. Аналогичное правило у Photon Quantum задокументировано явно (конверсия float→FP в симуляции = гарантированный десинк).
- Часть данных по Dota 2 — из Liquipedia/фан-вики и Valve Developer Community; сетка GridNav 64×64 подтверждена у Valve, поведение short/long pather — из Liquipedia (согласуется между источниками, но не первоисточник-код Valve).
- Точный вторичный ключ tie-break в 0 A.D. (`LongPathfinder.cpp`) не извлечён дословно; целочисленная основа costs подтверждена. Для Fluxus tie-break задаётся своим кодом, так что это не блокер.
- Оценки трудозатрат — порядковые, для одного разработчика, знакомого с ECS/движком; зависят от зрелости `core-ts` математики и пайплайна ассетов.
