/**
 * Реестр walkable-инстансов единого поля высот (REND-9): decoration с флагом
 * `walkable` (PRES-2) добавляет в поле верхнюю поверхность меша своей модели.
 * Владелец реестра — `VisualSurfaceSource`; поверхность (`visualSurface.ts`)
 * читает его в своих `heightAt`/`normalAt`, и второй реализации поля не
 * появляется — реестр слагаемое поля, а не сервис поверх него.
 *
 * Трансформ walkable-поверхности — ТОТ ЖЕ, каким инстанс нарисован (REND-9):
 * позиция записи, посадка на террейн-форму, наклон по её нормали с k записи
 * (snap без временнóго сглаживания — у декораций его нет, REND-18), курс с
 * поправкой переда (REND-13), масштаб записи × масштаб инстанса. Посадка
 * считается по террейн-форме — без walkable-вкладов, в том числе чужих: иначе
 * два моста сажались бы друг на друга по кругу (REND-9). Высотную выборку и
 * рейкаст по мешу делает разделяемый индекс ассета (`assets` ASSET-11); реестр
 * лишь переводит вертикаль/луч в канонические оси инстанса обратной матрицей —
 * тем же приёмом, каким picking пересекает AABB-прокси (REND-15).
 *
 * Клетки вне bbox walkable-инстансов не платят ничего: реестр держит перечень
 * инстансов по клеткам (bbox → клетки), и `coversCell(cell) === false`
 * оставляет у поверхности ровно прежний путь. Аллокаций в путях выборки и
 * наведения нет — скретчи переиспользуются; аллокации при регистрации
 * (переподача документа, догрузка ассета) — события правки, не кадра.
 */
import * as THREE from 'three';
import {
  modelSurfaceIndex,
  type ModelSurfaceBounds,
  type ModelSurfaceHit,
  type ModelSurfaceIndex,
  type NormalizedModel,
} from '@fluxus/assets';
import { orientFromTiltYaw, tiltTarget, type TiltVector } from './model/surfaceAlign.js';
import type { SurfaceNormal } from './visualSurface.js';

/**
 * Размещение walkable-инстанса — ровно те входы, из которых подсистема моделей
 * ставит его узел в кадре (REND-9, REND-18). Величины уже разложены точкой
 * приёма записи: курс — с поправкой переда (REND-13), масштаб — итоговый
 * равномерный множитель меша (масштаб инстанса × масштаб записи / высота
 * модели, как у `createModelInstance`).
 */
export interface WalkablePlacement {
  /** Позиция записи в мировых единицах. */
  readonly x: number;
  readonly y: number;
  /** Мировой курс, радианы: курс записи плюс поправка переда модели (REND-13). */
  readonly yaw: number;
  /** Параметры наклона записи манифеста (ASSET-6, REND-10); factor 0 — без наклона. */
  readonly tiltFactor: number;
  readonly tiltMaxRad: number | null;
  /** Итоговый равномерный масштаб меша в мировых осях. */
  readonly scale: number;
  /** Готовая модель (ASSET-4): до `ready` инстанс в реестр не попадает (REND-9). */
  readonly model: NormalizedModel;
  /**
   * Скрытые части записи манифеста (ASSET-6): инстанс их не рисует, значит и
   * поверхность их не видит — поле обязано совпадать с картинкой (REND-9), а
   * наведение — с нарисованными частями (REND-15).
   */
  readonly hiddenParts?: readonly number[];
}

/**
 * Террейн-форма поля (база + кривизна, REND-9) — то, по чему сажается сам
 * walkable-инстанс. Реализация — та же поверхность `visualSurface.ts`:
 * walkable-вкладов эти аксессоры не видят по построению.
 */
export interface TerrainFormSampler {
  terrainFormHeightAt(wx: number, wy: number): number;
  terrainFormNormalAt(wx: number, wy: number, out: SurfaceNormal): SurfaceNormal;
}

/**
 * Что поверхность спрашивает у реестра на горячем пути выборки (REND-9).
 * Отдельный интерфейс, чтобы у `visualSurface.ts` не было причин звать
 * регистрацию: форма поля — функция данных, а не истории вызовов.
 */
