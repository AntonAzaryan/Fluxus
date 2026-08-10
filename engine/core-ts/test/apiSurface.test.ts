/**
 * Эталон публичной поверхности ядра (CLI-8): перечень рантайм-экспортов
 * `src/index.ts` сверяется со списком в api-surface.golden.json. Случайный
 * экспорт мутатора мира — это side-channel мимо Command Buffer (TICK-3,
 * DET-7), и он обязан краснеть здесь до ревью.
 *
 * Расширение поверхности принимается явно: `UPDATE_API=1 npx vitest run
 * test/apiSurface.test.ts` — по модели golden-эталонов (CLI-5). Типы в
 * рантайм-поверхность не входят: мутаторы — значения, их и фиксируем.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'api-surface.golden.json');
const UPDATE = process.env.UPDATE_API === '1';

describe('поверхность экспорта ядра (CLI-8)', () => {
  it('рантайм-экспорты src/index.ts совпадают с эталоном', () => {
    const produced = `${JSON.stringify(Object.keys(api).sort(), null, 2)}\n`;
    if (UPDATE) {
      writeFileSync(GOLDEN, produced);
      return;
    }
    expect(produced).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});
