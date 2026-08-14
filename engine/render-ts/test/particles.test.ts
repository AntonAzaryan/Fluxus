/**
 * Подсистема частиц (REND-24): эмиттеры от доставленного presentation-состояния,
 * one-shot'ы от reliable-событий, decoration-эмиттеры от набора декораций.
 * Эффекты — эмиттерные ассеты (ASSET-14), записи — манифест визуалов.
 *
 * Проверяется наблюдаемое: эмиттер появляется и гаснет вместе со своим
 * источником, выстрел играет ровно один раз и возвращается в пул, перемотка
 * гасит проигрываемое и живые частицы, сокет двигает эмиттер за узлом инстанса,
 * а его отсутствие — предупреждение один раз и позиция сущности; новый эффект —
 * запись манифеста, и переподача её доносит.
 *
 * Документы эффектов — настоящие, записанные самой библиотекой частиц: фикстура
 * ловит дрейф её формата, ради которого версия и запинена точно.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ParticleEffectDocument, VisualManifest } from '@game-mvp/assets';
import {
  ModelsSubsystem,
  ParticlesSubsystem,
  type RenderContext,
  type SocketSource,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeTickView } from './fixtures.js';

function fixture(name: string): ParticleEffectDocument {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as ParticleEffectDocument;
}

/** Зацикленный факел и короткий одноразовый всплеск. */
const TORCH = 'vfx/torch.effect.json';
const BURST = 'vfx/burst.effect.json';
const torchDoc = fixture('torch.effect.json');
const burstDoc = fixture('burst.effect.json');

/** Порядок состояний сборки — он же словарь битов `EntityView.states` (CAM-6). */
const STATE_COMPONENTS = ['Falling', 'Poisoned'];
/** Бит состояния `Poisoned` в маске доставленных состояний. */
const POISONED = 1 << 1;

function makeManifest(): VisualManifest {
  return {
    entities: {},
    decorations: {
      Torch: { effect: TORCH },
    },
    particles: {
      byKind: { Fireball: { effect: TORCH, socket: 'Socket_Tail' } },
      byState: { Poisoned: { effect: TORCH, scale: 2 } },
      byEvent: { FireballExploded: { effect: BURST } },
    },
  };
}

interface RigOptions {
  readonly manifest?: VisualManifest;
  readonly sockets?: SocketSource;
  /** Не отдавать документы ассетов — проверка недоступной ссылки. */
  readonly missing?: boolean;
}

function makeRig(options: RigOptions = {}) {
  const manifest = options.manifest ?? makeManifest();
  const assets = makeAssets();
  if (options.missing !== true) {
    assets.resolve('particle-effect', TORCH, torchDoc);
    assets.resolve('particle-effect', BURST, burstDoc);
  }
  const scene = new THREE.Scene();
  const ctx: RenderContext = { scene, assets: assets.service, config: { heightStep: 0.5 } };
  const warnings: string[] = [];
  const subsystem = new ParticlesSubsystem(manifest, {
    stateComponents: STATE_COMPONENTS,
    sockets: options.sockets,
    warn: (m) => warnings.push(m),
  });
  subsystem.init(ctx);
  return { subsystem, scene, warnings, assets, ctx };
}

/** Прогон нескольких кадров часами кадра (SHELL-7). */
function frames(subsystem: ParticlesSubsystem, count: number, dt = 0.1): void {
  for (let i = 0; i < count; i++) subsystem.updateFrame(dt, 1);
}

/** Инстанс модели с названным узлом — вход резолва сокета (REND-24). */
function makeSockets(node: THREE.Object3D | null, rootAt = new THREE.Vector3()): SocketSource {
  const root = new THREE.Group();
  root.position.copy(rootAt);
  if (node !== null) root.add(node);
  return { instanceFor: () => ({ model: { root } }) };
}

