/**
 * @contribution
 *
 * Кандидаты пикеров — из поднятого мира, а не из разбора документа.
 *
 * Правило, которое здесь исполняется, одно (решение 5 design'а): аффорданс
 * может быть производным, вердикт всегда за ядром. Пикер предлагает ровно то
 * множество, которое принимает валидатор ядра в этом месте:
 *
 * | Слот | Предлагается | Кто выносит вердикт |
 * |---|---|---|
 * | `component`, `query.all/any/not` | `componentNames` | `componentSchema` в `checkAction`/`checkQuery` |
 * | ключи `values`/`data`/`bindings`, `field` | `fieldNames` | `checkFields` по той же схеме |
 * | `prefab` | `prefabNames` | `prefabOf` |
 * | ключи `overrides` | `prefabComponentNames` | `checkOverrides` (CMD-6) |
 *
 * Своего разбора документа тут нет и быть не может: перечень компонентов сцены
 * — это не только то, что объявил контент. Схемы пола (TERR-6), арены
 * (ARENA-1), шкалы времени и твинов (TIME-2, TWEEN-1) и тумана войны (FOW-1..3)
 * дописывает загрузчик, и система вправе называть их наравне с объявленными.
 * Документ о них не знает — мир знает.
 *
 * Мир поднимается со списком систем пустым. Причина та же, что у второго
 * подъёма в `validation/engineRules.ts`: сцена, чей список `systems` содержит
 * недостроенную систему, целиком не поднимается ИЗ-ЗА неё (`loadScene`
 * регистрирует системы последними и падает на первой негодной, SYS-3), — а
 * недостроенная система в редакторе систем есть всегда, это и есть авторинг.
 * Пикер, гаснущий ровно в тот момент, когда автор собирает блок, бесполезен.
 * Мир при этом законный и тот же: `validateSystem` читает компоненты и
 * prefabs, а их состав от регистрации систем не зависит вовсе.
 */
import { loadScene, world as coreWorld, type SceneDef, type WorldState } from '@game-mvp/core';
import { isJsonObject, type JsonValue } from '../document/json.js';

/** То, что пикеры блока спрашивают у мира. Только чтение — мир не правится ничем. */
export interface DslWorldView {
  /** Имена компонентов в порядке объявления: он нормативен (SER-7). */
  readonly componentNames: readonly string[];
  /** Имена зарегистрированных prefab'ов. */
  readonly prefabNames: readonly string[];
  /** Поля схемы компонента в порядке объявления; пусто — компонента нет. */
  fieldNames(component: string): readonly string[];
  /** Компоненты, которые prefab уже содержит (CMD-6); пусто — prefab'а нет. */
  prefabComponentNames(prefab: string): readonly string[];
}

const NONE: readonly string[] = Object.freeze([]);

/** Вид на уже поднятый мир — тот же, что держит правило валидации. */
export function dslWorldView(state: WorldState): DslWorldView {
  return {
    componentNames: coreWorld.componentNames(state),
    prefabNames: coreWorld.prefabNames(state),
    fieldNames(component) {
      const schema = coreWorld.componentSchema(state, component);
      return schema === undefined ? NONE : Object.keys(schema.fields);
    },
    prefabComponentNames(prefab) {
      const found = coreWorld.prefabOf(state, prefab);
      return found === undefined ? NONE : Object.keys(found.components);
    },
  };
}

/**
 * Мир конфига сцены (SER-7) для пикеров; `undefined` — сцена не поднимается
 * вовсе, и предлагать нечего.
 *
 * Причину `undefined` этот модуль не сообщает намеренно: о ней отчитывается
 * правило сцены находкой на документе, и второе описание того же нарушения
 * рядом с первым — ровно то, что запрещает ED-30.
 */
export function loadDslWorld(value: JsonValue): DslWorldView | undefined {
  if (!isJsonObject(value)) return undefined;
  try {
    return dslWorldView(loadScene({ ...(value as unknown as SceneDef), systems: [] }).world);
  } catch {
    return undefined;
  }
}
