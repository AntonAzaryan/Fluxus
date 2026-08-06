/**
 * VisualSurfaceSource — владелец визуальной поверхности террейна для обеих
 * подсистем (REND-8: подсистемы друг о друге не знают, общий хелпер получают
 * извне). До готовности карты кривизны (ASSET-7) поверхность плоская —
 * ступени REND-7; по готовности подменяется и подписчики пересобирают
 * геометрию. Несовпадение сетки карты с сеткой террейна — предупреждение и
 * рендер без кривизны, не ошибка (ASSET-7).
 */
import type { TerrainGrid } from '@game-mvp/core';
import type { AssetState, TerrainCurvatureMap } from '@game-mvp/assets';
import type { RenderContext } from './types.js';
import { createVisualSurface, type VisualSurface } from './visualSurface.js';

export interface VisualSurfaceSourceOptions {
  /** Asset id карты кривизны (манифест `terrain.curvatureMap`); нет — плоские ступени. */
  readonly curvatureMapId?: string;
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

export class VisualSurfaceSource {
  private readonly grid: TerrainGrid;
  private readonly curvatureMapId: string | undefined;
  private readonly warn: (message: string) => void;
  private readonly listeners: (() => void)[] = [];
  private surface: VisualSurface | null = null;
  private requested = false;
  private failedReason: string | null = null;

  constructor(grid: TerrainGrid, options: VisualSurfaceSourceOptions = {}) {
    this.grid = grid;
    this.curvatureMapId = options.curvatureMapId;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** Поверхность; null — ни одна подсистема ещё не вызвала init. */
  get current(): VisualSurface | null {
    return this.surface;
  }

  /** Подписка на подмену поверхности (карта кривизны догрузилась). */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Идемпотентна: зовут обе подсистемы из своих init, работа делается один раз. */
  init(ctx: RenderContext): void {
    if (this.surface === null) {
      this.surface = createVisualSurface(this.grid, ctx.config.heightStep, null);
    }
    if (this.requested || this.curvatureMapId === undefined) return;
    this.requested = true;

    const id = this.curvatureMapId;
    const handle = ctx.assets.request<TerrainCurvatureMap>('terrain-curvature', id);
    const onState = (state: AssetState<TerrainCurvatureMap>): void => {
      if (state.status === 'ready') {
        if (this.surface?.hasCurvature === true) return;
        const map = state.data;
        if (map.width !== this.grid.width || map.height !== this.grid.height) {
          // Несовпадение сетки: предупреждение и рендер без кривизны (ASSET-7).
          this.warn(
            `render: карта кривизны "${id}" ${map.width}×${map.height} не совпадает с сеткой террейна ` +
              `${this.grid.width}×${this.grid.height} — игнорируется (ASSET-7)`,
          );
          return;
        }
        this.surface = createVisualSurface(this.grid, ctx.config.heightStep, map);
        for (const listener of this.listeners) listener();
      } else if (state.status === 'failed' && this.failedReason !== state.reason) {
        this.failedReason = state.reason;
        this.warn(`render: карта кривизны "${id}" не загрузилась: ${state.reason} — плоские ступени (ASSET-7)`);
      }
    };
    onState(ctx.assets.state(handle));
    ctx.assets.subscribe(handle, onState);
  }
}
