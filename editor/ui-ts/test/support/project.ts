/**
 * Проект-фикстура для тестов каркаса и области сцены: дерево контента в памяти
 * и структурный дубль вьюпорта.
 *
 * Дерево — `createMemoryHost` из `editor-core`: он и есть тестовый дубль хоста
 * среды (ED-12), второй реализации «дерева в памяти» здесь не заводится.
 * Вьюпорт — дубль, потому что WebGL в headless-прогоне нет: проверяется не
 * картинка, а то, ЧТО редактор отдаёт рендеру, — набор инстансов, сетка и
 * кривизна (REND-11, REND-14). Картинку проверяет глаз на живой сцене, и
 * подделывать её тестом было бы враньём.
 *
 * Документы фикстуры — настоящие: конфиг сцены проходит `loadScene`, манифест —
 * `validateManifest`, карта кривизны — `validateCurvatureMap`. Иначе проверка
 * производной проверяла бы только саму себя.
 */
import { createMemoryHost, type MemoryHost } from '@game-mvp/editor-core';
import type { CameraPose, PresentationStage } from '@game-mvp/render';
import type { PositionBinding, SceneDraft } from '../../src/areas/sceneDocuments.js';
import type { SceneStage } from '../../src/areas/sceneStage.js';
import type { SceneProjectIds } from '../../src/areas/sceneProject.js';
import type { SceneOverlay, ScenePick } from '../../src/areas/sceneInteraction.js';

/**
 * Привязка проекта-фикстуры (ED-16). Она здесь ЕСТЬ и отличается от конвенции
 * ядра полем поворота: иначе «редактор берёт имена из настройки проекта» было бы
 * проверено на настройке, совпадающей с умолчанием, то есть не проверено.
 */
export const FIXTURE_POSITION: PositionBinding = {
  component: 'Position',
  x: 'x',
  y: 'y',
  rotation: { component: 'Position', field: 'turns' },
};

export const FIXTURE_IDS: SceneProjectIds = {
  config: 'scenes/fixture.scene.json',
  visuals: 'visuals/fixture.manifest.json',
  position: FIXTURE_POSITION,
};

export const FIXTURE_CURVATURE_ID = 'visuals/fixture.curvature.json';

/** Арена 4×4 с плато уровня 1 в правом нижнем углу и клеткой без пола. */
export const FIXTURE_SCENE = {
  components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed', turns: 'fixed' } }],
  prefabs: [
    { name: 'Hero', tags: ['Hero'], components: { Position: { x: 98304, y: 98304, turns: 0 } } },
    { name: 'Crate', tags: ['Crate'], components: { Position: { x: 163840, y: 98304, turns: 0 } } },
  ],
  terrain: {
    width: 4,
    height: 4,
    tileSize: 65536,
    levels: ['0000', '0000', '0011', '0011'],
    flags: ['....', '.._.', '....', '....'],
  },
  initial: [{ prefab: 'Hero' }, { prefab: 'Crate' }],
  capacity: 16,
};

export const FIXTURE_VISUALS = {
  entities: {
    Hero: { model: 'visuals/models/hero.mdx', scale: 1.6 },
  },
  terrain: { curvatureMap: FIXTURE_CURVATURE_ID },
};

export const FIXTURE_CURVATURE = {
  width: 4,
  height: 4,
  rows: ['....', '.1a.', '.a1.', '....'],
};

export function fixtureHost(): MemoryHost {
  return createMemoryHost({
    name: 'fixture',
    root: { label: 'fixture' },
    files: {
      [FIXTURE_IDS.config]: JSON.stringify(FIXTURE_SCENE),
      [FIXTURE_IDS.visuals]: JSON.stringify(FIXTURE_VISUALS),
      [FIXTURE_CURVATURE_ID]: JSON.stringify(FIXTURE_CURVATURE),
    },
  });
}

/**
 * Попадание, которое дубль вьюпорта отдаёт по точке экрана. Тест раскладывает
 * экран на попадания сам: настоящий picking считает по нарисованному (REND-15),
 * а нарисованного в headless-прогоне нет.
 */
export type FakeHits = ReadonlyMap<string, ScenePick>;

