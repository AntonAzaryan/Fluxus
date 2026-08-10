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
 * Мутирующей поверхности ядра этот модуль не расширяет: расстановку применяют
 * загрузчик сцены и прогон до первого тика (TICK-3, исключение `worldInit`),
 * а наружу из `index.ts` уходит только тип записи.
 */
import { spawn } from '../ecs/world.js';
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- baseline
    if (entry === null || typeof entry !== 'object') throw new Error(`${at}: запись — объект (SER-8)`);
    if (typeof entry.prefab !== 'string' || entry.prefab === '') {
      throw new Error(`${at}: "prefab" — непустая строка (SER-8)`);
    }
    try {
      spawn(world, entry.prefab, entry.overrides);
    } catch (error) {
      throw new Error(`${at} ("${entry.prefab}"): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