describe('ParticlesSubsystem: оболочка живёт со своим источником (REND-24)', () => {
  it('появляется с сущностью своего типа и исчезает вместе с ней', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    expect(subsystem.activeCount).toBe(1);
    expect(subsystem.emitterFor(1)!.effect).toBe(TORCH);

    subsystem.syncTick(makeTickView([]));
    expect(subsystem.activeCount).toBe(0);
    expect(subsystem.emitterFor(1)).toBeNull();
  });

  it('состояние появилось — частицы появились; исчезло — исчезли (сценарий «Частицы дебафа»)', () => {
    const { subsystem } = makeRig();
    const hero = (states: number) => makeEntityView(1, { kind: 'Hero', states });

    subsystem.syncTick(makeTickView([hero(0)]));
    expect(subsystem.activeCount).toBe(0);

    subsystem.syncTick(makeTickView([hero(POISONED)]));
    expect(subsystem.emitterFor(1, 'state:Poisoned')!.effect).toBe(TORCH);

    subsystem.syncTick(makeTickView([hero(0)]));
    expect(subsystem.emitterFor(1, 'state:Poisoned')).toBeNull();
    expect(subsystem.activeCount).toBe(0);
  });

  it('оболочки типа и состояния сосуществуют на одной сущности', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball', states: POISONED })]));
    expect(subsystem.activeCount).toBe(2);
    expect(subsystem.emitterFor(1, 'kind:Fireball')).not.toBeNull();
    expect(subsystem.emitterFor(1, 'state:Poisoned')).not.toBeNull();
  });

  it('состояние вне списка сборки — предупреждение один раз, второго словаря нет', () => {
    const { subsystem, warnings } = makeRig({
      manifest: { entities: {}, particles: { byState: { Burning: { effect: TORCH } } } },
    });
    subsystem.syncTick(makeTickView([makeEntityView(1, { states: 0xff })]));
    subsystem.syncTick(makeTickView([makeEntityView(2, { states: 0xff })]));
    expect(subsystem.activeCount).toBe(0);
    expect(warnings.filter((m) => m.includes('Burning'))).toHaveLength(1);
  });

  it('оболочка садится по интерполированной позиции и высоте уровня (REND-2, REND-7)', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { kind: 'Hero', states: POISONED, prevX: 0, currX: 4, currY: 2, prevY: 2, currLevel: 2, prevLevel: 2 }),
      ]),
    );
    subsystem.updateFrame(0.016, 0.5);
    const object = subsystem.emitterFor(1, 'state:Poisoned')!.object;
    expect(object.position.x).toBeCloseTo(2, 6);
    expect(object.position.y).toBeCloseTo(2, 6);
    expect(object.position.z).toBeCloseTo(1, 6); // 2 уровня × шаг 0.5
    // Множитель записи применён (REND-24: `scale` записи эмиттера).
    expect(object.scale.x).toBeCloseTo(2, 6);
  });
});

describe('ParticlesSubsystem: выстрел по событию (REND-24, HUD-5)', () => {
  const explosion = (data: Record<string, number>) =>
    makeTickView([], { freshEvents: true, events: [{ type: 'FireballExploded', data }] });

  it('играет свою длительность по часам кадра и возвращается в пул', () => {
    const { subsystem } = makeRig();
    // Координаты события — Q16.16, как их эмитировала система (REND-1).
    subsystem.syncTick(explosion({ x: 65536 * 4, y: 65536 * 5 }));
    expect(subsystem.activeCount).toBe(1);

    subsystem.updateFrame(0.1, 1);
    expect(subsystem.activeCount).toBe(1);
    expect(subsystem.particleCount).toBeGreaterThan(0);

    // Тик без событий выстрел не переигрывает — он доигрывает свою жизнь.
    subsystem.syncTick(makeTickView([]));
    frames(subsystem, 8);
    expect(subsystem.activeCount).toBe(0);
    expect(subsystem.particleCount).toBe(0);
  });

  it('нечестный проход событий не проигрывает (OBS-5)', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(
      makeTickView([], { freshEvents: false, events: [{ type: 'FireballExploded', data: { x: 0, y: 0 } }] }),
    );
    expect(subsystem.activeCount).toBe(0);
  });

  it('событие без записи в манифесте выстрела не порождает', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(
      makeTickView([], { freshEvents: true, events: [{ type: 'CastFireball', data: { x: 0, y: 0 } }] }),
    );
    expect(subsystem.activeCount).toBe(0);
  });

  it('перемотка гасит выстрел и живые частицы, оболочку восстанавливает доставка (REND-2)', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(explosion({ x: 0, y: 0 }));
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    frames(subsystem, 2);
    expect(subsystem.activeCount).toBe(2);
    expect(subsystem.particleCount).toBeGreaterThan(0);

    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })], { snapAll: true }));
    // Выстрела нет, оболочка производна от состояния и осталась, а частиц не
    // осталось ни у кого: разрыв непрерывности гасит проигрываемое.
    expect(subsystem.activeCount).toBe(1);
    expect(subsystem.emitterFor(1)).not.toBeNull();
    expect(subsystem.particleCount).toBe(0);
  });

  it('зацикленный документ по событию всё равно одноразовый', () => {
    const { subsystem } = makeRig({
      manifest: { entities: {}, particles: { byEvent: { Boom: { effect: TORCH } } } },
    });
    subsystem.syncTick(makeTickView([], { freshEvents: true, events: [{ type: 'Boom', data: { x: 0, y: 0 } }] }));
    expect(subsystem.activeCount).toBe(1);
    subsystem.syncTick(makeTickView([]));
    frames(subsystem, 40);
    expect(subsystem.activeCount).toBe(0);
  });
});

