/**
 * Хеш контент-пака (NET-17) — вычислимая половина версии игры (NET-16). Вторая
 * половина, идентификатор сборки ядра, приходит от сборочного конвейера: сам
 * себя бинарник не хеширует.
 *
 * Считается от канонического представления правил и формата, а не от байтов
 * документа: переформатированный конфиг обязан давать тот же хеш. Отсюда весь
 * нижеследующий разбор умолчаний — представление воспроизводит различения
 * ЗАГРУЗЧИКА (`scene.ts`), а не синтаксис документа. Где загрузчик двух записей
 * не различает, не различает и хеш; где различает — различает и хеш.
 *
 * Чего здесь нет и почему: ассетов террейна и арены (данные конкретного матча,
 * их тождественность обеспечивает хеш `worldInit`, DET-1), начальной
 * расстановки сцены (`initial` — тот же класс данных матча, SER-8) и ёмкости
 * мира (она целиком лежит в плоской форме мира, то есть в том же хеше
 * `worldInit`). Величина, сверяемая дважды, только размывает вопрос, на
 * который отвечает каждая из двух проверок.
 *
 * Сеть об этом модуле не знает и знать не должна в обратную сторону: хеш —
 * чистая функция от конфига сцены, ядро о сетевом слое не осведомлено (DI-3).
 * Сверку версий делает транспорт, вызывая эту функцию.
 */
import { fnv1a32, utf8Bytes } from '../math/rng.js';
import { DEFAULT_MODIFIER_SLOTS } from '../systems/modifiers.js';
import { canonicalJson } from './canonicalJson.js';
import type { SystemDef } from '../dsl/evaluatedSystem.js';
import type { SceneDef } from './scene.js';

/** Имя переменной итерации по умолчанию — то же, что разворачивает `EvaluatedSystem`. */
const DEFAULT_AS = 'entity';

/**
 * Каноническое представление (NET-17). Отдельно от хеша по той же причине, что
 * и у `worldInit`: при расхождении хешей сравнивают именно его, иначе
 * диагностика упирается в восемь шестнадцатеричных цифр, которые ни на что не
 * указывают.
 */
export function contentPackForm(def: SceneDef): Record<string, unknown> {
  return {
    // Порядок объявления сохраняется: он задаёт битовые id компонентов, то есть
    // представление масок в снапшоте (SER-7). Сортировать его нельзя.
    components: def.components.map((schema) => ({
      name: schema.name,
      fields: { ...schema.fields },
      defaults: significantDefaults(schema.defaults),
    })),
    // `prefabs` и `systems`: загрузчик берёт их через `?? []`, поэтому
    // отсутствующий список неотличим от пустого — и в хеше тоже.
    prefabs: (def.prefabs ?? []).map((prefab) => ({
      name: prefab.name,
      components: prefab.components,
      // `spawn` смотрит на непустоту списка тегов, поэтому пустой и
      // отсутствующий эквивалентны.
      tags: prefab.tags ?? [],
    })),
    systems: (def.systems ?? []).map(systemForm),
    // А вот здесь отсутствие и пустота — разные правила: без поля нет ни
    // `TweenSystem`, ни компонента `Tween`, то есть другой состав компонентов и
    // сдвинутые битовые id всего, что за ним. `null` против `[]` эту разницу и
    // держит.
    tweens:
      def.tweens === undefined
        ? null
        : def.tweens.map((tween) => ({
            target: tween.target,
            // `TweenSystem` подставляет пустой список действий, если его нет.
            onComplete: tween.onComplete ?? [],
          })),
    timeScale: def.timeScale === true,
    fog: def.fog === true,
    modifierSlots: def.modifierSlots ?? DEFAULT_MODIFIER_SLOTS,
  };
}

/** Восемь строчных hex-цифр — тот же канон и та же функция, что у хеша `worldInit` (DET-1, NET-17). */
export function contentPackHash(def: SceneDef): string {
  const hash = fnv1a32(utf8Bytes(canonicalJson(contentPackForm(def))));
  return hash.toString(16).padStart(8, '0');
}

/**
 * Умолчание, равное нулю, неотличимо от отсутствующего: `spawn` читает поле как
 * `defaults?.[field] ?? 0`, то есть ноль и есть значение по умолчанию.
 */
function significantDefaults(defaults: Readonly<Record<string, number>> | undefined): Record<string, number> {
  const significant: Record<string, number> = {};
  for (const [field, value] of Object.entries(defaults ?? {})) {
    if (value !== 0) significant[field] = value;
  }
  return significant;
}

/**
 * `as` попадает в представление только вместе с `query`: без запроса тела в
 * `forEach` не заворачивается и имя переменной итерации не используется вовсе
 * (`EvaluatedSystem.bodyOf`), то есть на правила не влияет.
 */
function systemForm(system: SystemDef): Record<string, unknown> {
  if (system.query === undefined) return { name: system.name, order: system.order, do: system.do };
  return {
    name: system.name,
    order: system.order,
    query: system.query,
    as: system.as ?? DEFAULT_AS,
    do: system.do,
  };
}
