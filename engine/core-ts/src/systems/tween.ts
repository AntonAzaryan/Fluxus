/**
 * Твины (TWEEN-1..7): интерполяция значения поля компонента за фиксированное
 * время, нативной системой, а не через evaluator (TWEEN-6).
 *
 * РАСХОЖДЕНИЕ С БУКВОЙ TWEEN-1. Спека описывает компонент
 * `Tween { target, from, to, duration, elapsed, easing, onComplete }`. Поля
 * ECS-компонента — только скаляры `i32`/`fixed` (ECS-3, `ComponentSchema` в
 * `types.ts`), поэтому строка `"Health.value"` и дерево action'ов в компонент
 * не помещаются. Они вынесены в иммутабельную таблицу определений сцены
 * (`TweenDef`), а в компоненте остаётся `def` — индекс в этой таблице.
 * Семантика требований сохранена: `target` по-прежнему путь к полю (TWEEN-3),
 * `onComplete` по-прежнему action и исполняется по завершении (TWEEN-4).
 * Побочная выгода — путь к полю разбирается один раз при сборке сцены, а не на
 * каждом тике каждого твина.
 *
 * TimeScale: учитывается или нет — решает каждый твин сам (TWEEN-7, TIME-4);
 * см. поле `ignoreTimeScale`. Требование TIME-5 документировать решение
 * закрыто именно этим: у системы единого решения нет, оно в данных.
 */
import * as fixed from '../math/fixed.js';
import { execute, systemError, TWEEN_COMPONENT, type Action } from '../dsl/actions.js';
import { FIXED_ONE, type ComponentSchema, type EntityId, type Fixed, type System, type SystemContext } from '../types.js';

export { TWEEN_COMPONENT };

/** Значения поля `easing` (TWEEN-2). Набор расширяется дописыванием в `EASINGS`. */
export const EASING_LINEAR = 0;
export const EASING_INSTANT = 1;

/**
 * Кривая: прогресс `[0, 1]` → доля пути `[0, 1]`. `instant` даёт единицу с
 * первого же тика — скачок без интерполяции выражен кривой, а не твином нулевой
 * длительности со спецобработкой (TWEEN-2).
 */
const EASINGS: readonly ((t: Fixed) => Fixed)[] = [
  (t) => t,
  () => FIXED_ONE,
];

/** 60 Hz в Q16.16 (TIME-1): tick rate фиксирован и от TimeScale не зависит. */
const DEFAULT_GLOBAL_DELTA = fixed.div(FIXED_ONE, fixed.fromInt(60));

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = 50;

/**
 * Компонент твина (TWEEN-1). `def` — индекс в таблице сцены, `easing` — одна из
 * констант `EASING_*`, `ignoreTimeScale` — флаг (TWEEN-7). Поля в алфавитном
 * порядке: он же порядок в plain-форме снапшота (SER-6).
 *
 * ponytail: один твин на сущность — компонент на сущности ровно один, повторный
 * `addTween` перезапишет предыдущий. Потолок известный; когда понадобятся
 * параллельные твины одной цели, они станут отдельными сущностями-носителями с
 * полем `owner`, а не массивом в компоненте (массивов в ECS нет).
 */
export const TWEEN_SCHEMA: ComponentSchema = {
  name: TWEEN_COMPONENT,
  fields: {
    def: 'i32',
    duration: 'fixed',
    easing: 'i32',
    elapsed: 'fixed',
    from: 'fixed',
    ignoreTimeScale: 'i32',
    to: 'fixed',
  },
};

/**
 * Определение твина: то, что не влезает в скалярные поля компонента. Таблица
 * задаётся при сборке сцены и иммутабельна — иначе индекс `def`, лежащий в
 * снапшоте, после отката указывал бы не туда (SNAP-1).
 */
export interface TweenDef {
  /** Путь к полю компонента, например `"Health.value"` (TWEEN-3). */
  readonly target: string;
  /** Исполняется по завершении твина (TWEEN-4); сущность связана именем `entity`. */
  readonly onComplete?: readonly Action[];
}

