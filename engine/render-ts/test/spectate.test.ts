/**
 * Наблюдение за сущностью и кинематографический путь (CAM-10): перебор
 * субъектов по доставленному состоянию и оценка пути по данным манифеста.
 *
 * Ни один тест не создаёт графического контекста: и перебор, и оценка — данные
 * (то же основание, что у headless-теста позы, CAM-1, и у машинного описания
 * типов эффектов, CAM-9).
 */
import { describe, expect, it } from 'vitest';
import type { CameraPathDef } from '@fluxus/assets';
import {
  CAMERA_PATH_DESCRIPTION,
  CAMERA_PATH_EASINGS,
  CameraPath,
  CameraPathPlayer,
  CameraRig,
  SpectatorSubjects,
  createCameraInput,
  easeParameter,
  resetCameraInput,
  type CameraInput,
  type CameraPathDefaults,
  type SpectatorEntityView,
} from '../src/index.js';

const PLAYER_STAT = 'slot';
const TEAM_STAT = 'team';

/** Доставленная сущность стенда: статы — те же имена, что объявляет контент (HUD-8). */
function delivered(id: number, stats?: Record<string, number>): SpectatorEntityView {
  return stats === undefined
    ? { id }
    : { id, stats: new Map(Object.entries(stats)) };
}

function subjects(): SpectatorSubjects {
  return new SpectatorSubjects({ playerStat: PLAYER_STAT, teamStat: TEAM_STAT });
}

// ------------------------------------------------------- субъект наблюдения

describe('перебор субъектов наблюдения (CAM-10)', () => {
  it('кандидаты отбираются объявленным статом, а не типом и не кодом камеры', () => {
    const spectate = subjects();
    spectate.sync([
      delivered(4, { [PLAYER_STAT]: 1 }),
      delivered(7), // без статов вовсе — снаряд, декорация
      delivered(9, { hp: 10 }), // статы есть, объявленного нет
      delivered(2, { [PLAYER_STAT]: 0 }),
    ]);
    expect([...spectate.candidates]).toEqual([2, 4]);
  });

  it('порядок детерминирован и не зависит от порядка обхода доставки', () => {
    const forward = subjects();
    const backward = subjects();
    const entities = [5, 1, 9, 3].map((id) => delivered(id, { [PLAYER_STAT]: id }));
    forward.sync(entities);
    backward.sync([...entities].reverse());
    expect([...forward.candidates]).toEqual([1, 3, 5, 9]);
    expect([...backward.candidates]).toEqual([1, 3, 5, 9]);
  });

  it('перебор цикличен в обе стороны', () => {
    const spectate = subjects();
    spectate.sync([1, 2, 3].map((id) => delivered(id, { [PLAYER_STAT]: id })));
    expect(spectate.current?.entity).toBe(1);
    expect(spectate.next()?.entity).toBe(2);
    expect(spectate.next()?.entity).toBe(3);
    // За последним — первый.
    expect(spectate.next()?.entity).toBe(1);
    // И назад через край.
    expect(spectate.prev()?.entity).toBe(3);
  });

  it('субъект несёт значение объявленного стата команды; без стата — null', () => {
    const withTeam = subjects();
    withTeam.sync([delivered(1, { [PLAYER_STAT]: 0, [TEAM_STAT]: 3 })]);
    expect(withTeam.current?.team).toBe(3);

    const без = new SpectatorSubjects({ playerStat: PLAYER_STAT });
    без.sync([delivered(1, { [PLAYER_STAT]: 0, [TEAM_STAT]: 3 })]);
    expect(без.current?.team).toBeNull();
  });

  it('смена состава субъекта не меняет: пока он в доставке, он текущий', () => {
    const spectate = subjects();
    spectate.sync([2, 5].map((id) => delivered(id, { [PLAYER_STAT]: id })));
    spectate.next(); // субъект — 5
    expect(spectate.current?.entity).toBe(5);
    // Пришли новые кандидаты, в том числе с меньшим id.
    spectate.sync([1, 2, 5, 9].map((id) => delivered(id, { [PLAYER_STAT]: id })));
    expect(spectate.current?.entity).toBe(5);
    expect([...spectate.candidates]).toEqual([1, 2, 5, 9]);
  });

  it('исчезнувший субъект уступает СЛЕДУЮЩЕМУ по порядку, а не первому', () => {
    const spectate = subjects();
    spectate.sync([1, 4, 7].map((id) => delivered(id, { [PLAYER_STAT]: id })));
    spectate.select(4);
    spectate.sync([1, 7].map((id) => delivered(id, { [PLAYER_STAT]: id })));
    expect(spectate.current?.entity).toBe(7);
  });

  it('кандидатов не осталось — субъекта нет, и это ответ, а не отказ', () => {
    const spectate = subjects();
    spectate.sync([delivered(1, { [PLAYER_STAT]: 0 })]);
    spectate.sync([]);
    expect(spectate.current).toBeNull();
    expect(spectate.next()).toBeNull();
    expect(spectate.prev()).toBeNull();
  });

  it('перемотка субъекта не меняет: выбор наблюдателя не входит в откатываемое (CAM-5)', () => {
    const spectate = subjects();
    const roster = [1, 2, 3].map((id) => delivered(id, { [PLAYER_STAT]: id }));
    spectate.sync(roster);
    spectate.select(3);
    // Перемотка приносит те же сущности заново (snapAll, REND-2) — и не меняет
    // ни субъекта, ни порядка: откат камере не виден (CAM-5, CAM-10).
    for (let i = 0; i < 5; i++) spectate.sync(roster);
    expect(spectate.current?.entity).toBe(3);
  });

  it('выбор чужой сущности отвергается, а текущий субъект не трогается', () => {
    const spectate = subjects();
    spectate.sync([1, 2].map((id) => delivered(id, { [PLAYER_STAT]: id })));
    expect(spectate.select(99)).toBe(false);
    expect(spectate.current?.entity).toBe(1);
    expect(spectate.select(2)).toBe(true);
    expect(spectate.current?.entity).toBe(2);
  });
});

