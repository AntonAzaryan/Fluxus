/**
 * Анимационный контроллер (REND-4): выбор клипа по манифесту (состояние →
 * клип, событие → one-shot), кроссфейд, возврат в локомоцию, смерть с
 * фиксацией последнего кадра. Всё headless: микшеру WebGL не нужен.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AnimationController, resolveClip } from '../src/index.js';

function makeClip(name: string, duration: number): THREE.AnimationClip {
  // Трек на реальную ноду 'b0' — чтобы PropertyBinding резолвился без warning.
  const track = new THREE.VectorKeyframeTrack(
    'b0.position',
    [0, duration],
    [0, 0, 0, 0, 0, 1],
  );
  return new THREE.AnimationClip(name, duration, [track]);
}

const CLIPS = [
  makeClip('Stand - 1', 1),
  makeClip('Walk Fast', 1),
  makeClip('Attack - 1', 0.5),
  makeClip('Death', 0.8),
];

function makeController(
  mapping: import('../src/index.js').AnimationMapping = {
    states: { idle: 'Stand', move: 'Walk' },
    events: { CastFireball: 'Attack', EntityDied: 'Death' },
  },
) {
  const root = new THREE.Group();
  const bone = new THREE.Object3D();
  bone.name = 'b0';
  root.add(bone);
  const mixer = new THREE.AnimationMixer(root);
  const controller = new AnimationController(mixer, CLIPS, mapping);
  return { controller, mixer };
}

describe('resolveClip: подстрока без регистра, фолбэк — первый клип', () => {
  it('находит клип по подстроке имени без учёта регистра', () => {
    expect(resolveClip(CLIPS, 'walk')!.name).toBe('Walk Fast');
    expect(resolveClip(CLIPS, 'ATTACK')!.name).toBe('Attack - 1');
  });

  it('не нашёл — первый клип модели; пустой список — null', () => {
    expect(resolveClip(CLIPS, 'Spell Slam')!.name).toBe('Stand - 1');
    expect(resolveClip([], 'Stand')).toBeNull();
  });
});

describe('AnimationController: состояния из манифеста (REND-4)', () => {
  it('idle/move переключают клипы по таблице states', () => {
    const { controller } = makeController();
    controller.setState('idle');
    expect(controller.currentClipName).toBe('Stand - 1');
    controller.setState('move');
    expect(controller.currentClipName).toBe('Walk Fast');
    controller.setState('move'); // повтор не рестартит клип
    expect(controller.currentClipName).toBe('Walk Fast');
  });

  it('состояние без записи в манифесте ничего не меняет — политика в данных', () => {
    const { controller } = makeController({ states: { idle: 'Stand' }, events: {} });
    controller.setState('idle');
    controller.setState('move');
    expect(controller.currentClipName).toBe('Stand - 1');
  });
});

describe('AnimationController: one-shot по событиям (REND-4)', () => {
  it('событие из таблицы играет one-shot и возвращается в локомоцию', () => {
    const { controller } = makeController();
    controller.setState('move');
    expect(controller.handleEvent('CastFireball')).toBe(true);
    expect(controller.currentClipName).toBe('Attack - 1');

    controller.update(0.3); // атака (0.5 с) ещё идёт
    expect(controller.currentClipName).toBe('Attack - 1');
    controller.update(0.4); // конец one-shot → возврат в move
    expect(controller.currentClipName).toBe('Walk Fast');
  });

  it('смена состояния во время one-shot применяется по его завершении', () => {
    const { controller } = makeController();
    controller.setState('idle');
    controller.handleEvent('CastFireball');
    controller.setState('move'); // запомнено, но не оборвало атаку
    expect(controller.currentClipName).toBe('Attack - 1');
    controller.update(0.6);
    expect(controller.currentClipName).toBe('Walk Fast');
  });

  it('незамапленное событие игнорируется', () => {
    const { controller } = makeController();
    controller.setState('idle');
    expect(controller.handleEvent('Collision')).toBe(false);
    expect(controller.currentClipName).toBe('Stand - 1');
  });
});

describe('AnimationController: смерть (REND-4)', () => {
  it('EntityDied — one-shot с фиксацией последнего кадра, состояния игнорируются', () => {
    const { controller } = makeController();
    controller.setState('move');
    expect(controller.handleEvent('EntityDied')).toBe(true);
    expect(controller.currentClipName).toBe('Death');

    controller.update(2); // далеко за концом клипа
    expect(controller.isDead).toBe(true);
    expect(controller.currentClipName).toBe('Death'); // не вернулись в локомоцию

    controller.setState('idle');
    expect(controller.currentClipName).toBe('Death');
    expect(controller.handleEvent('CastFireball')).toBe(false);
  });
});
