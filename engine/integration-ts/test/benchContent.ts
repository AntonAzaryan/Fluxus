/**
 * Синтетический контент бенч-стенда стоимости (`performance-budget` PERF-4,
 * PERF-6; change `bench-stand-subsystems`, решение D2).
 *
 * ## Зачем он есть
 *
 * Подсистемы моделей, частиц и террейна без контента не работают вовсе: у
 * моделей нет записи манифеста и нормализованной модели, у частиц — документа
 * эффекта, у террейна — карты кривизны, ради которой и заведён потолок
 * разбиения. Счётчики их работы (PERF-3) без всего этого лежали бы нулями, и
 * эталон стерёг бы пустоту.
 *
 * Контент здесь СИНТЕТИЧЕСКИЙ и настоящий одновременно: он проходит те же
 * валидаторы, что и документы дерева (`validateManifest`,
 * `validateParticleEffect`, `validateCurvatureMap`), и уезжает подсистемам тем
 * же путём — записью манифеста и загруженным ассетом. Из `content/` он не
 * читается ни байтом (CONT-4): дерево контента описывает ИГРУ, а нагрузка гейта
 * стоимости — движок, и эталон, краснеющий от правки баланса картинки
 * дизайнером, стерёг бы не то.
 *
 * Чужих `test/` файл не импортирует (CLI-9): фикстуры `render-ts` собраны из
 * его внутренних путей, а межпакетная сюита ходит только через опубликованные
 * поверхности `@fluxus/assets` и `@fluxus/render`.
 *
 * ## Что подобрано и почему именно так
 *
 * Значения выбраны так, чтобы РУЧКИ ПРЕСЕТОВ стенда кусали (QUAL-4):
 *
 * - цепочка уровней модели УБЫВАЕТ по треугольникам (64 → 16 → 4), иначе
 *   множитель порогов LOD (`models.lodThresholdScale`) двигал бы номер уровня,
 *   не двигая ни одного счётчика: работа кадра меряется треугольниками
 *   скомпактованных записей (REND-22, ASSET-12);
 * - записи манифеста две — одна называет ярус явно, вторая НЕ называет, и её
 *   носитель выбирает `models.defaultTier` (REND-20, ASSET-13);
 * - эмиссия эффекта постоянная и зацикленная: объём НАШЕЙ работы (оболочки,
 *   синхронизации, шаги систем) от кадра к кадру предсказуем, а стохастика
 *   three.quarks в счётчики не входит вовсе (design D3);
 * - карта кривизны поднимает узлы РЕДКОЙ решёткой: разбивается четверть клеток
 *   арены, и `terrain.curvatureTessellation` меняет число квадов пола
 *   квадратично (REND-9), не превращая пересборку чанка в главную статью
 *   времени прогона.
 */
import type { TerrainGrid } from '@fluxus/core';
import {
  validateCurvatureMap,
  validateManifest,
  validateParticleEffect,
  type AssetKind,
  type AssetService,
  type AssetState,
  type Handle,
  type NormalizedMesh,
  type NormalizedModel,
  type ParticleEffectDocument,
  type TerrainCurvatureMap,
  type VisualManifest,
} from '@fluxus/assets';

/** Asset id модели стенда — путь от корня дерева, как у всякого ассета (ASSET-2). */
const BENCH_MODEL_ID = 'bench/visuals/models/runner.mdx';
/** Asset id эмиттерного ассета стенда (ASSET-14). */
const BENCH_EFFECT_ID = 'bench/visuals/vfx/steady.effect.json';

/**
 * Визуальные типы стенда (ключи манифеста, ASSET-9). Их два, и различаются они
 * ровно ярусом: `BenchRunner` называет батчевый ярус сам, `BenchProp` не
 * называет никакого — его носитель выбирает `models.defaultTier` пресета
 * (REND-20). Всё остальное у записей совпадает, поэтому разница в счётчиках
 * между ними читается как разница ЯРУСА, а не как разница моделей.
 */
export const BENCH_KINDS = { runner: 'BenchRunner', prop: 'BenchProp' } as const;

