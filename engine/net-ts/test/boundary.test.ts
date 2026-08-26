/**
 * Граница модуля (NTR-1). Проверяется сборкой, а не ревью: ядро о сети не знает
 * (DI-3), и обратный импорт обязан быть невозможен физически.
 *
 * Второе проверяемое здесь — что появление сетевого слоя не расширило
 * мутирующую поверхность ядра. Хелпер, добавленный в ядро «для сети», и есть
 * тот side-channel, который TICK-3 объявляет несуществующим (NTR-1).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Путь берётся `fileURLToPath`, а не `URL.pathname`: у `file:`-адреса на
 * Windows `pathname` — это `/D:/Fluxus/...`, и `join` с него начинает второй
 * абсолютный путь (`D:\D:\Fluxus\...`). Проверка границы падала бы на ENOENT,
 * ни разу не заглянув в исходники.
 */
const CORE_ROOT = fileURLToPath(new URL('../../core-ts/', import.meta.url));

function coreSources(): string[] {
  return readdirSync(join(CORE_ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => join(CORE_ROOT, 'src', entry));
}

describe('зависимость односторонняя', () => {
  it('у ядра нет рантайм-зависимостей вообще', () => {
    const manifest = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('ни один исходник ядра не ссылается на сетевой модуль', () => {
    const offenders = coreSources().filter((file) => readFileSync(file, 'utf8').includes('@fluxus/net'));
    expect(offenders).toEqual([]);
  });
});

describe('поверхность ядра не расширялась', () => {
  it('мутирующий хелпер остался ровно один — worldInitSpawn', () => {
    const index = readFileSync(join(CORE_ROOT, 'src/index.ts'), 'utf8');
    const exportedMutators = ['spawn', 'destroy', 'setField', 'addComponent', 'removeComponent', 'addTag']
      .filter((name) => new RegExp(`^\\s*export (const|function) ${name}\\b`, 'm').test(index));
    expect(exportedMutators).toEqual([]);
    expect(index).toContain('export const worldInitSpawn');
  });

  it('сетевой слой обходится опубликованной поверхностью', () => {
    // Импорт из глубины ядра (`@fluxus/core/src/...`) означал бы, что граница
    // держится на честном слове, а не на экспортах.
    const netRoot = fileURLToPath(new URL('../src/', import.meta.url));
    const offenders = readdirSync(netRoot, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts'))
      .filter((entry) => readFileSync(join(netRoot, entry), 'utf8').includes('@fluxus/core/'));
    expect(offenders).toEqual([]);
  });
});
