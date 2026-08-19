/**
 * Словарь журнала боя демо-арены (DIAG-10) против событий её сцены.
 *
 * Читать дерево контента здесь законно — это сборка ИГРЫ (CONT-1), и словарь
 * описывает ровно её события. Тесты самого инструмента живут в ядре на своих
 * фикстурах (CONT-4): инструмент не знает ни одного игрового события, и
 * проверять на нём покрытие было бы нечем.
 *
 * Смысл теста в одном: новый тип события в сцене краснит ЗДЕСЬ и требует строки
 * в документе словаря, а не правки кода. Это и есть проверка того, что механизм
 * и политика разведены правильно.
 */
import { describe, expect, it } from 'vitest';
import dictionaryJson from '../app/journal/duel.dictionary.json';
import sceneJson from '../../../content/scenes/duel.scene.json';

interface Dictionary {
  readonly events: Readonly<Record<string, { kind: string; actor?: string; target?: string }>>;
}

const DICTIONARY = dictionaryJson as Dictionary;

/**
 * События НАТИВНЫХ систем движка: их эмитит не сцена действием `emitEvent`, а
 * физика (PHYS-9, PHYS-12) и арена (ARENA-5) — то есть механизм, включённый
 * зависимостями сборки матча. В документе сцены их не найти обходом, а в бою
 * они есть, и словарь обязан их называть: провалиться сквозь пол на демо-арене
 * — такой же боевой факт, как получить в лоб.
 *
 * Список с полями данных, а не голыми именами: роли словаря проверяются по нему
 * наравне с событиями сцены — иначе `target` мог бы указывать в пустоту.
 */
const NATIVE_EVENTS: Readonly<Record<string, readonly string[]>> = {
  Collision: ['entity', 'other', 'nx', 'ny'],
  Overlap: ['entity', 'other'],
  LeftArena: ['entity'],
  FellThroughFloor: ['entity'],
};

/**
 * Типы событий, которые сцена ЭМИТИТ: обход документа за действием `emitEvent`
 * (`dsl/actions.ts`). Обход, а не список рядом: список разошёлся бы со сценой
 * молча — то есть ровно так, как этот тест и должен ловить.
 *
 * Возвращается тип и имена полей его данных: словарь называет роли по именам
 * полей, и роль, названная мимо, обязана краснеть здесь, а не в бою.
 */
function emittedEvents(node: unknown, found = new Map<string, Set<string>>()): Map<string, Set<string>> {
  if (Array.isArray(node)) {
    for (const item of node) emittedEvents(item, found);
    return found;
  }
  if (typeof node !== 'object' || node === null) return found;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'emitEvent' && typeof value === 'object' && value !== null) {
      const emit = value as { type?: unknown; data?: unknown };
      if (typeof emit.type === 'string') {
        const fields = found.get(emit.type) ?? new Set<string>();
        if (typeof emit.data === 'object' && emit.data !== null) {
          for (const field of Object.keys(emit.data)) fields.add(field);
        }
        found.set(emit.type, fields);
      }
    }
    emittedEvents(value, found);
  }
  return found;
}

/** Всё, что матч демо-арены может опубликовать: события сцены плюс нативные. */
const EMITTED = ((): Map<string, Set<string>> => {
  const found = emittedEvents(sceneJson);
  for (const [type, fields] of Object.entries(NATIVE_EVENTS)) found.set(type, new Set(fields));
  return found;
})();

describe('словарь журнала демо-арены (DIAG-10)', () => {
  it('контроль: обход нашёл события сцены — иначе покрытие проверялось бы на пустом множестве', () => {
    expect(emittedEvents(sceneJson).size).toBeGreaterThan(5);
    expect([...EMITTED.keys()]).toContain('EntityDied');
  });

  it('каждый тип события матча назван словарём', () => {
    const missing = [...EMITTED.keys()].filter((type) => DICTIONARY.events[type] === undefined).sort();
    expect(missing).toEqual([]);
  });

  it('роли словаря указывают на поля, которые событие действительно несёт', () => {
    const dangling: string[] = [];
    for (const [type, semantics] of Object.entries(DICTIONARY.events)) {
      const fields = EMITTED.get(type);
      if (fields === undefined) continue;
      for (const role of ['actor', 'target'] as const) {
        const field = semantics[role];
        if (field !== undefined && !fields.has(field)) dangling.push(`${type}.${role} → ${field}`);
      }
    }
    expect(dangling.sort()).toEqual([]);
  });

  it('словарь не описывает событий, которых в матче нет', () => {
    // Не строгость ради строгости: лишняя строка означает переименованное или
    // удалённое событие, и молча она пережила бы правку контента.
    const extra = Object.keys(DICTIONARY.events).filter((type) => !EMITTED.has(type)).sort();
    expect(extra).toEqual([]);
  });

  it('семантический код у каждой строки непустой — им факт и опознаётся', () => {
    for (const [type, semantics] of Object.entries(DICTIONARY.events)) {
      expect(semantics.kind, type).toMatch(/\S/);
    }
  });
});
