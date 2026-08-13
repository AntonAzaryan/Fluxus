/**
 * Общие стенды тестов HUD: доставленное состояние с умолчаниями, виджет-стенд,
 * фиксирующий свои обновления, и сборка исполнителя на фейковом DOM.
 */
import {
  HudActionsFacade,
  HudOverlayHost,
  HudRegistry,
  HudRuntime,
  el,
  type HudActionsPort,
  type HudCameraContract,
  type HudDeliveredState,
  type HudNode,
  type HudParams,
  type HudUpdate,
  type HudWidget,
  type HudWidgetKind,
} from '../../src/index.js';
import { asElement, fakeDom, type FakeDom } from './fakeDom.js';

export function makeView(partial: Partial<HudDeliveredState> = {}): HudDeliveredState {
  return {
    tick: 0,
    mode: 'Running',
    isReplay: false,
    snapAll: false,
    freshEvents: true,
    entities: new Map(),
    statNames: [],
    events: [],
    floorBits: null,
    floorChangedCells: [],
    ...partial,
  };
}

/** Виджет-стенд: копит обновления, помнит порт действий и факт dispose. */
export class CaptureWidget implements HudWidget {
  readonly updates: HudUpdate[] = [];
  port: HudActionsPort | null = null;
  disposed = false;

  constructor(readonly params: HudParams) {}

  mount(actions: HudActionsPort): HudNode {
    this.port = actions;
    return el('div', { classes: ['capture'] });
  }

  update(update: HudUpdate): void {
    this.updates.push(update);
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Вид виджета, складывающий созданные экземпляры в общий список теста. */
export function captureKind(name: string, created: CaptureWidget[]): HudWidgetKind {
  return {
    name,
    create: (params) => {
      const widget = new CaptureWidget(params);
      created.push(widget);
      return widget;
    },
  };
}

export class CameraSpy implements HudCameraContract {
  readonly panned: [number, number][] = [];
  focused = 0;

  panTo(x: number, y: number): void {
    this.panned.push([x, y]);
  }

  focusOnHero(): void {
    this.focused += 1;
  }
}

export interface RuntimeBench {
  readonly runtime: HudRuntime;
  readonly host: HudOverlayHost;
  readonly facade: HudActionsFacade;
  readonly camera: CameraSpy;
  readonly dom: FakeDom;
}

/** Полный стенд исполнителя: реестр вызывающего, фейковый DOM, фасад со шпионом камеры. */
export function makeRuntime(registry: HudRegistry): RuntimeBench {
  const dom = fakeDom();
  const host = new HudOverlayHost(asElement(dom.container));
  const camera = new CameraSpy();
  const facade = new HudActionsFacade({ actions: registry, camera });
  const runtime = new HudRuntime({ registry, host, actions: facade });
  return { runtime, host, facade, camera, dom };
}