/**
 * Тип события, на который манифест вешает одноразовый эффект (`particles.byEvent`,
 * REND-24). Он и есть ось «число эффектов» синтетической нагрузки (PERF-6):
 * выстрелы заводятся событиями доставки, поэтому их число двигается СВОЕЙ
 * величиной — состав сущностей, ярусы и оболочки при этом не шевелятся, и
 * отношение L/S приписывается частицам, а не пересортице типов.
 */
export const BENCH_BURST_EVENT = 'BenchBurst';

/**
 * Треугольники уровней цепочки (ASSET-12, REND-22), от базового к грубейшему.
 * Убывание вчетверо на уровень — не «реалистичная децимация», а различимая
 * величина: множитель порогов пресета переводит инстанс на соседний уровень, и
 * `modelsBatchTriangles` обязан это показать диффом, а не округлением.
 */
const LOD_TRIANGLES = [64, 16, 4] as const;

/**
 * Пороги переключения уровней записи (ASSET-13) — доли высоты кадра, строго
 * убывающие.
 *
 * Подобраны под камеру стенда (`CAMERA_HEIGHT` в `benchLoad.ts`) и под
 * КОНСЕРВАТИВНЫЕ границы запечённой модели (ASSET-12): экранный размер инстанса
 * на обеих аренах стенда — около половины высоты кадра. При множителе 1 запись
 * держится нулевого уровня (0.36 = 0.9 × первого порога — ниже размера с
 * запасом в четверть), при множителе 2 уходит на первый (0.72 = 1.8 × первого
 * порога — выше размера с тем же запасом), а до второго уровня не добирается ни
 * при том, ни при другом. Запас взят от зоны нечувствительности выбора (±10%,
 * REND-22): у порога уровень не должен дёргаться от того, куда за тик шагнул
 * герой.
 */
const LOD_THRESHOLDS = [0.4, 0.1];

// ------------------------------------------------------------------ модель

/**
 * Меш из `triangles` независимых треугольников внутри единичного бокса. Габарит
 * фиксирован (высота по Z ровно 1), поэтому нормализация масштаба записи
 * (`visual.scale / model.height`) даёт единицу, а консервативная сфера
 * отсечения (REND-21) не зависит от уровня цепочки: уровни отличаются числом
 * треугольников, а не размером.
 */
function benchMesh(triangles: number): NormalizedMesh {
  const positions = new Float32Array(triangles * 9);
  const uvs = new Float32Array(triangles * 6);
  const indices = new Uint16Array(triangles * 3);
  const skinIndices = new Uint16Array(triangles * 12);
  const skinWeights = new Float32Array(triangles * 12);
  for (let t = 0; t < triangles; t++) {
    // Треугольники раскладываются по X внутри [0, 1]; крайние держат габарит.
    const u = triangles === 1 ? 0 : t / (triangles - 1);
    positions.set([u, 0, 0, u, 0.5, 0, u, 0, 1], t * 9);
    uvs.set([0, 0, 1, 0, 0, 1], t * 6);
    indices.set([t * 3, t * 3 + 1, t * 3 + 2], t * 3);
    for (let v = 0; v < 3; v++) {
      // Вершина привязана к корневой кости целиком: веса нормированы (ASSET-5).
      skinWeights[(t * 3 + v) * 4] = 1;
    }
  }
  return {
    partId: 0,
    positions,
    normals: null,
    uvs,
    indices,
    skinIndices,
    skinWeights,
    materialIndex: 0,
  };
}

/**
 * Модель стенда: два bone'а, базовый меш и цепочка упрощённых уровней
 * (ASSET-12). Клипы — минимальная пара, которой хватает состояниям `idle` и
 * `move` записи (REND-4); текстур у материала нет вовсе, и запросов текстурных
 * ассетов стенд не делает — заглушек скина в счётчиках быть не должно.
 *
 * Одна на весь прогон: производные (VAT, границы, цепочка) кэшируются по
 * ИДЕНТИЧНОСТИ модели (ASSET-12), и второй объект запекал бы их заново на
 * каждый стенд.
 */
