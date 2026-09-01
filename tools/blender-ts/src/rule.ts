/**
 * Правило-вклад «пространственный слой сцены разошёлся с источником» (BLND-2,
 * design, решение 6) — защита от молчаливого расхождения.
 *
 * Производные данные ведут себя как порождаемые схемы: импорт переписывает их
 * целиком, и ручная либо редакторская правка перезаписывается следующим
 * импортом. Запрещать правку редактор не станет (это была бы новая
 * level-дизайн-логика в замороженном направлении), но молчать о ней он не
 * вправе: находка — ПРЕДУПРЕЖДЕНИЕ (документ валиден, расхождение процессное) с
 * адресом и указанием, где чинить.
 *
 * Ловит она обе беды сразу: правку производного поля мимо Blender и забытый
 * пере-импорт после правки `.blend` — потому что сравнивает не «кто последний
 * писал», а сам слой с тем, что дал бы импорт.
 *
 * Сверяются ВСЕ производные данные, которые называет BLND-2: `initial` конфига
 * сцены, `decorations` парного документа, а при соответствующих объектах
 * источника — карты ассета террейна (BLND-9) и карта кривизны (BLND-10). Слой
 * для сверки считается тем же вызовом, что и слой импорта (`generateSpatialLayer`
 * + `generateCellLayer`): второе «что дал бы импорт» разошлось бы с первым молча
 * (ED-1, CORE-3), и первым же расхождением стало бы молчание о правке карты
 * уровней кистью ED-10.
 *
 * ## Почему источник читает не правило
 *
 * Правило исполняется синхронно и на каждую правку (ED-8), а чтение дерева —
 * асинхронный шов хоста среды (ED-12). Поэтому байты источника приносит кэш
 * (`createSourceCache`), который живёт снаружи правила и обновляется тем, кто
 * знает о правках дерева; правило спрашивает у него ТЕКУЩЕЕ состояние и не
 * ждёт. Кэш ключуется байтами источника — тем же приёмом «кэш по прочитанному»,
 * которым живёт валидатор (ED-8): пере-разбор glTF идёт только тогда, когда
 * файл действительно сменился.
 *
 * ## Шесть ответов кэша, и ни одного молчаливого
 *
 * - `none` — рядом со сценой нет ни экспорта, ни самого `.blend`: конвейер к
 *   ней отношения не имеет, находки нет и читать нечего (BLND-2).
 * - `unexported` — `.blend` рядом ЕСТЬ, экспорта нет ни одного. Сцена
 *   конвейеру принадлежит (пара считается от источника, BLND-2), но сверять
 *   слой не с чем: импорт идёт от экспорта, а `.blend` не читает никто
 *   (BLND-1, BLND-3). Своя находка — иначе «сопряжена ли сцена» отвечало бы
 *   не наличие источника, а факт того, сделан ли уже экспорт.
 * - `unknown` — источник ещё НЕ ЧИТАН: собирающий редактор кэш не обновил либо
 *   обновление ещё идёт. Это не «источника нет»: свести два ответа к одному
 *   значило бы объявить сцену несопряжённой на основании того, что о ней ничего
 *   не спрашивали, — то самое молчание, ради устранения которого правило и
 *   заведено. Поэтому у него своя находка, а у собирающего — обязанность
 *   обновить кэш до прогона (см. `app/assembly.ts` редактора).
 * - `unchecked` — среда не ответила, лежит ли рядом со сценой источник:
 *   отказало перечисление дерева. Отдельно от `unavailable` потому, что чтения
 *   здесь не было вовсе, и находка не вправе его утверждать (BLND-1).
 * - `unavailable` / `rejected` — экспорт есть, но прочитать или разобрать его
 *   не удалось: причина называется дословно (ED-12, ED-20).
 * - `ready` — есть с чем сверять.
 */
import {
  getAtPath,
  isJsonArray,
  ruleDescriptionKey,
  type ContentPath,
  type ContentTreeHost,
  type DocumentId,
  type DocumentKind,
  type EditorDocument,
  type JsonPath,
  type JsonValue,
  type PositionBinding,
  type ValidationRule,
  type ValidationRun,
} from '@fluxus/editor-core';
import { presentationPathOf } from '@fluxus/assets';
import { parseGltf, type GltfDocument } from './gltf.js';
import {
  generateSpatialLayer,
  hasErrors,
  type CurvatureMap,
  type Finding,
  type SpatialLayer,
  type SpatialLayerContext,
  type TerrainMaps,
} from './layer.js';
import { generateCellLayer, withCellLayer } from './maps.js';
import { normalizeDocument, type SourceObject } from './normalize.js';
import { DEFAULT_DECORATIONS_PATH, DEFAULT_INITIAL_PATH, DEFAULT_TERRAIN_PATH } from './operation.js';
import { BLEND_EXTENSION, SOURCE_EXTENSIONS, sourcePathOf } from './pairing.js';
import { contextOfValues } from './project.js';

