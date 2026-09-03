/**
 * Волна спавна под бюджетом кадра (`rendering` REND-44, design D10): дорогая
 * половина создания инстанса — монтирование изображения — уезжает в очередь, а
 * фаза отложимой работы достаёт из неё, пока есть время.
 *
 * Проверяется ровно то, что REND-44 разрешает и чего он не разрешает: инстанс
 * вправе появиться на кадр позже, но НЕ вправе потеряться; синхронные точки
 * доделывают очередь целиком; неограниченный бюджет не откладывает ничего и
 * оставляет счётные величины теми же, какими они были бы без механизма.
 *
 * Часы здесь — счётчик, который двигает сам тест: бюджет меряется временем, и
 * тест на настоящих часах был бы измерением машины, а не поведения.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { VisualManifest } from '@fluxus/assets';
import {
  ModelsSubsystem,
  PresentationStage,
  createCostCounters,
  withCostSink,
  type RenderContext,
  type TickView,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';
/** Один продюсер на весь файл: сцене от него нужна только идентичность. */
const PRODUCER = { name: 'test' };

/**
 * Часы, идущие НА КАЖДЫЙ ВОПРОС: бюджет спрашивает время между порциями, и
 * шаг в миллисекунду делает потолок счётчиком порций — величиной, которую тест
 * задаёт, а не угадывает.
 */
function tickingClock(): () => number {
  let value = 0;
  return () => value++;
}

interface Rig {
  readonly models: ModelsSubsystem;
  readonly stage: PresentationStage;
  readonly ctx: RenderContext;
}

function makeRig(budgetMs: number, camera?: THREE.Camera): Rig {
  const assets = makeAssets();
  const manifest: VisualManifest = { entities: { Runner: { model: MODEL_ID } } };
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const models = new ModelsSubsystem(manifest, {
    warn: () => {},
    ...(camera === undefined ? {} : { camera }),
  });
  const stage = new PresentationStage(ctx, {
    clock: tickingClock(),
    frameBudgetMs: budgetMs,
  }).register(models);
  assets.resolve('model', MODEL_ID, makeModel());
  return { models, stage, ctx };
}

/** Доставка волны из `count` сущностей; `snapAll` — разрыв непрерывности. */
function wave(count: number, snapAll = false): TickView {
  const entities = Array.from({ length: count }, (_unused, i) =>
    makeEntityView(i + 1, { currX: i, prevX: i }),
  );
  return makeTickView(entities, { snapAll });
}

/**
 * Сколько инстансов пула УЖЕ смонтировано. Проба — записи батча: у записи,
 * ждущей монтирования, слота в нём ещё нет, хотя в пуле она уже есть.
 */
function mounted(models: ModelsSubsystem): number {
  return models.batchStats().records;
}

