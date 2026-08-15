/**
 * Виджет статуса матча — через настоящий путь «реестр → композиция →
 * исполнитель». Пауза видна только по доставленному состоянию (HUD-2, сценарий
 * «Пауза из HUD»): клик шлёт команду обратным каналом и DOM не трогает.
 *
 * Виджеты на доставленных статах (полоса здоровья, панель кулдаунов, счётчики,
 * рантайм-панель) живут в `statWidgets.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  HudActionsFacade,
  HudOverlayHost,
  HudRegistry,
  HudRuntime,
  type HudComposition,
} from '../src/index.js';
import { MATCH_STATUS_PAUSED_CLASS, matchStatusKind } from '../src/widgets/index.js';
import { asElement, fakeDom, walkElements, type FakeElement } from './support/fakeDom.js';
import { CameraSpy, makeView } from './support/hud.js';

/**
 * Стенд с обоими адресатами мировых действий: латч сэмплера (world) и обратный
 * канал команд (control) — `makeRuntime` из support канала команд не держит.
 */
function bench(): {
  registry: HudRegistry;
  runtime: HudRuntime;
  host: HudOverlayHost;
  presses: string[];
  controlCalls: [string, number | undefined][];
} {
  const registry = new HudRegistry();
  registry.registerWidget(matchStatusKind);
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
    const { runtime, host } = bench();
    runtime.apply(statusComposition);
    runtime.subsystem.syncTick(makeView({ tick: 42, mode: 'Running' }));

    const zone = host.zone('top-left');
    expect(findByClass(zone, 'hud-match-status__tick').textContent).toBe('42');
    expect(findByClass(zone, 'hud-match-status__mode').textContent).toBe('Running');
    expect(findByClass(zone, 'hud-match-status__pause').textContent).toBe('Пауза');
  });

  it('клик шлёт команду обратным каналом, а видимую паузу ставит только доставка', () => {
    const { runtime, host, controlCalls } = bench();
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
    const { runtime, host } = bench();
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
    const { runtime, host } = bench();
    runtime.apply(statusComposition);
    runtime.subsystem.syncTick(makeView({ tick: 5 }));

    const tickElement = findByClass(host.zone('top-left'), 'hud-match-status__tick');
    const writes = tickElement.textWrites;
    runtime.subsystem.syncTick(makeView({ tick: 5 }));
    expect(tickElement.textWrites).toBe(writes);
  });
});