export interface WalkableField {
  /** Сколько walkable-инстансов в реестре; 0 — поле в точности террейн-форма. */
  readonly size: number;
  /** Накрыта ли клетка bbox'ом хотя бы одного walkable-инстанса. */
  coversCell(cell: number): boolean;
  /**
   * Верхняя walkable-поверхность под точкой среди инстансов, чей bbox накрывает
   * клетку и точку: мировая высота либо -Infinity — точка не накрыта. При
   * попадании и переданном `normalOut` в него пишется нормаль треугольника
   * победителя в мировых осях (ASSET-11 → REND-9).
   */
  topInCell(cell: number, wx: number, wy: number, normalOut: SurfaceNormal | null): number;
}

/** Запись реестра; матрицы и границы пересчитываются посадкой (`seat`). */
interface WalkableEntry {
  placement: WalkablePlacement;
  index: ModelSurfaceIndex;
  /** Мировая матрица меша — трансформ картинки (REND-9) — и её обратная. */
  readonly matrix: THREE.Matrix4;
  readonly inverse: THREE.Matrix4;
  /** Мировой AABB меша — граница применимости вклада (REND-9). */
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** Диапазон накрытых клеток; cx1 < cx0 — вклада нет (нет геометрии или вне арены). */
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
}

const EMPTY_CELLS: readonly number[] = [];

// Переиспользуемые скретчи горячих путей (выборка поля, наведение) и посадки.
const SCRATCH_NORMAL: SurfaceNormal = { x: 0, y: 0, z: 1 };
const SCRATCH_TILT: TiltVector = { x: 0, y: 0 };
const SCRATCH_Q = new THREE.Quaternion();
const SCRATCH_POS = new THREE.Vector3();
const SCRATCH_SCALE = new THREE.Vector3();
const SCRATCH_A = new THREE.Vector3();
const SCRATCH_B = new THREE.Vector3();
const SCRATCH_HIT: ModelSurfaceHit = { t: 0, point: [0, 0, 0], normal: [0, 0, 0] };

export class WalkableSurfaceRegistry implements WalkableField {
  private readonly entries = new Map<number, WalkableEntry>();
  /** Клетка → накрывающие её инстансы; пустых списков карта не держит. */
  private readonly cells = new Map<number, WalkableEntry[]>();
  private width = 0;
  private height = 0;
  private tile = 1;

  get size(): number {
    return this.entries.size;
  }

  /** Раскладка арены; смена размера или шага требует полной пересадки (`reseatAll`). */
  configure(width: number, height: number, tile: number): void {
    if (width !== this.width || height !== this.height) {
      // Смена размера меняет формулу ключа клетки (cy * width + cx): привязки,
      // сделанные под старой шириной, новым ключом не снять — остались бы
      // фантомные `coversCell` и удалённые записи в списках. Карта клеток
      // сбрасывается целиком, диапазоны записей помечаются «не привязан», и
      // последующая пересадка (`reseatAll`) привязывает всё заново, а
      // `detachCells` по сброшенному диапазону — no-op (REND-9).
      this.cells.clear();
      for (const entry of this.entries.values()) {
        entry.cx0 = 0;
        entry.cy0 = 0;
        entry.cx1 = -1;
        entry.cy1 = -1;
      }
    }
    this.width = width;
    this.height = height;
    this.tile = tile;
  }

  /**
   * Декларативная регистрация: `placement` — walkable-инстанс есть и стоит так;
   * `null` — инстанса нет (флаг снят, запись ушла, модель выгружена). Возвращает
   * клетки под старым ∪ новым bbox — их владелец реестра отдаёт подписчикам
   * (REND-9: инвалидация не позже следующего кадра); пустой список — вклад не
   * изменился, и правка не-walkable полей записи поле не трогает.
   */
  set(key: number, placement: WalkablePlacement | null, form: TerrainFormSampler | null): readonly number[] {
    const existing = this.entries.get(key);
    if (placement === null) {
      if (existing === undefined) return EMPTY_CELLS;
      this.entries.delete(key);
      this.detachCells(existing);
      const changed = new Set<number>();
      this.collectCells(existing, changed);
      return [...changed];
    }
    if (existing !== undefined && samePlacement(existing.placement, placement)) return EMPTY_CELLS;

    const changed = new Set<number>();
    let entry: WalkableEntry;
    if (existing === undefined) {
      entry = {
        placement,
        index: modelSurfaceIndex(placement.model, placement.hiddenParts),
        matrix: new THREE.Matrix4(),
        inverse: new THREE.Matrix4(),
        minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0,
        cx0: 0, cy0: 0, cx1: -1, cy1: -1,
      };
      this.entries.set(key, entry);
    } else {
      this.collectCells(existing, changed);
      this.detachCells(existing);
      entry = existing;
      entry.placement = placement;
      // Индекс кэширован НА АССЕТЕ по набору частей (ASSET-11): правка
      // трансформа его не трогает.
      entry.index = modelSurfaceIndex(placement.model, placement.hiddenParts);
    }
    if (form !== null) this.seat(entry, form);
    this.attachCells(entry);
    this.collectCells(entry, changed);
    return [...changed];
  }

