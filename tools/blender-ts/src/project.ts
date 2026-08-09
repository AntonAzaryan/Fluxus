/**
 * Цель импорта в дереве контента: какие документы открыть и что импортёру нужно
 * знать о них, чтобы проверить источник до записи (BLND-6).
 *
 * Документы открываются каналом editor-core через хост среды (ED-12) — второго
 * пути чтения у конвейера нет, как нет и второго пути записи. Раскладку
 * («расстановка лежит полем `initial` конфига сцены», «decorations — полем
 * парного документа») знает этот файл, а не операция и не правило: адреса им
 * приносит тот, кто собирает инструмент (ED-25), — здесь этот кто-то и есть.
 *
 * Парный presentation-документ открывается ВСЕГДА, в том числе когда файла в
 * дереве нет: он тогда открывается пустым (PRES-1 — сцена без декораций
 * законна), и на диск уходит только с содержимым (ED-21). Иначе первый же
 * импорт сцены, у которой декораций ещё не было, писать их было бы некуда.
 */
import { validateManifest, type VisualManifest } from '@game-mvp/assets';
import type { ComponentSchema, PrefabDef } from '@game-mvp/core';
import {
  getAtPath,
  isJsonObject,
  openDocumentFromHost,
  type ContentPath,
  type ContentTreeHost,
  type DocumentGroup,
  type DocumentId,
  type DocumentKind,
  type EditorSession,
  type JsonPath,
  type JsonValue,
  type PositionBinding,
} from '@game-mvp/editor-core';
import { presentationPathOf } from '@game-mvp/assets';
import { DEFAULT_DECORATIONS_PATH, DEFAULT_INITIAL_PATH, DEFAULT_TERRAIN_PATH } from './operation.js';
import type { SpatialLayerContext, TargetTerrain } from './layer.js';

/** Виды документов цели — ими ключуются вклады и правила (ED-25). */
export interface ImportKinds {
  readonly scene: DocumentKind;
  readonly presentation: DocumentKind;
  readonly manifest: DocumentKind;
  /** Документ карты кривизны (ASSET-7) — его адрес называет манифест. */
  readonly curvature: DocumentKind;
}

export const DEFAULT_IMPORT_KINDS: ImportKinds = Object.freeze({
  scene: 'scene',
  presentation: 'presentation',
  manifest: 'manifest',
  curvature: 'curvature',
});

/**
 * Какие клеточные слои даёт источник. Знание приходит СВЕРХУ, из уже
 * разобранного источника: документ карты кривизны открывается и попадает в
 * группу записи только тогда, когда импорт его действительно перепишет —
 * держать в группе документ, которого правка не касается, значило бы отвергать
 * сохранение из-за чужих несохранённых правок (BLND-2).
 */
export interface ImportSlots {
  readonly terrain?: boolean;
  readonly curvature?: boolean;
}

/** Манифест визуалов проекта (ASSET-9) — умолчание раскладки дерева контента. */
export const DEFAULT_MANIFEST_PATH: ContentPath = 'visuals/manifest.json';

export interface OpenImportTargetInput {
  /** Конфиг сцены — путь от корня дерева, он же `DocumentId` (ASSET-2). */
  readonly scene: ContentPath;
  /** Манифест визуалов; `null` — ссылки `visual` не проверяются вовсе. */
  readonly manifest?: ContentPath | null;
  readonly kinds?: ImportKinds;
  readonly initialPath?: JsonPath;
  readonly decorationsPath?: JsonPath;
  /** Где в конфиге сцены лежит ассет террейна (TERR-2); нет — поле `terrain`. */
  readonly terrainPath?: JsonPath;
  /** Какие клеточные слои даёт источник — см. `ImportSlots`. */
  readonly slots?: ImportSlots;
  /** Где у сим-объекта позиция и курс (ED-16); нет — конвенция ядра. */
  readonly binding?: PositionBinding;
}

/** Открытая цель: адреса документов и то, чем проверяется источник. */
export interface ImportTarget {
  readonly sceneId: DocumentId;
  readonly presentationId: DocumentId;
  readonly manifestId: DocumentId | null;
  /** Документ карты кривизны (ASSET-7); `null` — манифест её не адресует либо источник её не даёт. */
  readonly curvatureId: DocumentId | null;
  readonly initialPath: JsonPath;
  readonly decorationsPath: JsonPath;
  readonly terrainPath: JsonPath;
  readonly context: SpatialLayerContext;
  /** Документы, чьи правки обязаны уйти на диск одной записью (ED-21). */
  readonly group: DocumentGroup;
}

