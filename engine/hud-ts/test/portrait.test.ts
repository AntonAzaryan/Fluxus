/**
 * Виджет живого портрета (задача 4.4, HUD-7): изолированный стенд одной
 * модели за швом `PortraitStage`, модель по kind доставленной сущности через
 * манифест визуалов, общий asset-сервис с рендером арены (ASSET-2), реакции
 * от доставленных событий (HUD-4, HUD-5).
 *
 * THREE-часть (`threeStage.ts`) здесь не исполняется — ей нужен настоящий
 * WebGL; тесты подставляют стенд-заглушку через шов `PortraitSetup.createStage`
 * и проверяют всю логику виджета: что́ заказано стенду, каким сервисом и как
 * виджет реагирует на доставленное.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AssetService,
  type EntityVisual,
  type NormalizedModel,
  type VisualManifest,
} from '@game-mvp/assets';
import {
  PORTRAIT_DEAD_CLASS,
  PORTRAIT_EMPTY_CLASS,
  PORTRAIT_HIT_CLASS,
  PORTRAIT_WIDGET_NAME,
  createPortraitKind,
  type PortraitSetup,
} from '../src/portrait/index.js';
import type { PortraitStage, PortraitStageOptions } from '../src/portrait/stage.js';
import { HudRegistry } from '../src/registry.js';
import type { HudComposition } from '../src/composition.js';
import type { HudDeliveredState, HudEntityView } from '../src/delivery.js';
import { makeRuntime, makeView } from './support/hud.js';
import type { FakeElement } from './support/fakeDom.js';

const HERO_ID = 1;
const HERO_MODEL = 'visuals/models/hero.mdx';
const CREEP_MODEL = 'visuals/models/creep.mdx';

/** Минимальная нормализованная модель — данных стенду хватает любых. */
const FAKE_MODEL: NormalizedModel = {
  bones: [],
  meshes: [],
  sequences: [],
  materials: [],
  textureSlots: [],
  height: 1,
};

const MANIFEST: VisualManifest = {
  entities: {
    Hero: { model: HERO_MODEL, animations: { states: { idle: 'Stand' } } },
    Creep: { model: CREEP_MODEL },
  },
};

/** Стенд-заглушка: фиксирует, что́ виджет ему заказал. Никакого THREE. */
class StubStage implements PortraitStage {
  readonly attached: unknown[] = [];
  readonly shown: { model: NormalizedModel; visual: EntityVisual }[] = [];
  cleared = 0;
  disposed = false;

  attach(canvas: HTMLCanvasElement): void {
    this.attached.push(canvas);
  }

  showModel(model: NormalizedModel, visual: EntityVisual): void {
    this.shown.push({ model, visual });
  }

  clearModel(): void {
    this.cleared += 1;
  }

  dispose(): void {
    this.disposed = true;
  }
}

/**
 * Настоящий `AssetService` над фейковым источником: кэш по ID и handle —
 * настоящие (ASSET-2), только формат-заглушка вместо парсера MDX.
 */
function makeAssets(): AssetService {
  const service = new AssetService({
    read: () => Promise.resolve(new ArrayBuffer(0)),
  });
  service.registerLoader({
    kind: 'model',
    extensions: ['.mdx'],
    load: () => FAKE_MODEL,
  });
  return service;
}

function heroView(partial: Partial<HudEntityView> = {}): HudEntityView {
  return {
    id: HERO_ID,
    kind: 'Hero',
    currX: 0,
    currY: 0,
    currLevel: 0,
    snap: false,
    spawned: false,
    moving: false,
    ...partial,
  };
}

function viewWithHero(
  hero: HudEntityView | null,
  partial: Partial<HudDeliveredState> = {},
): HudDeliveredState {
  return makeView({
    entities: hero === null ? new Map() : new Map([[hero.id, hero]]),
    ...partial,
  });
}