export const SPATIAL_LAYER_SYNC_RULE = 'blender.spatialLayerSync';

/** Слой документов разошёлся с тем, что дал бы импорт источника. */
const LAYER_DIVERGED = 'layerDiverged';
/** Источник есть, но среда его не прочитала: причина названа, а не скрыта. */
const SOURCE_UNREADABLE = 'sourceUnreadable';
/** Источник прочитан, но импорт его отверг (BLND-6): сравнивать не с чем. */
const SOURCE_REJECTED = 'sourceRejected';
/** Источник не читан вовсе: сверки не было, и молчать об этом нельзя. */
const SOURCE_UNREAD = 'sourceUnread';
/** Источник (`.blend`) рядом со сценой есть, экспорта нет: сверять не с чем. */
const SOURCE_UNEXPORTED = 'sourceUnexported';
/** Среда не ответила, лежит ли рядом источник: сопряжённость сцены неизвестна. */
const SOURCE_UNCHECKED = 'sourceUnchecked';

/** Что известно об источнике сцены прямо сейчас. */
export type SourceState =
  /**
   * Рядом со сценой нет ни экспорта, ни самого `.blend` — сцена не сопряжена с
   * конвейером (BLND-2), и правило о ней молчит.
   */
  | { readonly status: 'none' }
  /**
   * Источник рядом со сценой ЕСТЬ (`.blend`), а экспорта нет ни одного: сцена
   * конвейеру принадлежит, но сверить её слой не с чем — импорт идёт от
   * экспорта, а `.blend` не читает никто (BLND-1, BLND-3). `path` — адрес
   * самого источника: находке нужно назвать, что именно лежит рядом.
   */
  | { readonly status: 'unexported'; readonly path: ContentPath }
  /**
   * Среда не смогла ОТВЕТИТЬ, лежит ли рядом со сценой источник: перечисление
   * дерева отказало. Своё состояние, а не `unavailable`: там среда не отдала
   * прочитанный файл, а здесь читать никто и не пробовал — `.blend` не читает
   * ни импорт, ни редактор (BLND-1, BLND-7), и находка, утверждающая чтение,
   * называла бы действие, которого конвейер не делает.
   */
  | { readonly status: 'unchecked'; readonly path: ContentPath; readonly reason: string }
  /**
   * О сцене ещё не спрашивали: кэш не обновляли ни разу. Отличается от `none`
   * тем же, чем «не проверяли» отличается от «проверили и не нашли».
   */
  | { readonly status: 'unknown' }
  /** Источник есть, среда его не отдала: причина — дословно от среды. */
  | { readonly status: 'unavailable'; readonly path: ContentPath; readonly reason: string }
  /** Источник прочитан, но не разобрался. */
  | { readonly status: 'rejected'; readonly path: ContentPath; readonly reason: string }
  | {
      readonly status: 'ready';
      readonly path: ContentPath;
      readonly objects: readonly SourceObject[];
      /**
       * Разобранный документ: клеточные слои (BLND-9, BLND-10) читаются из его
       * аксессоров, а не из объектов — те несут только адрес меша. Держится он
       * рядом с объектами по той же причине, по которой держатся объекты: это
       * самое дорогое в цикле, и разбирать его заново на каждую валидацию
       * значило бы платить за неизменившиеся байты (ED-8).
       */
      readonly document: GltfDocument;
      /** Отпечаток прочитанных байтов — ключ кэша (ED-8). */
      readonly fingerprint: string;
    };

/** Синхронная сторона кэша — единственное, что нужно правилу. */
export interface SpatialLayerSources {
  stateOf(scene: DocumentId): SourceState;
}

export interface SpatialLayerSourceCache extends SpatialLayerSources {
  /** Перечитывает источник сцены через хост; повторный разбор — только на новых байтах. */
  refresh(scene: DocumentId): Promise<SourceState>;
  /** Забыть запомненное: одну сцену или всё. */
  forget(scene?: DocumentId): void;
}

