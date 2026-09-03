/**
 * Импорт целиком: источник → целевой слой → зарегистрированная операция →
 * каноническое сохранение (BLND-1, BLND-5, ED-21).
 *
 * Этот файл ничего не решает о формате и ничего не пишет сам. Он соединяет уже
 * существующие звенья в том порядке, в каком их называет BLND-6: сперва разбор
 * и проверки, потом одна операция, и только потом — запись. Отсюда и
 * атомарность: между «слой посчитан» и «документы сохранены» нет ни одного
 * шага, который мог бы оставить половину.
 *
 * Режим проверки (`dryRun`) отличается двумя вещами: сохранения нет и сессия
 * своя. Всё остальное — те же разбор, те же находки, тот же целевой слой и та же
 * операция; иначе «живая проверка» аддона (BLND-8) проверяла бы не то, что
 * делает импорт, и расходилась бы с ним молча. Своя сессия — потому что
 * проверка обязана не менять НИЧЕГО: применённая в чужой сессии операция
 * осталась бы в ней правкой и записью истории (ED-18).
 */
import {
  OperationError,
  createEditorSession,
  createOperationRegistry,
  registerBuiltinOperations,
  saveDocuments,
  type ContentPath,
  type ContentTreeHost,
  type ContributionReader,
  type DocumentId,
  type EditorSession,
  type PositionBinding,
  type ValidationIssue,
  type ValidationRule,
} from '@fluxus/editor-core';
import { parseGltf, type GltfDocument } from './gltf.js';
import { generateSpatialLayer, hasErrors, type Finding, type SpatialLayer } from './layer.js';
import { generateCellLayer, withCellLayer } from './maps.js';
import { hasSingleSemantic, normalizeDocument, type SemanticKind, type SourceObject } from './normalize.js';
import { importParams } from './layerParam.js';
import { IMPORT_SPATIAL_LAYER, registerBlenderOperations } from './operation.js';
import { openImportTarget, type ImportKinds, type ImportSlots, type ImportTarget } from './project.js';
import { scenePathOf } from './pairing.js';

export interface ImportRequest {
  /** Дерево контента через хост среды (ED-12) — единственный канал чтения и записи. */
  readonly host: ContentTreeHost;
  /** Экспорт источника: `.glb` либо `.gltf`, путь от корня дерева. */
  readonly source: ContentPath;
  /** Конфиг сцены; нет — парный источнику по имени (BLND-2). */
  readonly scene?: ContentPath;
  /** Манифест визуалов; `null` — ссылки `visual` не проверять. */
  readonly manifest?: ContentPath | null;
  readonly binding?: PositionBinding;
  readonly kinds?: ImportKinds;
  /**
   * Сессия. Своя, если не подали: из редактора приходит его собственная — и
   * тогда импорт ложится в ту же историю (ED-18), что и правки автора. В режиме
   * проверки не используется: проверке нечего менять в чужой сессии.
   */
  readonly session?: EditorSession;
  /** Правила, которыми проверяется состояние дерева после записи (ED-8, ED-21). */
  readonly rules?: ContributionReader<ValidationRule>;
  /** Проверить и посчитать слой, ничего не записывая (BLND-6, мост аддона BLND-8). */
  readonly dryRun?: boolean;
}

export interface ImportResult {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly source: ContentPath;
  readonly scene: DocumentId;
  readonly presentation: DocumentId;
  /** Находки разбора источника (BLND-3, BLND-6) — адресованы именем объекта Blender. */
  readonly findings: readonly Finding[];
  /** Целевой слой: то, что импорт записал бы и записывает. */
  readonly layer: SpatialLayer;
  /** Что операция тронула; `null` — операция не исполнялась (отказ до неё). */
  readonly changes: Record<string, unknown> | null;
  /** Документы, записанные на диск. Пусто в режиме проверки и когда правок нет. */
  readonly written: readonly DocumentId[];
  /** Почему импорт не состоялся: отказ операции или отказ сохранения (ED-21). */
  readonly refusal: string | null;
  /** Находки валидации, которыми сохранение отвергло запись (ED-21). */
  readonly blocking: readonly ValidationIssue[];
}

