/**
 * Отладочные источники сборки демо (`render-debug` RDBG-1) — ПОЛИТИКА, а не
 * механизм: какие оси наблюдения существуют в этой игре, каким цветом они
 * рисуются и что попадает в дамп. Движок об этом файле не знает: реестр открыт
 * (RDBG-1), и сборка регистрирует свои источники наравне с подсистемными.
 *
 * ## Информационная граница держится сама (RDBG-6)
 *
 * Каждый источник здесь построен над тем, что у главного потока УЖЕ есть:
 * доставленным presentation-состоянием, сеткой террейна из handshake (SHELL-5),
 * позой камеры (CAM-1) и picking'ом по видимому изображению (REND-15). Ни
 * нового сообщения в канале оболочки (SHELL-3), ни расширения handshake, ни
 * запроса к серверу здесь нет и быть не может — иначе отладочный режим стал бы
 * каналом к данным, вырезанным фильтром снапшота (`netcode` NET-12).
 *
 * ## Что из этого реконструкция, а что снимок
 *
 * Статические коллайдеры и их broad-phase главный поток ВЫВОДИТ из сетки
 * террейна тем же правилом, что и физика ядра (PHYS-10, PHYS-5): у обеих сторон
 * один вход — `cliffs` (TERR-5). Расхождение двух выводов возможно и принимается
 * осознанно (design D5), поэтому дамп называет величину РЕКОНСТРУКЦИЕЙ, а размер
 * клетки берётся из конфигурации сборки, а не угадывается.
 */
import type { EntityId, TerrainGrid } from '@game-mvp/core';
import { FIXED_ONE } from '@game-mvp/core';
import {
  DebugRows,
  type CameraBounds,
  type CameraPose,
  type CameraRig,
  type DebugColor,
  type DebugDraw,
  type DebugFrameState,
  type DebugList,
  type DebugProbe,
  type DebugSource,
  type PickHit,
  type ViewportPicking,
} from '@game-mvp/render';

// ------------------------------------------------------------------ палитра

/** Цвета наложений — политика демо: рендер о них ничего не знает (RDBG-1). */
const COLORS = {
  staticCollider: 0xff9040,
  broadPhase: 0x604020,
  dynamicCollider: 0x40ffc0,
  inspector: 0xffffff,
  frustum: 0x9080ff,
  edgePan: 0xffd479,
} as const;

/**
 * Размер клетки broad-phase, мировые единицы — КОНФИГУРАЦИЯ СБОРКИ (PHYS-5,
 * design D5). Сцена демо физику настройками не переопределяет (`"physics": {}`),
 * поэтому здесь стоит умолчание ядра. Разъедься эти два числа — наложение
 * покажет не ту сетку, и это будет видно, а не молча неверно.
 */
const BROAD_PHASE_CELL_WORLD_UNITS = 4;

/** Потолок перечня статических коллайдеров (RDBG-7): арена крупнее — усечение. */
const STATIC_CAP = 512;
/** Потолок перечня динамических коллайдеров: их десятки, а не тысячи (PHYS-5). */
const DYNAMIC_CAP = 64;

// ------------------------------------ 4.1 статика и broad-phase из handshake

/** Прямоугольник нулевой толщины — так же представляет обрыв физика (PHYS-10). */
interface StaticRow {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Уровни клеток по обе стороны ребра (TERR-5): по ним читается направление. */
  levelNeg: number;
  levelPos: number;
}

export interface DebugStaticsProbe extends DebugProbe {
  /**
   * Величина ВЫВЕДЕНА главным потоком из сетки террейна, а не снята с физики
   * (design D5): у мира и у отладки один вход, но два вывода.
   */
  readonly reconstruction: true;
  readonly cliffSegments: number;
  readonly broadPhaseCellWorldUnits: number;
  readonly broadPhaseCellsX: number;
  readonly broadPhaseCellsY: number;
  readonly colliders: DebugList<StaticRow>;
}

/**
 * Статические коллайдеры обрывов и сетка broad-phase, реконструированные из
 * `cliffs` сетки террейна handshake (PHYS-10, PHYS-5, SHELL-5).
 *
 * Правило вывода то же, что у ядра: отрезок границы — прямоугольник нулевой
 * толщины. Второй реализации ЯДРА при этом не появляется: ядро строит статику у
 * себя из той же сетки, здесь — отладочная реконструкция для показа, и дамп
 * называет её так прямо.
 */