export interface SourceCacheOptions {
  /**
   * Расширения экспорта источника в порядке предпочтения; умолчание —
   * `SOURCE_EXTENSIONS` (`.glb`, затем `.gltf`). Их два по той же причине, по
   * которой их принимает импорт: форматом BLND-3 называет glTF 2.0, а не
   * контейнер, и правило, знающее только про `.glb`, молчало бы о сцене,
   * сопряжённой с текстовым экспортом.
   */
  readonly extensions?: readonly string[];
  /**
   * Расширение самого источника; умолчание — `BLEND_EXTENSION`. Кэш его не
   * ЧИТАЕТ, а только спрашивает файловую систему, лежит ли он рядом (BLND-2):
   * ответ «сцена сопряжена с конвейером» обязан быть свойством источника, а не
   * побочным следствием того, сделан ли уже экспорт. Blender для этого не
   * нужен ни тесту, ни редактору (BLND-7).
   */
  readonly blendExtension?: string;
}

const NONE: SourceState = Object.freeze({ status: 'none' });
const UNKNOWN: SourceState = Object.freeze({ status: 'unknown' });

/** FNV-1a по байтам: отпечаток нужен для сравнения «те же байты?», а не для криптографии. */
function fingerprintOf(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${bytes.length}:${hash.toString(16)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ответ о САМОМ источнике, когда экспорта рядом со сценой нет (BLND-2): лежит ли
 * `.blend` рядом. Отдельной функцией не ради краткости `refresh`, а потому что
 * это ДРУГОЙ вопрос: не «что читать», а «принадлежит ли сцена конвейеру».
 *
 * Три ответа, и ни одного молчаливого: `unchecked` — среда не смогла ответить
 * (чтения не было, и находка не вправе его утверждать), `unexported` — источник
 * есть, экспорта нет, `none` — конвейер к сцене отношения не имеет.
 *
 * Прежний `unexported` возвращается ТЕМ ЖЕ объектом: `none` и `unknown` —
 * синглтоны, `ready` мемоизирован отпечатком, а «состояние не изменилось»
 * собирающий редактор проверяет тождеством (`app/assembly.ts`). Новый объект на
 * каждый `refresh` означал бы полный прогон правил на каждое сохранение ещё не
 * экспортированной сцены — ровно ту плату, которой ED-8 избегает.
 */
async function probeBlend(
  host: ContentTreeHost,
  blend: ContentPath,
  known: SourceState | undefined,
): Promise<SourceState> {
  let exists = false;
  try {
    exists = (await host.stat(blend))?.kind === 'file';
  } catch (error) {
    return { status: 'unchecked', path: blend, reason: message(error) };
  }
  if (!exists) return NONE;
  if (known?.status === 'unexported' && known.path === blend) return known;
  return { status: 'unexported', path: blend };
}

/**
 * Кэш источников по байтам (ED-8: «кэш по прочитанному»). Хранит разобранные
 * объекты — самое дорогое в цикле, — а слой считает правило на каждый прогон:
 * слой есть функция ещё и от документов, которые автор правит прямо сейчас, и
 * закэшированный он разошёлся бы с ними на первой же правке.
 */
export function createSourceCache(
  host: ContentTreeHost,
  options: SourceCacheOptions = {},
): SpatialLayerSourceCache {
  const extensions = options.extensions ?? SOURCE_EXTENSIONS;
  const blendExtension = options.blendExtension ?? BLEND_EXTENSION;
  const states = new Map<DocumentId, SourceState>();

  return {
    // Не `none`: о сцене, про которую не спрашивали, кэш не вправе утверждать,
    // что источника у неё нет.
    stateOf: (scene) => states.get(scene) ?? UNKNOWN,

    forget(scene) {
      if (scene === undefined) states.clear();
      else states.delete(scene);
    },

    async refresh(scene) {
      let path: ContentPath | null = null;
      for (const extension of extensions) {
        const candidate = sourcePathOf(scene, extension);
        try {
          if ((await host.stat(candidate))?.kind !== 'file') continue;
        } catch (error) {
          const state: SourceState = { status: 'unavailable', path: candidate, reason: message(error) };
          states.set(scene, state);
          return state;
        }
        path = candidate;
        break;
      }
      if (path === null) {
        // Экспорта рядом нет — остаётся вопрос о САМОМ источнике (BLND-2). Ни
        // одного чтения он не стоит: у сцены без источника читать нечего, а
        // `.blend` не читает ни импорт, ни редактор (BLND-1, BLND-7).
        const state = await probeBlend(host, sourcePathOf(scene, blendExtension), states.get(scene));
        states.set(scene, state);
        return state;
      }

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await host.read(path));
      } catch (error) {
        const state: SourceState = { status: 'unavailable', path, reason: message(error) };
        states.set(scene, state);
        return state;
      }

      const fingerprint = fingerprintOf(bytes);
      const known = states.get(scene);
      if (known?.status === 'ready' && known.fingerprint === fingerprint) return known;

      let state: SourceState;
      try {
        const document = parseGltf(bytes);
        state = { status: 'ready', path, document, objects: normalizeDocument(document), fingerprint };
      } catch (error) {
        state = { status: 'rejected', path, reason: message(error) };
      }
      states.set(scene, state);
      return state;
    },
  };
}