/** Сессия с зарегистрированными операциями: базовыми и операцией импорта (ED-25). */
export function createImportSession(): EditorSession {
  const operations = registerBuiltinOperations(createOperationRegistry());
  registerBlenderOperations(operations);
  return createEditorSession({ operations });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Разобранный источник. Отдельным шагом, чтобы отказ чтения и отказ разбора
 * назывались путём источника: «файла нет» и «файл не разбирается» — разные
 * беды, и обе не про сцену.
 */
async function readSource(
  host: ContentTreeHost,
  source: ContentPath,
): Promise<{ readonly document: GltfDocument; readonly objects: readonly SourceObject[] }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await host.read(source));
  } catch (error) {
    throw new Error(`источник "${source}" не читается: ${message(error)}`);
  }
  // Разобранный документ переживает нормализацию: клеточные данные читаются из
  // его аксессоров и бинарного чанка (BLND-9, BLND-10), а объекты источника
  // несут только адрес меша.
  const document = parseGltf(bytes);
  return { document, objects: normalizeDocument(document) };
}

/**
 * Какие клеточные слои даёт источник. Считается ДО открытия цели: документ
 * карты кривизны открывается и попадает в группу записи только под слой,
 * который импорт действительно перепишет (BLND-2).
 */
function slotsOf(objects: readonly SourceObject[]): ImportSlots {
  const has = (kind: SemanticKind): boolean => objects.some((object) => hasSingleSemantic(object, kind));
  // Скалпт-поверхность переписывает ОБА клеточных слоя (BLND-13).
  const sculpt = has('sculpt');
  // Раскраска едет тем же grid-объектом террейна, что рампа и пол (BLND-14):
  // канала у скалпт-поверхности нет, и её документ импорт не открывает.
  return {
    terrain: sculpt || has('terrain'),
    curvature: sculpt || has('curvature'),
    paint: has('terrain'),
  };
}

export async function runImport(request: ImportRequest): Promise<ImportResult> {
  const { host, source } = request;
  const dryRun = request.dryRun === true;
  const scene = request.scene ?? scenePathOf(source);
  if ((await host.stat(scene))?.kind !== 'file') {
    throw new Error(`конфигу сцены "${scene}" нечего импортировать: файла нет (BLND-2 — парность по имени)`);
  }

  const { document, objects } = await readSource(host, source);
  // Режим проверки не касается чужой сессии: он ничего не записывает НИКУДА, а
  // применённая в подданной сессии операция осталась бы в ней правкой и записью
  // истории (ED-18) — то есть проверка меняла бы состояние редактора.
  const session = dryRun ? createImportSession() : (request.session ?? createImportSession());
  const target: ImportTarget = await openImportTarget(session, host, {
    scene,
    slots: slotsOf(objects),
    ...(request.manifest === undefined ? {} : { manifest: request.manifest }),
    ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
    ...(request.binding === undefined ? {} : { binding: request.binding }),
  });

  // Слой считается целиком до первой записи: размещения и клеточные слои — один
  // вход одной операции, и половины импорта не бывает (BLND-6).
  const layer = withCellLayer(
    generateSpatialLayer(objects, target.context),
    generateCellLayer(document, objects, target.context),
  );
  const base = {
    dryRun,
    source,
    scene: target.sceneId,
    presentation: target.presentationId,
    findings: layer.findings,
    layer,
  };

  // Гейт один и тот же на оба пути (BLND-5): решает операция, а не этот файл.
  // Ошибочный слой она отвергает до первой записи, и здесь остаётся назвать
  // причину — на диск при этом не ушло ничего (BLND-6).
  let changes: Record<string, unknown> | null = null;
  try {
    const outcome = session.applyOperation(
      IMPORT_SPATIAL_LAYER,
      importParams({
        scene: target.sceneId,
        presentation: target.presentationId,
        curvature: target.curvatureId,
        paint: target.paintId,
        layer,
        initialPath: target.initialPath,
        decorationsPath: target.decorationsPath,
        terrainPath: target.terrainPath,
      }),
    );
    changes = (outcome.result ?? null) as Record<string, unknown> | null;
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return { ...base, ok: false, changes: null, written: [], refusal: error.message, blocking: [] };
  }

  if (dryRun) {
    return { ...base, ok: !hasErrors(layer.findings), changes, written: [], refusal: null, blocking: [] };
  }

  const saved = await saveDocuments({
    session,
    host,
    documentIds: target.group.members,
    groups: [target.group],
    ...(request.rules === undefined ? {} : { rules: request.rules }),
  });
  if (saved.refused) {
    return {
      ...base,
      ok: false,
      changes,
      written: [],
      refusal: 'сохранение отвергнуто валидацией результата (ED-21, BLND-6)',
      blocking: saved.blocking,
    };
  }
  return { ...base, ok: true, changes, written: saved.written, refusal: null, blocking: [] };
}
