/**
 * Vite-конфиг приложения редактора. Корень — сам каталог app/ (index.html и
 * main.ts здесь), дерево контента раздаётся из `content/` (CONT-5: путь до
 * корня дерева — свойство оболочки, документы ссылаются друг на друга
 * относительно), поэтому веб-реализация хоста среды (ED-12) читает его по
 * тем же относительным путям, что и десктопная.
 *
 * Пакеты @fluxus/* подключены как file: симлинки на соседние каталоги
 * workspace, поэтому dev-серверу разрешается читать весь репозиторий, а кэш
 * оптимизатора уводится в node_modules пакета.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { contentEndpoint } from './contentEndpoint.js';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const contentRoot = fileURLToPath(new URL('../../../content', import.meta.url));

export default defineConfig({
  // Перечисление дерева и запись документа: у HTTP их нет, и веб-хосту среды
  // (ED-12) их даёт dev-сервер. Обоснование — в шапке `contentEndpoint.ts`.
  plugins: [contentEndpoint({ root: contentRoot })],
  root: appRoot,
  publicDir: contentRoot,
  cacheDir: '../node_modules/.vite-app',
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