/** Виды документов, между которыми стоит правило. */
export interface SyncKinds {
  readonly scene: DocumentKind;
  readonly presentation: DocumentKind;
  readonly manifest: DocumentKind;
  /** Документ карты кривизны (ASSET-7) — его адрес называет манифест. */
  readonly curvature: DocumentKind;
}

export const DEFAULT_SYNC_KINDS: SyncKinds = Object.freeze({
  scene: 'scene',
  presentation: 'presentation',
  manifest: 'manifest',
  curvature: 'curvature',
});

export interface SpatialLayerSyncOptions {
  /** Откуда правило узнаёт состояние источника. */
  readonly sources: SpatialLayerSources;
  readonly kinds?: SyncKinds;
  /** Где лежит расстановка в конфиге сцены (SER-8) — раскладку приносит собирающий. */
  readonly initialPath?: JsonPath;
  /** Где лежат decorations в парном документе (PRES-2). */
  readonly decorationsPath?: JsonPath;
  /** Где лежит ассет террейна (TERR-2); нет — поле `terrain` конфига сцены. */
  readonly terrainPath?: JsonPath;
  readonly binding?: PositionBinding;
}

/** Записи списка по адресу; не список — пустой перечень, форму проверяет формат. */
function recordsAt(value: JsonValue | undefined, path: JsonPath): readonly JsonValue[] {
  if (value === undefined) return [];
  const list = getAtPath(value, path);
  return isJsonArray(list) ? list : [];
}

function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * BLND-2: производные данные сцены обязаны совпадать с тем, что даёт импорт её
 * источника. Важность — предупреждение: документ валиден, а расхождение
 * процессное, и запирать автора отказом здесь незачем.
 */
export function spatialLayerSyncRule(options: SpatialLayerSyncOptions): ValidationRule {
  const kinds = options.kinds ?? DEFAULT_SYNC_KINDS;
  const initialPath = options.initialPath ?? DEFAULT_INITIAL_PATH;
  const decorationsPath = options.decorationsPath ?? DEFAULT_DECORATIONS_PATH;
  const terrainPath = options.terrainPath ?? DEFAULT_TERRAIN_PATH;

  return {
    id: SPATIAL_LAYER_SYNC_RULE,
    descriptionKey: ruleDescriptionKey(SPATIAL_LAYER_SYNC_RULE),
    reasonCodes: [
      LAYER_DIVERGED,
      SOURCE_UNREADABLE,
      SOURCE_REJECTED,
      SOURCE_UNREAD,
      SOURCE_UNEXPORTED,
      SOURCE_UNCHECKED,
    ],
    appliesTo: [kinds.scene],
    severity: 'warning',
    check(run) {
      const state = options.sources.stateOf(run.document.id);
      if (state.status !== 'ready') {
        reportSourceState(run, state);
        return;
      }

      // Слой считается ЦЕЛИКОМ — с клеточными слоями (BLND-9, BLND-10), — потому
      // что производными данными BLND-2 называет и их: ассет террейна и карту
      // кривизны при соответствующих объектах источника. Сравнивать половину
      // значило бы молчать о правке карты уровней мимо Blender ровно там, где
      // следующий импорт её перезапишет.
      const context = contextFor(run, kinds, options.binding, terrainPath);
      const layer: SpatialLayer = withCellLayer(
        generateSpatialLayer(state.objects, context),
        generateCellLayer(state.document, state.objects, context),
      );
      if (hasErrors(layer.findings)) {
        reportRejectedSource(run, layer.findings, state.path);
        return;
      }

      compare(run, {
        documentId: run.document.id,
        value: run.document.value,
        path: initialPath,
        expected: layer.initial,
        source: state.path,
        slot: 'initial',
      });
      compareTerrain(run, layer.terrain, terrainPath, state.path);
      compareCurvature(run, kinds.curvature, layer.curvature, context.curvatureMap, state.path);

      // Вторая сторона — парный документ (PRES-1), найденный правилом имени.
      // Не открыт ни один — правило о нём молчит: незагруженный документ не есть
      // расхождение (та же оговорка, что у прочих междокументных правил).
      const presentation = pairedDocument(run, kinds.presentation, run.document.id);
      if (presentation === undefined) return;
      compare(run, {
        documentId: presentation.id,
        value: run.valueOf(presentation.id),
        path: decorationsPath,
        expected: layer.decorations,
        source: state.path,
        slot: 'decorations',
      });
    },
  };
}