// ------------------------------------------------- кинематографический путь

const DEFAULTS: CameraPathDefaults = { distance: 16, yaw: Math.PI / 2, pitch: 0.9, fovDeg: 45 };

function pathOf(def: CameraPathDef): CameraPath {
  return new CameraPath(def, DEFAULTS);
}

describe('оценка кинематографического пути (CAM-10)', () => {
  const straight: CameraPathDef = {
    keys: [
      { x: 0, y: 0, duration: 2 },
      { x: 10, y: 0, duration: 2 },
      { x: 10, y: 10 },
    ],
  };

  it('чистая функция времени: тот же момент даёт то же самое', () => {
    const path = pathOf(straight);
    const a = { ...path.poseAt(1.3) };
    const b = { ...path.poseAt(1.3) };
    expect(b).toEqual(a);
  });

  it('ключи — узлы: в момент ключа поза равна его каналам', () => {
    const path = pathOf(straight);
    expect(path.poseAt(0).x).toBeCloseTo(0, 6);
    const middle = path.poseAt(2);
    expect(middle.x).toBeCloseTo(10, 6);
    expect(middle.y).toBeCloseTo(0, 6);
    const end = path.poseAt(4);
    expect(end.x).toBeCloseTo(10, 6);
    expect(end.y).toBeCloseTo(10, 6);
  });

  it('канал, ключом не названный, берёт действующее значение конфига (сценарий CAM-10)', () => {
    const pose = pathOf(straight).poseAt(1);
    expect(pose.distance).toBe(DEFAULTS.distance);
    expect(pose.pitch).toBe(DEFAULTS.pitch);
    expect(pose.fovDeg).toBe(DEFAULTS.fovDeg);
    expect(pose.yaw).toBe(DEFAULTS.yaw);
  });

  it('курс идёт по КРАТЧАЙШЕЙ дуге, а не через весь круг', () => {
    const path = pathOf({
      keys: [
        { x: 0, y: 0, yaw: 0.1, duration: 1 },
        { x: 1, y: 0, yaw: TAU_MINUS },
      ],
    });
    // Между 0.1 и −0.1 (то есть 2π − 0.1) кратчайший путь идёт ЧЕРЕЗ ноль.
    const middle = path.poseAt(0.5).yaw;
    expect(Math.abs(middle)).toBeLessThan(0.1);
  });

  it('сглаживание действует на ПАРАМЕТР отрезка — одинаково на все каналы', () => {
    const eased = pathOf({
      keys: [
        { x: 0, y: 0, distance: 10, duration: 1, easing: 'easeIn' },
        { x: 10, y: 0, distance: 20 },
      ],
    });
    const linear = pathOf({
      keys: [
        { x: 0, y: 0, distance: 10, duration: 1 },
        { x: 10, y: 0, distance: 20 },
      ],
    });
    const half = eased.poseAt(0.5);
    const plain = linear.poseAt(0.5);
    // `easeIn` на половине даёт 0.25 параметра: и точка, и дистанция отстают
    // ровно в одинаковой доле — «плавно приехала точка, рывком дистанция» не бывает.
    expect(half.distance).toBeCloseTo(12.5, 6);
    expect(plain.distance).toBeCloseTo(15, 6);
    expect(half.x).toBeLessThan(plain.x);
  });

  it('время за пределами пути прижимается к его краям, кольцо — заворачивается', () => {
    const open = pathOf(straight);
    expect(open.poseAt(-5).x).toBeCloseTo(0, 6);
    expect(open.poseAt(999).y).toBeCloseTo(10, 6);
    expect(open.finished(4)).toBe(true);

    const loop = pathOf({ ...straight, keys: [...straight.keys.slice(0, 2), { x: 10, y: 10, duration: 2 }], loop: true });
    expect(loop.finished(999)).toBe(false);
    // Полный оборот кольца возвращает в ту же позу.
    expect(loop.poseAt(6).x).toBeCloseTo(loop.poseAt(0).x, 6);
  });

  it('путь из одного ключа — постоянная поза, а не отказ', () => {
    const single = pathOf({ keys: [{ x: 3, y: 4 }] });
    expect(single.poseAt(0).x).toBe(3);
    expect(single.poseAt(100).y).toBe(4);
    expect(single.finished(0)).toBe(true);
  });

  it('незнакомое сглаживание идёт линейно: манифест переживает код (ASSET-17)', () => {
    expect(easeParameter('нет-такого', 0.25)).toBe(0.25);
    for (const name of CAMERA_PATH_EASINGS) {
      expect(easeParameter(name, 0)).toBeCloseTo(0, 6);
      expect(easeParameter(name, 1)).toBeCloseTo(1, 6);
    }
  });

  it('описание пути — единственный перечень каналов и сглаживаний (CAM-9-образец)', () => {
    const names = CAMERA_PATH_DESCRIPTION.channels.map((one) => one.name);
    expect(names).toContain('x');
    expect(names).toContain('y');
    // Точка наблюдения обязательна, прочее — нет: путь о ней и есть.
    const required = CAMERA_PATH_DESCRIPTION.channels.filter((one) => one.required);
    expect(required.map((one) => one.name)).toEqual(['x', 'y']);
    expect(CAMERA_PATH_DESCRIPTION.easings).toEqual(CAMERA_PATH_EASINGS);
    // Человекочитаемых формулировок в описании нет ни одной (CAM-9).
    expect(JSON.stringify(CAMERA_PATH_DESCRIPTION)).not.toMatch(/[А-Яа-я]/);
  });
});

