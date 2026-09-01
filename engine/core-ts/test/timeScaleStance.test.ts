/**
 * TIME-5 требует от КАЖДОЙ системы документировать своё отношение к TimeScale:
 * «Каждая система SHALL явно документировать своё решение (учитывает /
 * игнорирует TimeScale) — чтобы поведение под time-манипуляциями было
 * предсказуемо для дизайна». Дизайнер, ставящий на героя замедление, обязан
 * узнать судьбу каста, DoT и времени жизни зоны из документации системы, а не
 * из чтения её арифметики.
 *
 * Обязанность самоподдерживающаяся: новая нативная система без строки стенда
 * краснеет здесь, а не обнаруживается следующей валидацией спек. Формат строки —
 * конвенция кода, а не норма: требование велит документировать решение, а не
 * писать его в одну строку.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SYSTEMS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'systems');

/** Строка стенда: `TimeScale (TIME-5): учитывает|игнорирует — почему`. */
const STANCE = /TimeScale \(TIME-5\): (?:учитывает|игнорирует)/u;

/** Файл объявляет нативную систему, если в нём есть класс за контрактом `System`. */
const DECLARES_SYSTEM = /class \w+ implements System\b/u;

function sources(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

describe('TIME-5: отношение системы к TimeScale документировано', () => {
  const systemFiles = sources(SYSTEMS).filter((path) =>
    DECLARES_SYSTEM.test(readFileSync(path, 'utf8')),
  );

  it('нативные системы ядра вообще найдены — иначе проверка ничего не проверяет', () => {
    expect(systemFiles.length).toBeGreaterThan(10);
  });

  it.each(systemFiles.map((path) => path.slice(SYSTEMS.length + 1)))(
    '%s называет своё решение',
    (relative) => {
      expect(readFileSync(join(SYSTEMS, relative), 'utf8')).toMatch(STANCE);
    },
  );
});