/** Состояние источника, при котором сверять нечего: каждое со своей находкой. */
type UnreadySource = Exclude<SourceState, { readonly status: 'ready' }>;

/** Находка о состоянии источника — ни одного молчаливого ответа (см. шапку). */
function reportSourceState(run: ValidationRun, state: UnreadySource): void {
  // Сцена без источника живёт как прежде: редактор и ручная правка —
  // полноправные авторы её слоя, и предупреждения нет (BLND-2).
  if (state.status === 'none') return;
  if (state.status === 'unexported') {
    // Источник рядом есть, экспорта нет: слой сцены производный (BLND-2), но
    // сверить его не с чем — импорт идёт от экспорта. Молчание здесь означало
    // бы «сцена конвейеру не принадлежит», то есть неправду о владении слоем.
    run.report({
      path: [],
      expected: {
        kind: 'accepted',
        by: SPATIAL_LAYER_SYNC_RULE,
        detail: 'экспорт источника не сделан',
      },
      code: SOURCE_UNEXPORTED,
      params: { source: state.path, scene: run.document.id },
    });
    return;
  }
  if (state.status === 'unchecked') {
    // Сопряжённость сцены неизвестна: среда не ответила, лежит ли рядом
    // источник. Молчать нельзя — молчание читалось бы как «источника нет», то
    // есть как утверждение, которого никто не проверял.
    run.report({
      path: [],
      expected: { kind: 'accepted', by: SPATIAL_LAYER_SYNC_RULE, detail: state.reason },
      code: SOURCE_UNCHECKED,
      params: { source: state.path, reason: state.reason },
    });
    return;
  }
  if (state.status === 'unknown') {
    // Сверки не было ни одной: у собирающего редактора обязанность
    // обновить кэш до прогона, и невыполненная она обязана быть видимой.
    // Молчание здесь означало бы «слой сошёлся», чего никто не проверял.
    run.report({
      path: [],
      expected: {
        kind: 'accepted',
        by: SPATIAL_LAYER_SYNC_RULE,
        detail: 'состояние источника не прочитано ни разу',
      },
      code: SOURCE_UNREAD,
      params: { scene: run.document.id },
    });
    return;
  }
  run.report({
    path: [],
    expected: { kind: 'accepted', by: SPATIAL_LAYER_SYNC_RULE, detail: state.reason },
    code: state.status === 'unavailable' ? SOURCE_UNREADABLE : SOURCE_REJECTED,
    // Причина — параметром, а не через `{received}`: полученным значением
    // на пустом пути является весь документ, и подставить его в текст
    // значило бы показать автору файл вместо причины.
    params: { source: state.path, reason: state.reason },
  });
}

/**
 * Импорт этот источник отверг бы (BLND-6): сравнивать документы не с чем, и
 * молчать об этом нельзя — «расхождения нет» здесь было бы неправдой.
 */
function reportRejectedSource(run: ValidationRun, findings: readonly Finding[], source: ContentPath): void {
  const reason = findings
    .filter((finding) => finding.severity === 'error')
    .map((finding) => `${finding.object}: ${finding.message}`)
    .join('; ');
  run.report({
    path: [],
    expected: { kind: 'accepted', by: SPATIAL_LAYER_SYNC_RULE, detail: reason },
    code: SOURCE_REJECTED,
    params: { source, reason },
  });
}