const BENCH_MODEL: NormalizedModel = Object.freeze<NormalizedModel>({
  bones: [
    { index: 0, name: 'Bone_Root', parentIndex: -1, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], inverseBind: null },
    { index: 1, name: 'Bone_Chest', parentIndex: 0, position: [0, 0, 0.5], rotation: [0, 0, 0, 1], scale: [1, 1, 1], inverseBind: null },
  ],
  meshes: [benchMesh(LOD_TRIANGLES[0])],
  lodMeshes: [[benchMesh(LOD_TRIANGLES[1])], [benchMesh(LOD_TRIANGLES[2])]],
  sequences: [
    {
      name: 'Stand - 1',
      duration: 1,
      boneTracks: [
        {
          boneIndex: 1,
          rotation: {
            times: new Float32Array([0, 1]),
            values: new Float32Array([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]),
            interpolation: 'linear',
          },
        },
      ],
      partVisibility: [],
    },
    {
      name: 'Walk Fast',
      duration: 1,
      boneTracks: [
        {
          boneIndex: 1,
          rotation: {
            times: new Float32Array([0, 1]),
            values: new Float32Array([0, 0, 0, 1, 0, 0, -Math.SQRT1_2, Math.SQRT1_2]),
            interpolation: 'linear',
          },
        },
      ],
      partVisibility: [],
    },
  ],
  materials: [
    {
      baseColorFactor: [0.6, 0.6, 0.6, 1],
      baseColorTexture: null,
      metallicFactor: 0,
      roughnessFactor: 1,
      normalTexture: null,
      emissiveFactor: [0, 0, 0],
      emissiveTexture: null,
      emissiveStrength: 1,
      alphaMode: 'opaque',
      alphaCutoff: 0.5,
      doubleSided: false,
    },
  ],
  textureSlots: [],
  height: 1,
});

// ----------------------------------------------------------------- манифест

/**
 * Манифест визуалов стенда (ASSET-6, ASSET-9): две записи сущностей на одну
 * модель и запись эмиттера типа (ASSET-14, REND-24). Проходит тот же
 * `validateManifest`, что и документ дерева контента, — фикстура, которую
 * валидация не приняла бы, стерегла бы несуществующий формат.
 */
const BENCH_MANIFEST: VisualManifest = buildManifest();

function buildManifest(): VisualManifest {
  const entity = {
    model: BENCH_MODEL_ID,
    scale: 1,
    animations: { states: { idle: 'Stand', move: 'Walk' } },
    lodThresholds: LOD_THRESHOLDS,
  };
  const document = {
    entities: {
      // Ярус назван автором записи — пресету он не подчиняется (ASSET-13).
      [BENCH_KINDS.runner]: { ...entity, tier: 'batched' },
      // Ярус НЕ назван: носитель выбирает `models.defaultTier` (QUAL-1).
      [BENCH_KINDS.prop]: { ...entity },
    },
    particles: {
      // Оболочка типа живёт тиками — она и работает на записанных матчах, где
      // событий манифеста нет вовсе; выстрел по событию — ось масштабирования.
      byKind: { [BENCH_KINDS.runner]: { effect: BENCH_EFFECT_ID } },
      byEvent: { [BENCH_BURST_EVENT]: { effect: BENCH_EFFECT_ID } },
    },
  };
  const result = validateManifest(document);
  if (!result.ok) throw new Error(`манифест бенч-стенда невалиден: ${result.errors.join('; ')}`);
  return result.manifest;
}

export function benchManifest(): VisualManifest {
  return BENCH_MANIFEST;
}

// ------------------------------------------------------- документ эффекта

