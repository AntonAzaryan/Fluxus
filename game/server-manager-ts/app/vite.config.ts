/**
 * Vite-конфиг приложения менеджера. Корень — сам каталог `app/`.
 *
 * Дерева контента у менеджера нет ни в каком виде (`desktop-shell` DSK-5,
 * решение D11): ни `publicDir`, ни эндпоинта перечисления — с контентом он
 * работает только через управляющий протокол агента. Отсюда и разница с
 * конфигами редактора и демо: у них дерево раздаётся, у него раздавать нечего.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default defineConfig({
  root: appRoot,
  cacheDir: '../node_modules/.vite-app',
  server: {
    // Пакеты @fluxus/* подключены симлинками на соседей workspace — dev-серверу
    // нужно право читать их исходники.
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