/**
 * Карты ассета террейна лежат тем же документом (TERR-2 — полем конфига у этого
 * проекта), поэтому сверяются рядами: ряд — единица формата (TERR-3), и адрес
 * расхождения обязан называть ряд, а не файл.
 */
function compareTerrain(
  run: ValidationRun,
  terrain: TerrainMaps | undefined,
  terrainPath: JsonPath,
  source: ContentPath,
): void {
  if (terrain === undefined) return;
  for (const [key, rows] of [
    ['levels', terrain.levels],
    ['flags', terrain.flags],
  ] as const) {
    compare(run, {
      documentId: run.document.id,
      value: run.document.value,
      path: [...terrainPath, key],
      expected: [...rows],
      source,
      slot: `terrain.${key}`,
    });
  }
}

/**
 * Карта кривизны — отдельный документ, адрес которому даёт манифест (ASSET-7).
 * Не открыт — правило о нём молчит, как и о парном документе.
 */
function compareCurvature(
  run: ValidationRun,
  kind: DocumentKind,
  curvature: CurvatureMap | undefined,
  curvatureId: string | null | undefined,
  source: ContentPath,
): void {
  if (curvature === undefined || curvatureId == null) return;
  const document = run.documentsOfKind(kind).find((entry) => entry.id === curvatureId);
  if (document === undefined) return;
  const value = run.valueOf(document.id);
  // Размеры и ряды — по отдельности, ровно теми адресами, которыми их пишет
  // операция импорта: сверка документа целиком краснела бы от порядка ключей,
  // которого импорт не меняет (ED-21).
  for (const [key, wanted] of [
    ['width', curvature.width],
    ['height', curvature.height],
  ] as const) {
    if (sameJson(getAtPath(value ?? null, [key]), wanted)) continue;
    run.report({
      documentId: document.id,
      path: [key],
      expected: { kind: 'oneOf', values: [wanted] },
      code: LAYER_DIVERGED,
      params: { slot: `curvature.${key}`, source },
    });
  }
  compare(run, {
    documentId: document.id,
    value,
    path: ['rows'],
    expected: [...curvature.rows],
    source,
    slot: 'curvature.rows',
  });
}

/** Контекст проверки источника — по текущему состоянию документов сессии (ED-15). */
function contextFor(
  run: ValidationRun,
  kinds: SyncKinds,
  binding: PositionBinding | undefined,
  terrainPath: JsonPath,
): SpatialLayerContext {
  const manifests = run.documentsOfKind(kinds.manifest);
  const manifest = manifests[0];
  return contextOfValues(
    run.document.value,
    manifest === undefined ? undefined : run.valueOf(manifest.id),
    binding,
    terrainPath,
  );
}

/** Парный presentation-документ сцены (PRES-1): по правилу имени, а не по ссылке. */
function pairedDocument(
  run: ValidationRun,
  kind: DocumentKind,
  scene: DocumentId,
): EditorDocument | undefined {
  const paired = presentationPathOf(scene);
  return run.documentsOfKind(kind).find((document) => document.id === paired);
}

interface Comparison {
  readonly documentId: DocumentId;
  readonly value: JsonValue | undefined;
  readonly path: JsonPath;
  readonly expected: readonly JsonValue[];
  readonly source: ContentPath;
  readonly slot: string;
}

/**
 * Сравнение одного слота. Адрес находки — самая точная позиция, до какой
 * расхождение сужается: разошлась одна запись — адрес записи, разошёлся состав
 * — адрес списка, потому что «записей стало другое число» не принадлежит ни
 * одной из них.
 */
function compare(run: ValidationRun, comparison: Comparison): void {
  const { documentId, path, expected, slot, source } = comparison;
  const actual = recordsAt(comparison.value, path);
  if (actual.length !== expected.length) {
    run.report({
      documentId,
      path: [...path],
      expected: { kind: 'oneOf', values: [[...expected]] },
      code: LAYER_DIVERGED,
      params: { slot, source, actual: actual.length, wanted: expected.length },
    });
    return;
  }
  expected.forEach((record, index) => {
    if (sameJson(actual[index], record)) return;
    run.report({
      documentId,
      path: [...path, index],
      expected: { kind: 'oneOf', values: [record] },
      code: LAYER_DIVERGED,
      params: { slot, source, index },
    });
  });
}