  /**
   * Пересадка инстансов, чья точка посадки попала в прямоугольник клеток, — на
   * обновлённую террейн-форму (правка уровней ED-10 или кривизны ED-11 двигает
   * настил вместе с землёй под ним). Возвращает клетки под старым ∪ новым bbox
   * пересаженных.
   */
  reseatRect(form: TerrainFormSampler, x0: number, y0: number, x1: number, y1: number): readonly number[] {
    if (this.entries.size === 0) return EMPTY_CELLS;
    const changed = new Set<number>();
    for (const entry of this.entries.values()) {
      const cx = clampIndex(Math.floor(entry.placement.x / this.tile), this.width);
      const cy = clampIndex(Math.floor(entry.placement.y / this.tile), this.height);
      if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
      this.collectCells(entry, changed);
      this.detachCells(entry);
      this.seat(entry, form);
      this.attachCells(entry);
      this.collectCells(entry, changed);
    }
    return [...changed];
  }

  /** Полная пересадка — новая поверхность или арена (уведомление берёт владелец). */
  reseatAll(form: TerrainFormSampler): void {
    for (const entry of this.entries.values()) {
      this.detachCells(entry);
      this.seat(entry, form);
      this.attachCells(entry);
    }
  }

  coversCell(cell: number): boolean {
    return this.cells.has(cell);
  }

  topInCell(cell: number, wx: number, wy: number, normalOut: SurfaceNormal | null): number {
    const list = this.cells.get(cell);
    if (list === undefined) return Number.NEGATIVE_INFINITY;
    let best = Number.NEGATIVE_INFINITY;
    for (const entry of list) {
      // Граница применимости — мировой bbox инстанса (REND-9): клетка может
      // быть накрыта, а конкретная точка — нет.
      if (wx < entry.minX || wx > entry.maxX || wy < entry.minY || wy > entry.maxY) continue;
      // Вертикаль сверху вниз из-за верха bbox переводится в канонические оси
      // обратной матрицей инстанса; направление — как вектор без нормировки,
      // поэтому `t` остаётся в мировой шкале (ASSET-11).
      const z0 = entry.maxZ + 1;
      SCRATCH_A.set(wx, wy, z0).applyMatrix4(entry.inverse);
      SCRATCH_B.set(wx, wy, z0 - 1).applyMatrix4(entry.inverse);
      const hit = entry.index.raycast(
        SCRATCH_A.x, SCRATCH_A.y, SCRATCH_A.z,
        SCRATCH_B.x - SCRATCH_A.x, SCRATCH_B.y - SCRATCH_A.y, SCRATCH_B.z - SCRATCH_A.z,
        SCRATCH_HIT,
      );
      if (hit === null) continue;
      const top = z0 - hit.t;
      // Правило верха — max (REND-9): при пересечении мешей побеждает верхний,
      // и порядок записей документа на высоту не влияет.
      if (top <= best) continue;
      best = top;
      if (normalOut !== null) {
        // Нормаль треугольника в мировых осях (REND-9): равномерный масштаб —
        // достаточно повернуть и нормировать; ASSET-11 уже ориентировал её
        // навстречу лучу, то есть вверх для вертикали сверху.
        SCRATCH_A.set(hit.normal[0], hit.normal[1], hit.normal[2]).transformDirection(entry.matrix);
        normalOut.x = SCRATCH_A.x;
        normalOut.y = SCRATCH_A.y;
        normalOut.z = SCRATCH_A.z;
      }
    }
    return best;
  }

