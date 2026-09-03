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
import { BatchedRenderer, ParticleEmitter } from 'three.quarks';
import type { ParticleEffectDocument, VisualManifest } from '@fluxus/assets';
import {
  ModelsSubsystem,
  ParticlesSubsystem,
  createPickProxy,
  type PickProxy,
  type RenderContext,
  type SocketSource,
} from '../src/index.js';
import {
  ParticleEffectPool,
  instanceParticles,
  stepInstance,
} from '../src/particleEffects.js';
import { makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

function fixture(name: string): ParticleEffectDocument {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as ParticleEffectDocument;
}

/** Зацикленный факел и короткий одноразовый всплеск. */
const TORCH = 'vfx/torch.effect.json';
const BURST = 'vfx/burst.effect.json';
/** Огонь с подчинённым эмиттером искр и документ с `autoDestroy` (design D6). */
const SUB = 'vfx/sub-emitter.effect.json';
const SELF_DESTRUCT = 'vfx/self-destruct.effect.json';
/** Флипбук: атлас кадров 4×2 и поведение, ведущее кадр по жизни частицы. */
const FLIPBOOK = 'vfx/flipbook.effect.json';
const torchDoc = fixture('torch.effect.json');
const burstDoc = fixture('burst.effect.json');
const subDoc = fixture('sub-emitter.effect.json');
const selfDestructDoc = fixture('self-destruct.effect.json');
const flipbookDoc = fixture('flipbook.effect.json');

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
  /**
   * Словарь состояний сборки; не задан — тот же список, что у эффектов и камеры.
   * Пустой — законная сборка без доставленных состояний (вьюпорт редактора).
   */
  readonly stateComponents?: readonly string[];
}

