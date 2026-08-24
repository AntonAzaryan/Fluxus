/**
 * Доставляемые геймплейные статы (`match-hud` HUD-8) — весь путь: конфигурация
 * сборки воркера → плоская форма → кодек → доставленное состояние главного
 * потока. Имена статов едут ОДИН РАЗ в handshake (SHELL-5), кадр несёт пары
 * «индекс имени → значение» разреженно.
 *
 * Проверяется наблюдаемое виджетом (HUD-8): объявленный стат доезжает под своим
 * именем, стата без компонента-источника нет вовсе (а не ноль), переименование
 * компонента правит конфигурацию, а не код, и буферная дисциплина канала
 * (SHELL-3) от статов не разъезжается.
 */
import { describe, expect, it } from 'vitest';
import { tick } from '@fluxus/core';
import { Extractor, ViewBuffer, kindByTags, type StatSource } from '@fluxus/render';
import { RemoteHost, WorkerShell, readTick, requiredBytes, writeTick } from '../src/index.js';
import {
  PLAYER_ID,
  TICK_SECONDS,
  dummyContext,
  makeRig,
  snapshotView,
  syncPortPair,
} from './fixtures.js';

/** Слот игрока — единственный стат, источник которого в фикстуре есть. */
const SLOT_STAT: StatSource = { name: 'slot', component: 'Player', field: 'slot' };
/** Стат, объявленный «на вырост»: компонента здоровья в сцене фикстуры нет. */
const HP_STAT: StatSource = { name: 'hp', component: 'Health', field: 'hp' };
/** Стат fixed-поля: через границу он обязан приехать в мировых единицах (REND-1). */
const AIM_STAT: StatSource = { name: 'aim', component: 'Input', field: 'aimDir' };

function extractorWith(rig: ReturnType<typeof makeRig>, stats: readonly StatSource[]): Extractor {
  return new Extractor({
    kindOf: kindByTags(['Hero']),
    terrainGrid: rig.scene.terrain!.grid,
    stats,
  });
}

/** Один тик через кодек в буфер доставки: то же, что делает канал (SHELL-3). */
function deliver(stats: readonly StatSource[]): ViewBuffer {
  const rig = makeRig();
  const extractor = extractorWith(rig, stats);
  const ext = extractor.extract(tick(rig.sim, rig.state));
  const buffer = new ArrayBuffer(requiredBytes(ext.count, 0, ext.statPairs));
  writeTick(buffer, ext);
  const view = new ViewBuffer({ tickSeconds: TICK_SECONDS, clock: () => 0 });
  // Имена приезжают отдельно — как их отдаёт handshake, а не кадр.
  view.apply(readTick(buffer, [], ext.kindTable, extractor.statNames));
  return view;
}

describe('Extractor: статы объявляются конфигурацией сборки (HUD-8)', () => {
  it('объявленный стат доезжает под своим именем', () => {
    const view = deliver([SLOT_STAT]);
    const hero = [...view.view.entities.values()][0]!;
    expect(view.view.statNames).toEqual(['slot']);
    expect(hero.stats!.get('slot')).toBe(0);
  });

  it('стата без компонента-источника нет вовсе — ноль не выдумывается', () => {
    const view = deliver([SLOT_STAT, HP_STAT]);
    const hero = [...view.view.entities.values()][0]!;
    // Имя в словаре доставки есть — виджету будет на что забиндиться, — а
    // значения у сущности нет: «нет данных», а не 0 (HUD-8).
    expect(view.view.statNames).toEqual(['slot', 'hp']);
    expect(hero.stats!.has('hp')).toBe(false);
    expect(hero.stats!.get('hp')).toBeUndefined();
  });

  it('сборка без статов не везёт ни имён, ни значений', () => {
    const view = deliver([]);
    const hero = [...view.view.entities.values()][0]!;
    expect(view.view.statNames).toEqual([]);
    expect(hero.stats?.size ?? 0).toBe(0);
  });

  it('поле типа fixed приезжает в мировых единицах — конверсия на границе (REND-1)', () => {
    const rig = makeRig();
    const extractor = extractorWith(rig, [AIM_STAT]);
    // Ввод с направлением: fixed-поле мира ненулевое.
    const ext = extractor.extract(
      tick(rig.sim, rig.state, [
        {
          tick: rig.state.tick + 1,
          playerId: PLAYER_ID,
          seq: 1,
          move: { x: 0, y: 0 },
          aimDir: 1 << 16, // 1.0 в Q16.16
          buttons: 1,
        },
      ]),
    );
    expect(ext.statPairs).toBe(1);
    expect(ext.statValue[0]).toBeCloseTo(1, 6);
  });

  it('переименование компонента в контенте — правка конфигурации, а не кода', () => {
    // Тот же виджетный контракт («имя hp»), другой источник в мире: меняется
    // ЗАПИСЬ конфигурации, экстрактор и кодек остаются те же.
    const renamed = deliver([{ name: 'hp', component: 'Player', field: 'slot' }]);
    const hero = [...renamed.view.entities.values()][0]!;
    expect(hero.stats!.get('hp')).toBe(0);
  });
});

