/**
 * Десктоп-сборка менеджера: тот же бандл, другой каталог вывода и
 * относительная база.
 *
 * База относительная, потому что контейнер раздаёт бандл своей схемой (DSK-4), и
 * абсолютные пути `/assets/...` в ней не разрешаются. Ровно та же поправка, что
 * у десктоп-сборок редактора и игры.
 */
import { defineConfig, mergeConfig } from 'vite';
import web from './vite.config.js';

export default mergeConfig(web, defineConfig({ base: './', build: { outDir: 'dist-desktop' } }));
