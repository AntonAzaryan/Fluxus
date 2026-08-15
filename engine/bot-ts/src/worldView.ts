/**
 * Модель мира мозга — то и ровно то, что видит его клиент (BOT-3).
 *
 * Источник один: `ClientStep` собственного клиента, то есть отфильтрованный
 * персональный снапшот слота бота (`netcode` NET-12..15). Сущность, невидимая
 * слоту по FoW, в снапшот не входит вовсе — здесь её не появится ни при каком
 * размещении бота, и «помнить последнее виденное» приходится памятью
 * восприятия, а не запросом к миру (`perception.ts`).
 *
 * Читается пара снапшотов буфера интерполяции с долей между ними (`netcode`
 * NET-3) — та же картинка, которую видит человек: экстраполяции чужих сущностей
 * нет (NET-2), и бот не вправе видеть мир свежее, чем игрок с тем же клиентом.
 *
 * Fixed → float происходит здесь, на границе (BOT-5): дальше внутри мозга живёт
 * обычная float-математика.
 */
import { ARENA_COMPONENT, query, type EntityId, type WorldMode } from '@game-mvp/core';
import type { ClientStep, MatchSample } from '@game-mvp/net';
import { readFixedField, readIntField } from './boundary.js';

/**
 * Имена компонентов и полей — параметры сборки, а не конвенция ядра: те же
 * основания, что у `MatchClient` (`tick-loop` TICK-4). Умолчания совпадают с
 * умолчаниями клиента и сценой дуэли контента.
 */
export interface WorldViewNames {
  readonly playerComponent?: string;
  readonly slotField?: string;
  readonly positionComponent?: string;
  readonly velocityComponent?: string;
  readonly teamComponent?: string;
  readonly teamField?: string;
}

const DEFAULTS = {
  playerComponent: 'Player',
  slotField: 'slot',
  positionComponent: 'Position',
  velocityComponent: 'Velocity',
  teamComponent: 'Team',
  teamField: 'id',
} as const;

/** Сущность глазами мозга: положение и скорость — float в мировых осях. */
export interface BotEntityView {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** Слот игрока, если сущность им управляется; `undefined` — не игрок. */
  readonly slot: number | undefined;
  readonly team: number | undefined;
}

export interface BotWorldView {
  /** Тик состояния, из которого собран вид (номер серверного тика снапшота). */
  readonly tick: number;
  /**
   * Режим мира доставленного состояния (WSM-1). Приезжает тем же снапшотом, что
   * и всё остальное, — отдельного канала под него нет и заводить его нельзя
   * (BOT-3): в `Paused` и `Rewinding` живых тиков нет вовсе, и мозгу тут не
   * во что играть.
   */
  readonly mode: WorldMode;
  /**
   * Состояние принадлежит другой ветви истории — разрыв непрерывности (SHELL-7,
   * NTR-10). Тот же признак, по которому рендер рисует snap: номера тиков после
   * перемотки идут НАЗАД (NTR-16), и всё, что мозг помнил о будущем, стёрто.
   */
  readonly discontinuity: boolean;
  /** Своя сущность бота — опознаётся слотом (TICK-5). */
  readonly self: BotEntityView | undefined;
  /** Все прочие видимые сущности: чужие герои, снаряды, реквизит. */
  readonly others: readonly BotEntityView[];
  /**
   * Радиус арены (`arena` ARENA-1), если её носитель есть в снапшоте: радиус
   * мутабелен сужением, поэтому читается из состояния, а не из сборки. Центр
   * здесь не появляется намеренно — он живёт в ассете сцены, а не в компоненте.
   */
  readonly arenaRadius: number | undefined;
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

function entityView(
  sample: MatchSample,
  entity: EntityId,
  names: Required<WorldViewNames>,
): BotEntityView {
  const toX = readFixedField(sample.to.world, entity, names.positionComponent, 'x') ?? 0;
  const toY = readFixedField(sample.to.world, entity, names.positionComponent, 'y') ?? 0;
  const fromX = readFixedField(sample.from.world, entity, names.positionComponent, 'x');
  const fromY = readFixedField(sample.from.world, entity, names.positionComponent, 'y');
  // Скорость — из компонента, если сцена его несёт; иначе разностью пары
  // снапшотов. Ни то, ни другое не экстраполяция: обе величины уже приехали
  // авторитетным состоянием (NET-2).
  const vx =
    readFixedField(sample.to.world, entity, names.velocityComponent, 'x') ??
    (fromX === undefined ? 0 : toX - fromX);
  const vy =
    readFixedField(sample.to.world, entity, names.velocityComponent, 'y') ??
    (fromY === undefined ? 0 : toY - fromY);
  return {
    id: entity,
    x: fromX === undefined ? toX : lerp(fromX, toX, sample.alpha),
    y: fromY === undefined ? toY : lerp(fromY, toY, sample.alpha),
    vx,
    vy,
    slot: readIntField(sample.to.world, entity, names.playerComponent, names.slotField),
    team: readIntField(sample.to.world, entity, names.teamComponent, names.teamField),
  };
}

/**
 * Вид мира на момент шага. `undefined` — состояния нет: буфер интерполяции ещё
 * не набрался (NTR-15), и наблюдать нечего.
 */
export function readWorldView(
  step: ClientStep,
  slot: number,
  names: WorldViewNames = {},
): BotWorldView | undefined {
  const sample = step.state;
  if (sample === undefined) return undefined;
  const resolved: Required<WorldViewNames> = { ...DEFAULTS, ...names };
  let self: BotEntityView | undefined;
  const others: BotEntityView[] = [];
  for (const entity of query(sample.to.world, { all: [resolved.positionComponent] })) {
    const view = entityView(sample, entity, resolved);
    if (view.slot === slot) self = view;
    else others.push(view);
  }
  return {
    tick: sample.to.tick,
    mode: sample.to.mode,
    discontinuity: sample.discontinuity,
    self,
    others,
    arenaRadius: arenaRadius(sample),
  };
}

function arenaRadius(sample: MatchSample): number | undefined {
  for (const entity of query(sample.to.world, { all: [ARENA_COMPONENT] })) {
    const radius = readFixedField(sample.to.world, entity, ARENA_COMPONENT, 'radius');
    if (radius !== undefined) return radius;
  }
  return undefined;
}