/** Пустой парный документ: `{}`, а не `{"decorations": []}` — см. PRES-2 и ED-21. */
const EMPTY_PRESENTATION: JsonValue = Object.freeze({});

function objectsOf(value: JsonValue | undefined, key: string): readonly Record<string, unknown>[] {
  const shape = value as Record<string, unknown> | null | undefined;
  const list = shape?.[key];
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
}

/**
 * Схемы компонентов и prefab'ы конфига сцены (SER-7). Читаются приведением, а не
 * разбором: форма у них — форма ядра, и вторая её проверка здесь была бы вторым
 * описанием формата (ED-1). Записи не той формы просто не попадают в перечень —
 * их отвергнет валидация конфига на общих основаниях (ED-8), а импорт от них
 * отказывается назвать prefab неизвестным, что тоже правда.
 */
function shaped(entry: Record<string, unknown>, member: string): boolean {
  return typeof entry['name'] === 'string' && typeof entry[member] === 'object' && entry[member] !== null;
}

function componentsOf(value: JsonValue | undefined): readonly ComponentSchema[] {
  return objectsOf(value, 'components')
    .filter((entry) => shaped(entry, 'fields'))
    .map((entry) => entry as unknown as ComponentSchema);
}

function prefabsOf(value: JsonValue | undefined): readonly PrefabDef[] {
  return objectsOf(value, 'prefabs')
    .filter((entry) => shaped(entry, 'components'))
    .map((entry) => entry as unknown as PrefabDef);
}

/**
 * Манифест визуалов из значения документа (ASSET-9). Разбирает его модуль
 * ассетов; сломанный манифест — не отсутствующий: ссылки `visual` тогда не
 * проверяются, но импорт из-за чужого документа не останавливается (BLND-6 —
 * `visual` в никуда и так лишь предупреждение).
 */
export function visualsOf(value: JsonValue | undefined): VisualManifest | null {
  if (value === undefined) return null;
  const checked = validateManifest(value);
  return checked.ok ? checked.manifest : null;
}

/**
 * Ассет террейна цели по адресу в конфиге (TERR-2). Размеры и `tileSize`
 * читаются приведением: их форму проверяет ядро (`createTerrainGrid`) на общих
 * основаниях (ED-8), а импорту они нужны, чтобы СВЕРИТЬ с ними grid-объект.
 * Ассета нет — `null`: сцена без террейна законна, и terrain-объект в источнике
 * такой сцены отказывает с именем объекта (BLND-9), а не молча создаёт ассет.
 */
export function terrainOfValue(config: JsonValue | undefined, path: JsonPath): TargetTerrain | null {
  if (config === undefined) return null;
  const value = getAtPath(config, path);
  if (!isJsonObject(value)) return null;
  const { width, height, tileSize } = value;
  if (typeof width !== 'number' || typeof height !== 'number' || typeof tileSize !== 'number') return null;
  return { width, height, tileSize };
}

/**
 * Что импортёру нужно знать о цели — по ЗНАЧЕНИЯМ документов, а не по сессии:
 * тем же составом проверяет источник и правило синхронизации (BLND-2), у
 * которого сессии нет вовсе, а есть прогон валидации. Второй сборки контекста
 * рядом с первой быть не должно — она разошлась бы с ней молча (ED-1).
 */
export function contextOfValues(
  config: JsonValue | undefined,
  manifest: JsonValue | undefined,
  binding?: PositionBinding,
  terrainPath: JsonPath = DEFAULT_TERRAIN_PATH,
): SpatialLayerContext {
  const visuals = visualsOf(manifest);
  return {
    components: componentsOf(config),
    prefabs: prefabsOf(config),
    visuals,
    terrain: terrainOfValue(config, terrainPath),
    // Адрес карты кривизны называет манифест (ASSET-7) — своей конвенции имени
    // у неё нет, и выдумывать её импортёр не вправе.
    curvatureMap: visuals?.terrain?.curvatureMap ?? null,
    ...(binding === undefined ? {} : { binding }),
  };
}

