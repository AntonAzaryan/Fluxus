/**
 * Размещение виджета по мировому якорю (HUD-10): элемент стоит над сущностью в
 * точке, которую ПУБЛИКУЕТ рендер (`rendering` REND-41), и идёт вместе с ней
 * каденсом кадра.
 *
 * Проекции здесь нет ни одной: экранный слой опубликованное читает, а не
 * считает (HUD-3) — источник якорей в тесте отдаёт готовые пиксели, ровно как
 * его отдаёт `ScreenAnchors` рендера.
 */
import { describe, expect, it } from 'vitest';
import {
  HUD_ANCHOR_ATTR,
  HUD_ZONE_ATTR,
  HudRegistry,
  anchorEntityOf,
  resolveComposition,
  type HudAnchorSource,
  type HudComposition,
  type HudEntityView,
  type HudScreenAnchor,
} from '../src/index.js';
import { walkElements, type FakeElement } from './support/fakeDom.js';
import { captureKind, makeRuntime, makeView, type CaptureWidget } from './support/hud.js';

const HERO = 7;

/** Источник якорей стенда: словарь «сущность → опубликованный якорь». */
class AnchorsStub implements HudAnchorSource {
  readonly published = new Map<number, HudScreenAnchor>();

  anchorOf(entity: number): HudScreenAnchor | null {
    return this.published.get(entity) ?? null;
  }

  put(entity: number, x: number, y: number, partial: Partial<HudScreenAnchor> = {}): void {
    this.published.set(entity, { x, y, onScreen: true, drawn: true, ...partial });
  }
}

/** Запись доставки — то, что отдаёт селектор сущности героя (HUD-4). */
function heroView(id = HERO): HudEntityView {
  return { id, kind: 'Hero', currX: 0, currY: 0, currLevel: 0, snap: false, spawned: false, moving: false };
}

function bench(): { created: CaptureWidget[]; registry: HudRegistry } {
  const created: CaptureWidget[] = [];
  const registry = new HudRegistry();
  registry.registerWidget(captureKind('hp', created));
  registry.registerSelector('hero.entity', () => heroView());
  registry.registerSelector('hero.missing', () => null);
  return { created, registry };
}

/** Композиция с якорной записью: та же запись, что и в зоне, плюс `anchor`. */
const anchored: HudComposition = {
  entries: [
    {
      widget: 'hp',
      zone: 'bottom-left',
      bindings: { entity: 'hero.entity' },
      anchor: { entity: 'entity', offsetY: -6 },
    },
  ],
};

/** Держатель якорного виджета в материализованном оверлее. */
function holderOf(container: FakeElement): FakeElement {
  const holders = [...walkElements(container)].filter(
    (element) => element.getAttribute(HUD_ANCHOR_ATTR) !== null,
  );
  expect(holders).toHaveLength(1);
  return holders[0]!;
}

function transformOf(holder: FakeElement): string {
  return holder.style.getPropertyValue('transform');
}

function displayOf(holder: FakeElement): string {
  return holder.style.getPropertyValue('display');
}

