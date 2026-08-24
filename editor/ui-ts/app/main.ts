/**
 * Точка входа приложения редактора (ED-12).
 *
 * Здесь остаётся ровно то, что зависит от среды: КАКОЙ хост поднимается,
 * канал внешних изменений дерева, заголовок вкладки, документ и монтирование
 * страницы. Всё остальное — в `assembly.ts`, и написано оно так, будто среды
 * не существует: другая среда приносит свой хост и зовёт ту же сборку (ED-12 —
 * «десктопная сборка SHALL быть оболочкой над той же реализацией»).
 *
 * Сред две, и различает их одно: есть ли в странице мост десктоп-контейнера
 * (`desktop-shell` DSK-1). Не флаг сборки и не user-agent — бандл один и тот
 * же, а признак — наличие возможности. Ветвление кончается этой строкой: ниже
 * и дальше редактор видит один интерфейс хоста.
 */
import { desktopBridgeOf } from '@fluxus/desktop-shell/bridge';
import type { ContentChangeKind, ContentPath } from '@fluxus/editor-core';
import { createDesktopHost, createWebHost, mountWorkspaceFrame } from '../src/index.js';
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

/**
 * Мост контейнера, если страница открыта в нём. Заголовок окна на десктопе
 * ставит сам контейнер (`window`-возможность моста), поэтому `documentTitle`
 * туда не передаётся: заголовок вкладки — свойство вкладки.
 */
const bridge = desktopBridgeOf(globalThis);

const host =
  bridge === undefined
    ? createWebHost({
        root: { label: 'content' },
        ...(hot === undefined
          ? {}
          : {
              changes: (listener: (path: ContentPath, kind: ContentChangeKind) => void) => {
                hot.on('fx:content', (change) => { listener(change.path, change.kind); });
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
      })
    : createDesktopHost(bridge);

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
