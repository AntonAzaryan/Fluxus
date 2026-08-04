## MODIFIED Requirements

### Requirement: SYS-5 SystemContext как контракт границы core↔геймплей

`SystemContext` SHALL быть публичным контрактом границы core↔геймплей:

```ts
interface SystemContext {
  readonly tick: number;
  readonly query: (spec: QuerySpec) => Float64Array; // материализован на момент вызова (QUERY-3)
  readonly get: (entity: EntityId, component: string, field: string) => number;
  readonly has: (entity: EntityId, component: string) => boolean;
  readonly isAlive: (entity: EntityId) => boolean;
  readonly commands: CommandBuffer;                  // единственный канал мутаций (CMD-1..4)
  readonly events: EventEmitter & ReadonlyEventLog;  // публикация и чтение шины тика (EVT-1..4)
  readonly rng: RngStreams;                          // стрим по name системы (RNG-4)
  readonly math: MathApi;                            // обязательная зависимость (DI-2)
  readonly physics?: PhysicsApi;                     // опциональная (DI-3), обязательна при FoW
  readonly navigation?: NavigationApi;               // опциональная (DI-4), поиск пути (NAV-1)
  readonly terrain?: TerrainApi;                     // опциональная (DI-3), есть при террейне в сцене (TERR-4)
  readonly arena?: ArenaApi;                         // опциональная (DI-3), есть при арене в сцене (ARENA-1)
  readonly modifiers?: ModifierRegistry;             // опциональная (DI-3), списки источников сцены (TIME-7, FOW-3)
  readonly inputs: readonly InputFrame[];            // канонические вводы тика (TICK-2)
  readonly getEffectiveDelta: (entity: EntityId, globalDelta: Fixed) => Fixed; // TIME-3, TIME-4
}
```

Чтение мира — плоские `query`/`get`/`has`/`isAlive`, а не объект-view: view пришлось бы либо копировать, либо держать валидным дольше вызова, и то и другое противоречит QUERY-3.

`events` SHALL быть одновременно публикацией и read-only-чтением шины текущего тика: система обязана и эмитить факт, и видеть факты, опубликованные до неё (EVT-2). Мутирующей части у чтения быть не должно — очистка и восстановление шины принадлежат тику и rewind (EVT-4, `snapshot-rewind` REW-10), а не системе.

Опциональные поля (`physics?`, `navigation?`, `terrain?`, `arena?`, `modifiers?`) SHALL следовать паттерну опциональной зависимости DI-3: поле присутствует ровно тогда, когда зависимость собрана или сцена содержит соответствующие данные, — `physics` при собранной физике (и обязательно при FoW, FOW-4), `navigation` при собранной навигации (DI-4, `pathfinding` NAV-1), `terrain` при террейне в сцене (TERR-4), `arena` при арене в сцене (ARENA-1), `modifiers` при списках источников-модификаторов сцены (TIME-7, FOW-3). Система, которой отсутствующее поле необходимо, SHALL падать с ошибкой, называющей зависимость, и MUST NOT молча становиться системой без эффекта: сцена без зависимости — конфигурационная ошибка, а не режим работы.

Отдельного `TimeContext` в контракте нет: номер тика — поле `tick`, а масштабированный шаг — `getEffectiveDelta(entity, globalDelta)` (TIME-3), и учитывать его или нет решает каждая система сама (TIME-4).

Расширение состава `SystemContext` SHALL быть изменением этого требования, а не молчаливым расширением: контракт границы описан здесь целиком, и поле, которого тут нет, из системы недоступно.

#### Scenario: Системе нужен доступ к чему-то вне контекста

- **WHEN** реализации системы требуется ресурс, отсутствующий в `SystemContext`
- **THEN** это изменение публичного контракта — оформляется явно, а не обходится через импорт модуля напрямую

#### Scenario: Сцена без опциональной зависимости

- **WHEN** система обращается к `physics`, `navigation`, `terrain`, `arena` или `modifiers` в сцене, где их нет
- **THEN** она падает с ошибкой, называющей отсутствующую зависимость, а не отрабатывает тик без эффекта

#### Scenario: Система читает события тика

- **WHEN** системе нужен факт, опубликованный системой с меньшим `order`
- **THEN** она читает его через `events` — тот же объект, через который эмитит, но записать в него можно только новое событие