export interface TweenSystemOptions {
  readonly name?: string;
  /** Шаг тика в Q16.16; по умолчанию 1/60 (TIME-1). */
  readonly globalDelta?: Fixed;
}

interface ParsedDef {
  readonly component: string;
  readonly field: string;
  readonly onComplete: readonly Action[];
}

const NO_ACTIONS: readonly Action[] = [];

function parseDef(def: TweenDef, index: number): ParsedDef {
  const parts = typeof def.target === 'string' ? def.target.split('.') : [];
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`TweenSystem: определение ${index}: "target" — путь вида "Компонент.поле" (TWEEN-3)`);
  }
  return { component: parts[0]!, field: parts[1]!, onComplete: def.onComplete ?? NO_ACTIONS };
}

export class TweenSystem implements System {
  readonly name: string;
  readonly order = ANCHOR_ORDER;
  private readonly globalDelta: Fixed;
  private readonly defs: readonly ParsedDef[];

  constructor(defs: readonly TweenDef[], options: TweenSystemOptions = {}) {
    this.name = options.name ?? 'Tween';
    this.globalDelta = options.globalDelta ?? DEFAULT_GLOBAL_DELTA;
    // Путь разбирается один раз: битый target из конфига обязан падать на
    // сборке сцены, а не на первом же завершившемся твине посреди матча.
    this.defs = defs.map(parseDef);
  }

  run(ctx: SystemContext): void {
    for (const entity of ctx.query({ all: [TWEEN_COMPONENT] })) {
      const def = this.defs[ctx.get(entity, TWEEN_COMPONENT, 'def')];
      if (def === undefined) {
        throw new Error(
          `TweenSystem: сущность ${entity} ссылается на определение ${ctx.get(entity, TWEEN_COMPONENT, 'def')}, ` +
            `в таблице их ${this.defs.length}`,
        );
      }
      this.step(ctx, entity, def);
    }
  }

  private step(ctx: SystemContext, entity: EntityId, def: ParsedDef): void {
    const easing = ctx.get(entity, TWEEN_COMPONENT, 'easing');
    const curve = EASINGS[easing];
    if (curve === undefined) throw new Error(`TweenSystem: неизвестный easing ${easing} (TWEEN-2)`);

    const duration = ctx.get(entity, TWEEN_COMPONENT, 'duration');
    const from = ctx.get(entity, TWEEN_COMPONENT, 'from');
    const to = ctx.get(entity, TWEEN_COMPONENT, 'to');
    // TWEEN-7: флаг выбирает ось времени, глобальную или личную (TIME-3).
    const delta =
      ctx.get(entity, TWEEN_COMPONENT, 'ignoreTimeScale') !== 0
        ? this.globalDelta
        : ctx.getEffectiveDelta(entity, this.globalDelta);
    const elapsed = fixed.add(ctx.get(entity, TWEEN_COMPONENT, 'elapsed'), delta);

    // Проверка до деления: при `elapsed >= duration` частное вылетело бы за i32
    // на коротких длительностях, а результат всё равно был бы обрезан в 1.0.
    const done = easing === EASING_INSTANT || duration <= 0 || elapsed >= duration;
    const value = done ? to : lerp(from, to, curve(fixed.div(elapsed, duration)));
    ctx.commands.setField(entity, def.component, def.field, value);

    if (!done) {
      ctx.commands.setField(entity, TWEEN_COMPONENT, 'elapsed', elapsed);
      return;
    }
    // Порядок команд — порядок применения (CMD-3): целевое поле уже записано,
    // и onComplete видит его конечное значение только после общего flush.
    //
    // Ошибка внутри onComplete — та же ошибка класса 3, что у системы из данных
    // (SYS-9), и называть она обязана то же: систему, путь до узла и причину.
    // Механизм тот же, что у `EvaluatedSystem.run`, а не его копия.
    try {
      execute(def.onComplete, ctx, { entity });
    } catch (cause) {
      throw systemError(this.name, cause);
    }
    ctx.commands.removeComponent(entity, TWEEN_COMPONENT);
  }
}

function lerp(from: Fixed, to: Fixed, t: Fixed): Fixed {
  return fixed.add(from, fixed.mul(fixed.sub(to, from), t));
}
