/**
 * Черновой проект под кисти: сетка 8×8 и карта кривизны того же размера.
 *
 * Восемь на восемь, а не четыре на четыре проекта-фикстуры, ровно по одной
 * причине: ED-18 требует, чтобы отменялся мазок В ДВАДЦАТЬ КЛЕТОК, и на арене
 * из шестнадцати такой мазок был бы всей ареной, а не мазком по ней.
 *
 * Документы здесь настоящие: конфиг проходит `loadScene`, карта кривизны —
 * `validateCurvatureMap`. Иначе проверка кисти проверяла бы только саму себя.
 */
import {
  createEditorSession,
  createOperationRegistry,
  registerBuiltinOperations,
  type EditorSession,
} from '@game-mvp/editor-core';
import { PLACEMENT_LIST } from '../../src/areas/sceneProject.js';
import { registerPlacementOperations } from '../../src/areas/scenePlacement.js';
import { registerTerrainOperations } from '../../src/areas/sceneTerrain.js';

export const PAINT_IDS = {
  config: 'scenes/paint.scene.json',
  curvature: 'visuals/paint.curvature.json',
} as const;

/** Сторона сетки чернового проекта. */
export const PAINT_SIDE = 8;

const rows = (fill: string): string[] =>
  Array.from({ length: PAINT_SIDE }, () => fill.repeat(PAINT_SIDE));

export const PAINT_SCENE = {
  components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
  prefabs: [{ name: 'Hero', tags: ['Hero'], components: { Position: { x: 98304, y: 98304 } } }],
  terrain: {
    width: PAINT_SIDE,
    height: PAINT_SIDE,
    tileSize: 65536,
    levels: rows('0'),
    flags: rows('.'),
  },
  initial: [{ prefab: 'Hero' }],
  capacity: 16,
};

export const PAINT_CURVATURE = {
  width: PAINT_SIDE,
  height: PAINT_SIDE,
  rows: rows('.'),
};

/**
 * Сессия с обоими документами и тем же реестром операций, что собирает
 * приложение: второго пути правки у теста нет ровно так же, как у редактора
 * (ED-29).
 */
export function paintSession(): EditorSession {
  const session = createEditorSession({
    operations: registerTerrainOperations(
      registerPlacementOperations(registerBuiltinOperations(createOperationRegistry())),
    ),
  });
  session.openDocument({
    id: PAINT_IDS.config,
    kind: 'scene',
    value: PAINT_SCENE,
    lists: [PLACEMENT_LIST],
  });
  session.openDocument({
    id: PAINT_IDS.curvature,
    kind: 'terrain-curvature',
    value: PAINT_CURVATURE,
  });
  return session;
}

/** Значение документа байтами — им и сравнивается «не изменилось ни на байт». */
export function bytesOf(session: EditorSession, id: string): string {
  return JSON.stringify(session.documentValue(id));
}
