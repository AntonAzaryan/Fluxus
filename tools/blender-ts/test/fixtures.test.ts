/**
 * Закоммиченные бинарные фикстуры экспорта (задача 10.1, BLND-7): что они лежат
 * в дереве, что они — вывод читаемого перечня, и что разбор контейнера читает из
 * них то же самое, что из рукописной текстовой формы.
 *
 * Смысл проверки — в последнем. До неё контейнер `.glb` собирался в памяти
 * внутри самого теста, и такой тест не отличает «разбор верен» от «сборка и
 * разбор ошибаются согласованно»: обе стороны написаны одной рукой в одном
 * файле. Закоммиченный файл разрывает круг наполовину — сборка отделена от
 * прогона по времени, и её результат виден в диффе размером и датой.
 *
 * Blender не зовётся: фикстуры лежат в дереве, а собирает их Node (BLND-7).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGltf } from '../src/gltf.js';
import { normalizeDocument } from '../src/normalize.js';
import { generateSpatialLayer } from '../src/layer.js';
import { generateCellLayer } from '../src/maps.js';
import { GENERATED_FIXTURES } from './fixtureCatalogue.js';
import {
  CURVATURE_ROWS,
  TARGET_TERRAIN,
  TERRAIN_FLAGS,
  TERRAIN_LEVELS,
  context,
  fixtureBytes,
  objectsOf,
} from './support.js';

const committed = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe('BLND-7: закоммиченные фикстуры совпадают со своим источником', () => {
  it.each(GENERATED_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    '%s собрана перечнем и лежит в дереве',
    (name, fixture) => {
      // Забытая пере-сборка краснит здесь, а не доживает до первой странной
      // находки: `node test/fixtures/build.mjs` — и дифф виден в коммите.
      expect(Buffer.from(committed(name)).equals(Buffer.from(fixture.build())), name).toBe(true);
      expect(fixture.why.length, name).toBeGreaterThan(0);
    },
  );

  it('перечень не пуст и не дублируется', () => {
    const names = GENERATED_FIXTURES.map((fixture) => fixture.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.endsWith('.glb'), name).toBe(true);
  });
});

describe('BLND-3: контейнер и текстовая форма дают один и тот же разбор', () => {
  it('размещения из `.glb` совпадают с размещениями из рукописного `.gltf`', () => {
    const fromContainer = generateSpatialLayer(
      normalizeDocument(parseGltf(committed('placements.glb'))),
      context(),
    );
    const fromText = generateSpatialLayer(objectsOf('placements.gltf'), context());

    expect(fromContainer).toEqual(fromText);
    // Проверка не о пустоте: записи в слое есть, и их сравнение что-то значит.
    expect(fromContainer.initial.length + fromContainer.decorations.length).toBeGreaterThan(0);
  });

  it('ошибочные случаи отказывают из контейнера теми же находками', () => {
    const fromContainer = generateSpatialLayer(
      normalizeDocument(parseGltf(committed('errors.glb'))),
      context(),
    );

    expect(fromContainer).toEqual(generateSpatialLayer(objectsOf('errors.gltf'), context()));
    expect(fromContainer.findings.some((finding) => finding.severity === 'error')).toBe(true);
  });
});

describe('BLND-9, BLND-10: клеточные данные читаются из закоммиченного бинарного чанка', () => {
  const cellsOf = (name: string): ReturnType<typeof generateCellLayer> => {
    const document = parseGltf(committed(name));
    return generateCellLayer(document, normalizeDocument(document), context({ terrain: TARGET_TERRAIN }));
  };

  it('terrain-grid даёт те же карты, что и читаемые ряды перечня', () => {
    expect(cellsOf('terrain-grid.glb').terrain).toEqual({
      levels: [...TERRAIN_LEVELS],
      flags: [...TERRAIN_FLAGS],
    });
  });

  it('curvature-grid даёт те же ряды алфавита ASSET-7', () => {
    expect(cellsOf('curvature-grid.glb').curvature).toEqual({
      width: 4,
      height: 4,
      rows: [...CURVATURE_ROWS],
    });
  });

  it('полная фикстура несёт оба клеточных слоя и размещения сразу', () => {
    const document = parseGltf(committed('full.glb'));
    const objects = normalizeDocument(document);
    const cells = generateCellLayer(document, objects, context({ terrain: TARGET_TERRAIN }));
    const layer = generateSpatialLayer(objects, context({ terrain: TARGET_TERRAIN }));

    expect(cells.terrain).toEqual({ levels: [...TERRAIN_LEVELS], flags: [...TERRAIN_FLAGS] });
    expect(cells.curvature?.rows).toEqual([...CURVATURE_ROWS]);
    expect(layer.initial).toHaveLength(2);
    expect(layer.decorations).toHaveLength(1);
    expect(layer.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });

  it('клетка между уровнями отказывает адресом клетки, а не округляется', () => {
    const layer = cellsOf('terrain-fractional.glb');

    expect(layer.terrain).toBeUndefined();
    expect(layer.findings.map((finding) => finding.message).join('\n')).toContain('клетка (1, 2)');
  });

  it('рампа в одну клетку отказывает той же реализацией, что у кисти ED-10', () => {
    const layer = cellsOf('terrain-narrow-ramp.glb');

    expect(layer.terrain).toBeUndefined();
    expect(layer.findings.map((finding) => finding.message).join('\n')).toContain('TERR-7');
  });
});

describe('BLND-7: фикстуры — файлы дерева, а не результат запуска Blender', () => {
  it('ни одна не содержит следа вызова инструмента', () => {
    // `generator` контейнера пишет тот, кто его собрал: перечень этого пакета.
    // Настоящий Blender поставил бы туда своё имя, и подмена фикстуры экспортом
    // «на минутку» была бы видна.
    for (const fixture of GENERATED_FIXTURES) {
      const text = new TextDecoder().decode(committed(fixture.name).slice(0, 512));
      expect(text.toLowerCase(), fixture.name).not.toContain('blender foundation');
    }
    expect(fixtureBytes('placements.gltf').byteLength).toBeGreaterThan(0);
  });
});