  /**
   * Ближайшее пересечение мирового луча с walkable-мешами (REND-15): `t` в
   * мировой шкале либо -1 — луч не задел ничего. Обход — по инстансам, чей
   * мировой AABB луч может пересечь ближе текущего лучшего `t`; сами
   * треугольники считает ASSET-11, второй реализации пересечения нет.
   */
  raycastNearest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    if (this.entries.size === 0) return -1;
    let best = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      if (entry.cx1 < entry.cx0) continue; // вклада нет — нет и попадания
      if (!slabHit(entry, ox, oy, oz, dx, dy, dz, best)) continue;
      SCRATCH_A.set(ox, oy, oz).applyMatrix4(entry.inverse);
      SCRATCH_B.set(ox + dx, oy + dy, oz + dz).applyMatrix4(entry.inverse);
      const hit = entry.index.raycast(
        SCRATCH_A.x, SCRATCH_A.y, SCRATCH_A.z,
        SCRATCH_B.x - SCRATCH_A.x, SCRATCH_B.y - SCRATCH_A.y, SCRATCH_B.z - SCRATCH_A.z,
        SCRATCH_HIT,
      );
      if (hit !== null && hit.t < best) best = hit.t;
    }
    return Number.isFinite(best) ? best : -1;
  }

  // ------------------------------------------------------------- внутреннее

  /**
   * Посадка: тот же расчёт, каким подсистема моделей ставит узел инстанса, —
   * высота и нормаль террейн-формы, `tiltTarget` с k/limit записи snap'ом
   * (REND-18), общий `orientFromTiltYaw`, компоновка T·R·S. Расчёт один, поэтому
   * поверхность и картинка не могут разойтись (REND-9).
   */
  private seat(entry: WalkableEntry, form: TerrainFormSampler): void {
    const p = entry.placement;
    const z = form.terrainFormHeightAt(p.x, p.y);
    SCRATCH_TILT.x = 0;
    SCRATCH_TILT.y = 0;
    if (p.tiltFactor > 0) {
      form.terrainFormNormalAt(p.x, p.y, SCRATCH_NORMAL);
      tiltTarget(SCRATCH_NORMAL, p.tiltFactor, p.tiltMaxRad, SCRATCH_TILT);
    }
    orientFromTiltYaw(SCRATCH_TILT, p.yaw, SCRATCH_Q);
    SCRATCH_POS.set(p.x, p.y, z);
    SCRATCH_SCALE.setScalar(p.scale);
    entry.matrix.compose(SCRATCH_POS, SCRATCH_Q, SCRATCH_SCALE);
    entry.inverse.copy(entry.matrix).invert();

    const bounds = entry.index.bounds;
    if (bounds === null || p.scale === 0) {
      // Модель без треугольников (ASSET-11) или схлопнутый масштаб: рисовать
      // нечего — и вклада в поле нет.
      clearCells(entry);
      return;
    }
    worldAabb(entry, bounds);
    // bbox → клетки; инстанс целиком вне арены клеток не получает.
    const outside =
      entry.maxX < 0 ||
      entry.maxY < 0 ||
      entry.minX > this.width * this.tile ||
      entry.minY > this.height * this.tile;
    if (outside) {
      clearCells(entry);
      return;
    }
    entry.cx0 = clampIndex(Math.floor(entry.minX / this.tile), this.width);
    entry.cy0 = clampIndex(Math.floor(entry.minY / this.tile), this.height);
    entry.cx1 = clampIndex(Math.floor(entry.maxX / this.tile), this.width);
    entry.cy1 = clampIndex(Math.floor(entry.maxY / this.tile), this.height);
  }

  private attachCells(entry: WalkableEntry): void {
    for (let cy = entry.cy0; cy <= entry.cy1; cy++) {
      for (let cx = entry.cx0; cx <= entry.cx1; cx++) {
        const cell = cy * this.width + cx;
        const list = this.cells.get(cell);
        if (list === undefined) this.cells.set(cell, [entry]);
        else list.push(entry);
      }
    }
  }

  private detachCells(entry: WalkableEntry): void {
    for (let cy = entry.cy0; cy <= entry.cy1; cy++) {
      for (let cx = entry.cx0; cx <= entry.cx1; cx++) {
        const cell = cy * this.width + cx;
        const list = this.cells.get(cell);
        if (list === undefined) continue;
        const at = list.indexOf(entry);
        if (at >= 0) list.splice(at, 1);
        if (list.length === 0) this.cells.delete(cell);
      }
    }
  }

  private collectCells(entry: WalkableEntry, out: Set<number>): void {
    for (let cy = entry.cy0; cy <= entry.cy1; cy++) {
      for (let cx = entry.cx0; cx <= entry.cx1; cx++) out.add(cy * this.width + cx);
    }
  }
}

