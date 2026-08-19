/**
 * Предкомпиляция определений баффов (BUFF-2) — в ту же таблицу сцены и тем же
 * разбором, что определения способностей.
 *
 * Второго набора правил у баффов нет намеренно: проверка определения, его
 * предкомпиляция и класс ошибок нормируются наравне со способностями (ABIL-10),
 * поэтому списки действий и выражения проверяет тот же обход, что валидирует
 * JSON-систему (SYS-3), а недоверенный JSON читают те же функции `parse.ts`.
 *
 * Собственного отличия здесь ровно одно и оно принадлежит BUFF-4: список
 * источников-модификаторов, не подключённый конфигом сцены, — ошибка ЗАГРУЗКИ, а
 * не правка без эффекта. Проверяется он по составу компонентов мира: компонент
 * списка попадает в мир тем же флагом сцены, что и сам список (SER-7).
 */
import { componentSchema } from '../../ecs/world.js';
import {
  BUFF_NEGATIVE,
  BUFF_POSITIVE,
  STACKING_INDEPENDENT,
  STACKING_REFRESH,
  STACKING_STACK,
  type BuffPeriodicDef,
  type CompiledBuff,
  type CompiledBuffTrigger,
  type CompiledStatMod,
} from './model.js';
import { actionsOf, asList, asObject, expressionOf, fail, keyOf, literalName } from './parse.js';
import { BUFF_BOUND_NAMES } from './runtime.js';
import type { WorldState } from '../../types.js';

const BUFF_CLASSES: Readonly<Record<string, number>> = Object.freeze({
  positive: BUFF_POSITIVE,
  negative: BUFF_NEGATIVE,
});

const STACKING_POLICIES: Readonly<Record<string, number>> = Object.freeze({
  refresh: STACKING_REFRESH,
  stack: STACKING_STACK,
  independent: STACKING_INDEPENDENT,
});

export interface BuffBuffers {
  readonly buffs: CompiledBuff[];
  readonly statMods: CompiledStatMod[];
  readonly triggers: CompiledBuffTrigger[];
  readonly index: Map<string, number>;
}

export function emptyBuffBuffers(): BuffBuffers {
  return { buffs: [], statMods: [], triggers: [], index: new Map() };
}

/** Разбор таблицы `buffs` конфига сцены (SER-7) в общие массивы каталога. */
export function compileBuffs(
  declared: unknown,
  world: WorldState,
  buffers: BuffBuffers,
): void {
  if (declared === undefined) return;
  asList(declared, 'buffs').forEach((raw, i) => {
    const at = `бафф[${i}]`;
    const node = asObject(raw, at);
    const id = literalName(node.id, `${at}.id`);
    if (buffers.index.has(id)) fail(`${at}.id`, `определение "${id}" объявлено дважды`);
    buffers.index.set(id, i);
    buffers.buffs.push(compileBuff(node, id, world, buffers));
  });
}

function compileBuff(
  def: Readonly<Record<string, unknown>>,
  id: string,
  world: WorldState,
  buffers: BuffBuffers,
): CompiledBuff {
  const path = `бафф "${id}"`;
  const stacking =
    def.stacking === undefined
      ? STACKING_INDEPENDENT
      : keyOf(STACKING_POLICIES, def.stacking, `${path}.stacking`);
  // Потолок обязателен ровно там, где он что-то значит: без него `stack`
  // молча выродился бы в `refresh`. То же правило и тот же класс ошибки, что у
  // исхода прерывания `partial` без доли кулдауна (ABIL-6, ABIL-10).
  if (stacking === STACKING_STACK && def.maxStacks === undefined) {
    fail(`${path}.maxStacks`, 'политика "stack" требует потолка стаков в поле "maxStacks" (BUFF-3)');
  }

  const statStart = buffers.statMods.length;
  compileStatMods(def.statMods, world, buffers, path);
  const triggerStart = buffers.triggers.length;
  compileTriggers(def.triggers, world, buffers, path);
  const periodic =
    def.periodic === undefined ? undefined : asObject(def.periodic, `${path}.periodic`);

  return {
    id,
    klass: keyOf(BUFF_CLASSES, def.class, `${path}.class`),
    durationTicks: expressionOf(def.durationTicks, world, BUFF_BOUND_NAMES, `${path}.durationTicks`),
    stacking,
    maxStacks: expressionOf(def.maxStacks, world, BUFF_BOUND_NAMES, `${path}.maxStacks`),
    statStart,
    statCount: buffers.statMods.length - statStart,
    everyTicks: periodicEvery(periodic, world, path),
    periodic: actionsOf(periodic?.do, world, BUFF_BOUND_NAMES, `${path}.periodic.do`),
    triggerStart,
    triggerCount: buffers.triggers.length - triggerStart,
    onExpire: actionsOf(def.onExpire, world, BUFF_BOUND_NAMES, `${path}.onExpire`),
  };
}

function periodicEvery(
  periodic: Readonly<Record<string, unknown>> | undefined,
  world: WorldState,
  path: string,
): BuffPeriodicDef['everyTicks'] | undefined {
  if (periodic === undefined) return undefined;
  if (periodic.everyTicks === undefined) {
    fail(`${path}.periodic.everyTicks`, 'блок периодики требует периода в тиках (BUFF-5)');
  }
  return expressionOf(periodic.everyTicks, world, BUFF_BOUND_NAMES, `${path}.periodic.everyTicks`);
}

/**
 * Статовые правки (BUFF-4). Имя списка источников проверяется по составу
 * компонентов мира: сцена включает список тем же флагом, которым дописывает его
 * компонент (SER-7), поэтому «список не подключён» и «имени такого нет» — одна
 * и та же находка и один и тот же отказ.
 */
function compileStatMods(
  statMods: unknown,
  world: WorldState,
  buffers: BuffBuffers,
  path: string,
): void {
  if (statMods === undefined) return;
  asList(statMods, `${path}.statMods`).forEach((raw, i) => {
    const at = `${path}.statMods[${i}]`;
    const node = asObject(raw, at);
    const component = literalName(node.component, `${at}.component`);
    if (componentSchema(world, component) === undefined) {
      fail(`${at}.component`, `список источников "${component}" сцена не подключает (TIME-7, SER-7)`);
    }
    if (node.value === undefined) fail(`${at}.value`, 'статовая правка требует значения-выражения');
    buffers.statMods.push({
      component,
      value: expressionOf(node.value, world, BUFF_BOUND_NAMES, `${at}.value`)!,
    });
  });
}

/**
 * Реакции на события (BUFF-5). Отбор событий по отношению к цели платформа не
 * конвенционализирует: какие поля события называют цель — предикат определения,
 * потому что события сцены принадлежат контенту (ABIL-8). Поэтому единственное,
 * что здесь связывается сверх обычных имён, — само событие.
 */
function compileTriggers(
  triggers: unknown,
  world: WorldState,
  buffers: BuffBuffers,
  path: string,
): void {
  if (triggers === undefined) return;
  asList(triggers, `${path}.triggers`).forEach((raw, i) => {
    const at = `${path}.triggers[${i}]`;
    const node = asObject(raw, at);
    const as = node.as === undefined ? 'event' : literalName(node.as, `${at}.as`);
    buffers.triggers.push({
      type: literalName(node.type, `${at}.type`),
      as,
      actions: actionsOf(node.do, world, [...BUFF_BOUND_NAMES, as], `${at}.do`),
    });
  });
}
