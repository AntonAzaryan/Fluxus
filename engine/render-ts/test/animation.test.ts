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
  clips: readonly THREE.AnimationClip[] = CLIPS,
) {
  const root = new THREE.Group();
  const bone = new THREE.Object3D();
  bone.name = 'b0';
  root.add(bone);
  const mixer = new THREE.AnimationMixer(root);
  const warnings: string[] = [];
  const controller = new AnimationController(mixer, clips, mapping, {
    warn: (message) => warnings.push(message),
  });
  return { controller, mixer, warnings };
}

/** Имя разрешённого клипа либо null — разрешение больше не `clip | null`. */
function resolvedName(resolution: ReturnType<typeof resolveClip>): string | null {
  return resolution.status === 'resolved' ? resolution.clip.name : null;
}

describe('resolveClip: точное совпадение, затем единственная подстрока (REND-4)', () => {
  it('находит клип по подстроке имени без учёта регистра', () => {
    expect(resolvedName(resolveClip(CLIPS, 'walk'))).toBe('Walk Fast');
    expect(resolvedName(resolveClip(CLIPS, 'ATTACK'))).toBe('Attack - 1');
  });

  it('точное совпадение бьёт подстроку при любом порядке клипов в модели', () => {
    const idle = makeClip('Idle', 1);
    const melee = makeClip('2H_Melee_Idle', 1);
    // Оба порядка проверяются намеренно: порядок задаёт экспортёр модели, и
    // тест на одном из них прошёл бы и на старом «первый подходящий».
    for (const clips of [[idle, melee], [melee, idle]]) {
      expect(resolvedName(resolveClip(clips, 'Idle'))).toBe('Idle');
      expect(resolvedName(resolveClip(clips, 'idle'))).toBe('Idle'); // регистр не важен
    }
  });

  it('не совпавшая запись — «не разрешено», фолбэка на первый клип нет', () => {
    expect(resolveClip(CLIPS, 'Spell Slam').status).toBe('missing');
    expect(resolveClip([], 'Stand').status).toBe('missing');
  });

  it('несколько совпадений по подстроке — неоднозначность с именами кандидатов', () => {
    const clips = [makeClip('Dodge_Forward', 0.6), makeClip('Dodge_Backward', 0.6)];
    const resolution = resolveClip(clips, 'Dodge');
    expect(resolution.status).toBe('ambiguous');
    expect(resolution.status === 'ambiguous' ? resolution.candidates : []).toEqual([
      'Dodge_Forward',
      'Dodge_Backward',
    ]);
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
    const { controller, warnings } = makeController({ states: { idle: 'Stand' }, events: {} });
    controller.setState('idle');
    controller.setState('move');
    expect(controller.currentClipName).toBe('Stand - 1');
    // Отсутствие записи — не ошибка и не повод шуметь (REND-4); предупреждает
    // только запись, которая есть, но ни во что не разрешается.
    expect(warnings).toEqual([]);
  });
});

describe('AnimationController: неразрешённая запись манифеста (REND-4)', () => {
  it('запись с опечаткой — одно предупреждение, прежний клип, произвольный не играет', () => {
    const { controller, warnings } = makeController({ states: { idle: 'Stand', move: 'Wolk' } });
    controller.setState('idle');
    controller.setState('move');
    expect(controller.currentClipName).toBe('Stand - 1');

    // Контроллер зовут на каждой смене состояния — предупреждение одно на запись.
    controller.setState('idle');
    controller.setState('move');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('Wolk');
  });

  it('запись, совпавшая по подстроке с несколькими клипами, диагностируется как неоднозначная', () => {
    const clips = [
      makeClip('Stand - 1', 1),
      makeClip('Dodge_Forward', 0.6),
      makeClip('Dodge_Backward', 0.6),
    ];
    const { controller, warnings } = makeController(
      { states: { idle: 'Stand', move: 'Dodge' } },
      clips,
    );
    controller.setState('idle');
    controller.setState('move');
    expect(controller.currentClipName).toBe('Stand - 1');
    expect(warnings.length).toBe(1);
    // Предупреждение называет и запись, и конкурентов — иначе автор манифеста
    // не знает, чем уточнить имя.
    expect(warnings[0]).toContain('Dodge');
    expect(warnings[0]).toContain('Dodge_Forward');
    expect(warnings[0]).toContain('Dodge_Backward');
  });

  it('неразрешённое событие не играет one-shot и не рвёт локомоцию', () => {
    const { controller, warnings } = makeController({
      states: { move: 'Walk' },
      events: { CastFireball: 'Attak' },
    });
    controller.setState('move');
    expect(controller.handleEvent('CastFireball')).toBe(false);
    expect(controller.currentClipName).toBe('Walk Fast');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('Attak');
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
