/**
 * Документ начальной расстановки (SER-8) — один формат на три документа:
 * конфиг сцены (SER-7), сценарий CLI (CLI-2) и конфиг матча (NTR-5, NTR-6).
 * Второго формата быть не должно: расстановка входит в хеш `worldInit` через
 * плоскую форму мира (DET-1), и два описания одного и того же с разными
 * правилами порядка давали бы расхождение хешей на честных данных.
 *
 * Порядок записей нормативен: он задаёт выданные `index`/`generation` (ID-2,
 * DET-6). Список не сортируется и не дедуплицируется — две записи с одним
 * prefab'ом это два юнита на арене, а не дубль записи.
 *
 * Все три документа приходят сюда одним путём: конфиг сцены — через
 * `loadScene`, сценарий и конфиг матча — через `buildSimulation`. Отдельного
 * разбора расстановки в сетевом слое нет, и потому проверки этого модуля
 * (запись — объект, `prefab` — непустая строка, диапазон `support` арены,
 * номер записи в сообщении) действуют и на недоверенный конфиг матча.
 *
 * Мутирующей поверхности ядра этот модуль не расширяет: расстановку применяют
 * загрузчик сцены и сборка симуляции до первого тика (TICK-3, исключение
 * `worldInit`), а наружу из `index.ts` уходит только тип записи.
 */
import { spawn } from '../ecs/world.js';
import { checkArenaSupportOverride } from '../systems/arena.js';
import type { FieldOverrides, WorldState } from '../types.js';

/**
 * Запись расстановки (SER-8). Состав закрыт: `prefab` и необязательный
 * `overrides` — карта «компонент → поле → значение» поверх значений prefab'а
 * (CMD-6). Именованных полей вроде `position` здесь нет и не будет: какой
 * компонент несёт позицию, знает контент, а не ядро.
 *
 * Имя типа историческое (расстановка появилась полем сценария) и сохранено,
 * чтобы не переписывать потребителей; владелец формата — SER-8, а не CLI-2.
 */
export interface ScenarioSpawn {
  readonly prefab: string;
  readonly overrides?: FieldOverrides;
}

const isArray = (value: unknown): boolean => Array.isArray(value);
/**
 * Проверка без сужения типа, как `isArray`: запись расстановки приезжает
 * документом, где законен и `null` (`typeof null === 'object'`), а в типе
 * `ScenarioSpawn` его нет — по типам условие выглядит лишним, по данным оно
 * обязательно.
 */
const isRecord = (value: unknown): boolean => value !== null && typeof value === 'object';

/**
 * Применяет расстановку в порядке списка. Отсутствующий и пустой список
 * неразличимы (SER-8): и то и другое не создаёт ни одной сущности.
 *
 * Ошибочная запись отвергается до первого тика (SER-5, ECS-5): существование
 * prefab'а, состав компонентов и имена полей проверяет `spawn` (CMD-6), а
 * `where` и номер записи добавляются здесь — по одному имени prefab'а автор
 * документа не найдёт, какую из десяти записей он сломал.
 */
export function applyPlacement(
  world: WorldState,
  entries: readonly ScenarioSpawn[] | undefined,
  where: string,
): void {
  if (entries === undefined) return;
  // Проверка без сужения типа: `Array.isArray` над `readonly T[]` даёт `any[]`,
  // и вся дальнейшая работа с записью потеряла бы типы.
  if (!isArray(entries)) throw new Error(`${where}: расстановка — список записей (SER-8)`);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const at = `${where}: расстановка, запись #${i}`;
    if (!isRecord(entry)) throw new Error(`${at}: запись — объект (SER-8)`);
    if (typeof entry.prefab !== 'string' || entry.prefab === '') {
      throw new Error(`${at}: "prefab" — непустая строка (SER-8)`);
    }
    // Диапазон `support` (ARENA-3): `spawn` проверяет представимость значения в
    // типе поля (CMD-6), а «доля вне [0, 1]» — правило арены, и живёт оно там.
    // Здесь оно спрашивается один раз на все три документа расстановки (SER-8).
    checkArenaSupportOverride(entry.overrides, `${at} ("${entry.prefab}")`);
    try {
      spawn(world, entry.prefab, entry.overrides);
    } catch (error) {
      throw new Error(`${at} ("${entry.prefab}"): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
