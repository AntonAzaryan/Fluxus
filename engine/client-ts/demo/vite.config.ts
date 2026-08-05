/**
 * Vite-конфиг демо. Корень — сам каталог demo/ (index.html и main.ts здесь),
 * контент раздаётся из корня дерева контента `content/` (CONT-5: путь до корня
 * дерева — свойство оболочки, а сами документы ссылаются друг на друга
 * относительно). Пакеты @game-mvp/* подключены как file: симлинки на соседние
 * каталоги engine/, поэтому dev-серверу разрешается читать весь репозиторий,
 * а кэш оптимизатора уводится в node_modules пакета.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const demoRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const contentRoot = fileURLToPath(new URL('../../../content', import.meta.url));

export default defineConfig({
  root: demoRoot,
  publicDir: contentRoot,
  cacheDir: '../node_modules/.vite-demo',
  server: {
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
});
