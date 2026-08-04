/**
 * Vite-конфиг демо. Корень — сам каталог demo/ (index.html и main.ts здесь),
 * контент отдаётся из demo/public. Пакеты @game-mvp/* подключены как file:
 * симлинки на соседние каталоги engine/, поэтому dev-серверу разрешается
 * читать весь engine/, а кэш оптимизатора уводится в node_modules пакета.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const demoRoot = fileURLToPath(new URL('.', import.meta.url));
const engineRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: demoRoot,
  cacheDir: '../node_modules/.vite-demo',
  server: {
    fs: { allow: [engineRoot] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
