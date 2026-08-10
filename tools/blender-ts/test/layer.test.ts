/**
 * Генерация целевого пространственного слоя: записи расстановки (SER-8),
 * записи `decorations` (PRES-2), порядок (BLND-4), квантование (FP-1, PRES-3) и
 * находки импорта (BLND-3, BLND-6).
 *
 * Слой считается в память: запись документов — задача операции авторинга
 * (BLND-5), и её здесь нет.
 */
import { describe, expect, it } from 'vitest';
import { fixed } from '@game-mvp/core';
import {
  DEFAULT_POSITION_BINDING,
  generateSpatialLayer,
  hasErrors,
  quantizedFixed,
  type Finding,
} from '../src/layer.js';
import { COMPONENTS, context, objectsOf } from './support.js';

const ROTATION = { component: 'Facing', field: 'turns' } as const;

function messagesFor(findings: readonly Finding[], object: string): readonly string[] {
  return findings.filter((finding) => finding.object === object).map((finding) => finding.message);
}

describe('BLND-3: узел с prefab даёт запись расстановки', () => {
  const layer = generateSpatialLayer(objectsOf('placements.gltf'), context());

  it('позиция и курс — переопределения полей компонентов из настройки проекта (ED-16)', () => {
    const withRotation = generateSpatialLayer(
      objectsOf('placements.gltf'),
      context({ binding: { ...DEFAULT_POSITION_BINDING, rotation: ROTATION } }),
    );
    expect(withRotation.initial[1]).toEqual({
      prefab: 'Hero',
      overrides: {
        Facing: { turns: fixed.fromFloat(0.25) },
        Locomotion: { maxSpeed: fixed.fromFloat(0.5) },
        Player: { slot: 1 },
        Position: { x: fixed.fromFloat(3), y: fixed.fromFloat(4) },
      },
    });
  });

  it('проект, не назвавший, где лежит поворот, курса не хранит', () => {
    expect(Object.keys(layer.initial[1]?.overrides as object)).toEqual([
      'Locomotion',
      'Player',
      'Position',
    ]);
  });

  it('именованных полей позиции в записи нет: формат их не знает (SER-8)', () => {
    expect(layer.initial[0]).toEqual({
      prefab: 'Hero',
      overrides: { Position: { x: fixed.fromFloat(-1.5), y: fixed.fromFloat(-2.25) } },
    });
  });

  it('вспомогательный объект без семантических свойств не порождает ни записи, ни находки', () => {
    expect(layer.initial).toHaveLength(2);
    expect(messagesFor(layer.findings, 'marker-center')).toEqual([]);
  });
});

describe('BLND-3: узел с visual даёт запись decoration', () => {
  const layer = generateSpatialLayer(objectsOf('placements.gltf'), context());

  it('состав записи закрыт: позиция, курс, масштаб и скин, и ничего сверх (PRES-2)', () => {
    expect(layer.decorations).toEqual([
      { visual: 'Statue', x: 5.5, y: 18.5, yaw: 0.125, scale: 0.75, skin: 'steel' },
    ]);
  });

  it('умолчания не записываются: отсутствующее и равное умолчанию неразличимы', () => {
    const objects = objectsOf('warnings.gltf');
    const [record] = generateSpatialLayer(objects, context()).decorations;
    expect(Object.keys(record ?? {})).toEqual(['visual', 'x', 'y']);
  });

  it('сим-полей в записи нет ни под каким именем (PRES-2)', () => {
    for (const record of layer.decorations) {
      expect(record.prefab).toBeUndefined();
      expect(record.overrides).toBeUndefined();
    }
  });
});

describe('BLND-4: порядок записей — лексикографически по имени объекта', () => {
  const layer = generateSpatialLayer(objectsOf('placements.gltf'), context());

  it('расстановка упорядочена именами, а не порядком узлов glTF', () => {
    // В документе узлы идут zeta-hero, alpha-hero: порядок обхода другой.
    expect(layer.initial.map((record) => record.prefab)).toEqual(['Hero', 'Hero']);
    expect(layer.initial[0]?.overrides).toEqual({
      Position: { x: fixed.fromFloat(-1.5), y: fixed.fromFloat(-2.25) },
    });
  });

  it('порядок не зависит от локали среды: сравнение по кодовым единицам', () => {
    const objects = [...objectsOf('placements.gltf')].reverse();
    const reversed = generateSpatialLayer(objects, context());
    expect(reversed).toEqual(layer);
  });

  it('повторный прогон даёт тот же слой байт-в-байт', () => {
    const again = generateSpatialLayer(objectsOf('placements.gltf'), context());
    expect(JSON.stringify(again)).toBe(JSON.stringify(layer));
  });
});