describe('ParticlesSubsystem: сокет (REND-24)', () => {
  it('эмиттер следует мировой позе названного узла инстанса', () => {
    const node = new THREE.Object3D();
    node.name = 'Socket_Tail';
    node.position.set(1, 0, 2);
    const { subsystem } = makeRig({ sockets: makeSockets(node, new THREE.Vector3(10, 0, 0)) });

    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball', currX: 3, currY: 3 })]));
    subsystem.updateFrame(0.016, 1);
    const object = subsystem.emitterFor(1)!.object;
    // Позиция сущности (3, 3) не при чём: эмиттер сидит на узле (11, 0, 2).
    expect(object.position.x).toBeCloseTo(11, 6);
    expect(object.position.y).toBeCloseTo(0, 6);
    expect(object.position.z).toBeCloseTo(2, 6);

    // Инстанс переехал — эмиттер за ним, поза снимается каждый кадр.
    node.position.set(1, 5, 2);
    subsystem.updateFrame(0.016, 1);
    expect(object.position.y).toBeCloseTo(5, 6);
  });

  it('узла нет — предупреждение один раз и позиция сущности', () => {
    const { subsystem, warnings } = makeRig({ sockets: makeSockets(null) });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball', currX: 3, currY: 4 })]));
    frames(subsystem, 3, 0.016);

    const object = subsystem.emitterFor(1)!.object;
    expect(object.position.x).toBeCloseTo(3, 6);
    expect(object.position.y).toBeCloseTo(4, 6);
    expect(warnings.filter((m) => m.includes('Socket_Tail'))).toHaveLength(1);
  });

  it('источника инстансов нет — эмиттер играет в позиции сущности и говорит об этом', () => {
    const { subsystem, warnings } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball', currX: 2, currY: 2 })]));
    frames(subsystem, 2, 0.016);
    expect(subsystem.emitterFor(1)!.object.position.x).toBeCloseTo(2, 6);
    expect(warnings.filter((m) => m.includes('Socket_Tail'))).toHaveLength(1);
  });
});

describe('ParticlesSubsystem: decoration-эмиттеры (REND-18, REND-24)', () => {
  const torch = (id: number, x: number) =>
    makeEntityView(id, { kind: 'Torch', prevX: x, currX: x, prevY: 1, currY: 1 });

  it('вид-эмиттер набора декораций рисуется этой подсистемой (сценарий «Факел на арене»)', () => {
    const { subsystem } = makeRig();
    subsystem.syncDecorations(new Map([[1, torch(1, 5)]]));
    subsystem.updateFrame(0.016, 1);
    const emitter = subsystem.decorationEmitterFor(1)!;
    expect(emitter.effect).toBe(TORCH);
    expect(emitter.object.position.x).toBeCloseTo(5, 6);
    expect(subsystem.emitterFor(1)).toBeNull(); // наборы разные, нумерация своя
  });

  it('правка записи набор не мигает: ключ тот же — экземпляр тот же', () => {
    const { subsystem } = makeRig();
    subsystem.syncDecorations(new Map([[1, torch(1, 5)]]));
    const before = subsystem.decorationEmitterFor(1)!.object;

    subsystem.syncDecorations(new Map([[1, torch(1, 7)]]));
    subsystem.updateFrame(0.016, 1);
    expect(subsystem.decorationEmitterFor(1)!.object).toBe(before);
    expect(before.position.x).toBeCloseTo(7, 6);

    // Размещение убрано из набора — эмиттер погас.
    subsystem.syncDecorations(new Map());
    expect(subsystem.decorationEmitterFor(1)).toBeNull();
    expect(subsystem.activeCount).toBe(0);
  });

  it('модельный decoration-вид этой подсистеме не принадлежит', () => {
    const { subsystem } = makeRig({
      manifest: { entities: {}, decorations: { Rock: { model: 'rock.mdx' } } },
    });
    subsystem.syncDecorations(new Map([[1, makeEntityView(1, { kind: 'Rock' })]]));
    expect(subsystem.activeCount).toBe(0);
  });

  it('эмиттерный вид не получает magenta-заглушки моделей (ASSET-4, ASSET-14)', () => {
    const { assets, ctx } = makeRig();
    const warnings: string[] = [];
    const models = new ModelsSubsystem(makeManifest(), { warn: (m) => warnings.push(m) });
    models.init({ ...ctx, assets: assets.service });
    models.syncDecorations(new Map([[1, makeEntityView(1, { kind: 'Torch' })]]));
    models.updateFrame(0.016, 1);

    expect(models.instanceFor(1, true)!.placeholder).toBe(false);
    expect(warnings).toHaveLength(0);
  });
});

