/**
 * Оверлей паузы матча (HUD-9) — через настоящий путь «реестр → композиция →
 * исполнитель»: состояние паузы объявляется исполнителю (`deliverPause`), а
 * виджет читает его как всякое другое доставленное поле (HUD-1).
 *
 * Главное, что здесь проверяется, — чего оверлей НЕ делает: молчание канала он
 * паузой не считает. Доставки прекратились, тик замер, режим мира в доставке
 * какой угодно — оверлея нет, пока состояние паузы не доставлено (HUD-9,
 * сценарий «Просто пропала сеть»).
 */
import { describe, expect, it } from 'vitest';
import {
  HudActionsFacade,
  HudOverlayHost,
  HudRegistry,
  HudRuntime,
  type HudComposition,
  type HudPauseState,
} from '../src/index.js';
import { matchPauseSelector, pauseOverlayKind } from '../src/widgets/index.js';
import { asElement, fakeDom, walkElements, type FakeElement } from './support/fakeDom.js';
import { CameraSpy, makeView } from './support/hud.js';

function findByClass(root: Element, className: string): FakeElement {
  for (const element of walkElements(root as unknown as FakeElement)) {
    if ((element.getAttribute('class') ?? '').split(' ').includes(className)) return element;
  }
  throw new Error(`элемент с классом "${className}" не найден`);
}

const composition: HudComposition = {
  entries: [
    {
      widget: 'pause-overlay',
      zone: 'center',
      params: {
        // Имена слотов и фразы отказов — ДАННЫЕ композиции (HUD-4): смысл
        // причин принадлежит игре, а не виджету.
        slotNames: ['синий', 'красный'],
        denyLabels: { 'budget-spent': 'паузы кончились' },
        denyHoldMs: 1000,
      },
      bindings: { pause: 'match.pause' },
    },
  ],
};

function bench(): { runtime: HudRuntime; host: HudOverlayHost } {
  const registry = new HudRegistry();
  registry.registerWidget(pauseOverlayKind);
  registry.registerSelector('match.pause', matchPauseSelector);
  const dom = fakeDom();
  const host = new HudOverlayHost(asElement(dom.container));
  const facade = new HudActionsFacade({ actions: registry, camera: new CameraSpy() });
  const runtime = new HudRuntime({ registry, host, actions: facade });
  runtime.apply(composition);
  return { runtime, host };
}

const pause = (partial: Partial<HudPauseState> = {}): HudPauseState => ({
  state: 'frozen',
  slot: 0,
  countdownMs: 0,
  deniedSeq: 0,
  ...partial,
});

const root = (host: HudOverlayHost): FakeElement => findByClass(host.root, 'hud-pause');
const text = (host: HudOverlayHost, className: string): string =>
  findByClass(host.root, className).textContent ?? '';
const hidden = (element: FakeElement): boolean =>
  (element.getAttribute('style') ?? '').includes('display: none');