const EFFECT_GEOMETRY = 'bench-effect-geometry';
const EFFECT_MATERIAL = 'bench-effect-material';
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * Документ эффекта стенда (ASSET-14) — граф объектов three.js с одним
 * эмиттером, той же формы, что пишет внешний редактор эффектов.
 *
 * Эмиссия ПОСТОЯННАЯ и зацикленная, единовременных выбросов нет: объём нашей
 * работы (сведение оболочек, взятия из пула, шаги систем) тогда определяется
 * составом доставки и числом кадров, а не тем, куда попал внутренний рандом
 * библиотеки (design D3). `autoDestroy` снят — жизненным циклом экземпляра
 * владеет пул подсистемы, а не документ.
 */
const BENCH_EFFECT: ParticleEffectDocument = buildEffect();

function buildEffect(): ParticleEffectDocument {
  const document = {
    metadata: { version: 4.7, type: 'Object', generator: 'Object3D.toJSON' },
    geometries: [
      { uuid: EFFECT_GEOMETRY, type: 'PlaneGeometry', width: 1, height: 1, widthSegments: 1, heightSegments: 1 },
    ],
    materials: [
      {
        uuid: EFFECT_MATERIAL,
        type: 'MeshBasicMaterial',
        color: 16777215,
        envMapRotation: [0, 0, 0, 'XYZ'],
        reflectivity: 1,
        refractionRatio: 0.98,
        blending: 2,
        transparent: true,
        blendColor: 0,
        depthWrite: false,
      },
    ],
    object: {
      uuid: 'bench-effect-root',
      type: 'Group',
      name: 'BenchSteady',
      layers: 1,
      matrix: IDENTITY_MATRIX,
      up: [0, 1, 0],
      children: [
        {
          uuid: 'bench-effect-emitter',
          type: 'ParticleEmitter',
          name: 'BenchSteady',
          layers: 1,
          matrix: IDENTITY_MATRIX,
          up: [0, 1, 0],
          ps: {
            version: '3.0',
            autoDestroy: false,
            looping: true,
            prewarm: false,
            duration: 1,
            shape: {
              type: 'sphere',
              radius: 0.1,
              arc: 6.283185307179586,
              thickness: 1,
              mode: 0,
              spread: 0,
              speed: { type: 'ConstantValue', value: 1 },
            },
            startLife: { type: 'ConstantValue', value: 1 },
            startSpeed: { type: 'ConstantValue', value: 0.5 },
            startRotation: { type: 'ConstantValue', value: 0 },
            startSize: { type: 'ConstantValue', value: 0.2 },
            startColor: { type: 'ConstantColor', color: { r: 1, g: 0.55, b: 0.2, a: 1 } },
            emissionOverTime: { type: 'ConstantValue', value: 20 },
            emissionOverDistance: { type: 'ConstantValue', value: 0 },
            emissionBursts: [],
            onlyUsedByOther: false,
            instancingGeometry: EFFECT_GEOMETRY,
            renderOrder: 0,
            renderMode: 0,
            rendererEmitterSettings: {},
            material: EFFECT_MATERIAL,
            layers: 1,
            startTileIndex: { type: 'ConstantValue', value: 0 },
            uTileCount: 1,
            vTileCount: 1,
            blendTiles: false,
            softParticles: false,
            softFarFade: 0,
            softNearFade: 0,
            behaviors: [],
            worldSpace: false,
          },
        },
      ],
    },
  };
  const result = validateParticleEffect(document);
  if (!result.ok) throw new Error(`эффект бенч-стенда невалиден: ${result.errors.join('; ')}`);
  return result.effect;
}

// -------------------------------------------------------- карта кривизны

/** Узлы решётки, поднятые картой: каждый четвёртый по обеим осям. */
const CURVATURE_NODE_STEP = 4;

/**
 * Карта кривизны арены стенда (ASSET-7): узловые смещения в 1/32 шага высоты.
 * Подняты только узлы решётки шагом `CURVATURE_NODE_STEP`, поэтому кривизну
 * имеет ЧЕТВЕРТЬ клеток — ровно те, у которых поднятый узел оказался углом. Так
 * пересборка чанка (REND-7) платит и за плоские клетки, и за разбитые, а
 * потолок `terrain.curvatureTessellation` двигает второе слагаемое квадратично
 * (REND-9), не превращая стенд в генератор миллионов вершин.
 *
 * `offset` двигает решётку узлов вместе с решёткой укрытий стенда (`benchGrid`):
 * стенка обрыва разбивается плотностью ПОДПИРАЕМОГО пола (REND-9), то есть
 * клетки-столба, и решётка узлов мимо столбов оставила бы стенки одним квадом —
 * потолок разбиения перестал бы двигать `terrainWallQuads` вовсе. Доля клеток с
 * кривизной от сдвига не меняется: сдвигается вся решётка целиком.
 */
