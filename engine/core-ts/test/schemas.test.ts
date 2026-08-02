import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schemaFileContent, schemaFiles } from '../src/dsl/schemas.js';
import { actionNames } from '../src/dsl/actions.js';
import { operators } from '../src/dsl/expr.js';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');

// `npm run schemas` перезаписывает файлы; обычный прогон только сверяет (SER-5).
const UPDATE = process.env['UPDATE_SCHEMAS'] === '1';

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

  it('схема системы перечисляет все действия и операторы ядра', () => {
    const doc = schemaFiles['system.schema.json'] as {
      $defs: { action: { propertyNames: { enum: string[] } }; expression: { oneOf: { propertyNames?: { enum: string[] } }[] } };
    };

    expect(doc.$defs.action.propertyNames.enum).toEqual([...actionNames].sort());
    const opNode = doc.$defs.expression.oneOf.find((v) => v.propertyNames !== undefined);
    expect(opNode?.propertyNames?.enum).toEqual([...operators].sort());
  });
});
