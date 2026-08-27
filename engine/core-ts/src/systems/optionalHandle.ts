/**
 * Handle компонента, наличие которого система ПРОВЕРЯЕТ, а не требует
 * (`data-driven-systems` SYS-10).
 *
 * Строгость SYS-10 — про имя, КОТОРОЕ СИСТЕМЕ НУЖНО: опечатка в нём обязана
 * падать сразу, а не нулями посреди матча. Но есть и второй род имён —
 * те, о которых система СПРАШИВАЕТ мир: лок манёвров, override уровня,
 * маркер мёртвых. Строковый путь отвечал на них «не владеет» и на
 * незарегистрированном имени тоже (`hasComponent` в `ecs/world.ts` возвращает
 * `false`, а не бросает), и ровно так же читает такое имя запрос
 * (`ecs/query.ts`, `maskOf`: неизвестное имя в `not` просто опускается).
 *
 * Handle обязан значить то же самое: SYS-10 требует ПОБИТОВОЙ эквивалентности
 * двух путей чтения, а не новой строгости к сцене, которую вчера принимали.
 * `undefined` здесь — «компонента в схемах сцены нет вовсе», и проверка по нему
 * даёт тот же `false`, что давал строковый `has`.
 */
import type { ComponentHandle, SystemContext } from '../types.js';

export function optionalComponentHandle(
  ctx: SystemContext,
  component: string,
): ComponentHandle | undefined {
  if (component === '') return undefined;
  try {
    return ctx.resolveComponent(component);
  } catch {
    return undefined;
  }
}