describe('ParticlesSubsystem: данные, а не код (REND-24, REND-17)', () => {
  it('новый эффект — запись манифеста; переподача её доносит', () => {
    const manifest = makeManifest();
    const { subsystem } = makeRig({ manifest });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Rune' })]));
    expect(subsystem.activeCount).toBe(0);

    subsystem.applyManifest({
      ...manifest,
      particles: { ...manifest.particles, byKind: { ...manifest.particles?.byKind, Rune: { effect: BURST } } },
    });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Rune' })]));
    expect(subsystem.emitterFor(1)!.effect).toBe(BURST);
  });

  it('переподача пересводит живые эмиттеры обоих наборов единственным правилом', () => {
    const manifest = makeManifest();
    const { subsystem } = makeRig({ manifest });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    subsystem.syncDecorations(new Map([[1, makeEntityView(1, { kind: 'Torch' })]]));
    expect(subsystem.activeCount).toBe(2);

    // Записи не стало — не стало и эмиттеров, без пере-инициализации подсистемы.
    subsystem.applyManifest({ entities: {} });
    expect(subsystem.activeCount).toBe(0);
  });

  it('манифест без секции частиц: ни запроса ассета, ни объекта, ни предупреждения', () => {
    // Подсистема зарегистрирована в каждой сборке рендера (задача 3.1), и цена
    // её присутствия для сцены, частиц не заводившей, обязана быть нулевой:
    // секции нет, эмиттерных decoration-видов нет — рисовать нечего и спросить
    // не у кого. Иначе «добавили подсистему» означало бы «изменили каждую
    // существующую сцену».
    const { subsystem, assets, warnings } = makeRig({
      manifest: { entities: { Hero: { model: 'models/hero.mdx' } }, decorations: { Rock: { model: 'models/rock.mdx' } } },
    });
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Hero', states: POISONED })], {
        freshEvents: true,
        events: [{ type: 'FireballExploded', data: { x: 0, y: 0 } }],
      }),
    );
    subsystem.syncDecorations(new Map([[2, makeEntityView(2, { kind: 'Rock' })]]));
    frames(subsystem, 3);

    expect(assets.requests).toEqual([]);
    expect(subsystem.activeCount).toBe(0);
    expect(subsystem.particleCount).toBe(0);
    expect(subsystem.batchCount).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('недоступный эмиттерный ассет — предупреждение один раз и пропуск, а не отказ кадра', () => {
    const { subsystem, assets, warnings } = makeRig({ missing: true });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    assets.fail('particle-effect', TORCH, 'нет файла');
    subsystem.syncTick(makeTickView([makeEntityView(2, { kind: 'Fireball' })]));
    subsystem.updateFrame(0.016, 1);

    expect(subsystem.activeCount).toBe(0);
    expect(warnings.filter((m) => m.includes(TORCH))).toHaveLength(1);
  });
});

describe('ParticlesSubsystem: пул и батчи (REND-24)', () => {
  const explosion = makeTickView([], {
    freshEvents: true,
    events: [{ type: 'FireballExploded', data: { x: 0, y: 0 } }],
  });

  it('отыгравший выстрел возвращается в пул: экземпляр один на все три выстрела', () => {
    const { subsystem } = makeRig();
    for (let i = 0; i < 3; i++) {
      subsystem.syncTick(explosion);
      frames(subsystem, 8);
      expect(subsystem.activeCount).toBe(0);
      expect(subsystem.pooledCount).toBe(1);
    }
  });

  it('одновременных выстрелов больше, чем экземпляров, — пул растёт до пика и стоит', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(explosion);
    subsystem.syncTick(explosion);
    expect(subsystem.activeCount).toBe(2);
    expect(subsystem.pooledCount).toBe(2);

    frames(subsystem, 8);
    subsystem.syncTick(explosion);
    expect(subsystem.pooledCount).toBe(2);
  });

  it('сотня эмиттеров одного эффекта рисуется одним батчем (сценарий «Сотня факелов»)', () => {
    const { subsystem } = makeRig();
    const decorations = new Map(
      Array.from({ length: 100 }, (_, i) => [i + 1, makeEntityView(i + 1, { kind: 'Torch', currX: i })] as const),
    );
    subsystem.syncDecorations(decorations);
    subsystem.updateFrame(0.1, 1);
    expect(subsystem.activeCount).toBe(100);
    expect(subsystem.batchCount).toBe(1);
  });
});

describe('Частицы и picking (REND-15, REND-24)', () => {
  it('подсистема не является источником объёмов-прокси', () => {
    const { subsystem } = makeRig();
    expect('eachProxy' in subsystem).toBe(false);
    expect('proxyOf' in subsystem).toBe(false);
  });

  it('луч сцены батчи частиц не видит', () => {
    const { subsystem, scene } = makeRig();
    subsystem.syncDecorations(new Map([[1, makeEntityView(1, { kind: 'Torch' })]]));
    subsystem.updateFrame(0.1, 1);

    const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
    expect(raycaster.intersectObject(scene, true)).toHaveLength(0);
  });
});