const TAU_MINUS = Math.PI * 2 - 0.1;

// ------------------------------------------------------- режим пути у рига

describe('режим кинематографического пути у конвейера (CAM-10)', () => {
  const def: CameraPathDef = {
    keys: [
      { x: 0, y: 0, duration: 1 },
      { x: 10, y: 0 },
    ],
  };

  function rig(): { rig: CameraRig; input: CameraInput; path: CameraPath } {
    const built = new CameraRig({ startX: 0, startY: 0 });
    return { rig: built, input: createCameraInput(), path: pathOf(def) };
  }

  it('запуск переводит в режим пути, а поза идёт из его данных', () => {
    const bench = rig();
    bench.rig.playPath(bench.path);
    expect(bench.rig.mode).toBe('path');
    bench.rig.update(bench.input, 0.5, null);
    // Половина отрезка — половина пути между ключами.
    expect(bench.rig.focusX).toBeCloseTo(5, 3);
    expect(bench.rig.pathTime).toBeCloseTo(0.5, 6);
  });

  it('доигранный путь возвращает в режим, из которого был запущен', () => {
    const bench = rig();
    // Запуск из follow: туда же и возврат.
    expect(bench.rig.mode).toBe('follow');
    bench.rig.playPath(bench.path);
    bench.rig.update(bench.input, 0.6, null);
    expect(bench.rig.mode).toBe('path');
    bench.rig.update(bench.input, 0.6, null);
    expect(bench.rig.mode).toBe('follow');
    // Камера осталась там, где путь её оставил: возврат без скачка.
    expect(bench.rig.focusX).toBeCloseTo(10, 3);
  });

  it('ввод панорамирования забирает камеру у пути немедленно (сценарий CAM-10)', () => {
    const bench = rig();
    bench.rig.playPath(bench.path);
    bench.rig.update(bench.input, 0.3, null);
    const stopped = bench.rig.focusX;
    bench.input.panX = 1;
    bench.rig.update(bench.input, 1 / 60, null);
    expect(bench.rig.mode).not.toBe('path');
    // Панорама уже двигает камеру сама — от точки, где путь её оставил.
    expect(bench.rig.focusX).toBeGreaterThan(stopped);
  });

  it('явное открепление тоже прерывает путь, а `stopPath` — вход остановки', () => {
    const detach = rig();
    detach.rig.playPath(detach.path);
    detach.input.detach = true;
    detach.rig.update(detach.input, 1 / 60, null);
    resetCameraInput(detach.input);
    expect(detach.rig.mode).toBe('free');

    const stopped = rig();
    stopped.rig.playPath(stopped.path);
    stopped.rig.stopPath();
    expect(stopped.rig.mode).toBe('follow');
    expect(stopped.rig.pathTime).toBe(0);
  });

  it('кольцо камеру не отпускает: путь идёт, пока его не остановят', () => {
    const bench = rig();
    bench.rig.playPath(pathOf({ keys: [{ x: 0, y: 0, duration: 1 }, { x: 10, y: 0, duration: 1 }], loop: true }));
    for (let i = 0; i < 200; i++) bench.rig.update(bench.input, 1 / 60, null);
    expect(bench.rig.mode).toBe('path');
  });

  it('проигрыватель отдаёт последнюю позу и останавливается сам', () => {
    const player = new CameraPathPlayer();
    expect(player.advance(1)).toBeNull();
    player.start(pathOf(def));
    expect(player.active).toBe(true);
    expect(player.advance(0.5)?.x).toBeCloseTo(5, 3);
    // Кадр, на котором путь кончился, показывает его КОНЕЦ, а не прежнюю позу.
    expect(player.advance(0.6)?.x).toBeCloseTo(10, 3);
    expect(player.active).toBe(false);
    expect(player.advance(0.1)).toBeNull();
  });
});
