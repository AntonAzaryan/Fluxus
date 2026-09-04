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
import { describe, expect, it, vi } from 'vitest';
import { AssetService } from '@fluxus/assets';
import { HudRegistry, type HudComposition, type HudEntityView } from '../src/index.js';
import { HudIcons } from '../src/icons.js';
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

/**
 * Иконки — поверх НАСТОЯЩЕГО сервиса ассетов (HUD-4): второго кэша и второй
 * адресации у HUD нет, поэтому и в тесте байты приезжают `AssetSource`'ом.
 * Содержимое «файла» — сам его ID: так по `src` видно, какой ассет доехал.
 */
function iconService(): AssetService {
  return new AssetService({
    read: (id: string): Promise<ArrayBuffer> =>
      Promise.resolve(new TextEncoder().encode(id).slice().buffer),
  });
}

/** `src`, который получит кнопка иконки этого ID (data-URI загрузчика). */
function iconSrc(id: string): string {
  return `data:image/svg+xml;base64,${btoa(id)}`;
}

const icons = new HudIcons(iconService());

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

  const { runtime, host, facade, dom } = makeRuntime(registry);
  const presses: string[] = [];
  facade.start((action) => presses.push(action));
  runtime.apply(composition);
  const deliver = (entities: readonly HudEntityView[], tick = 1): void => {
    runtime.subsystem.syncTick(
      makeView({ tick, entities: new Map(entities.map((e) => [e.id, e])) }),
    );
  };
  if (hero !== null) deliver([hero]);
  return { runtime, host, presses, deliver, facade, dom };
}

/**
 * Событие указателя, которым игрок и берёт кнопку: ОСНОВНАЯ кнопка ОСНОВНОГО
 * указателя. Всё прочее — не «нажал эту кнопку» (HUD-2).
 */
