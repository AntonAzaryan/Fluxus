/**
 * Как физика читает коллайдер из мира — двумя путями и одним разбором.
 *
 * Внутри тика — по handle (`data-driven-systems` SYS-10): `PhysicsSystem`
 * разрешает имена своих компонентов один раз, на первом входе, и дальше
 * КАЖДЫЙ кандидат КАЖДОГО шага оси читается без словарного поиска по строкам.
 *
 * В луче (`createPhysicsApi`) — по именам: он собирается вокруг мира, а не
 * вокруг контекста тика, и своих handle не имеет. Разрешение имён для него —
 * отдельный шаг, этим change'ем не сделанный.
 *
 * Модуль отделён от `physics.ts` по размеру файла, а не по смыслу: разрешение
 * движения и его чтение мира — соседние темы, и живут они рядом.
 */
import { SHAPE_CIRCLE, type Collider, type MutableCollider } from './collisionGeometry.js';
import { COLLIDER_HEIGHT_FIELD } from './columnModel.js';
import {
  POSITION_COMPONENT,
  type EntityId,
  type FieldHandle,
  type SystemContext,
} from '../types.js';

/**
 * ponytail: коллайдер выдаётся новым объектом на каждый вызов. Внутри тика этого
 * уже нет — `PhysicsSystem` разбирает и движущегося, и кандидата в готовые
 * буферы (`colliderByHandle` ниже); осталось это в луче (`createPhysicsApi`),
 * где буфер пришлось бы разделить между вложенными вызовами. Снимается тем же
 * приёмом — когда профиль на реальной сцене покажет эти аллокации.
 */
export function colliderOf(read: FieldReader, entity: EntityId, component: string): Collider {
  const collider: MutableCollider = { halfX: 0, halfY: 0, shape: 0, radius: 0 };
  colliderInto(read, entity, component, collider);
  return collider;
}

/**
 * Разбор коллайдера по ИМЕНАМ — путь луча (`createPhysicsApi`): он собирается
 * вокруг мира, а не вокруг контекста тика, и своих handle не имеет. Разрешение
 * имён для него — отдельный шаг, не сделанный этим change'ем; внутри тика тот
 * же разбор идёт по handle (`colliderByHandle`, SYS-10).
 */
function colliderInto(
  read: FieldReader,
  entity: EntityId,
  component: string,
  out: MutableCollider,
): void {
  const shape = read(entity, component, 'shape');
  const radius = read(entity, component, 'radius');
  out.shape = shape;
  out.radius = radius;
  // У круга огибающая — квадрат по радиусу: полуоси коллайдера не читаются.
  out.halfX = shape === SHAPE_CIRCLE ? radius : read(entity, component, 'halfX');
  out.halfY = shape === SHAPE_CIRCLE ? radius : read(entity, component, 'halfY');
}

export type FieldReader = (entity: EntityId, component: string, field: string) => number;

/**
 * Handle полей, которые разрешение движения читает НА КАЖДОГО кандидата
 * КАЖДОГО шага оси (`data-driven-systems` SYS-10): позиция, четыре числа
 * коллайдера, три маски и скорость. Имена разрешаются один раз, на первом
 * входе в систему, и уже после раннего выхода — к этому моменту непустая
 * выборка движущихся доказывает, что все три компонента у сцены есть.
 *
 * `height` разрешается только при включённом колоночном гейте (PHYS-14): без
 * него поля высоты в схеме нет вовсе, и спрашивать его — значит требовать от
 * сцены того, чего строковый путь не требовал.
 */
export interface PhysicsHandles {
  readonly posX: FieldHandle;
  readonly posY: FieldHandle;
  readonly shape: FieldHandle;
  readonly radius: FieldHandle;
  readonly halfX: FieldHandle;
  readonly halfY: FieldHandle;
  readonly layer: FieldHandle;
  readonly blockMask: FieldHandle;
  readonly hitMask: FieldHandle;
  readonly cliffRise: FieldHandle;
  readonly height: FieldHandle | undefined;
  readonly velocityX: FieldHandle;
  readonly velocityY: FieldHandle;
}

/** Тот же разбор коллайдера, что `colliderInto`, но по handle (SYS-10). */
export function colliderByHandle(
  ctx: SystemContext,
  entity: EntityId,
  h: PhysicsHandles,
  out: MutableCollider,
): void {
  const shape = ctx.getByHandle(entity, h.shape);
  const radius = ctx.getByHandle(entity, h.radius);
  out.shape = shape;
  out.radius = radius;
  out.halfX = shape === SHAPE_CIRCLE ? radius : ctx.getByHandle(entity, h.halfX);
  out.halfY = shape === SHAPE_CIRCLE ? radius : ctx.getByHandle(entity, h.halfY);
}

/**
 * Разрешение имён физики (SYS-10). Зовётся системой один раз, на первом входе и
 * ПОСЛЕ раннего выхода: непустая выборка движущихся к этому моменту доказывает,
 * что позиция, коллайдер и скорость у сцены есть.
 */
export function resolvePhysicsHandles(
  ctx: SystemContext,
  colliderComponent: string,
  velocityComponent: string,
  heightGate: boolean,
): PhysicsHandles {
  const collider = (field: string): FieldHandle => ctx.resolveField(colliderComponent, field);
  return {
    posX: ctx.resolveField(POSITION_COMPONENT, 'x'),
    posY: ctx.resolveField(POSITION_COMPONENT, 'y'),
    shape: collider('shape'),
    radius: collider('radius'),
    halfX: collider('halfX'),
    halfY: collider('halfY'),
    layer: collider('layer'),
    blockMask: collider('blockMask'),
    hitMask: collider('hitMask'),
    cliffRise: collider('cliffRise'),
    height: heightGate ? collider(COLLIDER_HEIGHT_FIELD) : undefined,
    velocityX: ctx.resolveField(velocityComponent, 'x'),
    velocityY: ctx.resolveField(velocityComponent, 'y'),
  };
}