function makeRig(options: RigOptions = {}) {
  const manifest = options.manifest ?? makeManifest();
  const assets = makeAssets();
  if (options.missing !== true) {
    assets.resolve('particle-effect', TORCH, torchDoc);
    assets.resolve('particle-effect', BURST, burstDoc);
    assets.resolve('particle-effect', SUB, subDoc);
    assets.resolve('particle-effect', SELF_DESTRUCT, selfDestructDoc);
    assets.resolve('particle-effect', FLIPBOOK, flipbookDoc);
  }
  const scene = new THREE.Scene();
  const ctx: RenderContext = { scene, assets: assets.service, config: { heightStep: 0.5 } };
  const warnings: string[] = [];
  const subsystem = new ParticlesSubsystem(manifest, {
    stateComponents: options.stateComponents ?? STATE_COMPONENTS,
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

/** Имя узла-сокета записи `particles.byKind.Fireball` манифеста фикстуры. */
const SOCKET_NAME = 'Socket_Tail';

/** Модель снаряда, у которого кроме хвоста из частиц есть и своя запись. */
const MODEL_ID = 'models/fireball.mdx';

/**
 * Подсистема моделей на том же стенде и том же манифесте. Заявка чужой
 * подсистемы (REND-37) наблюдаема только с её стороны: заглушкой,
 * предупреждением и объёмом-прокси, — своего следа в подсистеме частиц у неё
 * нет и быть не должно.
 */
function makeModels(
  manifest: VisualManifest,
  ctx: RenderContext,
  options: { readonly fadeSeconds?: number } = {},
) {
  const warnings: string[] = [];
  const models = new ModelsSubsystem(manifest, { ...options, warn: (m) => warnings.push(m) });
  models.init(ctx);
  return { models, warnings };
}

/** Материал единственного меша под держателем сущности; null — меша нет. */
function holderMaterial(scene: THREE.Scene, name: string): THREE.Material | null {
  const holder = scene.children.find((child) => child.name === name);
  const mesh = holder?.children[0] as Partial<THREE.Mesh> | undefined;
  const material = mesh?.material;
  return material === undefined || Array.isArray(material) ? null : material;
}

/**
 * Источник поз узлов (REND-24): подсистема моделей отвечает на этот вопрос на
 * ОБОИХ ярусах (REND-20), поэтому фикстура — не дерево объектов, а семь чисел.
 * `move()` двигает узел: поза спрашивается каждый кадр, и кэша между кадрами у
 * привязки нет.
 */
function makeSockets(nodeAt: THREE.Vector3 | null) {
  const at = nodeAt === null ? null : nodeAt.clone();
  return {
    source: {
      nodePose: (_entity, node, out) => {
        if (at === null || node !== SOCKET_NAME) return false;
        out.x = at.x;
        out.y = at.y;
        out.z = at.z;
        out.qx = 0;
        out.qy = 0;
        out.qz = 0;
        out.qw = 1;
        return true;
      },
    } satisfies SocketSource,
    move: (x: number, y: number, z: number): void => {
      at?.set(x, y, z);
    },
  };
}

/** Источник без поз узлов вовсе — законная сборка без сокетов (REND-24). */
const NO_SOCKETS: SocketSource = {};

/** Сколько частиц живо у названной системы экземпляра — вход теста суб-эмиттеров. */
function particlesOfNamed(object: THREE.Object3D, name: string): number {
  let total = 0;
  object.traverse((child) => {
    if (child instanceof ParticleEmitter && child.name === name) total += child.system.particleNum;
  });
  return total;
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

    // Два кадра, а не один: первый шаг свежей системы копит эмиссию
    // (`waitEmiting` библиотеки), спавн идёт следующим. Раньше хватало одного —
    // общий `BatchedRenderer.update` шагал только что зарегистрированную
    // систему ДВАЖДЫ за кадр: обновляя её батч, он переставлял её запись в
    // конец `Map` прямо во время обхода. Это была случайность реализации
    // библиотеки, а не правило; по-эмиттерный шаг (REND-38) идёт ровно один раз
    // за кадр, и предмет проверки — «выстрел играет и возвращается в пул» —
    // от этого не меняется.
    subsystem.updateFrame(0.1, 1);
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
  const tailAt = (): THREE.Vector3 => new THREE.Vector3(11, 0, 2);

  it('эмиттер следует мировой позе названного узла инстанса', () => {
    const sockets = makeSockets(tailAt());
    const { subsystem } = makeRig({ sockets: sockets.source });

    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball', currX: 3, currY: 3 })]));
    subsystem.updateFrame(0.016, 1);
    const object = subsystem.emitterFor(1)!.object;
    // Позиция сущности (3, 3) не при чём: эмиттер сидит на узле (11, 0, 2).
    expect(object.position.x).toBeCloseTo(11, 6);
    expect(object.position.y).toBeCloseTo(0, 6);
    expect(object.position.z).toBeCloseTo(2, 6);

    // Инстанс переехал — эмиттер за ним, поза снимается каждый кадр.
    sockets.move(11, 5, 2);
    subsystem.updateFrame(0.016, 1);
    expect(object.position.y).toBeCloseTo(5, 6);
  });

  it('узла нет — предупреждение один раз и позиция сущности', () => {
    // Инстанс ещё строится либо вид такого узла не несёт: источник отдаёт оба
    // одним `false`, и ответ на них один — сказать один раз и играть у ног.
    const { subsystem, warnings } = makeRig({ sockets: makeSockets(null).source });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball', currX: 3, currY: 4 })]));
    frames(subsystem, 3, 0.016);
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball', currX: 3, currY: 4 })]));
    frames(subsystem, 3, 0.016);

    const object = subsystem.emitterFor(1)!.object;
    expect(object.position.x).toBeCloseTo(3, 6);
    expect(object.position.y).toBeCloseTo(4, 6);
    expect(warnings.filter((m) => m.includes('Socket_Tail'))).toHaveLength(1);
  });

  it('источника поз узлов нет — эмиттер играет в позиции сущности и говорит об этом', () => {
    for (const sockets of [undefined, NO_SOCKETS]) {
      const { subsystem, warnings } = makeRig(sockets === undefined ? {} : { sockets });
      subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball', currX: 2, currY: 2 })]));
      frames(subsystem, 2, 0.016);
      expect(subsystem.emitterFor(1)!.object.position.x).toBeCloseTo(2, 6);
      expect(warnings.filter((m) => m.includes('Socket_Tail'))).toHaveLength(1);
    }
  });

  it('батчевый ярус сокету не мешает: поза узла считается на обоих (REND-20)', () => {
    // Прежде сокет требовал ДЕТАЛЬНОГО яруса — обход дерева узлов на батчевом
    // был невозможен, — и запись получала предупреждение вместо эмиттера на
    // месте. Источник отвечает позой, а не деревом, и яруса больше не знает.
    const sockets = makeSockets(tailAt());
    const { subsystem, warnings } = makeRig({ sockets: sockets.source });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball', currX: 6, currY: 7 })]));
    frames(subsystem, 3, 0.016);

    expect(subsystem.emitterFor(1)!.object.position.x).toBeCloseTo(11, 6);
    expect(warnings).toEqual([]);
  });

  it('поза спрашивается каждый кадр: пересборка инстанса эмиттер не замораживает', () => {
    // Кэша найденного узла у привязки нет вовсе (REND-17): держаться было бы
    // не за что, и пересобранный инстанс уводит эмиттер за собой сам собой.
    const sockets = makeSockets(tailAt());
    const { subsystem } = makeRig({ sockets: sockets.source });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    subsystem.updateFrame(0.016, 1);
    const object = subsystem.emitterFor(1)!.object;
    expect(object.position.x).toBeCloseTo(11, 6);

    sockets.move(21, 0, 2);
    subsystem.updateFrame(0.016, 1);
    expect(object.position.x).toBeCloseTo(21, 6);
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

/**
 * Вид, изображение которого манифест отдал секции эмиттеров записью `byKind`
 * (REND-37): рисуют его частицы, а подсистема моделей молчит и даёт ему только
 * объём-прокси. Наблюдается всё это СО СТОРОНЫ МОДЕЛЕЙ — заглушкой,
 * предупреждением и прокси, — поэтому стенд здесь двойной.
 */
describe('Вид, нарисованный только частицами (REND-37)', () => {
  it('сущность вида из particles.byKind заглушки и предупреждения не получает', () => {
    const manifest = makeManifest();
    const { ctx } = makeRig({ manifest });
    const { models, warnings } = makeModels(manifest, ctx);
    // Две сущности одного типа подряд: предупреждение ASSET-6 одно на тип, и
    // пустой список означает, что его не было вовсе, а не что второе съедено
    // дедупом первого.
    models.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Fireball' }), makeEntityView(2, { kind: 'Fireball' })]),
    );
    models.updateFrame(0.016, 1);

    expect(models.instanceFor(1)!.placeholder).toBe(false);
    expect(models.instanceFor(2)!.placeholder).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('опечатка в ключе записи заявкой не становится (сценарий «Опечатка в ключе записи эмиттера»)', () => {
    const manifest: VisualManifest = { entities: {}, particles: { byKind: { Smok: { effect: TORCH } } } };
    const { subsystem, ctx } = makeRig({ manifest });
    const { models, warnings } = makeModels(manifest, ctx);
    const smoke = [makeEntityView(1, { kind: 'Smoke' }), makeEntityView(2, { kind: 'Smoke' })];
    models.syncTick(makeTickView(smoke));
    models.updateFrame(0.016, 1);
    subsystem.syncTick(makeTickView(smoke));

    expect(models.instanceFor(1)!.placeholder).toBe(true);
    expect(warnings.filter((m) => m.includes('Smoke'))).toHaveLength(1);
    // И частиц не досталось ни одному из двух ключей: `Smoke` записи не имеет,
    // а сущностей типа `Smok` в кадре нет.
    expect(subsystem.activeCount).toBe(0);
  });

  it('запись byState заглушки не отменяет — ни на приходе состояния, ни на его уходе', () => {
    // Ключ у `byState` — имя СОСТОЯНИЯ, и вида она не называет: заявить его ей
    // нечем. Иначе заглушка мигала бы вместе с доставленным состоянием.
    const manifest: VisualManifest = { entities: {}, particles: { byState: { Poisoned: { effect: TORCH } } } };
    const { ctx } = makeRig({ manifest });
    const { models, warnings } = makeModels(manifest, ctx);
    const ghost = (states: number): ReturnType<typeof makeEntityView> =>
      makeEntityView(1, { kind: 'Ghost', states });

    // Состояние несёт ПЕРВАЯ доставка: решение о заглушке принимается на
    // создании инстанса, и приди оно позже — ветка решения не выполнилась бы
    // при доставленном состоянии ни разу, а тест краснел бы только от того,
    // что заглушка перестала быть стабильной между кадрами.
    for (const states of [POISONED, 0, POISONED]) {
      models.syncTick(makeTickView([ghost(states)]));
      models.updateFrame(0.016, 1);
      expect(models.instanceFor(1)!.placeholder).toBe(true);
    }
    expect(warnings.filter((m) => m.includes('Ghost'))).toHaveLength(1);
  });

  it('вид с обеими записями byKind заявлен частицами и попадаем (сценарий «Пятно огня со свечением по земле»)', () => {
    // Форма собственного контента репозитория: у `BossFire` есть и эмиттер, и
    // плоская оболочка эффекта, подсвечивающая зону урона по земле. Нарисовано
    // при этом облако частиц, и попадаемость вид терять не вправе — иначе её
    // отнимало бы у него добавленное свечение.
    const manifest: VisualManifest = {
      entities: {},
      effects: { byKind: { Fireball: { primitive: 'sphere', color: '#ff6a1e', radius: 0.6, alpha: 0.12, height: 0 } } },
      particles: { byKind: { Fireball: { effect: TORCH } } },
    };
    const { subsystem, ctx } = makeRig({ manifest });
    const { models, warnings } = makeModels(manifest, ctx);
    const fire = makeEntityView(1, { kind: 'Fireball', prevX: 4, currX: 4, prevY: 3, currY: 3 });
    models.syncTick(makeTickView([fire]));
    models.updateFrame(0.016, 1);
    subsystem.syncTick(makeTickView([fire]));

    expect(models.instanceFor(1)!.placeholder).toBe(false);
    expect(warnings).toEqual([]);
    // Частицы его действительно рисуют — оболочка эффекта их не отменяет.
    expect(subsystem.emitterFor(1)!.effect).toBe(TORCH);

    // И объём-прокси тот же самый, что у вида, заявленного одной лишь секцией
    // эмиттеров: пятно со свечением попадаемо ровно как пятно без него.
    const both: PickProxy = createPickProxy();
    const emitterOnly: PickProxy = createPickProxy();
    expect(models.proxyOf(1, both)).toBe(true);
    const plain = makeModels(makeManifest(), ctx).models;
    plain.syncTick(makeTickView([makeEntityView(2, { kind: 'Fireball', prevX: 4, currX: 4, prevY: 3, currY: 3 })]));
    plain.updateFrame(0.016, 1);
    expect(plain.proxyOf(2, emitterOnly)).toBe(true);
    const box = (p: PickProxy): number[] => [p.minX, p.minY, p.minZ, p.maxX, p.maxY, p.maxZ];
    expect(box(both)).toEqual(box(emitterOnly));
  });

  it('заявка посреди угасания не оставляет fade за прежним мешом (FOW-8)', () => {
    // Смена содержимого держателя обязана закрывать эпизод угасания — тем же
    // порядком, каким его закрывает приезд модели: fade-копии материалов
    // привязаны к КОНКРЕТНЫМ мешам, и снятая заглушка унесла бы выданную копию
    // с собой. Не закрыть его здесь — значит оставить список целей указывать на
    // меш, которого в сцене больше нет, и заглушка, вернувшаяся обратной
    // правкой, не угасала бы уже никогда.
    // Сцена своя, без батчера частиц: проверяется, что после заявки в ней не
    // остаётся НИЧЕГО от инстанса, и чужой объект сделал бы счёт неверным.
    const assets = makeAssets();
    const ctxOf: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    // Длинное угасание: за кадры теста доля до единицы не доходит, и эпизод
    // остаётся живым на всю проверку.
    const { models } = makeModels({ entities: {} }, ctxOf, { fadeSeconds: 10 });
    models.syncTick(makeTickView([makeEntityView(1, { kind: 'Ghost' })]));
    models.updateFrame(0.016, 1);
    const fading = holderMaterial(ctxOf.scene, 'entity:1');
    expect(fading!.opacity).toBeLessThan(1); // заглушка угасает — эпизод идёт

    // Заявка появилась: заглушки не стало, держателя тоже.
    models.applyManifest({ entities: {}, particles: { byKind: { Ghost: { effect: TORCH } } } });
    expect(ctxOf.scene.children).toHaveLength(0);

    // Заявку убрали: заглушка вернулась — и угасает, а не стоит непрозрачной.
    models.applyManifest({ entities: {} });
    models.updateFrame(0.016, 1);
    const restored = holderMaterial(ctxOf.scene, 'entity:1');
    expect(restored).not.toBeNull();
    expect(restored!.opacity).toBeLessThan(1);
  });

  it('снаряд с моделью и хвостом из частиц строится моделью (приоритет модельной записи)', () => {
    const manifest = makeManifest();
    manifest.entities.Fireball = { model: MODEL_ID, tier: 'detailed' };
    const { ctx, assets } = makeRig({ manifest });
    const { models, warnings } = makeModels(manifest, ctx);
    models.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    models.updateFrame(0.016, 1);
    // Модель ещё едет: на этот срок заглушка полагается (ASSET-4) — заявка
    // частиц её не снимает, потому что к такому виду правило не применяется.
    expect(models.instanceFor(1)!.placeholder).toBe(true);

    assets.resolve('model', MODEL_ID, makeModel());
    models.updateFrame(0.016, 1);
    const instance = models.instanceFor(1)!;
    expect(instance.placeholder).toBe(false);
    // Объём-прокси даёт модель, а не фиксированный объём эмиттера.
    expect(instance.bounds).toBe(instance.model!.bounds);
    expect(warnings).toEqual([]);
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

  it('коллизия видов ассета — предупреждение один раз и пропуск, а не отказ кадра', () => {
    // Ключ реестра — пара «вид + формат» (ASSET-3): тот же адрес, уже
    // загруженный моделью, отказывает СИНХРОННО, из самого `request`. Ссылка от
    // этого не становится валиднее, но кадр обязан быть нарисован (REND-24).
    const { subsystem, assets, warnings } = makeRig({ missing: true });
    assets.collide('particle-effect', TORCH, `ассет "${TORCH}" уже загружен как "model"`);
    expect(() => {
      subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
      subsystem.syncTick(makeTickView([makeEntityView(2, { kind: 'Fireball' })]));
      subsystem.updateFrame(0.016, 1);
    }).not.toThrow();

    expect(subsystem.activeCount).toBe(0);
    expect(warnings.filter((m) => m.includes(TORCH))).toHaveLength(1);
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

describe('ParticlesSubsystem: экземпляр — не образец (REND-24, design D6)', () => {
  const subManifest: VisualManifest = {
    entities: {},
    decorations: { Ember: { effect: SUB } },
  };

  it('суб-эмиттеры играют у КАЖДОГО экземпляра, а не у образца', () => {
    // `EmitSubParticleSystem.clone()` библиотеки копирует ссылку на систему
    // ОБРАЗЦА: без пере-связывания суб-частицы не рисуются ни у одного
    // экземпляра, а счётчик образца растёт неограниченно.
    const { subsystem } = makeRig({ manifest: subManifest });
    const ember = (id: number, x: number) =>
      makeEntityView(id, { kind: 'Ember', prevX: x, currX: x });
    subsystem.syncDecorations(new Map([[1, ember(1, 0)], [2, ember(2, 10)]]));
    frames(subsystem, 6);

    const first = subsystem.decorationEmitterFor(1)!.object;
    const second = subsystem.decorationEmitterFor(2)!.object;
    expect(particlesOfNamed(first, 'Fire')).toBeGreaterThan(0);
    expect(particlesOfNamed(second, 'Fire')).toBeGreaterThan(0);
    // Главное: искры родились у обоих экземпляров, а не в общем образце.
    expect(particlesOfNamed(first, 'Sparks')).toBeGreaterThan(0);
    expect(particlesOfNamed(second, 'Sparks')).toBeGreaterThan(0);
    // И считаются они частицами подсистемы — то есть живут в её экземплярах.
    expect(subsystem.particleCount).toBe(
      particlesOfNamed(first, 'Fire') +
        particlesOfNamed(first, 'Sparks') +
        particlesOfNamed(second, 'Fire') +
        particlesOfNamed(second, 'Sparks'),
    );
  });

  it('документ с autoDestroy играет повторно: жизненным циклом владеет пул', () => {
    // Отыграв, документ с `autoDestroy` просит библиотеку снять систему с батча
    // и отцепить эмиттер от узла экземпляра. Экземпляр после этого мёртв
    // навсегда: пул отдаст его следующему употреблению, а играть в нём нечему.
    const { subsystem } = makeRig({
      manifest: { entities: {}, decorations: { Spark: { effect: SELF_DESTRUCT } } },
    });
    const placed = new Map([[1, makeEntityView(1, { kind: 'Spark' })]]);

    for (let take = 0; take < 2; take++) {
      subsystem.syncDecorations(placed);
      frames(subsystem, 2, 0.05);
      expect(subsystem.particleCount, `проигрывание ${take + 1}`).toBeGreaterThan(0);
      // Документ отыграл свою длительность целиком — вот здесь `autoDestroy` и
      // сработал бы, — после чего размещение снимается и экземпляр уходит в пул.
      frames(subsystem, 12);
      subsystem.syncDecorations(new Map());
      expect(subsystem.activeCount).toBe(0);
      // Снятое размещение прекращает эмиссию, а живые частицы доживают
      // (REND-24): экземпляр возвращается в пул сам, и следующее употребление
      // берёт ЕГО, а не заводит второй.
      frames(subsystem, 12);
      expect(subsystem.dyingCount, `догорание ${take + 1}`).toBe(0);
    }
    // Экземпляр всё это время один и тот же — он и вернулся в пул живым.
    expect(subsystem.pooledCount).toBe(1);
  });
});

describe('ParticlesSubsystem: разрыв непрерывности и набор декораций (REND-2, REND-18)', () => {
  it('перемотка гасит оболочки состояния и НЕ трогает decoration-эмиттеры', () => {
    // Смена продюсера, вход и выход из превью, перемотка приходят с потоком
    // тиков; набор декораций от них независим (REND-18), и переподжигать все
    // факелы арены на каждом переключении режима нечем.
    const { subsystem } = makeRig();
    subsystem.syncDecorations(new Map([[1, makeEntityView(1, { kind: 'Torch' })]]));
    subsystem.syncTick(makeTickView([makeEntityView(2, { kind: 'Fireball' })]));
    frames(subsystem, 3);
    const decoration = subsystem.decorationEmitterFor(1)!.object;
    const before = particlesOfNamed(decoration, 'Torch');
    expect(before).toBeGreaterThan(0);

    subsystem.syncTick(makeTickView([makeEntityView(2, { kind: 'Fireball' })], { snapAll: true }));
    // Оболочка сущности перезапущена — частиц у неё не осталось; декорация
    // горит непрерывно тем же экземпляром.
    expect(particlesOfNamed(subsystem.emitterFor(2)!.object, 'Torch')).toBe(0);
    expect(subsystem.decorationEmitterFor(1)!.object).toBe(decoration);
    expect(particlesOfNamed(decoration, 'Torch')).toBe(before);
  });
});

describe('ParticlesSubsystem: словарь состояний сборки (REND-24, CAM-6)', () => {
  const manifest: VisualManifest = {
    entities: {},
    particles: { byState: { Falling: { effect: TORCH } } },
  };

  it('словаря состояний у сборки нет — таблица пропускается молча', () => {
    // Вьюпорт редактора собирает подсистему без списка состояний: доставленных
    // состояний в кадре правки не бывает вовсе (тика здесь нет, ED-15). Ругань
    // на каждое открытие сцены с записью byState была бы ложной.
    const { subsystem, warnings } = makeRig({ manifest, stateComponents: [] });
    subsystem.syncTick(makeTickView([makeEntityView(1, { states: 0xff })]));
    expect(subsystem.activeCount).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('словарь есть, а названного состояния в нём нет — предупреждение один раз', () => {
    const { subsystem, warnings } = makeRig({ manifest, stateComponents: ['Poisoned'] });
    subsystem.syncTick(makeTickView([makeEntityView(1, { states: 0xff })]));
    subsystem.syncTick(makeTickView([makeEntityView(2, { states: 0xff })]));
    expect(subsystem.activeCount).toBe(0);
    expect(warnings.filter((m) => m.includes('Falling'))).toHaveLength(1);
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

  it('размещённый эмиттерный вид попадаем: прокси даёт подсистема моделей (REND-18, ED-17)', () => {
    // Источник объёмов-прокси один (REND-15), и подсистема частиц в нём не
    // участвует, — но выделять, двигать и удалять факел автор обязан тем же
    // способом, что статую: без прокси размещение было бы некликабельным.
    const { assets, ctx } = makeRig();
    const models = new ModelsSubsystem(makeManifest(), { warn: () => {} });
    models.init({ ...ctx, assets: assets.service });
    models.syncDecorations(new Map([[1, makeEntityView(1, { kind: 'Torch', prevX: 4, currX: 4, prevY: 3, currY: 3 })]]));
    models.updateFrame(0.016, 1);

    const proxy: PickProxy = createPickProxy();
    expect(models.proxyOf(1, proxy, true)).toBe(true);
    expect(proxy.decoration).toBe(true);
    expect(proxy.posX).toBeCloseTo(4, 6);
    expect(proxy.posY).toBeCloseTo(3, 6);
    expect(proxy.maxZ - proxy.minZ).toBeGreaterThan(0);
    expect(proxy.maxX - proxy.minX).toBeGreaterThan(0);

    // И тем же объёмом он приходит в общий обход прокси вьюпорта.
    const visited: number[] = [];
    models.eachProxy((p) => visited.push(p.entity));
    expect(visited).toEqual([1]);
  });

  it('сущность, нарисованная частицами, попадаема тем же объёмом (сценарий «Клик по сущности, нарисованной частицами»)', () => {
    // Обе дороги к одному изображению — сущность вида `Fireball` из
    // `particles.byKind` и размещение эмиттерного decoration-вида `Torch`, —
    // и объём попадания у них обязан быть один: второго размера под ту же
    // ситуацию не заведено. Источником прокси подсистема частиц при этом не
    // становится — это держит соседний тест этого же describe.
    const manifest = makeManifest();
    const { ctx } = makeRig({ manifest });
    const { models } = makeModels(manifest, ctx);
    models.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Fireball', prevX: 4, currX: 4, prevY: 3, currY: 3 })]),
    );
    models.syncDecorations(new Map([[2, makeEntityView(2, { kind: 'Torch' })]]));
    models.updateFrame(0.016, 1);

    const entity: PickProxy = createPickProxy();
    const placed: PickProxy = createPickProxy();
    expect(models.proxyOf(1, entity)).toBe(true);
    expect(models.proxyOf(2, placed, true)).toBe(true);
    expect(entity.posX).toBeCloseTo(4, 6);
    expect(entity.posY).toBeCloseTo(3, 6);
    expect(entity.maxZ - entity.minZ).toBeGreaterThan(0);
    const box = (p: PickProxy): number[] => [p.minX, p.minY, p.minZ, p.maxX, p.maxY, p.maxZ];
    expect(box(entity)).toEqual(box(placed));
  });
});

/**
 * Персональная шкала времени сущности (REND-38): шаг симуляции эмиттеров идёт
 * ПО-ЭМИТТЕРНО, и оболочке замедленной сущности достаются её собственные часы.
 * Наблюдаемое — эмиссия: за то же кадровое время замедленный эмиттер выбросил
 * во столько же раз меньше частиц, во сколько замедлена сама сущность.
 *
 * Из-под шкалы выведены обе картинные группы: decoration размещён СЦЕНОЙ и
 * сущности за ним нет (сценарий «Факел рядом с полем замедления»), а выстрел по
 * событию — образ момента мира, чья сущность-источник вправе не пережить свой
 * тик. Обе идут общими часами кадра.
 */
describe('ParticlesSubsystem: персональная шкала времени сущности (REND-38)', () => {
  /** Сколько частиц живо у эмиттера — сумма по всем его системам. */
  function particlesOf(object: THREE.Object3D): number {
    let total = 0;
    object.traverse((child) => {
      if (child instanceof ParticleEmitter) total += child.system.particleNum;
    });
    return total;
  }

  /** Полсекунды кадрами по 1/60 — эмиссия факела за это время ещё не умирает. */
  function halfSecond(subsystem: ParticlesSubsystem): void {
    for (let i = 0; i < 30; i++) subsystem.updateFrame(1 / 60, 1);
  }

  it('оболочка замедленной сущности эмитирует в её темпе, а не в темпе кадра', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { kind: 'Fireball' }),
        makeEntityView(2, { kind: 'Fireball', timeScale: 0.2 }),
      ]),
    );
    halfSecond(subsystem);

    const full = particlesOf(subsystem.emitterFor(1)!.object);
    const slow = particlesOf(subsystem.emitterFor(2)!.object);
    expect(full).toBeGreaterThan(0);
    expect(slow).toBeGreaterThan(0);
    // Пятая часть — с точностью до кадра округления эмиссии библиотекой.
    expect(slow / full).toBeGreaterThan(0.1);
    expect(slow / full).toBeLessThan(0.3);
  });

  it('decoration идёт общими часами: факел в зоне замедления не замедляется', () => {
    const { subsystem } = makeRig();
    // Один и тот же эффект (`TORCH`) у декорации и у замедленной сущности:
    // разница в эмиссии тогда — только темп, а не документ.
    subsystem.syncDecorations(
      new Map([[9, makeEntityView(9, { kind: 'Torch', prevX: 5, currX: 5 })]]),
    );
    subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { kind: 'Fireball' }),
        makeEntityView(2, { kind: 'Fireball', timeScale: 0.2 }),
      ]),
    );
    halfSecond(subsystem);

    const deco = particlesOf(subsystem.decorationEmitterFor(9)!.object);
    const full = particlesOf(subsystem.emitterFor(1)!.object);
    const slow = particlesOf(subsystem.emitterFor(2)!.object);
    expect(deco).toBe(full);
    expect(deco).toBeGreaterThan(slow);
  });

  it('выстрел по событию идёт общими часами, кто бы ни был замедлен рядом', () => {
    const shotParticles = (slowed: boolean): number => {
      const { subsystem } = makeRig();
      const entities = slowed
        ? [makeEntityView(1, { kind: 'Fireball', timeScale: 0.2 })]
        : [makeEntityView(1, { kind: 'Fireball' })];
      subsystem.syncTick(
        makeTickView(entities, {
          freshEvents: true,
          events: [{ type: 'FireballExploded', data: { x: 0, y: 0 } }],
        }),
      );
      for (let i = 0; i < 6; i++) subsystem.updateFrame(1 / 60, 1);
      // Живые частицы всей подсистемы минус частицы оболочки: остаток — выстрел.
      return subsystem.particleCount - particlesOf(subsystem.emitterFor(1)!.object);
    };

    const beside = shotParticles(true);
    expect(beside).toBeGreaterThan(0);
    // Ровно столько же, сколько без замедленной сущности рядом: темп выстрела
    // от чужой шкалы не зависит и от своей не бывает.
    expect(beside).toBe(shotParticles(false));
  });

  it('разный темп эмиттеров батчей не плодит (REND-24)', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { kind: 'Fireball' }),
        makeEntityView(2, { kind: 'Fireball', timeScale: 0.2 }),
        makeEntityView(3, { kind: 'Fireball', timeScale: 0.7 }),
      ]),
    );
    halfSecond(subsystem);
    // Конвейер один на всех — и батч один: по-эмиттерный шаг батчирование не
    // трогает, число draw calls растёт с конвейерами, а не с темпами.
    expect(subsystem.activeCount).toBe(3);
    expect(subsystem.batchCount).toBe(1);
  });
});

/**
 * Шаг экземпляра (`stepInstance`) — единственная точка, где рендер зовёт
 * симуляцию частиц библиотеки (REND-24, REND-38). Метод `ParticleSystem.update`
 * в типах three.quarks приватен, и обход этого сделан структурным типом с
 * рантайм-проверкой; тест пиннит именно его: сменится API библиотеки при
 * апгрейде — падение здесь, а не молчаливо замершая картинка на арене.
 */
describe('stepInstance: рантайм-API шага систем библиотеки (REND-24)', () => {
  it('шаг двигает эмиссию экземпляра', () => {
    const scene = new THREE.Scene();
    const batchRenderer = new BatchedRenderer();
    scene.add(batchRenderer);
    const group = new THREE.Group();
    scene.add(group);
    const warnings: string[] = [];
    const pool = new ParticleEffectPool(batchRenderer, (_key, message) => warnings.push(message));
    const instance = pool.acquire(TORCH, torchDoc, group)!;
    expect(instance).not.toBeNull();

    group.updateMatrixWorld();
    // Первый шаг копит эмиссию (`waitEmiting` библиотеки), второй её выбрасывает.
    stepInstance(instance, 0.1, (_key, message) => warnings.push(message));
    stepInstance(instance, 0.1, (_key, message) => warnings.push(message));
    expect(instanceParticles(instance)).toBeGreaterThan(0);
    // Молчание — часть контракта: предупреждение здесь означало бы, что метода
    // шага у системы больше нет.
    expect(warnings).toEqual([]);
  });

  it('нулевой шаг эмиссию не двигает — заморозка мира её замораживает (REND-25)', () => {
    const scene = new THREE.Scene();
    const batchRenderer = new BatchedRenderer();
    scene.add(batchRenderer);
    const group = new THREE.Group();
    scene.add(group);
    const pool = new ParticleEffectPool(batchRenderer, () => {});
    const instance = pool.acquire(TORCH, torchDoc, group)!;
    group.updateMatrixWorld();
    for (let i = 0; i < 10; i++) stepInstance(instance, 0, () => {});
    expect(instanceParticles(instance)).toBe(0);
  });
});

// ---------------------------------------------------------------- находки §2.6

/** Стенд пула вне подсистемы: батч-рендерер, группа сцены и сам пул. */
function makePoolRig() {
  const scene = new THREE.Scene();
  const batchRenderer = new BatchedRenderer();
  scene.add(batchRenderer);
  const group = new THREE.Group();
  scene.add(group);
  const warnings: string[] = [];
  const pool = new ParticleEffectPool(batchRenderer, (_key, message) => warnings.push(message));
  return { scene, batchRenderer, group, pool, warnings };
}

describe('ParticleEffectPool: трансформ и регистрация в батче — V-5, V-8', () => {
  it('взятие из пула сбрасывает кватернион и масштаб прошлого употребления', () => {
    // Сокетная оболочка копирует на экземпляр мировой поворот КОСТИ. Достанься
    // такой экземпляр декорации или выстрелу, конус эмиссии оказался бы
    // наклонён поворотом, которого в новой позе нет.
    const { pool, group } = makePoolRig();
    const first = pool.acquire(TORCH, torchDoc, group)!;
    first.object.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
    first.object.scale.setScalar(4.5);
    pool.release(first);

    const again = pool.acquire(TORCH, torchDoc, group)!;
    expect(again).toBe(first); // тот же экземпляр — пул работает
    expect(again.object.quaternion.equals(new THREE.Quaternion())).toBe(true);
    expect(again.object.scale.x).toBe(1);
  });

  it('в батче зарегистрированы ЖИВЫЕ экземпляры, а не весь пул', () => {
    // `VFXBatch.update()` перебирает своё множество систем каждый кадр; пуловые
    // экземпляры платили бы за это наравне с играющими — работой по размеру
    // пула (REND-26).
    const { pool, group, batchRenderer } = makePoolRig();
    const instance = pool.acquire(TORCH, torchDoc, group)!;
    const systems = instance.systems.length;
    expect(systems).toBeGreaterThan(0);
    expect(batchRenderer.systemToBatchIndex.size).toBe(systems);

    pool.release(instance);
    expect(batchRenderer.systemToBatchIndex.size).toBe(0);
    // Батч остаётся: конвейер никуда не делся, и следующее взятие попадёт в него.
    const batches = batchRenderer.batches.length;
    expect(batches).toBeGreaterThan(0);

    const again = pool.acquire(TORCH, torchDoc, group)!;
    expect(batchRenderer.systemToBatchIndex.size).toBe(systems);
    expect(batchRenderer.batches).toHaveLength(batches);
    expect(again).toBe(instance);
  });
});

describe('stepInstance: отсоединённый корень не убивает экземпляр — V-11', () => {
  it('шаг экземпляра вне сцены пропускается, и пул остаётся живым', () => {
    // `ParticleSystem.update` библиотеки само-уничтожается, если корень эмиттера
    // — не `Scene`: экземпляр снимается с батча навсегда, и `restart()` его уже
    // не оживит. Отсоединённый экземпляр — обычное состояние пула.
    const { pool, group, warnings } = makePoolRig();
    const instance = pool.acquire(TORCH, torchDoc, group)!;
    pool.release(instance); // снят со сцены — parent === null

    stepInstance(instance, 0.1, (_key, message) => warnings.push(message));

    const again = pool.acquire(TORCH, torchDoc, group)!;
    expect(again).toBe(instance);
    group.updateMatrixWorld();
    stepInstance(again, 0.1, (_key, message) => warnings.push(message));
    stepInstance(again, 0.1, (_key, message) => warnings.push(message));
    expect(instanceParticles(again)).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
  });

  it('корень подсистемы обязан быть сценой: иначе громкий отказ на сборке', () => {
    const assets = makeAssets();
    const subsystem = new ParticlesSubsystem(makeManifest(), { warn: () => {} });
    expect(() => {
      subsystem.init({
        // Группа вместо сцены — ровно тот случай, в котором библиотека молча
        // убивает пул на первом же кадре.
        scene: new THREE.Group() as unknown as THREE.Scene,
        assets: assets.service,
        config: { heightStep: 1 },
      });
    }).toThrow(/THREE.Scene/);
  });
});

describe('ParticlesSubsystem: оболочка гаснет — частицы доживают (REND-24) — V-2', () => {
  it('уход состояния прекращает эмиссию, а живые частицы доживают своё', () => {
    const { subsystem } = makeRig();
    const poisoned = makeEntityView(1, { kind: 'Hero', states: POISONED });
    subsystem.syncTick(makeTickView([poisoned]));
    frames(subsystem, 3);
    const before = subsystem.particleCount;
    expect(before).toBeGreaterThan(0);

    // Состояние перестало доставляться — оболочки не стало.
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Hero', states: 0 })]));
    expect(subsystem.activeCount).toBe(0);
    // …но выпущенные частицы никуда не делись: они догорают.
    expect(subsystem.dyingCount).toBe(1);
    expect(subsystem.particleCount).toBe(before);

    // Дальше частицы только убывают: эмиссия прекращена, и новых не появляется.
    // Первый кадр после гашения ещё выбрасывает накопленный библиотекой остаток
    // (`waitEmiting` последнего шага) — это residue, а не эмиссия.
    frames(subsystem, 1);
    const counts: number[] = [];
    for (let i = 0; i < 5; i++) {
      frames(subsystem, 1);
      counts.push(subsystem.particleCount);
    }
    expect(counts[0]).toBeGreaterThan(0);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]!);
    }

    // И догорев, экземпляр возвращается в пул сам.
    frames(subsystem, 40);
    expect(subsystem.dyingCount).toBe(0);
    expect(subsystem.particleCount).toBe(0);
  });

  it('разрыв непрерывности гасит догорающих немедленно (REND-2)', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Hero', states: POISONED })]));
    frames(subsystem, 3);
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Hero', states: 0 })]));
    expect(subsystem.dyingCount).toBe(1);

    subsystem.syncTick(makeTickView([], { snapAll: true }));

    expect(subsystem.dyingCount).toBe(0);
    expect(subsystem.particleCount).toBe(0);
  });

  it('разрыв, в котором сущность и исчезла, догорающих не оставляет (REND-2)', () => {
    // Гашение обязано идти ПОСЛЕ сведения: эта же доставка убирает сущность, и
    // её оболочка уходит в догорающие ровно в ней. Погаси мы их раньше —
    // догорающий пережил бы разрыв непрерывности.
    const { subsystem } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Hero', states: POISONED })]));
    frames(subsystem, 3);
    expect(subsystem.particleCount).toBeGreaterThan(0);

    subsystem.syncTick(makeTickView([], { snapAll: true }));

    expect(subsystem.dyingCount).toBe(0);
    expect(subsystem.particleCount).toBe(0);
  });

  it('снос подсистемы догорающих не теряет (REND-31)', () => {
    const { subsystem, scene } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Hero', states: POISONED })]));
    frames(subsystem, 3);
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Hero', states: 0 })]));
    expect(subsystem.dyingCount).toBe(1);

    subsystem.dispose();

    expect(subsystem.dyingCount).toBe(0);
    expect(scene.children).toHaveLength(0);
  });
});

