/**
 * VisualSurfaceSource — владелец визуальной поверхности террейна для обеих
 * подсистем (REND-8: подсистемы друг о друге не знают, общий хелпер получают
 * извне). До готовности карты кривизны (ASSET-7) поверхность плоская —
 * ступени REND-7; по готовности подменяется и подписчики пересобирают
 * геометрию. Несовпадение сетки карты с сеткой террейна — предупреждение и
 * рендер без кривизны, не ошибка (ASSET-7).
 *
 * У документного источника террейна (REND-14) оба входа поверхности мутабельны
 * — это те же два перечисленных входа REND-1, что и у подсистемы террейна:
 *
 * - `setGrid` принимает сетку, ПЕРЕСЧИТАННУЮ ЯДРОМ (`createTerrainGrid`,
 *   TERR-5): кисть уровней (ED-10) меняет карту уровней, а cliff-геометрию и
 *   прочие производные величины выводит ядро — рендер их только читает (ED-1).
 * - `setCurvature` принимает карту кривизны прямо из памяти: кисть ED-11 правит
 *   несохранённый документ, а ED-15 требует показать его текущее состояние —
 *   ждать записи ассета и его загрузки модулем ассетов тут нечего. Карта из
 *   памяти главнее асинхронно догруженного ассета: она и есть документ.
 *
 * Оба входа уведомляют подписчиков списком изменившихся клеток (`null` — вся
 * поверхность), чтобы подсистема террейна инвалидировала свои чанки точечно, а
 * не пересобирала арену на каждый мазок.
 */
import type { TerrainGrid } from '@game-mvp/core';
import type { AssetState, TerrainCurvatureMap } from '@game-mvp/assets';
import type { RenderContext } from './types.js';
import { createVisualSurface, type MutableVisualSurface } from './visualSurface.js';

export interface VisualSurfaceSourceOptions {
  /** Asset id карты кривизны (манифест `terrain.curvatureMap`); нет — плоские ступени. */
  readonly curvatureMapId?: string;
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

/**
 * Подписка на изменение поверхности: клетки, чьи данные изменились, либо `null`
 * — изменилась вся поверхность (догрузился ассет, сменились размеры арены).
 */
export type SurfaceChangeListener = (cells: readonly number[] | null) => void;

export class VisualSurfaceSource {
  private grid: TerrainGrid;
  private curvature: TerrainCurvatureMap | null = null;
  private readonly curvatureMapId: string | undefined;
  private readonly warn: (message: string) => void;
  private readonly listeners: SurfaceChangeListener[] = [];
  private surface: MutableVisualSurface | null = null;
  private heightStep = 1;
  private requested = false;
  private failedReason: string | null = null;
  /** Карта задана из памяти (ED-11): догруженный ассет её не перебивает. */
  private overridden = false;

