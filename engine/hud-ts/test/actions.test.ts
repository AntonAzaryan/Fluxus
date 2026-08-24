/**
 * Фасад действий с двумя адресатами (задача 3.3, HUD-2): мировое действие —
 * тем же путём и в том же виде, что ввод с устройства; presentation-действие —
 * локальный вызов контракта камеры без единого сообщения воркеру.
 */
import { describe, expect, it } from 'vitest';
import { InputSampler, KeyboardMouseSource } from '@fluxus/client';
import { HudActionsFacade, HudRegistry } from '../src/index.js';
import { CameraSpy } from './support/hud.js';

/** Смысл битов — у контента (INP-4); таблица — как в демо (`sim.ts`). */
const ACTION_BITS = { cast: 0, kill: 1, dodge: 2, jump: 3 } as const;

function facadeBench(): {
  registry: HudRegistry;
  facade: HudActionsFacade;
  camera: CameraSpy;
  controlCalls: [string, number | undefined][];
} {
  const registry = new HudRegistry();
  const camera = new CameraSpy();
  const controlCalls: [string, number | undefined][] = [];
  const facade = new HudActionsFacade({
    actions: registry,
    camera,
    control: { control: (action, tick) => controlCalls.push([action, tick]) },
  });
  return { registry, facade, camera, controlCalls };
}

describe('кнопка неотличима от клавиши (HUD-2)', () => {
  it('фасад в сэмплере даёт тот же канонический ввод, что настоящая клавиша', () => {
    // Путь клавиши: реальный источник клавиатуры по биндингам-данным (INP-4).
    const keySampler = new InputSampler({ actionBits: ACTION_BITS });
    const keyboard = new KeyboardMouseSource({
      bindings: {
        move: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' },
        keys: { Space: 'jump' },
        pointerButtons: {},
      },
    });
    keySampler.add(keyboard);
    keyboard.handleKeyDown('Space');
    const fromKey = keySampler.sample();

    // Путь кнопки HUD: фасад — обычный источник того же сэмплера, действие
    // ссылается на то же семантическое имя из словаря биндингов.
    const { registry, facade } = facadeBench();
    registry.registerAction('jumpButton', { target: 'world', action: 'jump' });
    const hudSampler = new InputSampler({ actionBits: ACTION_BITS });
    hudSampler.add(facade);
    facade.dispatch('jumpButton');
    const fromHud = hudSampler.sample();

    // В воркер ушёл бы одинаковый ввод: симуляция не различает источники.
    expect(fromHud).toEqual(fromKey);
    expect(fromHud.buttons).toBe(1 << ACTION_BITS.jump);
  });

  it('мировое действие без сэмплера — ошибка, а не тихая потеря', () => {
    const { registry, facade } = facadeBench();
    registry.registerAction('castButton', { target: 'world', action: 'cast' });
    expect(() => { facade.dispatch('castButton'); }).toThrow('не добавлен в сэмплер');
  });

  it('команда машины состояний уходит обратным каналом (SHELL-6)', () => {
    const { registry, facade, controlCalls } = facadeBench();
    registry.registerAction('pauseButton', { target: 'control', action: 'pause' });
    registry.registerAction('seekButton', { target: 'control', action: 'seekTo' });
    facade.dispatch('pauseButton');
    facade.dispatch('seekButton', { tick: 120 });
    expect(controlCalls).toEqual([
      ['pause', undefined],
      ['seekTo', 120],
    ]);
  });

  it('seekTo без числового tick — ошибка конфигурации, а не тихий no-op', () => {
    const { registry, facade, controlCalls } = facadeBench();
    registry.registerAction('seekButton', { target: 'control', action: 'seekTo' });
    // Без нагрузки и с нечисловой нагрузкой воркер молча проигнорировал бы
    // команду (WSM-5) — фасад обязан сказать об этом громко.
    expect(() => { facade.dispatch('seekButton'); }).toThrow('нужен числовой "tick"');
    expect(() => { facade.dispatch('seekButton', {}); }).toThrow('нужен числовой "tick"');
    expect(controlCalls).toEqual([]);
  });
});

describe('камера — локально (HUD-2)', () => {
  it('presentation-действие зовёт контракт камеры и не пишет ни в канал, ни в ввод', () => {
    const { registry, facade, camera, controlCalls } = facadeBench();
    registry.registerAction('minimapPan', {
      target: 'presentation',
      run: (cam, payload) => {
        cam.panTo(payload?.x ?? 0, payload?.y ?? 0);
      },
    });
    const pressed: string[] = [];
    facade.start((action) => pressed.push(action)); // как будто фасад в сэмплере

    facade.dispatch('minimapPan', { x: 3, y: 4 });

    expect(camera.panned).toEqual([[3, 4]]); // камера перемещена в главном потоке
    expect(pressed).toEqual([]); // фронтов ввода не возникло
    expect(controlCalls).toEqual([]); // команд в канал не ушло
  });

  it('фокус на герое — тоже локальный вызов контракта', () => {
    const { registry, facade, camera } = facadeBench();
    registry.registerAction('focusHero', {
      target: 'presentation',
      run: (cam) => {
        cam.focusOnHero();
      },
    });
    facade.dispatch('focusHero');
    expect(camera.focused).toBe(1);
  });
});
