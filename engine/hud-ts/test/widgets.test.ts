/**
 * Первые виджеты (задача 5.1): статус матча и панель действий героя — через
 * настоящий путь «реестр → композиция → исполнитель». Пауза видна только по
 * доставленному состоянию (HUD-2, сценарий «Пауза из HUD»), кнопки способностей
 * шлют те же семантические действия, что клавиши (INP-4), иконки — по asset ID
 * из таблицы в params через шов сборки (HUD-4).
 */
import { describe, expect, it } from 'vitest';
import {
  HudActionsFacade,
  HudOverlayHost,
  HudRegistry,
  HudRuntime,
  type HudComposition,
} from '../src/index.js';
import type { HudIconSource } from '../src/icons.js';
import {
  MATCH_STATUS_PAUSED_CLASS,
  abilityBarKind,
  matchStatusKind,
} from '../src/widgets/index.js';
import { asElement, fakeDom, walkElements, type FakeElement } from './support/fakeDom.js';
import { CameraSpy, makeView } from './support/hud.js';

/**
 * Стенд с обоими адресатами мировых действий: латч сэмплера (world) и обратный
 * канал команд (control) — `makeRuntime` из support канала команд не держит.
 */
function bench(icons: HudIconSource): {
  registry: HudRegistry;
  runtime: HudRuntime;
  host: HudOverlayHost;
  presses: string[];
  controlCalls: [string, number | undefined][];
} {
  const registry = new HudRegistry();
  registry.registerWidget(matchStatusKind);
  registry.registerWidget(abilityBarKind(icons));
  registry.registerAction('hud.pause', { target: 'control', action: 'pause' });
  registry.registerAction('hud.resume', { target: 'control', action: 'resume' });
  registry.registerAction('hero.cast', { target: 'world', action: 'cast' });
  registry.registerAction('hero.dodge', { target: 'world', action: 'dodge' });
  registry.registerAction('hero.jump', { target: 'world', action: 'jump' });

  const controlCalls: [string, number | undefined][] = [];
  const facade = new HudActionsFacade({
    actions: registry,
    camera: new CameraSpy(),
    control: { control: (action, tick) => controlCalls.push([action, tick]) },
  });
  // Латч фронтов, как его ставит `InputSampler.add` (INP-2): что пришло сюда —
  // то ушло бы в воркер тем же каноническим вводом, что от клавиши.
  const presses: string[] = [];
  facade.start((action) => presses.push(action));

  const dom = fakeDom();
  const host = new HudOverlayHost(asElement(dom.container));
  const runtime = new HudRuntime({ registry, host, actions: facade });
  return { registry, runtime, host, presses, controlCalls };
}

const NO_ICONS: HudIconSource = {
  resolveIconUrl: () => {
    throw new Error('в этом тесте иконки не резолвятся');
  },
};

function findByClass(root: Element, className: string): FakeElement {
  for (const element of walkElements(root as unknown as FakeElement)) {
    if ((element.getAttribute('class') ?? '').split(' ').includes(className)) return element;
  }
  throw new Error(`элемент с классом "${className}" не найден`);
}

const statusComposition: HudComposition = {
  entries: [
    {
      widget: 'match-status',
      zone: 'top-left',
      actions: { pause: 'hud.pause', resume: 'hud.resume' },
    },
  ],
};

describe('статус матча: пауза из HUD (HUD-2)', () => {
  it('тик и режим — из доставленного состояния', () => {
    const { runtime, host } = bench(NO_ICONS);
    runtime.apply(statusComposition);
    runtime.subsystem.syncTick(makeView({ tick: 42, mode: 'Running' }));

    const zone = host.zone('top-left');
    expect(findByClass(zone, 'hud-match-status__tick').textContent).toBe('42');
    expect(findByClass(zone, 'hud-match-status__mode').textContent).toBe('Running');
    expect(findByClass(zone, 'hud-match-status__pause').textContent).toBe('Пауза');
  });

  it('клик шлёт команду обратным каналом, а видимую паузу ставит только доставка', () => {
    const { runtime, host, controlCalls } = bench(NO_ICONS);
    runtime.apply(statusComposition);
    runtime.subsystem.syncTick(makeView({ tick: 10, mode: 'Running' }));

    const zone = host.zone('top-left');
    const root = findByClass(zone, 'hud-match-status');
    const button = findByClass(zone, 'hud-match-status__pause');

    // Кнопка интерактивна (перехватывает указатель), контейнер — нет (HUD-3).
    expect(button.getAttribute('style')).toContain('pointer-events: auto');
    expect(root.getAttribute('style') ?? '').not.toContain('pointer-events: auto');

    button.dispatch('click');
    expect(controlCalls).toEqual([['pause', undefined]]);
    // Исход HUD не изображает: до доставки паузы на экране её нет (HUD-2).
    expect((root.getAttribute('class') ?? '').includes(MATCH_STATUS_PAUSED_CLASS)).toBe(false);
    expect(findByClass(zone, 'hud-match-status__mode').textContent).toBe('Running');
    expect(button.textContent).toBe('Пауза');

    // Пауза доставлена — только теперь она видима, и кнопка становится «Продолжить».
    runtime.subsystem.syncTick(makeView({ tick: 10, mode: 'Paused' }));
    expect((root.getAttribute('class') ?? '').includes(MATCH_STATUS_PAUSED_CLASS)).toBe(true);
    expect(findByClass(zone, 'hud-match-status__mode').textContent).toBe('Paused');
    expect(button.textContent).toBe('Продолжить');

    // Из доставленной паузы тот же клик шлёт resume — по доставленному режиму.
    button.dispatch('click');
    expect(controlCalls).toEqual([
      ['pause', undefined],
      ['resume', undefined],
    ]);
    // И снова: видимое состояние не меняется до следующей доставки.
    expect((root.getAttribute('class') ?? '').includes(MATCH_STATUS_PAUSED_CLASS)).toBe(true);
  });

  it('оболочка без управления миром не получает кнопки вовсе (D5 демо, NET-11)', () => {
    // Тонкому сетевому клиенту перематывать и ставить на паузу нечего: своей
    // машины состояний у него нет (`snapshot-rewind` REW-6). Композиция такой
    // сборки не ведёт слоты действий никуда, а виджет не строит кнопку —
    // показанная и неработающая, она обещала бы то, чего сборка не сделает.
    const { runtime, host } = bench(NO_ICONS);
    runtime.apply({
      entries: [{ widget: 'match-status', zone: 'top-left', params: { controls: false } }],
    });
    runtime.subsystem.syncTick(makeView({ tick: 7, mode: 'Running' }));

    const zone = host.zone('top-left');
    // Тик и режим на месте: доставленное состояние виджет показывает по-прежнему.
    expect(findByClass(zone, 'hud-match-status__tick').textContent).toBe('7');
    expect(findByClass(zone, 'hud-match-status__mode').textContent).toBe('Running');
    expect(() => findByClass(zone, 'hud-match-status__pause')).toThrow();
  });

  it('точечные обновления: одинаковая доставка не пишет в DOM повторно', () => {
    const { runtime, host } = bench(NO_ICONS);
    runtime.apply(statusComposition);
    runtime.subsystem.syncTick(makeView({ tick: 5 }));

    const tickElement = findByClass(host.zone('top-left'), 'hud-match-status__tick');
    const writes = tickElement.textWrites;
    runtime.subsystem.syncTick(makeView({ tick: 5 }));
    expect(tickElement.textWrites).toBe(writes);
  });
});

