/**
 * Анимационный контроллер (REND-4): выбор клипа по манифесту (состояние →
 * клип, событие → one-shot), кроссфейд, возврат в локомоцию, смерть с
 * фиксацией последнего кадра, ход клипа по знаку часов презентации (REND-25).
 * Всё headless: микшеру WebGL не нужен.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  AnimationController,
  MixerAnimationBackend,
  VatAnimationBackend,
  resolveClip,
} from '../src/index.js';

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

/** Скелет с одной костью, микшер над ним и бэкенд детального яруса. */
function makeBackend(clips: readonly THREE.AnimationClip[] = CLIPS) {
  const root = new THREE.Group();
  const bone = new THREE.Object3D();
  bone.name = 'b0';
  root.add(bone);
  const mixer = new THREE.AnimationMixer(root);
  return { backend: new MixerAnimationBackend(mixer, clips), mixer, bone };
}

function makeController(
  mapping: import('../src/index.js').AnimationMapping = {
    states: { idle: 'Stand', move: 'Walk' },
    events: { CastFireball: 'Attack', EntityDied: 'Death' },
  },
  clips: readonly THREE.AnimationClip[] = CLIPS,
) {
  const { backend, mixer, bone } = makeBackend(clips);
  const warnings: string[] = [];
  const controller = new AnimationController(backend, mapping, {
    warn: (message: string) => warnings.push(message),
  });
  return { controller, mixer, bone, warnings };
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

describe('MixerAnimationBackend: ход клипа по знаку часов (REND-25)', () => {
  /**
   * Поза кости — то, что видно в кадре: трек фикстуры ведёт `b0.position.z`
   * от нуля к единице ровно за длительность клипа, и по нему читается фаза.
   */
  it('нулевые часы замораживают позу, отрицательные отматывают клип назад', () => {
    const { backend, bone } = makeBackend();
    backend.playLoop(0, 0.15); // 'Stand - 1', длительность 1 с
    // Первый шаг длиннее кроссфейда: дальше вес действия — единица, и поза
    // читается фазой клипа, а не долей входа в него.
    backend.update(0.3);
    expect(bone.position.z).toBeCloseTo(0.3, 5);

    // Мир замер (REND-25): кадры идут, фаза стоит.
    backend.update(0);
    backend.update(0);
    expect(bone.position.z).toBeCloseTo(0.3, 5);

    backend.update(-0.1);
    expect(bone.position.z).toBeCloseTo(0.2, 5);

    // Через начало клипа: зацикленный клип заворачивается на хвост, а не
    // упирается в нулевой кадр.
    backend.update(-0.3);
    expect(bone.position.z).toBeCloseTo(0.9, 5);

    // Возобновление: вперёд с текущей фазы, рывка анимационного времени нет.
    backend.update(0.05);
    expect(bone.position.z).toBeCloseTo(0.95, 5);
  });

  it('кроссфейд дренируется по модулю: обратный ход его доигрывает, а не вешает', () => {
    const { backend, bone } = makeBackend();
    backend.playLoop(0, 0.15); // 'Stand - 1'
    backend.update(0.5);
    expect(bone.position.z).toBeCloseTo(0.5, 5);

    // Смена клипа заводит переход, и тут же начинается перемотка.
    backend.playLoop(1, 0.15); // 'Walk Fast' с фазы 0
    for (let i = 0; i < 12; i++) backend.update(-1 / 60); // 0.2 с > 0.15 с перехода

    // Переход отыгран: позу целиком ведёт входящий клип, отмотанный к своему
    // хвосту (0 − 0.2 → 0.8). Отматывайся конверт вместе с фазами, вес входящего
    // клипа вернулся бы к нулю и в кадре остался бы уходящий.
    expect(bone.position.z).toBeCloseTo(0.8, 3);
  });
});

describe('AnimationController: one-shot при обратном ходе (REND-25)', () => {
  it('активный one-shot отступает к своему началу и уступает клипу состояния', () => {
    const { controller } = makeController();
    controller.setState('move');
    controller.handleEvent('CastFireball'); // 'Attack - 1', 0.5 с
    controller.update(0.2);
    expect(controller.currentClipName).toBe('Attack - 1');

    controller.update(-0.1); // ещё внутри клипа — one-shot держится
    expect(controller.currentClipName).toBe('Attack - 1');

    controller.update(-0.2); // дошёл до начала — возврат в локомоцию
    expect(controller.currentClipName).toBe('Walk Fast');
  });

  it('пауза one-shot не снимает: нулевые часы — не «клип доигран»', () => {
    const { controller } = makeController();
    controller.setState('move');
    controller.handleEvent('CastFireball');
    for (let i = 0; i < 10; i++) controller.update(0);
    expect(controller.currentClipName).toBe('Attack - 1');
  });

  it('one-shot, доигранный до перемотки, обратным ходом не воскресает', () => {
    const { controller } = makeController();
    controller.setState('move');
    controller.handleEvent('CastFireball');
    controller.update(0.7); // атака доиграна, вернулись в локомоцию
    expect(controller.currentClipName).toBe('Walk Fast');

    // Принятое упрощение (design D5): «раз-финишить» клип микшеру нечем, а
    // позы сущностей всё равно ведёт доставленное состояние (REND-4).
    for (let i = 0; i < 30; i++) controller.update(-1 / 60);
    expect(controller.currentClipName).toBe('Walk Fast');
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

  it('снап доставки смерть снимает: перемотка через неё возвращает клип состояния', () => {
    const { controller } = makeController();
    controller.setState('move');
    controller.handleEvent('EntityDied');
    controller.update(2);
    expect(controller.isDead).toBe(true);

    // Разрыв непрерывности (REND-2): мир авторитетно другой — перемотка вернула
    // сущность к жизни. Событие смерти в прошлом «не разэмитится», и снап
    // остаётся единственным указанием, по которому контроллер узнаёт об этом.
    controller.onSnap();

    expect(controller.isDead).toBe(false);
    expect(controller.currentClipName).toBe('Walk Fast');
    // И события снова слышны: труп их игнорировал.
    expect(controller.handleEvent('CastFireball')).toBe(true);
  });

  it('снап живого контроллера ничего не переигрывает', () => {
    const { controller } = makeController();
    controller.setState('move');
    controller.handleEvent('CastFireball');
    controller.update(0.2);
    expect(controller.currentClipName).toBe('Attack - 1');

    // Снап приходит и на обычном реплее, и на смене ветви истории — сбивать им
    // фазу живого one-shot не за чем: его ведёт своя шкала.
    controller.onSnap();

    expect(controller.currentClipName).toBe('Attack - 1');
  });
});

/**
 * Возрождение (REND-4): сцена вправе сделать смерть не терминальной, вернув
 * сущность ТЕМ ЖЕ идентификатором. Мир при этом идёт вперёд и непрерывен —
 * снапа нет, и снять фиксацию последнего кадра может только названное сборкой
 * событие. Имя события — данные сборки, а не литерал кода.
 */
describe('AnimationController: возрождение снимает фиксацию смерти (REND-4)', () => {
  /** Контроллер, которому сборка назвала событие возрождения. */
  function makeReviving(
    mapping: import('../src/index.js').AnimationMapping = {
      states: { idle: 'Stand', move: 'Walk' },
      events: { CastFireball: 'Attack', EntityDied: 'Death' },
    },
  ) {
    const { backend } = makeBackend();
    const warnings: string[] = [];
    const controller = new AnimationController(backend, mapping, {
      reviveEvent: 'HeroRespawned',
      warn: (message: string) => warnings.push(message),
    });
    return { controller, warnings };
  }

  it('событие возрождения возвращает клип состояния и слух к событиям', () => {
    const { controller } = makeReviving();
    controller.setState('move');
    controller.handleEvent('EntityDied');
    controller.update(2); // клип смерти доигран и зафиксирован
    expect(controller.isDead).toBe(true);
    expect(controller.currentClipName).toBe('Death');

    expect(controller.handleEvent('HeroRespawned')).toBe(true);

    expect(controller.isDead).toBe(false);
    expect(controller.currentClipName).toBe('Walk Fast');
    expect(controller.handleEvent('CastFireball')).toBe(true);
  });

  it('возвращается клип ТЕКУЩЕГО состояния, а не того, в котором застала смерть', () => {
    const { controller } = makeReviving();
    controller.setState('move');
    controller.handleEvent('EntityDied');
    controller.update(2);
    // Труп лежит на точке смерти, а доставка продолжает называть состояние:
    // герой возрождается стоящим на спавне, и клип обязан быть его.
    controller.setState('idle');
    expect(controller.currentClipName).toBe('Death'); // фиксация держится

    controller.handleEvent('HeroRespawned');

    expect(controller.currentClipName).toBe('Stand - 1');
  });

  it('возрождение живого — no-op: фазу его one-shot оно не сбивает', () => {
    const { controller } = makeReviving();
    controller.setState('move');
    controller.handleEvent('CastFireball');
    controller.update(0.2);
    expect(controller.currentClipName).toBe('Attack - 1');

    // Событие возрождения приходит на КАЖДОГО возрождённого героя, а слышат
    // его контроллеры всех — живому оно ничего не значит.
    expect(controller.handleEvent('HeroRespawned')).toBe(false);

    expect(controller.currentClipName).toBe('Attack - 1');
  });

  it('без названного сборкой имени то же событие ничего не значит', () => {
    // Умолчания у возрождения нет: смерть — конвенция ядра, возрождение
    // описывает сцена. Сборка, не назвавшая события, ведёт себя как раньше.
    const { controller } = makeController();
    controller.setState('move');
    controller.handleEvent('EntityDied');
    controller.update(2);

    expect(controller.handleEvent('HeroRespawned')).toBe(false);

    expect(controller.isDead).toBe(true);
    expect(controller.currentClipName).toBe('Death');
  });

  it('манифест вправе назначить возрождению клип — он играет обычным one-shot', () => {
    const { controller } = makeReviving({
      states: { idle: 'Stand', move: 'Walk' },
      events: { CastFireball: 'Attack', EntityDied: 'Death', HeroRespawned: 'Attack' },
    });
    controller.setState('move');
    controller.handleEvent('EntityDied');
    controller.update(2);

    controller.handleEvent('HeroRespawned');
    expect(controller.isDead).toBe(false);
    expect(controller.currentClipName).toBe('Attack - 1');

    // И по его завершении — возврат в локомоцию по общему правилу REND-4.
    controller.update(0.6);
    expect(controller.currentClipName).toBe('Walk Fast');
  });
});

/**
 * Фиксация смерти БЕЗ события (REND-4): доставленное состояние называет
 * сущность мёртвой, а гибели этот контроллер не видел — так встаёт инстанс,
 * созданный по состоянию (труп из тумана, FOW-8; сущность, умершая до первого
 * снапшота наблюдателя). Клип тот же, что у события, но не проигрывается:
 * поза конечная сразу.
 */
describe('AnimationController: фиксация смерти по состоянию (REND-4)', () => {
  it('встаёт последним кадром клипа смерти, не разыгрывая гибель', () => {
    const { controller } = makeController();
    controller.setState('move');

    expect(controller.enterDeath()).toBe(true);
    expect(controller.isDead).toBe(true);
    expect(controller.currentClipName).toBe('Death');

    // Кадр не «доигрывает» клип: он уже на конце, и нулевой шаг ничего не
    // меняет — фиксация держится, состояния и события не слышны.
    controller.update(0);
    expect(controller.currentClipName).toBe('Death');
    controller.setState('idle');
    expect(controller.currentClipName).toBe('Death');
    expect(controller.handleEvent('CastFireball')).toBe(false);
  });

  it('повторный вход — no-op; клип смерти без записи манифеста не подставляется', () => {
    const { controller } = makeController();
    controller.enterDeath();
    expect(controller.enterDeath()).toBe(false);

    // Манифест без записи смерти: фиксация не ставится, произвольный клип
    // не подставляется (REND-4) — отсутствие записи не ошибка.
    const bare = makeController({ states: { idle: 'Stand', move: 'Walk' }, events: {} });
    bare.controller.setState('move');
    expect(bare.controller.enterDeath()).toBe(false);
    expect(bare.controller.isDead).toBe(false);
    expect(bare.controller.currentClipName).toBe('Walk Fast');
  });

  it('снятие по состоянию возвращает клип текущего состояния', () => {
    const { controller } = makeController();
    controller.setState('move');
    controller.handleEvent('EntityDied');
    controller.update(2);
    expect(controller.isDead).toBe(true);

    // Сцена возродила сущность СВОЕЙ системой, событие которой сборка назвать
    // не успела: снятие приходит доставленным состоянием, а не именем события.
    expect(controller.releaseDeath()).toBe(true);
    expect(controller.isDead).toBe(false);
    expect(controller.currentClipName).toBe('Walk Fast');
    expect(controller.handleEvent('CastFireball')).toBe(true);
    // Живому снимать нечего — фазу его one-shot это не сбивает.
    expect(controller.releaseDeath()).toBe(false);
  });
});

/**
 * Паритет ярусов (REND-20): фиксация по состоянию — часть машины, а машина у
 * ярусов одна. Батчевый носитель обязан вставать в тот же последний кадр, что
 * и микшер, — и так же не звать возврат в локомоцию.
 */
describe('VatAnimationBackend: кадр-фиксатор батчевого яруса (REND-20, REND-4)', () => {
  /** Две запечённых секвенции: `Walk` кадры 0..3, `Death` кадры 4..7 при 10 fps. */
  const BAKED = [
    { name: 'Walk', offset: 0, length: 4, duration: 0.4, loop: true },
    { name: 'Death', offset: 4, length: 4, duration: 0.4, loop: false },
  ];

  it('встаёт последним кадром клипа и не сообщает о завершении one-shot', () => {
    const backend = new VatAnimationBackend(BAKED, 10, 99);
    let finished = 0;
    backend.onOneShotFinished = (): void => { finished++; };

    backend.playFinal(1);

    expect(backend.currentClip).toBe(1);
    // Последний кадр секвенции — `offset + length - 1`, без подмешивания
    // следующего: смеси на конце клипа нет.
    expect(backend.rowA).toBe(7);
    expect(backend.rowB).toBe(7);
    expect(backend.blend).toBe(0);

    // Кадр фиксацию не двигает, и возврата в локомоцию не случается.
    backend.update(1);
    expect(backend.rowA).toBe(7);
    expect(finished).toBe(0);
  });

  it('поза равна той, которой кончается доигранный one-shot того же клипа', () => {
    const played = new VatAnimationBackend(BAKED, 10, 99);
    played.playOnce(1, 0);
    played.update(1); // доигран и зафиксирован clampWhenFinished-путём
    const frozen = new VatAnimationBackend(BAKED, 10, 99);
    frozen.playFinal(1);

    expect({ a: frozen.rowA, b: frozen.rowB, blend: frozen.blend }).toEqual({
      a: played.rowA,
      b: played.rowB,
      blend: played.blend,
    });
  });
});
