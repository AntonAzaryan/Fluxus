/**
 * Точка монтирования: константа `EDITOR_ROOT_ID`, разметка приложения и
 * подготовка корня обязаны говорить об одном элементе — иначе приложение
 * собирается, запускается и молча ничего не показывает.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDITOR_ROOT_ID, mountEditorRoot } from '../src/index.js';

const page = readFileSync(fileURLToPath(new URL('../app/index.html', import.meta.url)), 'utf8');

/** Документ-заглушка: DOM здесь не нужен, нужен только поиск по id. */
function fakeDocument(root: { replaceChildren: () => void } | null): Document {
  return {
    getElementById: (id: string) => (id === EDITOR_ROOT_ID ? root : null),
  } as unknown as Document;
}

describe('точка монтирования редактора', () => {
  it('страница приложения содержит корень с этим идентификатором', () => {
    expect(page).toContain(`id="${EDITOR_ROOT_ID}"`);
    expect(page).toContain('src="./main.ts"');
  });

  it('возвращает корень пустым', () => {
    let cleared = false;
    const root = {
      replaceChildren: () => {
        cleared = true;
      },
    };

    expect(mountEditorRoot(fakeDocument(root))).toBe(root as unknown as HTMLElement);
    expect(cleared).toBe(true);
  });

  it('падает, если корня в документе нет', () => {
    expect(() => mountEditorRoot(fakeDocument(null))).toThrow(EDITOR_ROOT_ID);
  });
});