describe('размещение по мировому якорю (HUD-10)', () => {
  it('виджет встаёт над сущностью по опубликованному якорю со смещением записи', () => {
    const { registry } = bench();
    const anchors = new AnchorsStub();
    const { runtime, dom } = makeRuntime(registry, anchors);
    runtime.apply(anchored);

    anchors.put(HERO, 120, 80);
    runtime.subsystem.syncTick(makeView({ tick: 1 }));
    runtime.subsystem.updateFrame(1 / 60, 1, 1 / 60);

    const holder = holderOf(dom.container);
    // Смещение записи — `offsetY: -6`; центрирование над точкой — соглашение
    // самого размещения: якорь публикуется над макушкой инстанса (REND-41).
    expect(transformOf(holder)).toBe('translate(120px, 74px) translate(-50%, -100%)');
    expect(displayOf(holder)).toBe('block');
  });

  it('идёт вместе с камерой: кадр двигает элемент, доставки для этого не нужно', () => {
    const { registry } = bench();
    const anchors = new AnchorsStub();
    const { runtime, dom } = makeRuntime(registry, anchors);
    runtime.apply(anchored);
    runtime.subsystem.syncTick(makeView({ tick: 1 }));

    anchors.put(HERO, 100, 100);
    runtime.subsystem.updateFrame(1 / 60, 1, 1 / 60);
    const holder = holderOf(dom.container);
    expect(transformOf(holder)).toContain('translate(100px, 94px)');

    // Камера сдвинулась — новая доставка не приезжала, а элемент уехал.
    anchors.put(HERO, 40, 130);
    runtime.subsystem.updateFrame(1 / 60, 1, 1 / 60);
    expect(transformOf(holder)).toContain('translate(40px, 124px)');
  });

  it('пишет в DOM только изменившееся: неподвижный якорь стиль не трогает', () => {
    const { registry } = bench();
    const anchors = new AnchorsStub();
    const { runtime, dom } = makeRuntime(registry, anchors);
    runtime.apply(anchored);
    runtime.subsystem.syncTick(makeView({ tick: 1 }));
    anchors.put(HERO, 10, 20);
    runtime.subsystem.updateFrame(1 / 60, 1, 1 / 60);

    const holder = holderOf(dom.container);
    const writes = holder.styleWrites;
    for (let i = 0; i < 30; i++) runtime.subsystem.updateFrame(1 / 60, 1, 1 / 60);
    expect(holder.styleWrites).toBe(writes);
  });

  it('сущность ушла с экрана — виджет скрыт, а не висит в последней точке', () => {
    const { registry } = bench();
    const anchors = new AnchorsStub();
    const { runtime, dom } = makeRuntime(registry, anchors);
    runtime.apply(anchored);
    runtime.subsystem.syncTick(makeView({ tick: 1 }));
    anchors.put(HERO, 50, 50);
    runtime.subsystem.updateFrame(1 / 60, 1, 1 / 60);
    const holder = holderOf(dom.container);
    expect(displayOf(holder)).toBe('block');

    anchors.put(HERO, 900, 50, { onScreen: false });
    runtime.subsystem.updateFrame(1 / 60, 1, 1 / 60);
    expect(displayOf(holder)).toBe('none');
  });

  it('инстанс не нарисован (REND-21) — тот же скрытый виджет', () => {
    const { registry } = bench();
    const anchors = new AnchorsStub();
    const { runtime, dom } = makeRuntime(registry, anchors);
    runtime.apply(anchored);
    runtime.subsystem.syncTick(makeView({ tick: 1 }));
    anchors.put(HERO, 50, 50, { drawn: false });
    runtime.subsystem.updateFrame(1 / 60, 1, 1 / 60);
    expect(displayOf(holderOf(dom.container))).toBe('none');
  });

  it('якоря сущности нет вовсе — виджет скрыт с самого монтирования', () => {
    const { registry } = bench();
    const { runtime, dom } = makeRuntime(registry, new AnchorsStub());
    runtime.apply(anchored);
    runtime.subsystem.syncTick(makeView({ tick: 1 }));
    runtime.subsystem.updateFrame(1 / 60, 1, 1 / 60);
    expect(displayOf(holderOf(dom.container))).toBe('none');
  });

  it('источника якорей у сборки нет — композиция монтируется, виджет скрыт, отказа нет', () => {
    const { created, registry } = bench();
    const { runtime, dom } = makeRuntime(registry);
    expect(() => { runtime.apply(anchored); }).not.toThrow();
    runtime.subsystem.syncTick(makeView({ tick: 1 }));
    runtime.subsystem.updateFrame(1 / 60, 1, 1 / 60);
    expect(displayOf(holderOf(dom.container))).toBe('none');
    // Данные виджет получает по-прежнему доставкой (HUD-5): скрыт — не значит мёртв.
    expect(created[0]!.updates.length).toBeGreaterThan(0);
  });

  it('тот же вид виджета в зоне — без единой правки его кода (HUD-10)', () => {
    const { created, registry } = bench();
    const { runtime, dom } = makeRuntime(registry, new AnchorsStub());
    runtime.apply({
      entries: [{ widget: 'hp', zone: 'bottom-left', bindings: { entity: 'hero.entity' } }],
    });
    // Держателя якорного слоя нет: виджет лежит в контейнере своей зоны.
    const holders = [...walkElements(dom.container)].filter(
      (element) => element.getAttribute(HUD_ANCHOR_ATTR) !== null,
    );
    expect(holders).toHaveLength(0);
    const zone = [...walkElements(dom.container)].find(
      (element) => element.getAttribute(HUD_ZONE_ATTR) === 'bottom-left',
    )!;
    expect(zone.childElements).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  it('снятие композиции убирает держателя вместе с виджетом', () => {
    const { registry } = bench();
    const { runtime, dom } = makeRuntime(registry, new AnchorsStub());
    runtime.apply(anchored);
    expect(
      [...walkElements(dom.container)].filter(
        (element) => element.getAttribute(HUD_ANCHOR_ATTR) !== null,
      ),
    ).toHaveLength(1);
    runtime.clear();
    expect(
      [...walkElements(dom.container)].filter(
        (element) => element.getAttribute(HUD_ANCHOR_ATTR) !== null,
      ),
    ).toHaveLength(0);
  });
});

describe('резолв якорной записи (HUD-4, HUD-10)', () => {
  it('слот якоря обязан быть объявлен биндингом записи — иначе отказ до монтирования', () => {
    const { registry } = bench();
    expect(() =>
      resolveComposition(registry, {
        entries: [
          {
            widget: 'hp',
            zone: 'bottom-left',
            bindings: { entity: 'hero.entity' },
            anchor: { entity: 'unit' },
          },
        ],
      }),
    ).toThrow(/якор/);
  });

  it('запись без якоря резолвится как прежде: поле необязательно', () => {
    const { registry } = bench();
    const resolved = resolveComposition(registry, {
      entries: [{ widget: 'hp', zone: 'top', bindings: { entity: 'hero.entity' } }],
    });
    expect(resolved.entries[0]!.anchor).toBeUndefined();
  });
});

describe('сущность из значения биндинга (HUD-10)', () => {
  it('запись доставленного состояния и голый идентификатор — оба', () => {
    expect(anchorEntityOf(heroView())).toBe(HERO);
    expect(anchorEntityOf(HERO)).toBe(HERO);
  });

  it('пустое значение сущностью не является — виджет скрывается, а не падает', () => {
    expect(anchorEntityOf(null)).toBeNull();
    expect(anchorEntityOf(undefined)).toBeNull();
    expect(anchorEntityOf(0)).toBeNull();
    expect(anchorEntityOf('7')).toBeNull();
    expect(anchorEntityOf({ kind: 'Hero' })).toBeNull();
  });

  it('селектор без сущности — скрытый виджет (HUD-10)', () => {
    const { registry } = bench();
    const anchors = new AnchorsStub();
    anchors.put(HERO, 10, 10);
    const { runtime, dom } = makeRuntime(registry, anchors);
    runtime.apply({
      entries: [
        {
          widget: 'hp',
          zone: 'bottom-left',
          bindings: { entity: 'hero.missing' },
          anchor: { entity: 'entity' },
        },
      ],
    });
    runtime.subsystem.syncTick(makeView({ tick: 1 }));
    runtime.subsystem.updateFrame(1 / 60, 1, 1 / 60);
    expect(displayOf(holderOf(dom.container))).toBe('none');
  });
});
