/**
 * Арифметика путей корня: форма пути и единственная дверь наружу (DSK-5).
 *
 * Проверяется отдельно от контрактного сьюта потому, что сьют проверяет
 * ПОВЕДЕНИЕ границы («за корень не выходит ни одна операция»), а здесь —
 * причину, по которой оно такое: нормализация отказывает, а не усекает.
 */
import { describe, expect, it } from 'vitest';
import {
  compareHostNames,
  hostPathExtension,
  hostPathName,
  joinHostPath,
  normalizeHostPath,
} from '../src/host/paths.js';

describe('нормализация пути корня', () => {
  it('приводит форму: разделитель, лишние слэши, точка', () => {
    expect(normalizeHostPath('/scenes//duel.scene.json')).toBe('scenes/duel.scene.json');
    expect(normalizeHostPath('./visuals/./manifest.json')).toBe('visuals/manifest.json');
    expect(normalizeHostPath('visuals\\models\\hero.mdx')).toBe('visuals/models/hero.mdx');
    expect(normalizeHostPath('')).toBe('');
    expect(normalizeHostPath('/')).toBe('');
  });

  it('выход за корень — отказ, а не усечение', () => {
    // Усечение до "secret" сделало бы `..` бесшумным способом ходить по диску
    // ровно там, где корень и есть вся выданная возможность.
    expect(() => normalizeHostPath('../secret')).toThrow('выходит за корень');
    expect(() => normalizeHostPath('scenes/../../secret')).toThrow('выходит за корень');
  });

  it('внутренний `..` тоже отказ: путь дерева его не содержит', () => {
    expect(() => normalizeHostPath('scenes/../visuals/manifest.json')).toThrow();
  });

  it('NUL и абсолютный путь Windows не проходят', () => {
    expect(() => normalizeHostPath('scenes/\0.json')).toThrow('NUL');
    expect(() => normalizeHostPath('C:/Windows/system32')).toThrow('абсолютен');
  });
});

describe('разбор и склейка', () => {
  it('имя, расширение, склейка', () => {
    expect(hostPathName('scenes/duel.scene.json')).toBe('duel.scene.json');
    expect(hostPathName('')).toBe('');
    expect(hostPathExtension('visuals/models/hero.MDX')).toBe('.mdx');
    expect(hostPathExtension('LICENSE')).toBe('');
    expect(hostPathExtension('.gitignore')).toBe('');
    expect(joinHostPath('visuals', 'models/hero.mdx')).toBe('visuals/models/hero.mdx');
    expect(joinHostPath('', 'index.html')).toBe('index.html');
  });

  it('порядок имён нормирован и не зависит от локали', () => {
    const names = ['duel.scene.json', 'Duel.scene.json', 'arena.json'];
    expect([...names].sort(compareHostNames)).toEqual([
      'Duel.scene.json',
      'arena.json',
      'duel.scene.json',
    ]);
  });
});
