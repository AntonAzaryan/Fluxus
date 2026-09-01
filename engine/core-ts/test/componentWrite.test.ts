/**
 * Запись поля компонента, которым сущность не владеет (ECS-8).
 *
 * Проверяется то, что наблюдаемо: ячейка хранилища не меняется (плоская форма
 * мира сверяется побитово — SER-1, CLI-6), владения не возникает, dirty-срез
 * такую запись не отмечает, тик не обрывается, а порядок проверок сохранён —
 * непредставимое значение остаётся жёсткой ошибкой (ECS-3, SYS-9) и у
 * невладеющей сущности тоже. Отдельно закреплено разведение каналов (FP-4):
 * мягкий assert debug-сборки не меняет ни состояния мира, ни результата.
 *
 * Чего здесь нет: теста на исход команды в трейсе. Словарь исходов (DIAG-5)
 * описывает решение буфера о команде, а не объём мутации, и от ECS-8 он не
 * меняется — команда доходит до мутатора в свой черёд и там не делает ничего.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  clearDirty,
  createWorld,
  destroy,
  dirtyEntities,
  getField,
  hasComponent,
  removeComponent,
  setField,
  spawn,
  toPlain,
  type PrefabDef,
} from '../src/ecs/world.js';
import { createCommandBuffer } from '../src/ecs/commands.js';
import { indexOf as rawIndexOf } from '../src/ecs/entityIndex.js';
import { withDiagnostics } from '../src/debug.js';
import {
  NO_ENTITY,
  type ComponentSchema,
  type DiagnosticRecord,
  type DiagnosticsSink,
  type WorldState,
} from '../src/types.js';

const Health: ComponentSchema = { name: 'Health', fields: { current: 'fixed', max: 'fixed' } };
/** Носитель ссылки: `target` — поле типа `entity` (ECS-6). */
const Seeker: ComponentSchema = { name: 'Seeker', fields: { target: 'entity', hits: 'i32' } };
const Note: ComponentSchema = { name: 'Note', fields: { value: 'i32' } };

const SCHEMAS: readonly ComponentSchema[] = [Health, Seeker, Note];

const PREFABS: readonly PrefabDef[] = [
  { name: 'hero', components: { Health: { current: 500, max: 500 }, Note: { value: 0 } } },
  // Ни `Health`, ни `Seeker` — тот, кому пишут «без владения».
  { name: 'rock', components: { Note: { value: 0 } } },
];

function world(): WorldState {
  return createWorld(SCHEMAS, PREFABS, 16);
}

function collector(): { sink: DiagnosticsSink; entries: DiagnosticRecord[] } {
  const entries: DiagnosticRecord[] = [];
  return { sink: { trace: 'off', record: (entry) => entries.push(entry) }, entries };
}

describe('запись без владения — пустая операция (ECS-8)', () => {
  it('живая сущность без компонента: ячейка сохраняет прежнее содержимое, владения не возникает', () => {
    const state = world();
    const rock = spawn(state, 'rock');
    addComponent(state, rock, 'Health', { current: 777, max: 777 });
    removeComponent(state, rock, 'Health');

    setField(state, rock, 'Health', 'current', 42);

    // Ни ячейка, ни маска не тронуты: состав компонентов задаёт addComponent (CMD-4).
    expect(toPlain(state).components.Health!.current![rawIndexOf(rock)]).toBe(777);
    expect(hasComponent(state, rock, 'Health')).toBe(false);
    // Чтение по-прежнему нейтрально (ECS-7) — и было бы им и при записи в ячейку.
    expect(getField(state, rock, 'Health', 'current')).toBe(0);
  });

  it('владеющая запись не задета: соседняя сущность с компонентом пишется как прежде', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    setField(state, hero, 'Health', 'current', 123);
    expect(getField(state, hero, 'Health', 'current')).toBe(123);
  });

  it('поле типа entity у невладеющей сущности остаётся «ссылки нет» (ECS-6)', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const rock = spawn(state, 'rock');
    setField(state, rock, 'Seeker', 'target', hero);
    expect(getField(state, rock, 'Seeker', 'target')).toBe(NO_ENTITY);
  });

  it('dirty-срез отброшенную запись не отмечает (OBS-6)', () => {
    const state = world();
    const rock = spawn(state, 'rock');
    clearDirty(state);

    setField(state, rock, 'Health', 'current', 42);
    expect(dirtyEntities(state, 'Health').has(rock)).toBe(false);
  });

  it('не-живая сущность: запись тоже пустая операция, как и команда к ней (CMD-7)', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const index = rawIndexOf(hero);
    destroy(state, hero);

    setField(state, hero, 'Health', 'current', 13);
    expect(toPlain(state).components.Health!.current![index]).toBe(500);
  });
});

describe('порядок проверок записи (ECS-3, ECS-8)', () => {
  it('непредставимое значение остаётся жёсткой ошибкой и у невладеющей сущности', () => {
    const state = world();
    const rock = spawn(state, 'rock');
    // Дефект здесь — сам текст системы, а не состояние мира, поэтому владение
    // отказ не отменяет: значение проверяется раньше (SYS-9, класс 3).
    expect(() => { setField(state, rock, 'Health', 'current', 2 ** 40); }).toThrow(/непредставимо/);
  });

  it('опечатка в имени компонента и поля остаётся ошибкой (ECS-5)', () => {
    const state = world();
    const rock = spawn(state, 'rock');
    expect(() => { setField(state, rock, 'Halth', 'current', 1); }).toThrow(/не зарегистрирован/);
    expect(() => { setField(state, rock, 'Health', 'currnt', 1); }).toThrow(/нет поля/);
  });
});

describe('запись без владения через Command Buffer (ECS-8, CMD-1)', () => {
  it('компонент снят раньше в том же буфере — запись отбрасывается молча', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const commands = createCommandBuffer(state);

    commands.removeComponent(hero, 'Health');
    commands.setField(hero, 'Health', 'current', 42);
    expect(() => { commands.flush(); }).not.toThrow();

    expect(hasComponent(state, hero, 'Health')).toBe(false);
    expect(toPlain(state).components.Health!.current![rawIndexOf(hero)]).toBe(500);
  });

  it('addComponent раньше setField в одном буфере — значение доходит (CMD-3)', () => {
    const state = world();
    const rock = spawn(state, 'rock');
    const commands = createCommandBuffer(state);

    commands.addComponent(rock, 'Health', { current: 10, max: 10 });
    commands.setField(rock, 'Health', 'current', 42);
    commands.flush();

    expect(hasComponent(state, rock, 'Health')).toBe(true);
    expect(getField(state, rock, 'Health', 'current')).toBe(42);
  });
});

describe('громкость отброшенной записи — отдельный канал (FP-4, ECS-8)', () => {
  it('debug-сборка даёт ровно одну запись об отсутствии владения и не меняет мир', () => {
    const state = world();
    const rock = spawn(state, 'rock');
    const before = JSON.stringify(toPlain(state));

    const { sink, entries } = collector();
    withDiagnostics(sink, 1, () => {
      setField(state, rock, 'Health', 'current', 42);
    });

    expect(entries.map((e) => e.code)).toEqual(['COMPONENT_WRITE_WITHOUT_OWNERSHIP']);
    expect(JSON.stringify(toPlain(state))).toBe(before);
  });
});