/** Дубль вьюпорта: помнит поданное, вместо того чтобы это рисовать. */
export interface FakeStage extends SceneStage {
  readonly submitted: readonly SceneDraft[];
  readonly zooms: readonly number[];
  readonly last: SceneDraft | undefined;
  /** Наборы наложений в порядке подачи (REND-16). */
  readonly overlaySets: readonly (readonly SceneOverlay[])[];
  /** Последний набор наложений. */
  readonly overlays: readonly SceneOverlay[];
  /** Что дубль отвечает на попадание в точку `x,y`; ключ — `${x}:${y}`. */
  readonly hits: Map<string, ScenePick>;
  /** То же для запроса «только поверхность». */
  readonly surfaceHits: Map<string, ScenePick>;
  /** Причина сорвавшегося кадра — её ставит тест, как поставил бы её кадр. */
  fail(reason: string | null): void;
}

/** Попадание в поверхность: то, что picking отдаёт при клике по пустому месту. */
export function surfaceHit(x: number, y: number, cell = 0): ScenePick {
  return {
    kind: 'surface',
    handle: null,
    key: null,
    x,
    y,
    z: 0,
    cell,
    cellX: 0,
    cellY: 0,
    noFloor: false,
    wall: false,
  };
}

/**
 * Попадание в клетку сетки — то, чем picking отвечает кисти (REND-15): индекс
 * клетки, её координаты и признак отсутствия пола. Мировая точка здесь центр
 * клетки: кисти она не нужна, но попадания без неё рендер не отдаёт.
 */
export function cellHit(cellX: number, cellY: number, width: number, noFloor = false): ScenePick {
  return {
    kind: 'surface',
    handle: null,
    key: null,
    x: cellX + 0.5,
    y: cellY + 0.5,
    z: 0,
    cell: cellY * width + cellX,
    cellX,
    cellY,
    noFloor,
    wall: false,
  };
}

/** Попадание в размещённый объект: ключ уже переведён набором (REND-11). */
export function entityHit(key: string): ScenePick {
  return {
    kind: 'entity',
    handle: null,
    key,
    x: 0,
    y: 0,
    z: 0,
    cell: -1,
    cellX: -1,
    cellY: -1,
    noFloor: false,
    wall: false,
  };
}

/**
 * Дубль повторяет ОБЪЯВИТЕЛЬНЫЙ характер настоящего вьюпорта: о смене режима и
 * о сорвавшемся кадре он сообщает `announce`, а не ждёт, что его спросят. Чего
 * он не повторяет — задержки в один кадр: у настоящего конвейера режим
 * применяет ближайший кадр rig'а (CAM-2), и без RAF этого не воспроизвести.
 * Поэтому здесь и проверяется механизм оповещения, а не момент его срабатывания.
 */
export function fakeStage(announce: () => void = () => undefined): FakeStage {
  const submitted: SceneDraft[] = [];
  const zooms: number[] = [];
  const overlaySets: (readonly SceneOverlay[])[] = [];
  const hits = new Map<string, ScenePick>();
  const surfaceHits = new Map<string, ScenePick>();
  let flying = false;
  let failure: string | null = null;
  const at = (x: number, y: number): string => `${x}:${y}`;
  return {
    submit: (draft) => {
      submitted.push(draft);
    },
    get flying(): boolean {
      return flying;
    },
    toggleFly: () => {
      flying = !flying;
      announce();
    },
    zoom: (steps) => {
      zooms.push(steps);
    },
    get instanceCount(): number {
      return submitted.at(-1)?.placements.length ?? 0;
    },
    get failure(): string | null {
      return failure;
    },
    fail: (reason) => {
      failure = reason;
      announce();
    },
    // Presentation-сцену дубль не заводит: в headless-прогоне публиковать в неё
    // нечего, а тип держит её обязательной ради превью и просмотрщика.
    presentation: null as unknown as PresentationStage,
    pose: null as CameraPose | null,
    pick: (x, y) => hits.get(at(x, y)) ?? null,
    pickSurface: (x, y) => surfaceHits.get(at(x, y)) ?? null,
    setOverlays: (items) => {
      overlaySets.push([...items]);
    },
    dispose: () => undefined,
    submitted,
    zooms,
    overlaySets,
    hits,
    surfaceHits,
    get overlays(): readonly SceneOverlay[] {
      return overlaySets.at(-1) ?? [];
    },
    get last(): SceneDraft | undefined {
      return submitted.at(-1);
    },
  };
}

/**
 * Ожидание того, что асинхронное уже случилось: открытие документов
 * асинхронно даже у хоста в памяти.
 *
 * Ждёт макрозадачу, а не считает микрозадачи: очередь микрозадач опустошается
 * целиком перед следующей макрозадачей, и цепочка из скольких угодно `await`
 * успевает завершиться. Счёт же микрозадач привязывает фикстуру к длине
 * цепочки — одна лишняя `await` в открытии проекта, и тест краснеет там, где
 * ничего не сломалось.
 */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
