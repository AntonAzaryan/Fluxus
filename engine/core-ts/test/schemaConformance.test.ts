/**
 * SER-5: опубликованная схема MUST NOT быть строже загрузчика. Красный тест —
 * каждый golden-сценарий обязан проходить свою опубликованную схему.
 *
 * Без ajv (SER-5 запрещает ядру зависимость от валидатора JSON Schema):
 * ручной обход трёх структурных правил — `$ref` в `$defs`,
 * `additionalProperties: false` → неизвестное свойство, `required` →
 * отсутствующее поле. Значения (`type`/`pattern`/`minimum`/`enum`/`oneOf`) не
 * проверяются: эту строгость несёт загрузчик, не схема.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');
const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');

type Json = Record<string, unknown>;

function readSchema(name: string): Json {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8')) as Json;
}

/** Три правила из SER-5/design.md; ничего сверх них не проверяется. */
function validate(defs: Json, node: Json, value: unknown, path: string): string[] {
  if (typeof node['$ref'] === 'string') {
    const name = (node['$ref']).replace('#/$defs/', '');
    const target = defs[name] as Json | undefined;
    if (target === undefined) return [`${path}: неизвестная ссылка "${node['$ref']}"`];
    return validate(defs, target, value, path);
  }
  const errors: string[] = [];
  if (node['type'] === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Json;
    const props = (node['properties'] as Json | undefined) ?? {};
    if (node['additionalProperties'] === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path}: неизвестное свойство "${key}"`);
      }
    }
    for (const key of (node['required'] as string[] | undefined) ?? []) {
      if (!(key in obj)) errors.push(`${path}: отсутствует обязательное поле "${key}"`);
    }
    for (const key of Object.keys(obj)) {
      if (props[key] !== undefined) errors.push(...validate(defs, props[key] as Json, obj[key], `${path}.${key}`));
    }
  } else if (node['type'] === 'array' && Array.isArray(value) && node['items'] !== undefined) {
    value.forEach((item, i) => errors.push(...validate(defs, node['items'] as Json, item, `${path}[${i}]`)));
  }
  return errors;
}

const goldenNames = readdirSync(GOLDEN_DIR).filter((name) => name.endsWith('.scenario.json'));

describe('golden-сценарии проходят опубликованную схему (SER-5)', () => {
  const sceneSchema = readSchema('scene.schema.json');
  const scenarioSchema = readSchema('scenario.schema.json');

  for (const name of goldenNames) {
    it(`${name}: scene проходит scene.schema.json, документ — scenario.schema.json`, () => {
      const doc = JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')) as Json;
      expect(validate(sceneSchema['$defs'] as Json, sceneSchema, doc['scene'], 'scene')).toEqual([]);
      expect(validate(scenarioSchema['$defs'] as Json, scenarioSchema, doc, 'scenario')).toEqual([]);
    });
  }
});
