import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schemaFileContent, schemaFiles } from '../src/dsl/schemas.js';
import { actionNames } from '../src/dsl/actions.js';
import { operators } from '../src/dsl/expr.js';
import {
  terrainFlagChar,
  terrainLevelChar,
  TERRAIN_CELL_KINDS,
  TERRAIN_LEVEL_MAX,
} from '../src/systems/terrain.js';
import type { LocomotionOptions } from '../src/systems/locomotion.js';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');

// `npm run schemas` перезаписывает файлы; обычный прогон только сверяет (SER-5).
const UPDATE = process.env.UPDATE_SCHEMAS === '1';

describe('engine/schemas (SER-5)', () => {
  if (UPDATE) {
    it('перегенерированы', () => {
      mkdirSync(SCHEMA_DIR, { recursive: true });
      for (const name of Object.keys(schemaFiles)) {
        writeFileSync(join(SCHEMA_DIR, name), schemaFileContent(name));
      }
      expect(Object.keys(schemaFiles).length).toBeGreaterThan(0);
    });
    return;
  }

  for (const name of Object.keys(schemaFiles)) {
    it(`${name} совпадает с генератором`, () => {
      const onDisk = readFileSync(join(SCHEMA_DIR, name), 'utf8');
      expect(onDisk).toBe(schemaFileContent(name));
    });
  }

  /**
   * SER-5: схема не поддерживается отдельно от ядра. Паттерн карты записан
   * диапазоном (`0-9A-F`), а алфавит ядра — перечислением символов, поэтому
   * сверяется не текст паттерна, а принимаемое им множество: разойдись они —
   * редактор писал бы ассет, который схема отвергает (ED-10).
   */
  it('схема террейна принимает ровно алфавиты карт (TERR-3)', () => {
    const doc = schemaFiles['terrain.schema.json'] as {
      properties: { levels: { items: { pattern: string } }; flags: { items: { pattern: string } } };
    };
    const levelChars = new Set(
      Array.from({ length: TERRAIN_LEVEL_MAX + 1 }, (_unused, level) => terrainLevelChar(level)),
    );
    const flagChars = new Set(TERRAIN_CELL_KINDS.map((kind) => terrainFlagChar(kind)));
    const levels = new RegExp(doc.properties.levels.items.pattern);
    const flags = new RegExp(doc.properties.flags.items.pattern);

    // Печатаемый ASCII — множество, из которого алфавит карты вообще выбирается.
    for (let code = 0x21; code <= 0x7e; code++) {
      const char = String.fromCharCode(code);
      expect([char, levels.test(char)]).toEqual([char, levelChars.has(char)]);
      expect([char, flags.test(char)]).toEqual([char, flagChars.has(char)]);
    }
  });

  /**
   * SER-5: схема MUST NOT быть строже загрузчика. Блок `locomotion` закрыт
   * `additionalProperties: false`, поэтому опция системы, в нём не описанная,
   * отвергалась бы схемой при живом ядре (LOC-1, LOC-7).
   */
  it('схема сценария описывает ровно опции локомоушена (LOC-1, LOC-7)', () => {
    // `Required<>` держит список полным: новая опция системы не пройдёт
    // typecheck, пока её не впишут сюда, а тест — пока её не опишет схема.
    const options: Required<LocomotionOptions> = {
      name: 'Locomotion',
      inputComponent: 'Input',
      velocityComponent: 'Velocity',
      configComponent: 'Locomotion',
      stateComponent: 'LocomotionState',
      colliderComponent: 'Collider',
      dodgeButton: 1,
      jumpButton: 2,
      lockComponent: 'ActionLock',
      maneuverLockBit: 0,
    };
    const doc = schemaFiles['scenario.schema.json'] as {
      properties: { locomotion: { properties: Record<string, unknown> } };
    };

    expect(Object.keys(doc.properties.locomotion.properties).sort()).toEqual(Object.keys(options).sort());
  });

  it('схема системы перечисляет все действия и операторы ядра', () => {
    const doc = schemaFiles['system.schema.json'] as {
      $defs: { action: { propertyNames: { enum: string[] } }; expression: { oneOf: { propertyNames?: { enum: string[] } }[] } };
    };

    expect(doc.$defs.action.propertyNames.enum).toEqual([...actionNames].sort());
    const opNode = doc.$defs.expression.oneOf.find((v) => v.propertyNames !== undefined);
    expect(opNode?.propertyNames?.enum).toEqual([...operators].sort());
  });
});
