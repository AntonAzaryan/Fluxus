/**
 * Точка входа веб-приложения редактора (ED-12, веб-среда).
 *
 * Здесь остаётся ровно то, чего не бывает нигде, кроме браузера: веб-хост
 * среды, его канал внешних изменений дерева, заголовок вкладки, документ и
 * монтирование страницы. Всё остальное — в `assembly.ts`, и написано оно так,
 * будто среды не существует: другая среда приносит свой хост и зовёт ту же
 * сборку (ED-12 — «десктопная сборка SHALL быть оболочкой над той же
 * реализацией»).
 */
import type { ContentChangeKind, ContentPath } from '@game-mvp/editor-core';
import { createWebHost, mountWorkspaceFrame } from '../src/index.js';
import { createEditorApp } from './assembly.js';

/**
 * Канал внешних изменений дерева контента: сокет dev-сервера
 * (`contentEndpoint.ts`). У вкладки своего наблюдателя за файлами нет, поэтому
 * канал приносит оболочка; в сборке без dev-сервера его нет, и хост молчит о
 * чужих правках — на корректность это не влияет, только на свежесть (ED-12).
 */
interface HotChannel {
  on(event: string, listener: (data: { path: string; kind: ContentChangeKind }) => void): void;
}

const hot = (import.meta as unknown as { hot?: HotChannel }).hot;

const host = createWebHost({
  root: { label: 'content' },
  ...(hot === undefined
    ? {}
    : {
        changes: (listener: (path: ContentPath, kind: ContentChangeKind) => void) => {
          hot.on('fx:content', (change) => listener(change.path, change.kind));
          // Сокет живёт столько же, сколько вкладка: отписывать нечего.
          return () => undefined;
        },
      }),
  documentTitle: {
    set: (value: string) => {
      document.title = value;
    },
  },
  window,
});

// Открытие проекта асинхронно (дерево читает среда), и страница монтируется по
// его завершении: каркас без единой области показывать нечего, а области
// заводятся сборкой. Отказ открытия из этого пути не приходит — обход дерева
// возвращает причину значением, и её показывает сама область (ED-8).
createEditorApp({ host })
  .then((app) => {
    mountWorkspaceFrame(document, app.frame);
  })
  .catch((error: unknown) => {
    // Единственный отказ, который некому показать: страницы ещё нет. Молчать
    // о нём нельзя — иначе редактор не открылся бы без единого следа.
    console.error(error);
  });