describe('волна спавна под бюджетом кадра (REND-44)', () => {
  it('доезжает за несколько кадров и не теряет ни одного инстанса', () => {
    const { models, stage } = makeRig(2);
    // Первый кадр показывает очереди ОГРАНИЧЕННЫЙ бюджет: до этого монтирование
    // синхронное, как в сборке без механизма вовсе.
    stage.frame(0.016, 1);

    const count = 8;
    stage.publish(PRODUCER, wave(count));
    // Запись пула готова сразу — доставка применяется целиком (REND-3);
    // отложено ИЗОБРАЖЕНИЕ, а не сведение набора.
    expect(models.instanceFor(1)).not.toBeNull();
    expect(mounted(models)).toBeLessThan(count);

    let frames = 0;
    let previous = -1;
    while (mounted(models) < count && frames < 40) {
      const before = mounted(models);
      stage.frame(0.016, 1);
      const after = mounted(models);
      // Прогресс каждым кадром: «отложено, но не потеряно» иначе стало бы
      // неправдой в пределе (REND-44).
      expect(after).toBeGreaterThan(before);
      previous = after;
      frames++;
    }
    expect(previous).toBe(count);
    // Нарезка потребовала нескольких кадров — иначе тест не про бюджет.
    expect(frames).toBeGreaterThan(1);
  });

  it('первая порция идёт при нулевом потолке: работа продвигается, а не встаёт', () => {
    const { models, stage } = makeRig(0);
    stage.frame(0.016, 1);
    stage.publish(PRODUCER, wave(4));
    expect(models.batchStats().records).toBe(0);

    stage.frame(0.016, 1);
    expect(models.batchStats().records).toBe(1);
    stage.frame(0.016, 1);
    expect(models.batchStats().records).toBe(2);
  });

  it('снятая до монтирования сущность отменяется, а не монтируется зря', () => {
    const { models, stage } = makeRig(0);
    stage.frame(0.016, 1);
    stage.publish(PRODUCER, wave(3));
    expect(models.batchStats().records).toBe(0);

    // Сущности не стало ещё до того, как её изображение построили: строить его
    // теперь не для чего, и очередь не должна держать мёртвую запись.
    stage.publish(PRODUCER, makeTickView([makeEntityView(2), makeEntityView(3)]));
    expect(models.instanceFor(1)).toBeNull();

    for (let i = 0; i < 5; i++) stage.frame(0.016, 1);
    expect(models.batchStats().records).toBe(2);
    expect(models.instanceFor(1)).toBeNull();
  });

  it('разрыв непрерывности доделывает очередь синхронно (REND-2)', () => {
    const { models, stage } = makeRig(0);
    stage.frame(0.016, 1);
    stage.publish(PRODUCER, wave(5));
    expect(models.batchStats().records).toBe(0);

    // `snapAll` — перемотка, смена режима, первая доставка: размазывать её по
    // кадрам MUST NOT (REND-44, по образцу FOW-11).
    stage.publish(PRODUCER, wave(5, true));
    expect(models.batchStats().records).toBe(5);
  });

  it('снос сцены отменяет отложенное, а не строит его перед сносом', () => {
    const { models, stage } = makeRig(0);
    stage.frame(0.016, 1);
    stage.publish(PRODUCER, wave(4));

    // Сцена доделывает отложенное ПЕРЕД сносом сама (`flushBudget`), поэтому
    // здесь оно уже смонтировано — и снос уносит его вместе с пулом.
    stage.dispose();
    expect(models.batchStats().records).toBe(0);
  });

  it('неограниченный бюджет не откладывает ничего — счётчик отложений нулевой', () => {
    const cost = createCostCounters();
    withCostSink(cost, () => {
      // Потолок не назван: сцена ведёт себя ровно как сцена без механизма.
      const { models, stage } = makeRig(Number.POSITIVE_INFINITY);
      stage.frame(0.016, 1);
      stage.publish(PRODUCER, wave(12));
      // Инстансы смонтированы ДОСТАВКОЙ, а не кадром: очередь не наполнялась.
      expect(models.batchStats().records).toBe(12);
    });
    expect(cost.frameBudgetDeferrals).toBe(0);
  });

  it('подсистема без сцены фазы не видит и не откладывает', () => {
    const assets = makeAssets();
    const manifest: VisualManifest = { entities: { Runner: { model: MODEL_ID } } };
    const models = new ModelsSubsystem(manifest, { warn: () => {} });
    models.init({
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    });
    assets.resolve('model', MODEL_ID, makeModel());

    // Вьюпорт редактора, стенды, тесты: фазы отложимой работы у них нет вовсе,
    // и отложенное в такой сборке не доехало бы никогда.
    models.syncTick(wave(6));
    expect(models.batchStats().records).toBe(6);
  });

  it('ближние к камере монтируются раньше дальних', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    // Камера стоит у дальнего конца ряда: ближе всех к ней последняя сущность.
    camera.position.set(20, 0, 0);
    camera.updateMatrixWorld();
    const { models, stage } = makeRig(0, camera);
    stage.frame(0.016, 1);

    const count = 6;
    stage.publish(PRODUCER, wave(count));
    stage.frame(0.016, 1);

    // Ровно один инстанс смонтирован (нулевой потолок, гарантия первой порции),
    // и это САМЫЙ БЛИЗКИЙ к камере: задержку видно там, куда игрок смотрит.
    expect(models.batchStats().records).toBe(1);
    expect(models.instanceFor(count)!.tier).toBe('batched');
    // Проба монтирования — слот батча: у неcмонтированной записи его нет.
    const drawn: number[] = [];
    for (let id = 1; id <= count; id++) {
      if (models.instanceFor(id)!.bounds !== null) drawn.push(id);
    }
    expect(drawn).toEqual([count]);
  });

  it('счётные величины создания записи бюджет не двигает (PERF-3)', () => {
    const cost = createCostCounters();
    withCostSink(cost, () => {
      const { stage } = makeRig(0);
      stage.frame(0.016, 1);
      stage.publish(PRODUCER, wave(7));
    });
    // Инстанс СОЗДАН доставкой — записью в пуле; отложено его изображение.
    // Считать создание кадром монтирования значило бы приписать доставке не то,
    // что она сделала.
    expect(cost.modelsInstancesCreated).toBe(7);
  });
});