const abilityComposition: HudComposition = {
  entries: [
    {
      widget: 'ability-bar',
      zone: 'bottom',
      params: {
        abilities: ['cast', 'dodge', 'jump'],
        icons: {
          cast: 'visuals/icons/cast.png',
          dodge: 'visuals/icons/dodge.png',
          jump: 'visuals/icons/jump.png',
        },
      },
      actions: { cast: 'hero.cast', dodge: 'hero.dodge', jump: 'hero.jump' },
    },
  ],
};

/** Шов сборки: помечает URL схемно, чтобы тест отличал его от asset ID. */
function markingSource(): { source: HudIconSource; requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    source: {
      resolveIconUrl: (assetId) => {
        requested.push(assetId);
        return `resolved://root/${assetId}`;
      },
    },
  };
}

describe('панель действий героя (HUD-2, HUD-4)', () => {
  it('кнопка шлёт то же семантическое действие, что клавиша (INP-4)', () => {
    const { runtime, host, presses } = bench(markingSource().source);
    runtime.apply(abilityComposition);

    const zone = host.zone('bottom') as unknown as FakeElement;
    const buttons = [...walkElements(zone)].filter((e) => e.getAttribute('data-ability') !== null);
    expect(buttons.map((b) => b.getAttribute('data-ability'))).toEqual(['cast', 'dodge', 'jump']);

    buttons[0]!.dispatch('click');
    buttons[2]!.dispatch('click');
    expect(presses).toEqual(['cast', 'jump']);
  });

  it('интерактивны только кнопки, не контейнер панели (HUD-3)', () => {
    const { runtime, host } = bench(markingSource().source);
    runtime.apply(abilityComposition);

    const zone = host.zone('bottom');
    const bar = findByClass(zone, 'hud-ability-bar');
    expect(bar.getAttribute('style') ?? '').not.toContain('pointer-events: auto');
    for (const button of walkElements(bar)) {
      if (button.getAttribute('data-ability') === null) continue;
      expect(button.getAttribute('style')).toContain('pointer-events: auto');
    }
  });

  it('иконки — из таблицы params через шов; в композиции URL нет', () => {
    const { source, requested } = markingSource();
    const { runtime, host } = bench(source);
    runtime.apply(abilityComposition);

    // К шву ушли ровно asset ID таблицы — по одному на кнопку.
    expect(requested).toEqual([
      'visuals/icons/cast.png',
      'visuals/icons/dodge.png',
      'visuals/icons/jump.png',
    ]);
    const icon = findByClass(host.zone('bottom'), 'hud-ability-bar__icon');
    expect(icon.getAttribute('src')).toBe('resolved://root/visuals/icons/cast.png');

    // Композиция — чистые asset ID: резолвленный URL в неё не просочился (HUD-4).
    expect(JSON.stringify(abilityComposition)).not.toContain('://');
  });

  it('способность без записи в таблице иконок валит apply с именем способности', () => {
    const { runtime } = bench(markingSource().source);
    const broken: HudComposition = {
      entries: [
        {
          widget: 'ability-bar',
          zone: 'bottom',
          params: { abilities: ['cast'], icons: {} },
          actions: { cast: 'hero.cast' },
        },
      ],
    };
    expect(() => {
      runtime.apply(broken);
    }).toThrow('"cast"');
  });
});
