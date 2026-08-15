/**
 * Виджеты на доставленных статах (HUD-8) и на величинах главного потока:
 * полоса здоровья, панель кулдаунов, счётчики смертей, рантайм-панель.
 *
 * Всё через настоящий путь «реестр → композиция → исполнитель» и на фейковом
 * DOM. Проверяется МОДЕЛЬ, а не пиксели: доля затемнения и число секунд, доля
 * заполнения полосы, строки счётчиков — то, что виджет вычислил из доставки.
 * Главный сценарий HUD-8 повторяется в каждом: стата нет — пустое состояние, а
 * не выдуманный ноль.
 */
import { describe, expect, it } from 'vitest';
import { HudRegistry, type HudComposition, type HudEntityView } from '../src/index.js';
import type { HudIconSource } from '../src/icons.js';
import {
  FrameRateMeter,
  HP_BAR_EMPTY_CLASS,
  cooldownModel,
  cooldownsKind,
  deathsKind,
  deathsRows,
  hpBarKind,
  runtimeKind,
} from '../src/widgets/index.js';
import { walkElements, type FakeElement } from './support/fakeDom.js';
import { makeRuntime, makeView } from './support/hud.js';

const icons: HudIconSource = { resolveIconUrl: (id) => `resolved://${id}` };

/** Сущность с произвольным набором статов — то, что доезжает до HUD (HUD-8). */
function entityWith(id: number, stats: Record<string, number>): HudEntityView {
  return {
    id,
    kind: 'Hero',
    currX: 0,
    currY: 0,
    currLevel: 0,
    snap: false,
    spawned: false,
    moving: false,
    stats: new Map(Object.entries(stats)),
  };
}

function findByClass(root: Element, className: string): FakeElement {
  for (const element of walkElements(root as unknown as FakeElement)) {
    if ((element.getAttribute('class') ?? '').split(' ').includes(className)) return element;
  }
  throw new Error(`элемент с классом "${className}" не найден`);
}

function bench(composition: HudComposition, hero: HudEntityView | null) {
  const registry = new HudRegistry();
  registry.registerWidget(hpBarKind);
  registry.registerWidget(cooldownsKind(icons));
  registry.registerWidget(deathsKind);
  registry.registerWidget(runtimeKind);
  registry.registerSelector('hero', (state) => [...state.entities.values()][0] ?? null);
  registry.registerSelector('entities', (state) => state.entities);
  registry.registerAction('hero.cast', { target: 'world', action: 'cast' });
  registry.registerAction('hero.dodge', { target: 'world', action: 'dodge' });

  const { runtime, host, facade } = makeRuntime(registry);
  const presses: string[] = [];
  facade.start((action) => presses.push(action));
  runtime.apply(composition);
  const deliver = (entities: readonly HudEntityView[], tick = 1): void => {
    runtime.subsystem.syncTick(
      makeView({ tick, entities: new Map(entities.map((e) => [e.id, e])) }),
    );
  };
  if (hero !== null) deliver([hero]);
  return { runtime, host, presses, deliver };
}

// ------------------------------------------------------------ полоса здоровья

const hpComposition: HudComposition = {
  entries: [
    {
      widget: 'hp-bar',
      zone: 'bottom-left',
      params: { stat: 'hp', maxStat: 'hpMax' },
      bindings: { entity: 'hero' },
    },
  ],
};

describe('полоса здоровья на доставленных статах (HUD-8)', () => {
  it('доля и текст — из статов; полный, половина и ноль различимы', () => {
    const { host, deliver } = bench(hpComposition, entityWith(1, { hp: 100, hpMax: 100 }));
    const bar = findByClass(host.zone('bottom-left'), 'hud-hp-bar');
    expect(bar.getAttribute('data-fraction')).toBe('1.000');

    deliver([entityWith(1, { hp: 50, hpMax: 100 })], 2);
    expect(bar.getAttribute('data-fraction')).toBe('0.500');
    expect(findByClass(host.zone('bottom-left'), 'hud-hp-bar__text').textContent).toBe('50 / 100');

    deliver([entityWith(1, { hp: 0, hpMax: 100 })], 3);
    expect(bar.getAttribute('data-fraction')).toBe('0.000');
    // Ноль здоровья — это данные: пустым состоянием он не становится.
    expect((bar.getAttribute('class') ?? '').includes(HP_BAR_EMPTY_CLASS)).toBe(false);
  });

  it('без статов — пустое состояние, а не ноль (сценарий «Стата нет»)', () => {
    const { host } = bench(hpComposition, entityWith(1, {}));
    const bar = findByClass(host.zone('bottom-left'), 'hud-hp-bar');
    expect((bar.getAttribute('class') ?? '').includes(HP_BAR_EMPTY_CLASS)).toBe(true);
    expect(bar.getAttribute('data-fraction')).toBe('');
    expect(findByClass(host.zone('bottom-left'), 'hud-hp-bar__text').textContent).toBe('—');
  });

  it('значение сверх максимума кламппится, отрицательное — не уводит полосу за край', () => {
    const { host, deliver } = bench(hpComposition, entityWith(1, { hp: 150, hpMax: 100 }));
    const bar = findByClass(host.zone('bottom-left'), 'hud-hp-bar');
    expect(bar.getAttribute('data-fraction')).toBe('1.000');
    deliver([entityWith(1, { hp: -20, hpMax: 100 })], 2);
    expect(bar.getAttribute('data-fraction')).toBe('0.000');
  });
});