/** Ждём микрозадачи загрузки ассета: read → load → уведомление подписчиков. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const COMPOSITION: HudComposition = {
  entries: [
    {
      widget: PORTRAIT_WIDGET_NAME,
      zone: 'left',
      params: { damageEvents: ['FireballExploded'] },
      bindings: { hero: 'portraitHero' },
    },
  ],
};

interface Bench {
  readonly assets: AssetService;
  readonly stages: StubStage[];
  readonly stageOptions: PortraitStageOptions[];
  readonly runtime: ReturnType<typeof makeRuntime>['runtime'];
  readonly host: ReturnType<typeof makeRuntime>['host'];
}

function bench(setupOverride: Partial<PortraitSetup> = {}): Bench {
  const assets = makeAssets();
  const stages: StubStage[] = [];
  const stageOptions: PortraitStageOptions[] = [];
  const registry = new HudRegistry();
  registry.registerWidget(
    createPortraitKind({
      assets,
      visuals: MANIFEST,
      createStage: (options) => {
        stageOptions.push(options);
        const stage = new StubStage();
        stages.push(stage);
        return stage;
      },
      ...setupOverride,
    }),
  );
  registry.registerSelector('portraitHero', (state) => state.entities.get(HERO_ID));
  const { runtime, host } = makeRuntime(registry);
  return { assets, stages, stageOptions, runtime, host };
}

/** Контейнер портрета в зоне — по нему проверяются классы состояния. */
function portraitElement(host: Bench['host']): FakeElement {
  const zone = host.zone('left') as unknown as FakeElement;
  const element = zone.childElements[0];
  if (element === undefined) throw new Error('портрет не смонтирован в зоне');
  return element;
}

function classesOf(element: FakeElement): string[] {
  return (element.getAttribute('class') ?? '').split(' ').filter(Boolean);
}

describe('один кэш ассетов (HUD-7, ASSET-2)', () => {
  it('модель, уже загруженная ареной, приходит стенду тем же handle того же сервиса', async () => {
    const { assets, stages, stageOptions, runtime } = bench();
    // «Арена» уже запросила модель героя у общего сервиса.
    const arenaHandle = assets.request<NormalizedModel>('model', HERO_MODEL);
    await flush();

    const request = vi.spyOn(assets, 'request');
    runtime.apply(COMPOSITION);
    runtime.subsystem.syncTick(viewWithHero(heroView()));
    await flush();

    // Виджет сходил за моделью в ТОТ ЖЕ сервис и получил ТОТ ЖЕ handle —
    // повторной загрузки нет, кэш один (сценарий «Один кэш ассетов»).
    expect(request).toHaveBeenCalledWith('model', HERO_MODEL);
    expect(request.mock.results[0]!.value).toBe(arenaHandle);
    // Стенд собран на том же инстансе сервиса — своего виджет не заводил.
    expect(stageOptions[0]!.assets).toBe(assets);
    expect(stages[0]!.shown[0]!.model).toBe(FAKE_MODEL);
  });

  it('стенд не получает ничего, кроме asset-сервиса, — арене в него не попасть', () => {
    const { stageOptions, runtime } = bench();
    runtime.apply(COMPOSITION);
    // Вся запись создания стенда — один общий сервис: ни сцены арены, ни её
    // камеры в шве нет по построению (HUD-7).
    expect(Object.keys(stageOptions[0]!)).toEqual(['assets']);
  });
});

describe('модель по kind доставленной сущности (HUD-7)', () => {
  it('kind → запись манифеста → модель стенда; смена kind меняет модель', async () => {
    const { stages, runtime } = bench();
    runtime.apply(COMPOSITION);
    const stage = stages[0]!;

    runtime.subsystem.syncTick(viewWithHero(heroView()));
    await flush();
    expect(stage.shown).toHaveLength(1);
    expect(stage.shown[0]!.visual).toBe(MANIFEST.entities.Hero);

    // Смена визуального типа — стенду заказана другая модель.
    runtime.subsystem.syncTick(viewWithHero(heroView({ kind: 'Creep' })));
    await flush();
    expect(stage.shown).toHaveLength(2);
    expect(stage.shown[1]!.visual).toBe(MANIFEST.entities.Creep);
  });

  it('kind без записи в манифесте — стенд очищен и пуст, без ошибок', async () => {
    const { stages, runtime, host } = bench();
    runtime.apply(COMPOSITION);
    runtime.subsystem.syncTick(viewWithHero(heroView({ kind: 'Unknown' })));
    await flush();
    expect(stages[0]!.shown).toHaveLength(0);
    expect(classesOf(portraitElement(host))).toContain(PORTRAIT_EMPTY_CLASS);
  });

  it('до готовности модели портрет помечен пустым, по готовности — нет', async () => {
    const { runtime, host } = bench();
    runtime.apply(COMPOSITION);
    runtime.subsystem.syncTick(viewWithHero(heroView()));
    expect(classesOf(portraitElement(host))).toContain(PORTRAIT_EMPTY_CLASS);
    await flush();
    expect(classesOf(portraitElement(host))).not.toContain(PORTRAIT_EMPTY_CLASS);
  });
});