export function staticCollidersDebugSource(
  gridOf: () => TerrainGrid | null,
): DebugSource<DebugStaticsProbe> {
  const rows = new DebugRows<StaticRow>(STATIC_CAP, () => ({
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
    levelNeg: 0,
    levelPos: 0,
  }));
  const probe = {
    reconstruction: true as const,
    cliffSegments: 0,
    broadPhaseCellWorldUnits: BROAD_PHASE_CELL_WORLD_UNITS,
    broadPhaseCellsX: 0,
    broadPhaseCellsY: 0,
    colliders: rows.list,
    noData: undefined as string | undefined,
  };
  return {
    id: 'physics.statics',
    title: 'статика обрывов и broad-phase (реконструкция)',
    probe(): DebugStaticsProbe {
      const grid = gridOf();
      if (grid === null) {
        probe.noData = 'сетки террейна ещё нет: handshake оболочки не пришёл (SHELL-5)';
        return probe;
      }
      probe.noData = undefined;
      const tile = grid.tileSize / FIXED_ONE;
      rows.begin();
      for (const edge of grid.cliffs) {
        const row = rows.next();
        if (row === null) continue;
        // Приём сетки — точка входной границы рендера (REND-1): Q16.16 остаётся
        // за ней, дальше только мировые единицы.
        row.minX = Math.min(edge.from.x, edge.to.x) / FIXED_ONE;
        row.minY = Math.min(edge.from.y, edge.to.y) / FIXED_ONE;
        row.maxX = Math.max(edge.from.x, edge.to.x) / FIXED_ONE;
        row.maxY = Math.max(edge.from.y, edge.to.y) / FIXED_ONE;
        row.levelNeg = edge.levelNeg;
        row.levelPos = edge.levelPos;
      }
      rows.end();
      probe.cliffSegments = grid.cliffs.length;
      probe.broadPhaseCellsX = Math.ceil((grid.width * tile) / BROAD_PHASE_CELL_WORLD_UNITS);
      probe.broadPhaseCellsY = Math.ceil((grid.height * tile) / BROAD_PHASE_CELL_WORLD_UNITS);
      return probe;
    },
    draw(value: DebugStaticsProbe, out: DebugDraw): void {
      for (const row of value.colliders.items) {
        // Отрезок обрыва по поверхности: ломаной, чтобы было видно и вырожденную
        // по одной оси границу.
        out.polyline([row.minX, row.minY, 0, row.maxX, row.maxY, 0], COLORS.staticCollider);
      }
      const cell = value.broadPhaseCellWorldUnits;
      for (let i = 0; i <= value.broadPhaseCellsX; i += 1) {
        const x = i * cell;
        out.polyline([x, 0, 0, x, value.broadPhaseCellsY * cell, 0], COLORS.broadPhase);
      }
      for (let j = 0; j <= value.broadPhaseCellsY; j += 1) {
        const y = j * cell;
        out.polyline([0, y, 0, value.broadPhaseCellsX * cell, y, 0], COLORS.broadPhase);
      }
    },
  };
}

// ------------------------------------- 4.2 динамические коллайдеры по статам

interface DynamicRow {
  entity: EntityId;
  x: number;
  y: number;
  radiusWorldUnits: number;
}

export interface DebugDynamicProbe extends DebugProbe {
  readonly statName: string;
  readonly withRadius: number;
  readonly withoutRadius: number;
  readonly colliders: DebugList<DynamicRow>;
}

/**
 * Круги динамических коллайдеров ПО ОБЪЯВЛЕННОМУ СТАТУ (HUD-8, RDBG-6).
 *
 * Радиус коллайдера — число компонента сущности, и возить такие числа умеет
 * ровно один механизм: объявленные статы доставки. Сборка, желающая видеть круги
 * коллизий, объявляет стат — и всё. Не объявила — источник говорит «нет данных»
 * и MUST NOT рисовать выдуманный радиус: круг «примерно такой» хуже отсутствия
 * круга, потому что по нему станут делать выводы.
 */