describe('Кодек: статы разреженно, имена — в handshake (SHELL-3, SHELL-5)', () => {
  it('кадр без статов не растёт от появления секции', () => {
    const rig = makeRig();
    const bare = extractorWith(rig, []).extract(tick(rig.sim, rig.state));
    expect(requiredBytes(bare.count, 0, bare.statPairs)).toBe(requiredBytes(bare.count, 0));
  });

  it('кадр со статами растёт ровно на доставленные пары', () => {
    const rig = makeRig();
    const ext = extractorWith(rig, [SLOT_STAT, HP_STAT]).extract(tick(rig.sim, rig.state));
    // Источник есть только у одного стата — пара одна, а не две.
    expect(ext.statPairs).toBe(1);
    const grown = requiredBytes(ext.count, 0, ext.statPairs) - requiredBytes(ext.count, 0);
    // Пара — 8 байт значения плюс 4 байта индекса; полный размер кадра выровнен
    // по 8 (секция f64 идёт сразу за заголовком), поэтому 12 байт полезной
    // нагрузки дают 16 байт кадра. Растёт он на ПАРЫ, а не на число статов в
    // конфигурации: незаехавший `hp` в кадре не занимает ничего.
    expect(grown).toBe(16);
    expect(requiredBytes(ext.count, 0, 2) - requiredBytes(ext.count, 0, 1)).toBe(8);
  });

  it('имена статов через границу не едут — кадр несёт индексы', () => {
    const rig = makeRig();
    const extractor = extractorWith(rig, [SLOT_STAT]);
    const ext = extractor.extract(tick(rig.sim, rig.state));
    const buffer = new ArrayBuffer(requiredBytes(ext.count, 0, ext.statPairs));
    writeTick(buffer, ext);
    // Читатель без словаря имён видит пары, но имени за ними нет: словарь —
    // handshake, а не кадр (SHELL-5).
    const wire = readTick(buffer, [], []);
    expect(wire.statPairs).toBe(1);
    expect(wire.statIndex[0]).toBe(0);
    expect(wire.statNames).toEqual([]);
  });
});

describe('Оболочка: словарь статов приезжает handshake\'ом (SHELL-5, HUD-8)', () => {
  it('имена объявлены воркером, значения читаются главным потоком', () => {
    const rig = makeRig();
    const [workerPort, mainPort] = syncPortPair();
    const shell = new WorkerShell({
      mode: 'local',
      port: workerPort,
      sim: rig.sim,
      state: rig.state,
      tickSeconds: TICK_SECONDS,
      extractor: extractorWith(rig, [SLOT_STAT, HP_STAT]),
      playerId: PLAYER_ID,
      clock: () => 0,
    });

    let names: readonly string[] | undefined;
    const remote = new RemoteHost(dummyContext(), {
      clock: () => 0,
      onReady: (hello) => {
        names = hello.statNames;
      },
    }).connect(mainPort);
    shell.start();
    expect(names).toEqual(['slot', 'hp']);

    shell.stepTick();
    const view = remote.view!;
    const hero = [...view.entities.values()][0]!;
    expect(view.statNames).toEqual(['slot', 'hp']);
    expect(hero.stats!.get('slot')).toBe(0);
    expect(hero.stats!.has('hp')).toBe(false);
    // Доставленное состояние остаётся сравнимым снимком: статы — его часть.
    expect(snapshotView(view)).toMatchObject({ tick: 1 });
  });
});