describe('реакции от доставленных событий (HUD-7, HUD-4, HUD-5)', () => {
  it('событие урона по сущности портрета — краткая реакция до следующей доставки', async () => {
    const { runtime, host } = bench();
    runtime.apply(COMPOSITION);
    runtime.subsystem.syncTick(viewWithHero(heroView()));
    await flush();

    runtime.subsystem.syncTick(
      viewWithHero(heroView(), {
        events: [{ type: 'FireballExploded', tick: 5, data: { entity: HERO_ID } }],
      }),
    );
    expect(classesOf(portraitElement(host))).toContain(PORTRAIT_HIT_CLASS);

    // Следующая доставка без события урона гасит реакцию.
    runtime.subsystem.syncTick(viewWithHero(heroView()));
    expect(classesOf(portraitElement(host))).not.toContain(PORTRAIT_HIT_CLASS);
  });

  it('событие урона по чужой сущности портрет не трогает', () => {
    const { runtime, host } = bench();
    runtime.apply(COMPOSITION);
    runtime.subsystem.syncTick(
      viewWithHero(heroView(), {
        events: [{ type: 'FireballExploded', tick: 5, data: { entity: 99 } }],
      }),
    );
    expect(classesOf(portraitElement(host))).not.toContain(PORTRAIT_HIT_CLASS);
  });

  it('событие смерти переводит в состояние dead; оно держится между доставками', () => {
    const { runtime, host } = bench();
    runtime.apply(COMPOSITION);
    runtime.subsystem.syncTick(
      viewWithHero(heroView(), {
        events: [{ type: 'EntityDied', tick: 7, data: { entity: HERO_ID } }],
      }),
    );
    expect(classesOf(portraitElement(host))).toContain(PORTRAIT_DEAD_CLASS);
    // Сущность ушла из доставленного состояния — dead держится: показывает
    // смерть событие, а не пустота кадра.
    runtime.subsystem.syncTick(viewWithHero(null));
    expect(classesOf(portraitElement(host))).toContain(PORTRAIT_DEAD_CLASS);
  });

  it('респавн сущности и разрыв непрерывности снимают dead (HUD-5)', () => {
    const { runtime, host } = bench();
    runtime.apply(COMPOSITION);
    runtime.subsystem.syncTick(
      viewWithHero(heroView(), {
        events: [{ type: 'EntityDied', tick: 7, data: { entity: HERO_ID } }],
      }),
    );
    expect(classesOf(portraitElement(host))).toContain(PORTRAIT_DEAD_CLASS);

    // Респавн: та же сущность рождается заново — прежняя смерть не про неё.
    runtime.subsystem.syncTick(viewWithHero(heroView({ spawned: true })));
    expect(classesOf(portraitElement(host))).not.toContain(PORTRAIT_DEAD_CLASS);

    // Разрыв (перемотка): накопленное снапается к доставленному состоянию.
    runtime.subsystem.syncTick(
      viewWithHero(heroView(), {
        events: [{ type: 'EntityDied', tick: 9, data: { entity: HERO_ID } }],
      }),
    );
    expect(classesOf(portraitElement(host))).toContain(PORTRAIT_DEAD_CLASS);
    runtime.subsystem.syncTick(viewWithHero(heroView(), { snapAll: true }));
    expect(classesOf(portraitElement(host))).not.toContain(PORTRAIT_DEAD_CLASS);
  });
});

describe('жизненный цикл (HUD-4)', () => {
  it('dispose останавливает стенд, поздняя готовность ассета его не будит', async () => {
    const { stages, runtime } = bench();
    runtime.apply(COMPOSITION);
    runtime.subsystem.syncTick(viewWithHero(heroView()));
    // Снимаем виджет ДО того, как модель догрузилась.
    runtime.clear();
    expect(stages[0]!.disposed).toBe(true);
    await flush();
    // Отписка сработала: готовый ассет стенду уже не заказывается.
    expect(stages[0]!.shown).toHaveLength(0);
  });

  it('canvas из разметки прикрепляется к стенду при материализации', () => {
    const { stages, runtime } = bench();
    runtime.apply(COMPOSITION);
    expect(stages[0]!.attached).toHaveLength(1);
    expect((stages[0]!.attached[0] as FakeElement).tag).toBe('canvas');
  });
});