export function dynamicCollidersDebugSource(statName: string): DebugSource<DebugDynamicProbe> {
  const rows = new DebugRows<DynamicRow>(DYNAMIC_CAP, () => ({
    entity: 0,
    x: 0,
    y: 0,
    radiusWorldUnits: 0,
  }));
  const probe = {
    statName,
    withRadius: 0,
    withoutRadius: 0,
    colliders: rows.list,
    noData: undefined as string | undefined,
  };
  return {
    id: 'physics.dynamics',
    title: 'круги динамических коллайдеров (по объявленному стату)',
    probe(state: DebugFrameState): DebugDynamicProbe {
      const view = state.view;
      if (view === null) {
        probe.noData = 'доставок ещё не было';
        return probe;
      }
      if (!view.statNames.includes(statName)) {
        // Стат сборкой не объявлен — рисовать нечего и выдумывать нечего.
        probe.noData = `стат "${statName}" сборкой не объявлен (HUD-8): радиуса коллайдера у клиента нет`;
        return probe;
      }
      probe.noData = undefined;
      let withRadius = 0;
      let withoutRadius = 0;
      rows.begin();
      for (const entity of view.entities.values()) {
        const radius = entity.stats?.get(statName);
        if (radius === undefined) {
          withoutRadius += 1;
          continue;
        }
        withRadius += 1;
        const row = rows.next();
        if (row === null) continue;
        row.entity = entity.id;
        // Позиция кадра — та же интерполяция, по которой нарисован инстанс.
        row.x = entity.prevX + (entity.currX - entity.prevX) * state.alpha;
        row.y = entity.prevY + (entity.currY - entity.prevY) * state.alpha;
        row.radiusWorldUnits = radius;
      }
      rows.end();
      probe.withRadius = withRadius;
      probe.withoutRadius = withoutRadius;
      return probe;
    },
    draw(value: DebugDynamicProbe, out: DebugDraw): void {
      for (const row of value.colliders.items) {
        out.circle(row.x, row.y, row.radiusWorldUnits, COLORS.dynamicCollider);
      }
    },
  };
}

// ------------------------------------------- 4.3 инспектор сущности курсором

export interface DebugInspectorProbe extends DebugProbe {
  readonly hit: string;
  readonly entity: number;
  readonly decoration: boolean;
  readonly kind: string | null;
  readonly worldX: number;
  readonly worldY: number;
  readonly worldZ: number;
  readonly cell: number;
  readonly cellX: number;
  readonly cellY: number;
  readonly noFloor: boolean;
  /** Позиции двух доставленных тиков и интерполированная (REND-2). */
  readonly prevTickX: number;
  readonly prevTickY: number;
  readonly currTickX: number;
  readonly currTickY: number;
  readonly frameX: number;
  readonly frameY: number;
  readonly level: number;
  /** Битовая маска состояний сущности (CAM-6): состав задаёт сборка. */
  readonly stateBits: number;
  readonly motionPhase: number | null;
  readonly flightPhase: number | null;
  readonly stats: Readonly<Record<string, number>>;
}

/** Что инспектору нужно от страницы: курсор, прямоугольник вьюпорта и поза. */
export interface InspectorAccess {
  picking(): ViewportPicking | null;
  pose(): CameraPose | null;
  /** Точка вьюпорта под курсором; null — курсор ещё не двигался. */
  point(): { x: number; y: number; width: number; height: number } | null;
}

/**
 * Инспектор сущности под курсором: разрешает курсор ТЕМ ЖЕ picking'ом по
 * видимому изображению (REND-15), которым его разрешает вьюпорт редактора.
 * Второй реализации пересечения не заводится — две разошлись бы между собой
 * ровно так же, как разошёлся бы с кадром луч по «почти той же» позе.
 *
 * В кадре инспектор рисует рамку примитивами; имена, статы и биты состояний
 * печатает DOM-панель приложения из дампа — текста в кадре нет (RDBG-3,
 * REND-19). Показывает он только доставленное (RDBG-6): состава компонентов у
 * клиента нет, и придумывать его инспектор не станет.
 */