describe('ParticlesSubsystem: возраст события доставки (REND-24, SHELL-4) — V-1', () => {
  it('выстрел старого тика приходит уже сыгравшим часть своей длительности', () => {
    const assets = makeAssets();
    assets.resolve('particle-effect', TORCH, torchDoc);
    assets.resolve('particle-effect', BURST, burstDoc);
    const scene = new THREE.Scene();
    const subsystem = new ParticlesSubsystem(makeManifest(), {
      stateComponents: STATE_COMPONENTS,
      tickSeconds: 0.1,
      warn: () => {},
    });
    subsystem.init({ scene, assets: assets.service, config: { heightStep: 1 } });

    // Свежее событие того же тика: ни одного кадра ещё не было — частиц нет.
    subsystem.syncTick(
      makeTickView([], {
        tick: 5,
        freshEvents: true,
        events: [{ type: 'FireballExploded', tick: 5, data: { x: 0, y: 0 } }],
      }),
    );
    expect(subsystem.particleCount).toBe(0);

    // А событие тика 1 приезжает с возрастом 400 мс и догоняет его шагами.
    subsystem.syncTick(
      makeTickView([], {
        tick: 5,
        freshEvents: true,
        events: [{ type: 'FireballExploded', tick: 1, data: { x: 3, y: 3 } }],
      }),
    );
    expect(subsystem.particleCount).toBeGreaterThan(0);
  });
});