  constructor(grid: TerrainGrid, options: VisualSurfaceSourceOptions = {}) {
    this.grid = grid;
    this.curvatureMapId = options.curvatureMapId;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** Поверхность; null — ни одна подсистема ещё не вызвала init. */
  get current(): MutableVisualSurface | null {
    return this.surface;
  }

  /** Сетка, на которой стоит поверхность сейчас. */
  get terrain(): TerrainGrid {
    return this.grid;
  }

  /** Подписка на изменение поверхности (догрузка карты, правка документа). */
  onChange(listener: SurfaceChangeListener): void {
    this.listeners.push(listener);
  }

  /** Идемпотентна: зовут обе подсистемы из своих init, работа делается один раз. */
  init(ctx: RenderContext): void {
    this.heightStep = ctx.config.heightStep;
    if (this.surface === null) {
      this.surface = createVisualSurface(this.grid, this.heightStep, this.curvature);
    }
    // Карта из памяти уже есть — ассет ей не нужен и запрашивать его нечего.
    if (this.requested || this.curvatureMapId === undefined || this.overridden) return;
    this.requested = true;

    const id = this.curvatureMapId;
    const handle = ctx.assets.request<TerrainCurvatureMap>('terrain-curvature', id);
    const onState = (state: AssetState<TerrainCurvatureMap>): void => {
      if (state.status === 'ready') {
        if (this.overridden || this.surface?.hasCurvature === true) return;
        const map = state.data;
        if (map.width !== this.grid.width || map.height !== this.grid.height) {
          // Несовпадение сетки: предупреждение и рендер без кривизны (ASSET-7).
          this.warn(
            `render: карта кривизны "${id}" ${map.width}×${map.height} не совпадает с сеткой террейна ` +
              `${this.grid.width}×${this.grid.height} — игнорируется (ASSET-7)`,
          );
          return;
        }
        this.curvature = map;
        this.refresh(null);
      } else if (state.status === 'failed' && this.failedReason !== state.reason) {
        this.failedReason = state.reason;
        this.warn(`render: карта кривизны "${id}" не загрузилась: ${state.reason} — плоские ступени (ASSET-7)`);
      }
    };
    onState(ctx.assets.state(handle));
    ctx.assets.subscribe(handle, onState);
  }

  /**
   * Сетка пересчитана ядром (TERR-5) — например кистью уровней (ED-10) — и
   * доставлена после инициализации (REND-14); приём `tileSize` внутри
   * поверхности остаётся точкой входной границы рендера (REND-1).
   * `changed` — клетки, чьи уровень или флаг рампы изменились; не передан —
   * источник сверяет карты сам. Карта пола поверхности не видна: дыра не
   * меняет ни высот, ни нормалей.
   */
  setGrid(grid: TerrainGrid, changed?: readonly number[]): void {
    const previous = this.grid;
    this.grid = grid;
    if (grid.width !== previous.width || grid.height !== previous.height) {
      // Другая арена: раскладка углов другого размера — поверхность собирается
      // заново, а карта кривизны чужой сетки отбрасывается (ASSET-7).
      if (
        this.curvature !== null &&
        (this.curvature.width !== grid.width || this.curvature.height !== grid.height)
      ) {
        this.warn(
          `render: карта кривизны ${this.curvature.width}×${this.curvature.height} не совпадает с сеткой ` +
            `террейна ${grid.width}×${grid.height} — игнорируется (ASSET-7)`,
        );
        this.curvature = null;
      }
      if (this.surface !== null) {
        this.surface = createVisualSurface(grid, this.heightStep, this.curvature);
      }
      this.notify(null);
      return;
    }
    this.refresh(changed ?? diffShape(previous, grid));
  }

  /**
   * Карта кривизны из памяти (REND-14, ED-11, ED-15): несохранённый документ
   * кисти — перечисленный вход REND-1, а не обход модуля ассетов.
   * `null` — кривизны нет, поверхность возвращается к плоским ступеням REND-7.
   * Несовпадение сетки — предупреждение и игнор, как у ассета (ASSET-7).
   */
  setCurvature(map: TerrainCurvatureMap | null): void {
    this.overridden = true;
    if (map !== null && (map.width !== this.grid.width || map.height !== this.grid.height)) {
      this.warn(
        `render: карта кривизны из памяти ${map.width}×${map.height} не совпадает с сеткой террейна ` +
          `${this.grid.width}×${this.grid.height} — игнорируется (ASSET-7)`,
      );
      return;
    }
    const previous = this.curvature;
    this.curvature = map;
    this.refresh(diffOffsets(previous, map, this.grid.width * this.grid.height));
  }

  /**
   * Пересчитывает углы затронутых клеток и уведомляет подписчиков. До `init`
   * поверхности ещё нет — она соберётся уже с новыми данными.
   */
  private refresh(cells: readonly number[] | null): void {
    const surface = this.surface;
    if (surface === null) return;
    if (cells === null) {
      surface.update(this.grid, this.curvature, 0, 0, this.grid.width - 1, this.grid.height - 1);
      this.notify(null);
      return;
    }
    if (cells.length === 0) {
      // Пустой прямоугольник: подменить ссылку на сетку и ничего не считать.
      surface.update(this.grid, this.curvature, 0, 0, -1, -1);
      return;
    }
    const { width } = this.grid;
    let x0 = width;
    let y0 = this.grid.height;
    let x1 = -1;
    let y1 = -1;
    for (const cell of cells) {
      const x = cell % width;
      const y = Math.floor(cell / width);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    // Пересчёт идёт охватывающим прямоугольником: мазок кисти локален, а
    // разбросанный набор в пределе вырождается в пересчёт всей сетки — ровно то,
    // что делалось бы и без него.
    surface.update(this.grid, this.curvature, x0, y0, x1, y1);
    this.notify(cells);
  }

  private notify(cells: readonly number[] | null): void {
    for (const listener of this.listeners) listener(cells);
  }
}

/** Клетки, у которых изменились уровень или флаг рампы — вход поверхности. */
function diffShape(previous: TerrainGrid, next: TerrainGrid): number[] {
  const changed: number[] = [];
  const cells = next.width * next.height;
  for (let cell = 0; cell < cells; cell++) {
    if (previous.levels[cell] !== next.levels[cell] || previous.ramps[cell] !== next.ramps[cell]) {
      changed.push(cell);
    }
  }
  return changed;
}

/** Клетки, у которых изменилось смещение кривизны; отсутствующая карта — нули. */
function diffOffsets(
  previous: TerrainCurvatureMap | null,
  next: TerrainCurvatureMap | null,
  cells: number,
): number[] {
  const changed: number[] = [];
  for (let cell = 0; cell < cells; cell++) {
    const before = previous?.offsets[cell] ?? 0;
    const after = next?.offsets[cell] ?? 0;
    if (before !== after) changed.push(cell);
  }
  return changed;
}
