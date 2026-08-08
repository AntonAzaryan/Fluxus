/**
 * @contribution Открытие документов сцены — часть вклада области, а не каркаса.
 *
 * Сцена — это не один документ: конфиг (SER-7) ссылается на ассет террейна,
 * манифест визуалов (ASSET-6) — на модели, скины и карту кривизны (ASSET-7).
 * ED-15 требует, чтобы изображение было производным от текущего состояния
 * ИХ ВСЕХ, поэтому все они открываются сессией как документы: правка манифеста
 * и правка кривизны — такие же правки, как правка позиции, и ждать записи на
 * диск ради картинки нельзя (ED-9, ED-21 — сохранение отдельная операция).
 *
 * Читаются они через хост среды (ED-12) и только через него: прямого обращения
 * к файловой системе тут нет и в вебе быть не может.
 */
import {
  openDocumentFromHost,
  type ContentPath,
  type ContentTreeHost,
  type DocumentId,
  type EditorSession,
  type JsonPath,
} from '@game-mvp/editor-core';
import type { VisualManifest } from '@game-mvp/assets';
import { sceneDraft, visualsOf, type SceneDraft } from './sceneDocuments.js';

/** Путь списка расстановки в конфиге сцены (SER-7, SER-8) — доменное знание вклада. */
export const PLACEMENT_LIST: JsonPath = ['initial'];

/** Виды документов сцены — ими ключуются вклады инспектора и правил валидации (ED-25). */
export const SCENE_KINDS = {
  config: 'scene',
  visuals: 'visuals',
  curvature: 'terrain-curvature',
} as const;

export interface SceneProjectIds {
  /** Конфиг сцены — путь от корня дерева контента, он же ID документа (ASSET-2). */
  readonly config: ContentPath;
  /** Манифест визуалов; карту кривизны он называет сам (`terrain.curvatureMap`). */
  readonly visuals: ContentPath;
}

/** То, что редактор открыл: чем рисовать сцену и где это лежит. */
export interface SceneProject {
  readonly configId: DocumentId;
  readonly visualsId: DocumentId;
  /** Карта кривизны — её ID берётся из манифеста; `null` — арена без кривизны. */
  readonly curvatureId: DocumentId | null;
  readonly visuals: VisualManifest;
}

/**
 * Открывает документы сцены в сессии. Идемпотентно: каркас может завести запись
 * состояния области дважды над одной сессией (`AreaSetup`), и повторное
 * открытие не должно ни перечитывать диск, ни сбрасывать несохранённые правки.
 */
export async function openSceneProject(
  session: EditorSession,
  host: ContentTreeHost,
  ids: SceneProjectIds,
): Promise<SceneProject> {
  if (!session.isOpen(ids.config)) {
    await openDocumentFromHost(session, host, {
      id: ids.config,
      kind: SCENE_KINDS.config,
      // Записи расстановки адресуются дескрипторами сессии: они и служат
      // ключами инстансов документного набора (REND-11).
      lists: [PLACEMENT_LIST],
    });
  }
  if (!session.isOpen(ids.visuals)) {
    await openDocumentFromHost(session, host, { id: ids.visuals, kind: SCENE_KINDS.visuals });
  }
  const visuals = visualsOf(session.documentValue(ids.visuals));

  const curvatureId = visuals.terrain?.curvatureMap ?? null;
  if (curvatureId !== null && !session.isOpen(curvatureId)) {
    await openDocumentFromHost(session, host, {
      id: curvatureId,
      kind: SCENE_KINDS.curvature,
    });
  }

  return { configId: ids.config, visualsId: ids.visuals, curvatureId, visuals };
}

/**
 * Кадр по текущему состоянию открытых документов (ED-15). Ключи записей —
 * дескрипторы сессии: они переживают правку соседей, а значит инстанс не
 * пересоздаётся от правки позиции (REND-11).
 */
export function draftOf(session: EditorSession, project: SceneProject): SceneDraft {
  return sceneDraft({
    config: session.documentValue(project.configId),
    keys: session.descriptors(project.configId, PLACEMENT_LIST),
    visuals: project.visuals,
    curvature:
      project.curvatureId === null || !session.isOpen(project.curvatureId)
        ? null
        : session.documentValue(project.curvatureId),
  });
}