export function inspectorDebugSource(access: InspectorAccess): DebugSource<DebugInspectorProbe> {
  const stats: Record<string, number> = {};
  const probe = {
    hit: 'none',
    entity: 0,
    decoration: false,
    kind: null as string | null,
    worldX: 0,
    worldY: 0,
    worldZ: 0,
    cell: -1,
    cellX: -1,
    cellY: -1,
    noFloor: false,
    prevTickX: 0,
    prevTickY: 0,
    currTickX: 0,
    currTickY: 0,
    frameX: 0,
    frameY: 0,
    level: 0,
    stateBits: 0,
    motionPhase: null as number | null,
    flightPhase: null as number | null,
    stats,
    noData: undefined as string | undefined,
  };
  const reset = (): void => {
    probe.entity = 0;
    probe.decoration = false;
    probe.kind = null;
    probe.prevTickX = probe.prevTickY = probe.currTickX = probe.currTickY = 0;
    probe.frameX = probe.frameY = 0;
    probe.level = 0;
    probe.stateBits = 0;
    probe.motionPhase = null;
    probe.flightPhase = null;
    for (const key of Object.keys(stats)) delete stats[key];
  };

  return {
    id: 'game.inspector',
    title: 'инспектор сущности под курсором',
    probe(state: DebugFrameState): DebugInspectorProbe {
      const picking = access.picking();
      const pose = access.pose();
      const point = access.point();
      if (picking === null || pose === null || point === null) {
        probe.noData = 'курсор ещё не двигался либо сцена не собрана';
        return probe;
      }
      probe.noData = undefined;
      const hit: PickHit | null = picking.pick(pose, point);
      reset();
      if (hit === null) {
        probe.hit = 'none';
        probe.worldX = probe.worldY = probe.worldZ = 0;
        probe.cell = probe.cellX = probe.cellY = -1;
        probe.noFloor = false;
        return probe;
      }
      probe.hit = hit.kind;
      probe.worldX = hit.x;
      probe.worldY = hit.y;
      probe.worldZ = hit.z;
      probe.cell = hit.cell;
      probe.cellX = hit.cellX;
      probe.cellY = hit.cellY;
      probe.noFloor = hit.noFloor;
      probe.decoration = hit.decoration;
      probe.entity = hit.entity;
      const entity = hit.entity === 0 ? undefined : state.view?.entities.get(hit.entity);
      if (entity === undefined) return probe;
      probe.kind = entity.kind;
      probe.prevTickX = entity.prevX;
      probe.prevTickY = entity.prevY;
      probe.currTickX = entity.currX;
      probe.currTickY = entity.currY;
      probe.frameX = entity.prevX + (entity.currX - entity.prevX) * state.alpha;
      probe.frameY = entity.prevY + (entity.currY - entity.prevY) * state.alpha;
      probe.level = entity.currLevel;
      probe.stateBits = entity.states;
      probe.motionPhase = Number.isNaN(entity.currMotionPhase) ? null : entity.currMotionPhase;
      probe.flightPhase = Number.isNaN(entity.flightPhase) ? null : entity.flightPhase;
      for (const [name, value] of entity.stats ?? []) stats[name] = value;
      return probe;
    },
    draw(value: DebugInspectorProbe, out: DebugDraw): void {
      if (value.hit === 'none') return;
      // Точка попадания и небольшая рамка вокруг неё: текста в кадре нет.
      out.point(value.worldX, value.worldY, value.worldZ, COLORS.inspector);
      if (value.entity === 0) {
        out.circle(value.worldX, value.worldY, 0.4, COLORS.inspector);
        return;
      }
      out.circle(value.frameX, value.frameY, 0.6, COLORS.inspector);
      out.segment(
        value.frameX,
        value.frameY,
        value.worldZ,
        value.worldX,
        value.worldY,
        value.worldZ + 1.5,
        COLORS.inspector,
      );
    },
  };
}

// ------------------------------------------------------- 4.4 камера и зоны

export interface DebugCameraProbe extends DebugProbe {
  readonly mode: string;
  readonly posX: number;
  readonly posY: number;
  readonly posZ: number;
  readonly yawRadians: number;
  readonly pitchRadians: number;
  readonly rollRadians: number;
  readonly fovDegrees: number;
  readonly focusX: number;
  readonly focusY: number;
  readonly groundZ: number;
  /** Границы кадрирования камеры (CAM-8), мировые единицы. */
  readonly boundsMinX: number;
  readonly boundsMinY: number;
  readonly boundsMaxX: number;
  readonly boundsMaxY: number;
  /** Ширина краевой полосы панорамирования (CAM-3), пиксели. */
  readonly edgeMarginPixels: number;
  /** Размер вьюпорта, пиксели — по нему считается доля краевой полосы. */
  readonly viewportWidthPixels: number;
  readonly viewportHeightPixels: number;
}