// ------------------------------------------------------------------ кулдауны

/** Тик 50 мс — числа секунд получаются круглыми, как и в реальном handshake. */
const TICK_MS = 50;

const cooldownComposition: HudComposition = {
  entries: [
    {
      widget: 'cooldowns',
      zone: 'bottom',
      params: {
        perRow: 2,
        tickMs: TICK_MS,
        abilities: [
          { action: 'cast', icon: 'visuals/icons/cast.svg', stat: 'cast.cd', maxStat: 'cast.cdMax' },
          { action: 'dodge', icon: 'visuals/icons/dodge.svg', stat: 'dodge.cd', maxStat: 'dodge.cdMax' },
        ],
      },
      bindings: { entity: 'hero' },
      actions: { cast: 'hero.cast', dodge: 'hero.dodge' },
    },
  ],
};

describe('панель кулдаунов (HUD-8, сценарий «Кулдаун способности»)', () => {
  it('модель оверлея: доля от полной длительности и секунды из тиков × tickMs', () => {
    const hero = entityWith(1, { 'cast.cd': 20, 'cast.cdMax': 40 });
    const ability = { action: 'cast', icon: 'i', stat: 'cast.cd', maxStat: 'cast.cdMax' };
    expect(cooldownModel(hero, ability, TICK_MS)).toEqual({
      fraction: 0.5,
      seconds: 1, // 20 тиков × 50 мс = 1 с
      unknown: false,
    });
    // Готовая способность: оверлея нет, но данные есть.
    expect(cooldownModel(entityWith(1, { 'cast.cd': 0 }), ability, TICK_MS)).toEqual({
      fraction: 0,
      seconds: 0,
      unknown: false,
    });
    // Стата нет вовсе — «нет данных» (HUD-8), а не готовность.
    expect(cooldownModel(entityWith(1, {}), ability, TICK_MS).unknown).toBe(true);
  });

  it('оверлей и секунды доезжают до DOM по доставке', () => {
    const { host, deliver } = bench(
      cooldownComposition,
      entityWith(1, { 'cast.cd': 30, 'cast.cdMax': 60 }),
    );
    const buttons = [...walkElements(host.zone('bottom') as unknown as FakeElement)].filter(
      (element) => element.getAttribute('data-ability') !== null,
    );
    expect(buttons.map((b) => b.getAttribute('data-ability'))).toEqual(['cast', 'dodge']);
    expect(buttons[0]!.getAttribute('data-cooldown')).toBe('0.500');
    expect(findByClass(host.zone('bottom'), 'hud-cooldowns__seconds').textContent).toBe('2');
    // Способность без стата — пустое состояние: ни доли, ни секунд.
    expect(buttons[1]!.getAttribute('data-cooldown')).toBe('');

    deliver([entityWith(1, { 'cast.cd': 0, 'cast.cdMax': 60 })], 2);
    expect(buttons[0]!.getAttribute('data-cooldown')).toBe('0.000');
    expect(findByClass(host.zone('bottom'), 'hud-cooldowns__seconds').textContent).toBe('');
  });

  it('кнопка шлёт то же семантическое действие, что клавиша (HUD-2)', () => {
    const { host, presses } = bench(cooldownComposition, entityWith(1, {}));
    const buttons = [...walkElements(host.zone('bottom') as unknown as FakeElement)].filter(
      (element) => element.getAttribute('data-ability') !== null,
    );
    buttons[1]!.dispatch('click');
    expect(presses).toEqual(['dodge']);
  });

  it('иконки — asset ID через шов сборки; URL в композиции отвергается (HUD-4)', () => {
    const requested: string[] = [];
    const registry = new HudRegistry();
    registry.registerWidget(
      cooldownsKind({
        resolveIconUrl: (assetId) => {
          requested.push(assetId);
          return `resolved://root/${assetId}`;
        },
      }),
    );
    registry.registerSelector('hero', () => null);
    registry.registerAction('hero.cast', { target: 'world', action: 'cast' });
    registry.registerAction('hero.dodge', { target: 'world', action: 'dodge' });
    const { runtime, host } = makeRuntime(registry);
    runtime.apply(cooldownComposition);

    // К шву ушли ровно asset ID записей — по одному на кнопку.
    expect(requested).toEqual(['visuals/icons/cast.svg', 'visuals/icons/dodge.svg']);
    expect(findByClass(host.zone('bottom'), 'hud-cooldowns__icon').getAttribute('src')).toBe(
      'resolved://root/visuals/icons/cast.svg',
    );
    // Композиция — чистые asset ID: резолвленный URL в неё не просочился.
    expect(JSON.stringify(cooldownComposition)).not.toContain('://');

    // URL вместо asset ID валит `apply` до монтирования и называет запись.
    expect(() => {
      runtime.apply({
        entries: [
          {
            widget: 'cooldowns',
            zone: 'bottom',
            params: { abilities: [{ action: 'cast', icon: 'https://cdn.example/cast.png' }] },
            actions: { cast: 'hero.cast' },
          },
        ],
      });
    }).toThrow('выглядит как URL');
  });

  it('раскладка рядов — данные композиции, а не код виджета', () => {
    const { host } = bench(cooldownComposition, entityWith(1, {}));
    const panel = findByClass(host.zone('bottom'), 'hud-cooldowns');
    expect(panel.getAttribute('style')).toContain('repeat(2, auto)');
  });
});