describe('BLND-4: квантование выполняет импортёр до записи', () => {
  it('сим-величины — Q16.16 вызовом ядра (FP-1)', () => {
    expect(quantizedFixed(1.5)).toBe(fixed.fromFloat(1.5));
    expect(quantizedFixed(0)).toBe(0);
  });

  it('величина вне диапазона Q16.16 не приводится молча', () => {
    expect(quantizedFixed(100000)).toBe(null);
    expect(quantizedFixed(Number.NaN)).toBe(null);
  });

  it('величины decoration — шаг PRES-3', () => {
    const objects = objectsOf('placements.gltf').map((object) =>
      object.name === 'beta-statue' ? { ...object, x: 1.23456789, yaw: 0.12345678 } : object,
    );
    const [record] = generateSpatialLayer(objects, context()).decorations;
    expect(record?.x).toBe(1.235);
    expect(record?.yaw).toBe(0.1235);
  });
});

describe('BLND-3, BLND-6: находки называют объект Blender', () => {
  const layer = generateSpatialLayer(objectsOf('errors.gltf'), context());

  it('объект с двумя семантическими свойствами — отказ', () => {
    expect(messagesFor(layer.findings, 'both-layers')).toEqual([
      expect.stringContaining('семантических свойств несколько') as unknown as string,
    ]);
  });

  it('неизвестное имя prefab\'а — отказ с именем', () => {
    expect(messagesFor(layer.findings, 'ghost-prefab')[0]).toContain('Ghost');
  });

  it('компонент вне схем сцены — отказ', () => {
    expect(messagesFor(layer.findings, 'unknown-component')[0]).toContain('Health');
  });

  it('поле вне схемы компонента — отказ', () => {
    expect(messagesFor(layer.findings, 'unknown-field')[0]).toContain('team');
  });

  it('значение вне Q16.16 — отказ, а не молчаливое приведение', () => {
    expect(messagesFor(layer.findings, 'out-of-range')[0]).toContain('Q16.16');
  });

  it('нецелое значение в поле i32 не округляется', () => {
    expect(messagesFor(layer.findings, 'fractional-int')[0]).toContain('i32');
  });

  it('поле типа entity пространственным слоем не пишется — отказ (ECS-6)', () => {
    // Ссылка на сущность — не координата, и идентификатора создаваемой той же
    // расстановкой сущности до применения команды не существует.
    const components = COMPONENTS.map((schema) =>
      schema.name === 'Player' ? { ...schema, fields: { ...schema.fields, target: 'entity' as const } } : schema,
    );
    const objects = objectsOf('placements.gltf').map((object) =>
      object.name === 'alpha-hero'
        ? { ...object, extras: { ...object.extras, 'Player.target': 5 } }
        : object,
    );
    const withEntityField = generateSpatialLayer(objects, context({ components }));
    expect(messagesFor(withEntityField.findings, 'alpha-hero')[0]).toContain('поле типа entity');
    expect(hasErrors(withEntityField.findings)).toBe(true);
    // Значение в запись не уехало: переопределение осталось только позиционным.
    expect(withEntityField.initial[0]?.overrides).toEqual({
      Position: { x: fixed.fromFloat(-1.5), y: fixed.fromFloat(-2.25) },
    });
  });

  it('все ошибки источника видны разом, и запись не выполняется целиком', () => {
    expect(hasErrors(layer.findings)).toBe(true);
    expect(new Set(layer.findings.map((finding) => finding.object)).size).toBe(6);
  });

  it('компонент вне состава prefab\'а — отказ (CMD-6)', () => {
    const objects = objectsOf('placements.gltf').map((object) =>
      object.name === 'alpha-hero' ? { ...object, semanticValue: 'Marker' } : object,
    );
    const findings = generateSpatialLayer(objects, context()).findings;
    expect(messagesFor(findings, 'alpha-hero')[0]).toContain("не входит в состав prefab'а");
  });

  it('custom property на месте позиции — отказ: позиция берётся из трансформа', () => {
    // Молчаливо предпочесть одно из двух значений импортёр не вправе: автор
    // двигал бы объект в Blender, а в кадре не менялось бы ничего (BLND-3).
    const objects = objectsOf('placements.gltf').map((object) =>
      object.name === 'alpha-hero'
        ? { ...object, extras: { ...object.extras, 'Position.x': 9 } }
        : object,
    );
    const layer = generateSpatialLayer(objects, context());
    expect(messagesFor(layer.findings, 'alpha-hero')[0]).toContain('из трансформа объекта');
    expect(hasErrors(layer.findings)).toBe(true);
    // Значение custom property в запись не уехало: позиция осталась трансформной.
    expect(layer.initial[0]?.overrides).toEqual({
      Position: { x: fixed.fromFloat(-1.5), y: fixed.fromFloat(-2.25) },
    });
  });

  it('custom property на месте курса — отказ у проекта, назвавшего поворот', () => {
    const objects = objectsOf('placements.gltf').map((object) =>
      object.name === 'alpha-hero'
        ? { ...object, extras: { ...object.extras, 'Facing.turns': 0.5 } }
        : object,
    );
    const withRotation = context({ binding: { ...DEFAULT_POSITION_BINDING, rotation: ROTATION } });
    expect(messagesFor(generateSpatialLayer(objects, withRotation).findings, 'alpha-hero')[0]).toContain(
      'из трансформа объекта',
    );
    // Проект, не назвавший, где лежит поворот, того же поля не занимает: для
    // него это обычное переопределение (BLND-3).
    expect(messagesFor(generateSpatialLayer(objects, context()).findings, 'alpha-hero')).toEqual([]);
  });

  it('имя объекта, встретившееся дважды, лишает порядок однозначности', () => {
    const objects = objectsOf('placements.gltf');
    const twin = objects.find((object) => object.name === 'alpha-hero');
    const findings = generateSpatialLayer([...objects, { ...twin!, node: 99 }], context()).findings;
    expect(messagesFor(findings, 'alpha-hero')[0]).toContain('дважды');
  });
});