/** Пустой диапазон клеток: запись есть, вклада в поле нет. */
function clearCells(entry: WalkableEntry): void {
  entry.cx0 = 0;
  entry.cy0 = 0;
  entry.cx1 = -1;
  entry.cy1 = -1;
}

/** Мировой AABB записи — восемь углов канонических границ под её матрицей. */
function worldAabb(entry: WalkableEntry, bounds: ModelSurfaceBounds): void {
  entry.minX = Number.POSITIVE_INFINITY;
  entry.minY = Number.POSITIVE_INFINITY;
  entry.minZ = Number.POSITIVE_INFINITY;
  entry.maxX = Number.NEGATIVE_INFINITY;
  entry.maxY = Number.NEGATIVE_INFINITY;
  entry.maxZ = Number.NEGATIVE_INFINITY;
  for (let corner = 0; corner < 8; corner++) {
    SCRATCH_A.set(
      (corner & 1) === 0 ? bounds.min[0] : bounds.max[0],
      (corner & 2) === 0 ? bounds.min[1] : bounds.max[1],
      (corner & 4) === 0 ? bounds.min[2] : bounds.max[2],
    ).applyMatrix4(entry.matrix);
    growAabb(entry, SCRATCH_A);
  }
}

/** Расширение мирового AABB записи точкой. */
function growAabb(entry: WalkableEntry, point: THREE.Vector3): void {
  if (point.x < entry.minX) entry.minX = point.x;
  if (point.y < entry.minY) entry.minY = point.y;
  if (point.z < entry.minZ) entry.minZ = point.z;
  if (point.x > entry.maxX) entry.maxX = point.x;
  if (point.y > entry.maxY) entry.maxY = point.y;
  if (point.z > entry.maxZ) entry.maxZ = point.z;
}

/** Один и тот же вклад: те же место, курс, наклон, масштаб, ассет и набор частей. */
function samePlacement(a: WalkablePlacement, b: WalkablePlacement): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.yaw === b.yaw &&
    a.tiltFactor === b.tiltFactor &&
    a.tiltMaxRad === b.tiltMaxRad &&
    a.scale === b.scale &&
    a.model === b.model &&
    sameHiddenParts(a.hiddenParts, b.hiddenParts)
  );
}

/** Один и тот же набор скрытых частей (ASSET-6): порядок и отсутствие — не различия. */
function sameHiddenParts(a?: readonly number[], b?: readonly number[]): boolean {
  if (a === b) return true;
  const before = a ?? [];
  const after = b ?? [];
  return before.length === after.length && before.every((part) => after.includes(part));
}

/**
 * Скретч слэб-теста: `slabAxis` сужает им диапазон параметра луча по одной оси.
 * Модульный, а не создаваемый на луч, — наведение зовут по кадру на курсор.
 */
const SLAB_RANGE = { tMin: 0, tMax: 0 };

/** Пересечение луча с мировым AABB записи (слэбы); ближе `tBest` — иначе false. */
function slabHit(
  entry: WalkableEntry,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tBest: number,
): boolean {
  SLAB_RANGE.tMin = 0;
  SLAB_RANGE.tMax = tBest;
  return (
    slabAxis(ox, dx, entry.minX, entry.maxX) &&
    slabAxis(oy, dy, entry.minY, entry.maxY) &&
    slabAxis(oz, dz, entry.minZ, entry.maxZ) &&
    SLAB_RANGE.tMin <= SLAB_RANGE.tMax
  );
}

/**
 * Сужение `SLAB_RANGE` слэбом одной оси. `false` — луч параллелен слэбу и лежит
 * вне него: дальше считать нечего, остальные оси не смотрим.
 */
function slabAxis(origin: number, dir: number, lo: number, hi: number): boolean {
  if (dir === 0) return origin >= lo && origin <= hi;
  const inv = 1 / dir;
  let t1 = (lo - origin) * inv;
  let t2 = (hi - origin) * inv;
  if (t1 > t2) {
    const swap = t1;
    t1 = t2;
    t2 = swap;
  }
  if (t1 > SLAB_RANGE.tMin) SLAB_RANGE.tMin = t1;
  if (t2 < SLAB_RANGE.tMax) SLAB_RANGE.tMax = t2;
  return true;
}

function clampIndex(value: number, size: number): number {
  return Math.min(Math.max(value, 0), size - 1);
}