/** Что источнику камеры нужно от страницы. */
export interface CameraDebugAccess {
  rig(): CameraRig | null;
  /** Поза, которой нарисован кадр (CAM-1): она же уехала в THREE-камеру. */
  pose(): CameraPose | null;
  /** Границы кадрирования, инжектированные камере (CAM-7, CAM-8). */
  bounds(): CameraBounds | null;
  viewport(): { width: number; height: number } | null;
}

/** Дальность пирамиды видимости наложения, мировые единицы: весь конус не нужен. */
const FRUSTUM_REACH = 24;

/** Орт-базис камеры по её позе: тот же, каким кадр посажен на THREE-камеру. */
interface CameraBasis {
  fx: number;
  fy: number;
  fz: number;
  rx: number;
  ry: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
  tanH: number;
  tanV: number;
}

function basisOf(value: DebugCameraProbe): CameraBasis {
  const aspect =
    value.viewportHeightPixels > 0 ? value.viewportWidthPixels / value.viewportHeightPixels : 1;
  const tanV = Math.tan(((value.fovDegrees / 2) * Math.PI) / 180);
  const cos = Math.cos(value.pitchRadians);
  const fx = Math.cos(value.yawRadians) * cos;
  const fy = Math.sin(value.yawRadians) * cos;
  const fz = -Math.sin(value.pitchRadians);
  // Экранный «вправо» — forward × worldUp: мировой верх сцены (0,0,1).
  const rx = Math.sin(value.yawRadians);
  const ry = -Math.cos(value.yawRadians);
  // Экранный «вверх» — right × forward: тройка правая, как у THREE-камеры.
  return {
    fx,
    fy,
    fz,
    rx,
    ry,
    rz: 0,
    ux: ry * fz,
    uy: -rx * fz,
    uz: rx * fy - ry * fx,
    tanH: tanV * aspect,
    tanV,
  };
}

/** Точка плоскости земли под лучом через нормализованную точку кадра; null — мимо. */
function groundAt(
  value: DebugCameraProbe,
  basis: CameraBasis,
  ndcX: number,
  ndcY: number,
): [number, number] | null {
  const dx = basis.fx + basis.rx * basis.tanH * ndcX + basis.ux * basis.tanV * ndcY;
  const dy = basis.fy + basis.ry * basis.tanH * ndcX + basis.uy * basis.tanV * ndcY;
  const dz = basis.fz + basis.rz * basis.tanH * ndcX + basis.uz * basis.tanV * ndcY;
  if (dz >= -1e-6) return null; // луч уходит в небо: пересечения с землёй нет
  const t = (value.groundZ - value.posZ) / dz;
  if (t <= 0) return null;
  return [value.posX + dx * t, value.posY + dy * t];
}

/**
 * Пирамида видимости камеры и зоны краевого панорамирования (CAM-1, CAM-3).
 *
 * Пирамида рисуется от позы камеры её же углами — той самой позой, которой
 * нарисован кадр (CAM-1): второго конвейера позы нет. Краевые зоны — полосы у
 * границ вьюпорта, спроецированные на плоскость земли: по ним видно, ГДЕ курсор
 * начинает двигать камеру, а это ровно тот вопрос, на который иначе отвечают
 * наощупь.
 */