describe('BLND-6: ключ visual без записи манифеста — предупреждение, а не отказ', () => {
  const layer = generateSpatialLayer(objectsOf('warnings.gltf'), context());

  it('запись пишется, находка — предупреждение', () => {
    expect(hasErrors(layer.findings)).toBe(false);
    expect(layer.decorations).toHaveLength(2);
    expect(messagesFor(layer.findings, 'ghost-visual')).toEqual([
      expect.stringContaining('NoSuchVisual') as unknown as string,
    ]);
  });

  it('манифеста нет вовсе — ссылки не проверяются: это не то же, что ключа в нём нет', () => {
    const findings = generateSpatialLayer(objectsOf('warnings.gltf'), context({ visuals: null })).findings;
    expect(messagesFor(findings, 'ghost-visual')).toEqual([]);
  });

  it('неодинаковый по осям масштаб — предупреждение с названным выбором', () => {
    expect(messagesFor(layer.findings, 'stretched-statue')[0]).toContain('оси X');
  });

  it('зеркальный трансформ — предупреждение: запись decoration зеркала не выражает', () => {
    const objects = objectsOf('warnings.gltf').map((object) =>
      object.name === 'stretched-statue' ? { ...object, mirrored: true } : object,
    );
    const findings = generateSpatialLayer(objects, context()).findings;
    expect(messagesFor(findings, 'stretched-statue').some((m) => m.includes('зеркальный'))).toBe(true);
    expect(hasErrors(findings)).toBe(false);
  });

  it('зеркальный трансформ сим-размещения — предупреждение у проекта с поворотом', () => {
    const objects = objectsOf('placements.gltf').map((object) =>
      object.name === 'alpha-hero' ? { ...object, mirrored: true } : object,
    );
    const withRotation = context({ binding: { ...DEFAULT_POSITION_BINDING, rotation: ROTATION } });
    expect(messagesFor(generateSpatialLayer(objects, withRotation).findings, 'alpha-hero')[0]).toContain(
      'зеркальный',
    );
    // Позиции зеркало не касается: сцена без поворота о нём и не слышит.
    expect(messagesFor(generateSpatialLayer(objects, context()).findings, 'alpha-hero')).toEqual([]);
  });
});

describe('BLND-7: конвейер изолирован от Blender', () => {
  it('слой считается от закоммиченной фикстуры, и цель импорта — данные вызывающего', () => {
    const layer = generateSpatialLayer(objectsOf('placements.gltf'), {
      components: context().components,
    });
    // Без списка prefab'ов имя не проверяется — цель может быть неизвестна.
    expect(hasErrors(layer.findings)).toBe(false);
    expect(layer.initial).toHaveLength(2);
  });
});