/** Тот же контекст по открытым документам сессии. */
export function contextOf(
  session: EditorSession,
  target: { readonly sceneId: DocumentId; readonly manifestId: DocumentId | null },
  binding?: PositionBinding,
  terrainPath: JsonPath = DEFAULT_TERRAIN_PATH,
): SpatialLayerContext {
  return contextOfValues(
    session.documentValue(target.sceneId),
    target.manifestId === null ? undefined : session.documentValue(target.manifestId),
    binding,
    terrainPath,
  );
}

export async function openImportTarget(
  session: EditorSession,
  host: ContentTreeHost,
  input: OpenImportTargetInput,
): Promise<ImportTarget> {
  const kinds = input.kinds ?? DEFAULT_IMPORT_KINDS;
  const initialPath = input.initialPath ?? DEFAULT_INITIAL_PATH;
  const decorationsPath = input.decorationsPath ?? DEFAULT_DECORATIONS_PATH;
  const terrainPath = input.terrainPath ?? DEFAULT_TERRAIN_PATH;
  const sceneId = input.scene;
  const presentationId = presentationPathOf(sceneId);
  const manifestId = input.manifest === null ? null : (input.manifest ?? DEFAULT_MANIFEST_PATH);

  if (!session.isOpen(sceneId)) {
    // Записи расстановки адресуются дескрипторами сессии (ED-29): без
    // отслеживаемого списка операция импорта не нашла бы, что переписывать.
    await openDocumentFromHost(session, host, {
      id: sceneId,
      kind: kinds.scene,
      lists: [initialPath],
    });
  }

  if (!session.isOpen(presentationId)) {
    const opening = { id: presentationId, kind: kinds.presentation, lists: [decorationsPath] };
    if ((await host.stat(presentationId))?.kind === 'file') {
      await openDocumentFromHost(session, host, opening);
    } else {
      session.openDocument({ ...opening, value: EMPTY_PRESENTATION });
    }
  }

  let openedManifest: DocumentId | null = null;
  if (manifestId !== null) {
    if (session.isOpen(manifestId)) openedManifest = manifestId;
    else if ((await host.stat(manifestId))?.kind === 'file') {
      await openDocumentFromHost(session, host, { id: manifestId, kind: kinds.manifest });
      openedManifest = manifestId;
    }
  }

  const target = { sceneId, manifestId: openedManifest };
  const context = contextOf(session, target, input.binding, terrainPath);

  // Документ карты кривизны открывается только под слой, который источник
  // действительно даёт (BLND-2): у сцены без curvature-объекта карта остаётся
  // за кистью редактора и руками, и импорт её не читает и не пишет.
  let curvatureId: DocumentId | null = null;
  if (input.slots?.curvature === true && context.curvatureMap != null) {
    curvatureId = context.curvatureMap;
    if (!session.isOpen(curvatureId)) {
      const opening = { id: curvatureId, kind: kinds.curvature };
      if ((await host.stat(curvatureId))?.kind === 'file') {
        await openDocumentFromHost(session, host, opening);
      } else {
        // Карты ещё нет в дереве: первый импорт создаёт её так же, как первый
        // импорт создаёт парный presentation-документ (PRES-1, ED-21).
        session.openDocument({ ...opening, value: {} });
      }
    }
  }

  return {
    sceneId,
    presentationId,
    manifestId: openedManifest,
    curvatureId,
    initialPath,
    decorationsPath,
    terrainPath,
    context,
    // Группа записи — ровно те документы, которые пишет импорт (ED-21):
    // производные данные лежат в двух документах (а с картой кривизны — в трёх),
    // и уйти на диск они обязаны одной записью, иначе на диске окажется половина
    // слоя. Ассет террейна отдельного документа не требует: он лежит полем
    // конфига сцены, который в группе уже есть. Манифест в группу не входит:
    // импорт его не трогает (BLND-2), а держать вместе документы, которых правка
    // не касается, значило бы отвергать сохранение из-за чужих несохранённых
    // правок.
    group: {
      id: sceneId,
      members: curvatureId === null ? [sceneId, presentationId] : [sceneId, presentationId, curvatureId],
    },
  };
}