describe('ParticlesSubsystem: пол ручки плотности (QUAL-2 через QUAL-3) — V-4', () => {
  it('byKind-эмиттер эмитит на минимуме ручки: зона урона не исчезает', () => {
    const { subsystem } = makeRig();
    const knob = subsystem.quality().knobs.find((entry) => entry.name === 'particles.density')!;
    // Ноль ручка принимать не вправе: эмиттер — изображение сущности (REND-37).
    expect(knob.min).toBeGreaterThan(0);

    subsystem.applyQuality(new Map([['particles.density', knob.min!]]));
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Hero', states: POISONED })]));
    frames(subsystem, 6);

    expect(subsystem.particleCount).toBeGreaterThan(0);
  });
});

describe('ParticlesSubsystem: сокет через прямую позу узла (REND-24, REND-20)', () => {
  it('источник, умеющий `nodePose`, двигает эмиттер без дерева узлов', () => {
    // Шов на будущее: дерево узлов есть только у ДЕТАЛЬНОГО яруса, а поза узла
    // — ответ, который подсистема моделей вправе дать на обоих. Резолв
    // предпочитает её и обходом дерева не пользуется вовсе.
    const calls: string[] = [];
    const sockets: SocketSource = {
      nodePose: (entity, node, out) => {
        calls.push(`${String(entity)}:${node}`);
        // Семь чисел формы источника (REND-20): поворот на π/2 вокруг Z.
        out.x = 7;
        out.y = 8;
        out.z = 9;
        out.qx = 0;
        out.qy = 0;
        out.qz = Math.SQRT1_2;
        out.qw = Math.SQRT1_2;
        return true;
      },
    };
    const { subsystem } = makeRig({ sockets });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    subsystem.updateFrame(0.016, 1);

    const object = subsystem.emitterFor(1)!.object;
    expect(calls).toEqual([`1:${SOCKET_NAME}`]);
    expect(object.position.toArray()).toEqual([7, 8, 9]);
    expect(object.quaternion.z).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('узла нет — предупреждение один раз и позиция сущности', () => {
    const sockets: SocketSource = { nodePose: () => false };
    const { subsystem, warnings } = makeRig({ sockets });
    for (let i = 0; i < 3; i++) {
      subsystem.syncTick(
        makeTickView([makeEntityView(1, { kind: 'Fireball', currX: 2, prevX: 2, currY: 3, prevY: 3 })]),
      );
      subsystem.updateFrame(0.016, 1);
    }
    const object = subsystem.emitterFor(1)!.object;
    expect(object.position.x).toBeCloseTo(2, 6);
    expect(object.position.y).toBeCloseTo(3, 6);
    expect(warnings.filter((m) => m.includes(SOCKET_NAME))).toHaveLength(1);
  });

  it('источник без обоих ответов — законный источник без сокетов', () => {
    const { subsystem, warnings } = makeRig({ sockets: {} });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    subsystem.updateFrame(0.016, 1);
    expect(subsystem.emitterFor(1)).not.toBeNull();
    expect(warnings.filter((m) => m.includes('socket') || m.includes('сокет'))).toHaveLength(1);
  });
});

// ------------------------------- флипбук: атлас кадров (REND-24, ASSET-14)

describe('Флипбук: сетка тайлов документа доезжает до батча (REND-24)', () => {
  const FLIP_MANIFEST: VisualManifest = {
    entities: {},
    particles: { byKind: { Flame: { effect: FLIPBOOK } } },
  };

  /** Батчи библиотеки: подсистема кладёт их корень в сцену своим `init`. */
  function batchesOf(scene: THREE.Scene): BatchedRenderer {
    return scene.getObjectByName('particle-batches') as BatchedRenderer;
  }

  it('атлас 4×2 и смешивание тайлов — настройки конвейера отрисовки', () => {
    // Конвейер батча собирается ИЗ ДОКУМЕНТА: атлас — часть ключа конвейера, и
    // потеряйся он по дороге, частица рисовалась бы целой текстурой вместо
    // кадра. Проверяется поэтому батч, а не поля системы.
    const { subsystem, scene } = makeRig({ manifest: FLIP_MANIFEST });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Flame' })]));
    subsystem.updateFrame(0.1, 1);

    const batch = batchesOf(scene).batches[0]!;
    expect(batch.settings.uTileCount).toBe(4);
    expect(batch.settings.vTileCount).toBe(2);
    expect(batch.settings.blendTiles).toBe(true);
  });

  it('прогрев заводит конвейер флипбука до первого кадра (REND-24)', async () => {
    const { subsystem, scene } = makeRig({ manifest: FLIP_MANIFEST });
    await subsystem.prewarm();

    // Батч с атласом уже есть, а играть ничего не начало: программа шейдера
    // компилируется тёплой сценой, а не кадром первого появления эмиттера.
    expect(batchesOf(scene).batches[0]!.settings.uTileCount).toBe(4);
    expect(subsystem.pooledCount).toBe(1);
    expect(subsystem.activeCount).toBe(0);
    expect(subsystem.particleCount).toBe(0);
  });

  it('поведение кадра над атласом 1×1 — предупреждение один раз, а не отказ', () => {
    // Документ легален: анимировать по сетке из одной клетки нечего, и рендер
    // рисует статичный спрайт. Молчать значило бы оставить автора эффекта
    // гадать, почему анимация не идёт (REND-24).
    const flat = structuredClone(flipbookDoc) as unknown as {
      object: { children: { ps: Record<string, unknown> }[] };
    };
    flat.object.children[0]!.ps.uTileCount = 1;
    flat.object.children[0]!.ps.vTileCount = 1;
    const { subsystem, assets, warnings } = makeRig({
      manifest: { entities: {}, particles: { byKind: { Flame: { effect: 'vfx/flat.effect.json' } } } },
      missing: true,
    });
    assets.resolve('particle-effect', 'vfx/flat.effect.json', flat);

    // Две сущности — два экземпляра, то есть две развёртки: предупреждение
    // всё равно одно.
    subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { kind: 'Flame' }),
        makeEntityView(2, { kind: 'Flame' }),
      ]),
    );

    expect(subsystem.activeCount).toBe(2);
    expect(warnings.filter((m) => m.includes('атласу 1×1'))).toHaveLength(1);
  });
});