export function cameraDebugSource(access: CameraDebugAccess): DebugSource<DebugCameraProbe> {
  const probe = {
    mode: 'none',
    posX: 0,
    posY: 0,
    posZ: 0,
    yawRadians: 0,
    pitchRadians: 0,
    rollRadians: 0,
    fovDegrees: 0,
    focusX: 0,
    focusY: 0,
    groundZ: 0,
    boundsMinX: 0,
    boundsMinY: 0,
    boundsMaxX: 0,
    boundsMaxY: 0,
    edgeMarginPixels: 0,
    viewportWidthPixels: 0,
    viewportHeightPixels: 0,
    noData: undefined as string | undefined,
  };
  return {
    id: 'camera.pose',
    title: 'пирамида камеры и зоны краевого панорамирования',
    probe(): DebugCameraProbe {
      const rig = access.rig();
      const viewport = access.viewport();
      const pose = access.pose();
      if (rig === null || viewport === null || pose === null) {
        probe.noData = 'камера ещё не собрана: сцена не готова (CAM-1)';
        return probe;
      }
      probe.noData = undefined;
      const bounds = access.bounds();
      probe.mode = rig.mode;
      probe.posX = pose.posX;
      probe.posY = pose.posY;
      probe.posZ = pose.posZ;
      probe.yawRadians = pose.yaw;
      probe.pitchRadians = pose.pitch;
      probe.rollRadians = pose.roll;
      probe.fovDegrees = pose.fovDeg;
      probe.focusX = rig.focusX;
      probe.focusY = rig.focusY;
      probe.groundZ = rig.groundZ;
      probe.boundsMinX = bounds?.minX ?? 0;
      probe.boundsMinY = bounds?.minY ?? 0;
      probe.boundsMaxX = bounds?.maxX ?? 0;
      probe.boundsMaxY = bounds?.maxY ?? 0;
      probe.edgeMarginPixels = rig.config.edgeMarginPx;
      probe.viewportWidthPixels = viewport.width;
      probe.viewportHeightPixels = viewport.height;
      return probe;
    },
    draw(value: DebugCameraProbe, out: DebugDraw): void {
      const basis = basisOf(value);
      // Пирамида: четыре луча от глаза камеры по углам кадра.
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const dx = basis.fx + basis.rx * basis.tanH * sx + basis.ux * basis.tanV * sy;
          const dy = basis.fy + basis.ry * basis.tanH * sx + basis.uy * basis.tanV * sy;
          const dz = basis.fz + basis.rz * basis.tanH * sx + basis.uz * basis.tanV * sy;
          out.segment(
            value.posX,
            value.posY,
            value.posZ,
            value.posX + dx * FRUSTUM_REACH,
            value.posY + dy * FRUSTUM_REACH,
            value.posZ + dz * FRUSTUM_REACH,
            COLORS.frustum,
          );
        }
      }
      // Границы кадрирования (CAM-8) — прямоугольник по земле.
      out.polyline(
        [
          value.boundsMinX, value.boundsMinY, value.groundZ,
          value.boundsMaxX, value.boundsMinY, value.groundZ,
          value.boundsMaxX, value.boundsMaxY, value.groundZ,
          value.boundsMinX, value.boundsMaxY, value.groundZ,
        ],
        COLORS.frustum,
        true,
      );
      // Зоны краевого панорамирования (CAM-3) — две рамки на земле: внешняя по
      // кромке кадра, внутренняя отступом краевой полосы. Между ними курсор и
      // двигает камеру; наощупь эта граница иначе не находится.
      const marginX =
        value.viewportWidthPixels > 0 ? (2 * value.edgeMarginPixels) / value.viewportWidthPixels : 0;
      const marginY =
        value.viewportHeightPixels > 0
          ? (2 * value.edgeMarginPixels) / value.viewportHeightPixels
          : 0;
      const insets: readonly (readonly [number, number])[] = [
        [0, 0],
        [marginX, marginY],
      ];
      for (const [insetX, insetY] of insets) {
        const corners: number[] = [];
        const ndc: readonly (readonly [number, number])[] = [
          [-1 + insetX, -1 + insetY],
          [1 - insetX, -1 + insetY],
          [1 - insetX, 1 - insetY],
          [-1 + insetX, 1 - insetY],
        ];
        for (const [ndcX, ndcY] of ndc) {
          const point = groundAt(value, basis, ndcX, ndcY);
          if (point === null) return; // луч ушёл выше горизонта — рамки нет
          corners.push(point[0], point[1], value.groundZ);
        }
        out.polyline(corners, COLORS.edgePan, true);
      }
    },
  };
}

/** Цвета наружу — панель печатает легенду теми же (политика демо). */
export const DEBUG_COLORS: Readonly<Record<string, DebugColor>> = COLORS;
