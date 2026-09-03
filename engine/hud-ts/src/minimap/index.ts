// Миникарта (HUD-6): canvas-2D виджет на доставленных данных, представление
// маркеров — таблица данных с политикой неизвестного типа, специальные
// отрисовщики — именованный реестр за единым интерфейсом.

export {
  builtinMarkerRenderers,
  markerColor,
  markerTableFromParams,
  MinimapRendererRegistry,
  resolveMarkerTable,
} from './markers.js';
export type {
  MinimapColorSpec,
  MinimapContext2D,
  MinimapEntityView,
  MinimapMarkerDraw,
  MinimapMarkerRenderer,
  MinimapMarkerSpec,
  MinimapMarkerTable,
  MinimapUnknownKindPolicy,
  ResolvedMarker,
  ResolvedMarkerTable,
} from './markers.js';

export {
  MINIMAP_PAN_SLOT,
  MINIMAP_WIDGET_NAME,
  minimapEntitiesSelector,
  minimapFloorSelector,
  minimapWidgetKind,
} from './widget.js';
export type {
  MinimapFloorValue,
  MinimapFogLayer,
  MinimapFogSource,
  MinimapFootprint,
  MinimapTerrainGrid,
  MinimapTerrainLayers,
  MinimapTerrainSource,
  MinimapWidgetOptions,
} from './widget.js';