export function benchCurvature(grid: TerrainGrid, offset = 0): TerrainCurvatureMap {
  const raised = (n: number): boolean => n % CURVATURE_NODE_STEP === offset % CURVATURE_NODE_STEP;
  const rows = Array.from({ length: grid.height + 1 }, (_, ny) =>
    Array.from({ length: grid.width + 1 }, (_, nx) =>
      raised(nx) && raised(ny)
        ? 1 + ((nx - offset + (ny - offset)) / CURVATURE_NODE_STEP) % 5
        : 0,
    ),
  );
  const result = validateCurvatureMap({ width: grid.width, height: grid.height, rows });
  if (!result.ok) throw new Error(`карта кривизны бенч-стенда невалидна: ${result.errors.join('; ')}`);
  return result.map;
}

// ---------------------------------------------------------------- ассеты

/**
 * Источник ассетов стенда: модель и документ эффекта СРАЗУ готовы (ASSET-4).
 *
 * Настоящий `AssetService` здесь не годится по механике, а не по вкусу: он
 * асинхронен по контракту, и готовность приезжает микрозадачей — а прогон
 * записи синхронен от первого тика до последнего, и подсистемы весь замер
 * простояли бы на заглушках. Стенд поэтому подставляет реализацию контракта,
 * у которой запрошенный ассет готов немедленно; всё остальное — тот же
 * контракт: идемпотентный `request`, наблюдаемое состояние, подписка,
 * приносящая текущее состояние сразу (ASSET-2, ASSET-4).
 *
 * Свой на каждый стенд: кэш ассетов — часть измеряемой сборки, и делить его
 * между прогонами значило бы мерить второй прогон в чужом состоянии.
 */
export function benchAssets(): AssetService {
  const ready = new Map<string, AssetState<unknown>>([
    [`model ${BENCH_MODEL_ID}`, { status: 'ready', data: BENCH_MODEL }],
    [`particle-effect ${BENCH_EFFECT_ID}`, { status: 'ready', data: BENCH_EFFECT }],
  ]);
  const handles = new Map<string, Handle>();
  const missing = (kind: AssetKind, id: string): AssetState<unknown> => ({
    status: 'failed',
    reason: `бенч-стенд не знает ассета "${id}" вида "${kind}" (CONT-4: дерево контента он не читает)`,
  });
  const stateOf = (kind: AssetKind, id: string): AssetState<unknown> =>
    ready.get(`${kind} ${id}`) ?? missing(kind, id);

  const service = {
    registerLoader(): void {
      // Загрузчиков стенду не нужно: ассеты уже разобраны (ASSET-3).
    },
    request(kind: AssetKind, id: string): Handle {
      const key = `${kind} ${id}`;
      let handle = handles.get(key);
      if (handle === undefined) {
        handle = Object.freeze({ id, kind });
        handles.set(key, handle);
      }
      return handle;
    },
    state(handle: Handle): AssetState<unknown> {
      return stateOf(handle.kind, handle.id);
    },
    subscribe(handle: Handle, listener: (state: AssetState<unknown>) => void): () => void {
      // Подписка немедленно приносит текущее состояние — как у настоящего
      // сервиса (ASSET-4); иначе потребитель ждал бы события, которого не будет.
      listener(stateOf(handle.kind, handle.id));
      return () => {
        // Отписываться не от чего: состояние ассета стенда не меняется.
      };
    },
    retry(): void {
      // Перезапуск загрузки бессмыслен: неудача стенда — отсутствие фикстуры.
    },
  };
  return service as unknown as AssetService;
}