const PRIMARY_POINTER = { button: 0, isPrimary: true };

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
    const ability = { action: 'cast', icon: 'i', stat: 'cast.cd', maxStat: 'cast.cdMax', hold: false };
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
    const { host, presses, facade } = bench(cooldownComposition, entityWith(1, {}));
    const buttons = [...walkElements(host.zone('bottom') as unknown as FakeElement)].filter(
      (element) => element.getAttribute('data-ability') !== null,
    );
    expect(buttons[1]!.getAttribute('data-form')).toBe('press');
    buttons[1]!.dispatch('click');
    expect(presses).toEqual(['dodge']);
    // Кнопка формы «фронт» удержаний не заводит: бит живёт один тик (INP-2).
    expect([...facade.held()]).toEqual([]);
  });

  it('иконки едут тем же сервисом ассетов, что модели рендера (HUD-4)', async () => {
    const reads: string[] = [];
    const service = new AssetService({
      read: (id: string): Promise<ArrayBuffer> => {
        reads.push(id);
        return Promise.resolve(new TextEncoder().encode(id).slice().buffer);
      },
    });
    const registry = new HudRegistry();
    registry.registerWidget(cooldownsKind(new HudIcons(service)));
    registry.registerSelector('hero', () => null);
    registry.registerAction('hero.cast', { target: 'world', action: 'cast' });
    registry.registerAction('hero.dodge', { target: 'world', action: 'dodge' });
    const { runtime, host } = makeRuntime(registry);
    runtime.apply(cooldownComposition);

    // Сервису ушли ровно asset ID записей — по одному на кнопку; собственного
    // корня и собственного адреса у HUD нет (HUD-4).
    expect(reads).toEqual(['visuals/icons/cast.svg', 'visuals/icons/dodge.svg']);
    const icon = findByClass(host.zone('bottom'), 'hud-cooldowns__icon');
    const button = [...walkElements(host.zone('bottom') as unknown as FakeElement)].find(
      (element) => element.getAttribute('data-ability') === 'cast',
    )!;
    // Пока байты не приехали — `src` пуст, и состояние иконки названо.
    expect(icon.getAttribute('src')).toBeNull();
    expect(button.getAttribute('data-icon')).toBe('loading');

    await vi.waitFor(() => {
      expect(button.getAttribute('data-icon')).toBe('ready');
    });
    expect(icon.getAttribute('src')).toBe(iconSrc('visuals/icons/cast.svg'));
    // Композиция — чистые asset ID: резолвленный адрес в неё не просочился.
    expect(JSON.stringify(cooldownComposition)).not.toContain('://');
  });

  it('битый файл иконки виден на кнопке, а не молчит (HUD-4, ASSET-4)', async () => {
    const registry = new HudRegistry();
    registry.registerWidget(
      cooldownsKind(new HudIcons(new AssetService({ read: () => Promise.reject(new Error('нет файла')) }))),
    );
    registry.registerSelector('hero', () => null);
    registry.registerAction('hero.cast', { target: 'world', action: 'cast' });
    registry.registerAction('hero.dodge', { target: 'world', action: 'dodge' });
    const { runtime, host } = makeRuntime(registry);
    runtime.apply(cooldownComposition);
    const button = [...walkElements(host.zone('bottom') as unknown as FakeElement)].find(
      (element) => element.getAttribute('data-ability') === 'cast',
    )!;
    await vi.waitFor(() => {
      expect(button.getAttribute('data-icon')).toBe('failed');
    });
  });

  it('URL вместо asset ID валит apply до монтирования и называет запись (HUD-4)', () => {
    const registry = new HudRegistry();
    registry.registerWidget(cooldownsKind(new HudIcons(iconService())));
    registry.registerSelector('hero', () => null);
    registry.registerAction('hero.cast', { target: 'world', action: 'cast' });
    const { runtime } = makeRuntime(registry);
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

// ------------------------------------------------- кнопка формы «удержание»

/** Панель, где вторая кнопка объявлена удерживаемой (HUD-2). */
const holdComposition: HudComposition = {
  entries: [
    {
      widget: 'cooldowns',
      zone: 'bottom',
      params: {
        tickMs: TICK_MS,
        abilities: [
          { action: 'cast', icon: 'visuals/icons/cast.svg' },
          { action: 'dodge', icon: 'visuals/icons/dodge.svg', hold: true },
        ],
      },
      bindings: { entity: 'hero' },
      actions: { cast: 'hero.cast', dodge: 'hero.dodge' },
    },
  ],
};

/** Кнопка панели по имени способности. */
function abilityButton(host: { zone(name: 'bottom'): Element }, action: string): FakeElement {
  const found = [...walkElements(host.zone('bottom') as unknown as FakeElement)].find(
    (element) => element.getAttribute('data-ability') === action,
  );
  if (found === undefined) throw new Error(`кнопки "${action}" нет в панели`);
  return found;
}

describe('форма органа управления объявляется композицией (HUD-2)', () => {
  it('удержание кнопки даёт фронт и держит бит до отпускания', () => {
    const { host, presses, facade } = bench(holdComposition, entityWith(1, {}));
    const button = abilityButton(host, 'dodge');
    expect(button.getAttribute('data-form')).toBe('hold');

    button.dispatch('pointerdown', PRIMARY_POINTER);
    // Фронт латчится ровно как у клавиши на `keydown` — иначе нажатие короче
    // тика отличалось бы от такого же нажатия клавиши.
    expect(presses).toEqual(['dodge']);
    // И держится: сэмплер собирает удержания каждую выборку, поэтому бит стоит
    // во всех кадрах подряд (INP-2).
    expect([...facade.held()]).toEqual(['dodge']);
    expect([...facade.held()]).toEqual(['dodge']);

    button.dispatch('pointerup');
    expect([...facade.held()]).toEqual([]);
    // Отпускание второго фронта не порождает: `click` удерживаемая кнопка не
    // слушает вовсе.
    button.dispatch('click');
    expect(presses).toEqual(['dodge']);
  });

  it('увод указателя и отмена жеста снимают удержание (INP-5)', () => {
    for (const event of ['pointerleave', 'pointercancel']) {
      const { host, facade } = bench(holdComposition, entityWith(1, {}));
      const button = abilityButton(host, 'dodge');
      button.dispatch('pointerdown', PRIMARY_POINTER);
      expect([...facade.held()]).toEqual(['dodge']);
      button.dispatch(event);
      expect([...facade.held()]).toEqual([]);
    }
  });

  it('снятие виджета отпускает то, что он держал (INP-5)', () => {
    const { host, runtime, facade } = bench(holdComposition, entityWith(1, {}));
    abilityButton(host, 'dodge').dispatch('pointerdown', PRIMARY_POINTER);
    expect([...facade.held()]).toEqual(['dodge']);
    runtime.clear();
    expect([...facade.held()]).toEqual([]);
  });

  it('не-основная кнопка и не-основной указатель удержания не начинают (HUD-2)', () => {
    const { host, presses, facade } = bench(holdComposition, entityWith(1, {}));
    const button = abilityButton(host, 'dodge');

    // Правая и средняя кнопки — свои органы управления (в раскладке демо ПКМ
    // занята живым мировым вводом, INP-4): удержание они не начинают.
    for (const pointer of [{ button: 2, isPrimary: true }, { button: 1, isPrimary: true }]) {
      button.dispatch('pointerdown', pointer);
      expect([...facade.held()]).toEqual([]);
      expect(presses).toEqual([]);
    }
    // Второй палец мультитача — тоже нет.
    button.dispatch('pointerdown', { button: 0, isPrimary: false });
    expect([...facade.held()]).toEqual([]);
    expect(presses).toEqual([]);

    // А основная кнопка основного указателя — да.
    button.dispatch('pointerdown', PRIMARY_POINTER);
    expect([...facade.held()]).toEqual(['dodge']);
  });

  it('клавиатурный путь: Space и Enter держат кнопку, автоповтор не в счёт (HUD-2)', () => {
    for (const key of [' ', 'Enter']) {
      const { host, presses, facade } = bench(holdComposition, entityWith(1, {}));
      const button = abilityButton(host, 'dodge');
      let prevented = 0;
      const event = { key, repeat: false, preventDefault: () => { prevented += 1; } };

      button.dispatch('keydown', event);
      expect(presses).toEqual(['dodge']);
      expect([...facade.held()]).toEqual(['dodge']);
      // Прокрутка страницы пробелом гасится: кнопка занята удержанием.
      expect(prevented).toBe(1);

      // Автоповтор ОС — не новое нажатие (INP-2): ни второго фронта, ни
      // повторного взятия.
      button.dispatch('keydown', { ...event, repeat: true });
      expect(presses).toEqual(['dodge']);
      expect([...facade.held()]).toEqual(['dodge']);

      button.dispatch('keyup', event);
      expect([...facade.held()]).toEqual([]);
    }
  });

  it('посторонняя клавиша кнопку не трогает', () => {
    const { host, presses, facade } = bench(holdComposition, entityWith(1, {}));
    const button = abilityButton(host, 'dodge');
    button.dispatch('keydown', { key: 'Tab', repeat: false });
    expect(presses).toEqual([]);
    expect([...facade.held()]).toEqual([]);
  });

  it('уход фокуса окна и потеря фокуса кнопкой снимают удержание (INP-5)', () => {
    // Alt-tab с зажатой кнопкой: ни `pointerup`, ни `keyup` не придут.
    const alt = bench(holdComposition, entityWith(1, {}));
    abilityButton(alt.host, 'dodge').dispatch('pointerdown', PRIMARY_POINTER);
    expect([...alt.facade.held()]).toEqual(['dodge']);
    alt.dom.view.dispatch('blur');
    expect([...alt.facade.held()]).toEqual([]);

    // Фокус уехал с самой кнопки, не покидая страницы.
    const inner = bench(holdComposition, entityWith(1, {}));
    const button = abilityButton(inner.host, 'dodge');
    button.dispatch('keydown', { key: ' ', repeat: false });
    expect([...inner.facade.held()]).toEqual(['dodge']);
    button.dispatch('blur');
    expect([...inner.facade.held()]).toEqual([]);
  });

  it('снятие виджета отписывает его от окна — слушателей не копится', () => {
    const { runtime, dom } = bench(holdComposition, entityWith(1, {}));
    expect(dom.view.count('blur')).toBe(1);
    runtime.clear();
    expect(dom.view.count('blur')).toBe(0);
  });

  it('панель без удерживаемых кнопок на окно не подписывается', () => {
    const { dom } = bench(cooldownComposition, entityWith(1, {}));
    expect(dom.view.count('blur')).toBe(0);
  });

  it('повторный pointerdown без отпускания не удваивает фронт', () => {
    const { host, presses } = bench(holdComposition, entityWith(1, {}));
    const button = abilityButton(host, 'dodge');
    button.dispatch('pointerdown', PRIMARY_POINTER);
    button.dispatch('pointerdown', PRIMARY_POINTER);
    expect(presses).toEqual(['dodge']);
  });

  it('удержание не-мирового действия — названная ошибка сборки', () => {
    const registry = new HudRegistry();
    registry.registerWidget(cooldownsKind(new HudIcons(iconService())));
    registry.registerSelector('hero', () => null);
    registry.registerAction('hero.cast', { target: 'presentation', run: () => undefined });
    const { runtime, host, facade } = makeRuntime(registry);
    facade.start(() => undefined);
    runtime.apply({
      entries: [
        {
          widget: 'cooldowns',
          zone: 'bottom',
          params: { abilities: [{ action: 'cast', icon: 'visuals/icons/cast.svg', hold: true }] },
          actions: { cast: 'hero.cast' },
        },
      ],
    });
    expect(() => {
      abilityButton(host, 'cast').dispatch('pointerdown', PRIMARY_POINTER);
    }).toThrow('удержание есть форма мирового действия-ввода');
  });

  it('не-булева форма в записи — ошибка композиции до монтирования', () => {
    const { runtime } = bench(cooldownComposition, null);
    expect(() => {
      runtime.apply({
        entries: [
          {
            widget: 'cooldowns',
            zone: 'bottom',
            params: { abilities: [{ action: 'cast', icon: 'visuals/icons/cast.svg', hold: 'yes' }] },
            actions: { cast: 'hero.cast' },
          },
        ],
      });
    }).toThrow('булево значение');
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

  it('слот с несколькими носителями даёт ОДНУ строку (HUD-4)', () => {
    // РЕГРЕССИЯ: строка шла на каждую доставленную сущность со статом слота, и
    // на арене демо «слот 2» повторялся столько раз, сколько живых юнитов нёс
    // слот босса (`Player.slot` там ещё и поле команды платформы способностей).
    const rows = deathsRows(
      new Map([
        [2, entityWith(2, { slot: 2, deaths: 1 })],
        [9, entityWith(9, { slot: 2 })],
        [10, entityWith(10, { slot: 2 })],
        [3, entityWith(3, { slot: 0, deaths: 4 })],
      ]),
      'slot',
      'deaths',
    );
    expect(rows).toEqual([
      { slot: 0, deaths: 4 },
      { slot: 2, deaths: 1 },
    ]);
  });

  it('число слота — максимум доставленных: порядок обхода его не меняет', () => {
    const entities: [number, HudEntityView][] = [
      [2, entityWith(2, { slot: 2, deaths: 1 })],
      [9, entityWith(9, { slot: 2, deaths: 5 })],
      [10, entityWith(10, { slot: 2 })],
    ];
    const forward = deathsRows(new Map(entities), 'slot', 'deaths');
    const backward = deathsRows(new Map([...entities].reverse()), 'slot', 'deaths');
    expect(forward).toEqual([{ slot: 2, deaths: 5 }]);
    expect(backward).toEqual(forward);
  });

  it('носитель без стата смертей не гасит число слота, а один такой даёт прочерк', () => {
    expect(
      deathsRows(
        new Map([
          [9, entityWith(9, { slot: 1 })],
          [4, entityWith(4, { slot: 1, deaths: 2 })],
        ]),
        'slot',
        'deaths',
      ),
    ).toEqual([{ slot: 1, deaths: 2 }]);
    expect(
      deathsRows(
        new Map([
          [9, entityWith(9, { slot: 1 })],
          [4, entityWith(4, { slot: 1 })],
        ]),
        'slot',
        'deaths',
      ),
    ).toEqual([{ slot: 1, deaths: null }]);
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