// ------------------------------ горячая перезагрузка документов (ED-15)

describe('Правленые эмиттерные ассеты доезжают до кадра (ED-15, ASSET-14)', () => {
  const HOT: VisualManifest = {
    entities: {},
    particles: { byKind: { Flame: { effect: TORCH } } },
  };

  function batchesOf(scene: THREE.Scene): BatchedRenderer {
    return scene.getObjectByName('particle-batches') as BatchedRenderer;
  }

  it('refreshAssets переразбирает документ и заводит живые эмиттеры заново', () => {
    const { subsystem, scene, assets } = makeRig({ manifest: HOT });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Flame' })]));
    frames(subsystem, 2);
    expect(subsystem.activeCount).toBe(1);
    expect(batchesOf(scene).batches[0]!.settings.uTileCount).toBe(1);

    // Дерево контента правлено из-под редактора: по тому же адресу теперь
    // другой документ, а кэш ассетов выброшен целиком (`assetModule.ts`).
    assets.resolve('particle-effect', TORCH, flipbookDoc);
    subsystem.refreshAssets();
    frames(subsystem, 1);

    // Оболочка та же — сущность из доставленного состояния никуда не делась
    // (REND-24), — а играет она уже правленым документом.
    expect(subsystem.activeCount).toBe(1);
    expect(batchesOf(scene).batches[0]!.settings.uTileCount).toBe(4);
    // Конвейер прежнего документа снесён вместе с пулом, а не оставлен рядом
    // (REND-31): иначе каждая правка стоила бы кадру ещё одного батча.
    expect(batchesOf(scene).batches).toHaveLength(1);
  });

  it('ассет запрашивается заново: прежний кэш редактор уже выбросил (ASSET-2)', () => {
    const { subsystem, assets } = makeRig({ manifest: HOT });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Flame' })]));
    const before = assets.requests.filter((request) => request.id === TORCH).length;
    expect(before).toBe(1);

    subsystem.refreshAssets();

    expect(assets.requests.filter((request) => request.id === TORCH)).toHaveLength(2);
  });

  it('без доставленного состояния перезагрузка ничего не заводит', () => {
    // Правка дерева — не доставка: оболочек, которых не было, она не создаёт.
    const { subsystem } = makeRig({ manifest: HOT });
    subsystem.refreshAssets();
    expect(subsystem.activeCount).toBe(0);
    expect(subsystem.pooledCount).toBe(0);
  });
});