describe('оверлей паузы на доставленном состоянии (HUD-9)', () => {
  it('молчание канала паузой не считается: без доставленного состояния оверлея нет', () => {
    const b = bench();
    b.runtime.subsystem.syncTick(makeView({ tick: 40 }));
    expect(hidden(root(b.host))).toBe(true);

    // Доставки прекратились, тик замер — картина сбоя сети. Оверлей не
    // появляется: HUD не выдумывает состояния, которого не доставляли.
    for (let i = 0; i < 30; i++) b.runtime.subsystem.updateFrame(0.016, 1, 0.016);
    expect(hidden(root(b.host))).toBe(true);
  });

  it('замерший режим мира в доставке паузой тоже не считается', () => {
    // `mode: 'Paused'` в доставке — это машина состояний МИРА (WSM-1), а не
    // пауза матча: её ставит и перемотка. Источник оверлея один — доставленное
    // состояние паузы (HUD-9).
    const b = bench();
    b.runtime.subsystem.syncTick(makeView({ tick: 40, mode: 'Paused' }));
    expect(hidden(root(b.host))).toBe(true);
  });

  it('заморозка называет инициатора, а объявленное возобновление — отсчёт', () => {
    const b = bench();
    b.runtime.subsystem.syncTick(makeView({ tick: 40 }));

    b.runtime.deliverPause(pause({ slot: 1 }));
    expect(hidden(root(b.host))).toBe(false);
    expect(text(b.host, 'hud-pause__by')).toBe('поставил: красный');
    expect(hidden(findByClass(b.host.root, 'hud-pause__countdown'))).toBe(true);

    b.runtime.deliverPause(pause({ state: 'resuming', slot: 1, countdownMs: 3000 }));
    expect(text(b.host, 'hud-pause__countdown')).toBe('Возобновление через 3');

    // Отсчёт ведётся местными часами презентации от ДОСТАВЛЕННОЙ длительности.
    for (let i = 0; i < 60; i++) b.runtime.subsystem.updateFrame(0.016, 1, 0.02);
    expect(text(b.host, 'hud-pause__countdown')).toBe('Возобновление через 2');

    // И сходится к доставляемым обновлениям, а не заменяет их: конец паузы
    // приходит доставкой «идёт», а не истечением местного счётчика (HUD-5).
    b.runtime.deliverPause(pause({ state: 'running', slot: 1 }));
    expect(hidden(root(b.host))).toBe(true);
  });

  it('пауза сервера названа сервером, а не выдуманным слотом', () => {
    const b = bench();
    b.runtime.subsystem.syncTick(makeView());
    b.runtime.deliverPause(pause({ slot: -1 }));
    expect(text(b.host, 'hud-pause__by')).toBe('поставил: сервер');
  });

  it('именованный отказ политики показывается причиной, а матч не замирает', () => {
    const b = bench();
    b.runtime.subsystem.syncTick(makeView());
    b.runtime.deliverPause(pause({ state: 'running', denied: 'budget-spent', deniedSeq: 1 }));

    expect(text(b.host, 'hud-pause__denied')).toBe('паузы кончились');
    // Визуальной заморозки нет: причина показана, бой продолжается.
    expect(hidden(findByClass(b.host.root, 'hud-pause__title'))).toBe(true);
    expect(hidden(findByClass(b.host.root, 'hud-pause__by'))).toBe(true);

    // Показ ограничен сроком композиции — местными часами, не доставкой.
    for (let i = 0; i < 70; i++) b.runtime.subsystem.updateFrame(0.016, 1, 0.016);
    expect(hidden(root(b.host))).toBe(true);
  });

  it('второй отказ с той же причиной перезапускает показ: номер отличает их', () => {
    const b = bench();
    b.runtime.subsystem.syncTick(makeView());
    b.runtime.deliverPause(pause({ state: 'running', denied: 'budget-spent', deniedSeq: 1 }));
    for (let i = 0; i < 40; i++) b.runtime.subsystem.updateFrame(0.016, 1, 0.016);

    b.runtime.deliverPause(pause({ state: 'running', denied: 'budget-spent', deniedSeq: 2 }));
    for (let i = 0; i < 40; i++) b.runtime.subsystem.updateFrame(0.016, 1, 0.016);
    // Прошло 1.28 с суммарно, но срок отсчитан со ВТОРОГО отказа: показ жив.
    expect(text(b.host, 'hud-pause__denied')).toBe('паузы кончились');
  });

  it('незнакомая причина показывается ключом, а не молчанием', () => {
    const b = bench();
    b.runtime.subsystem.syncTick(makeView());
    b.runtime.deliverPause(pause({ state: 'running', denied: 'too-early', deniedSeq: 1 }));
    expect(text(b.host, 'hud-pause__denied')).toBe('too-early');
  });

  it('объявление до первой доставки тика не теряется: доедет первой же доставкой', () => {
    const b = bench();
    b.runtime.deliverPause(pause({ slot: 0 }));
    expect(hidden(root(b.host))).toBe(true);

    b.runtime.subsystem.syncTick(makeView({ tick: 3 }));
    expect(hidden(root(b.host))).toBe(false);
    expect(text(b.host, 'hud-pause__by')).toBe('поставил: синий');
  });

  it('свежесмонтированная композиция получает объявленную паузу немедленно (HUD-5)', () => {
    const b = bench();
    b.runtime.subsystem.syncTick(makeView({ tick: 7 }));
    b.runtime.deliverPause(pause({ slot: 0 }));

    b.runtime.apply(composition);
    expect(hidden(root(b.host))).toBe(false);
    expect(text(b.host, 'hud-pause__by')).toBe('поставил: синий');
  });
});