// ------------------------------------------------------------------- смерти

const deathsComposition: HudComposition = {
  entries: [
    {
      widget: 'deaths',
      zone: 'top',
      params: { slotStat: 'slot', deathsStat: 'deaths' },
      bindings: { entities: 'entities' },
    },
  ],
};

describe('счётчики смертей по слотам (HUD-8)', () => {
  it('строки идут по слоту, а не по порядку обхода доставки', () => {
    const rows = deathsRows(
      new Map([
        [7, entityWith(7, { slot: 1, deaths: 3 })],
        [2, entityWith(2, { slot: 0, deaths: 1 })],
      ]),
      'slot',
      'deaths',
    );
    expect(rows).toEqual([
      { slot: 0, deaths: 1 },
      { slot: 1, deaths: 3 },
    ]);
  });

  it('сущность без слота счётчика не получает, без стата смертей — прочерк', () => {
    const { host } = bench(deathsComposition, entityWith(1, { slot: 0 }));
    const row = findByClass(host.zone('top'), 'hud-deaths__row');
    expect(row.getAttribute('data-slot')).toBe('0');
    expect(row.textContent).toBe('—');

    // Снаряд (не игрок) в счётчиках не участвует.
    expect(deathsRows(new Map([[3, entityWith(3, {})]]), 'slot', 'deaths')).toEqual([]);
  });

  it('доставленное число смертей показывается как есть', () => {
    const { host, deliver } = bench(deathsComposition, entityWith(1, { slot: 0, deaths: 0 }));
    expect(findByClass(host.zone('top'), 'hud-deaths__row').textContent).toBe('0');
    deliver([entityWith(1, { slot: 0, deaths: 2 })], 2);
    expect(findByClass(host.zone('top'), 'hud-deaths__row').textContent).toBe('2');
  });
});

// ------------------------------------------------------------ рантайм-панель

const runtimeComposition: HudComposition = {
  entries: [
    { widget: 'runtime', zone: 'top-left', params: { windowMs: 100 }, bindings: { entities: 'entities' } },
  ],
};

describe('рантайм-панель: доставленное и своё (HUD-4)', () => {
  it('тик и число сущностей — из доставки', () => {
    const { host, deliver } = bench(runtimeComposition, entityWith(1, {}));
    expect(findByClass(host.zone('top-left'), 'hud-runtime__tick').textContent).toBe('1');
    expect(findByClass(host.zone('top-left'), 'hud-runtime__entities').textContent).toBe('1');

    deliver([entityWith(1, {}), entityWith(2, {})], 17);
    expect(findByClass(host.zone('top-left'), 'hud-runtime__tick').textContent).toBe('17');
    expect(findByClass(host.zone('top-left'), 'hud-runtime__entities').textContent).toBe('2');
  });

  it('счётчик кадров меряет кадры главного потока, а не тики', () => {
    const { runtime, host } = bench(runtimeComposition, entityWith(1, {}));
    // Шесть кадров по 20 мс: окно в 100 мс закрывается, частота — 50 к/с.
    for (let i = 0; i < 6; i++) runtime.subsystem.updateFrame(0.02, 0, 0.02);
    expect(findByClass(host.zone('top-left'), 'hud-runtime__fps').textContent).toBe('50');
    // Доставка на счётчик кадров не влияет — это величина ЭТОГО потока.
    expect(findByClass(host.zone('top-left'), 'hud-runtime__tick').textContent).toBe('1');
  });

  it('замороженный и перематываемый мир счётчик кадров не останавливают (REND-25)', () => {
    const { runtime, host } = bench(runtimeComposition, entityWith(1, {}));
    // Часы презентации стоят (`Paused`) и идут назад (`Rewinding`) — а кадры
    // главного потока идут своим чередом, и частота обязана считаться по ним.
    for (let i = 0; i < 3; i++) runtime.subsystem.updateFrame(0, 0, 0.02);
    for (let i = 0; i < 3; i++) runtime.subsystem.updateFrame(-0.02, 0, 0.02);

    expect(findByClass(host.zone('top-left'), 'hud-runtime__fps').textContent).toBe('50');
  });

  it('окно счётчика: частота появляется по его заполнении и не дрожит', () => {
    const meter = new FrameRateMeter(100);
    expect(meter.push(0.02)).toBe(false);
    expect(meter.fps).toBe(0);
    for (let i = 0; i < 4; i++) meter.push(0.02);
    expect(meter.fps).toBeCloseTo(50, 6);
  });
});
