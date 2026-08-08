/**
 * Точка входа веб-приложения редактора (ED-12, веб-среда).
 *
 * Здесь и только здесь редактор собирается из частей: хост среды, реестры
 * вкладов, сессия с одной историей на всех (ED-18, ED-23), ресурсы строк и
 * каркас рабочих областей. Всё, что этот файл делает с областями, —
 * регистрирует их. Ни порядка зон, ни переключения, ни истории он не задаёт:
 * это каркас, и он одинаков при любом наборе вкладов (ED-25).
 *
 * Добавить область — значит дописать сюда одну строку регистрации. Ни каркас,
 * ни уже зарегистрированные области при этом не правятся, и проверяет это не
 * обещание в комментарии, а `test/frameExtension.test.ts`.
 *
 * Среда — единственное, что этот файл знает и о чём не знает никто больше:
 * веб-хост, его канал внешних изменений дерева и заголовок вкладки. Всё
 * остальное написано так, будто среды не существует (ED-12).
 */
import {
  createEditorContributions,
  createEditorSession,
  createOperationRegistry,
  registerBuiltinOperations,
  type ContentChangeKind,
  type ContentPath,
} from '@game-mvp/editor-core';
import {
  createWebHost,
  createWorkspaceFrame,
  mountWorkspaceFrame,
  uiResources,
} from '../src/index.js';
import type { WorkspaceArea } from '../src/index.js';
import { createSceneArea } from '../src/areas/scene.js';
import { systemsArea } from '../src/areas/systems.js';

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

const contributions = createEditorContributions<WorkspaceArea>();
contributions.areas.register(createSceneArea({ host }));
contributions.areas.register(systemsArea);

const session = createEditorSession({
  operations: registerBuiltinOperations(createOperationRegistry()),
});

mountWorkspaceFrame(
  document,
  createWorkspaceFrame({
    areas: contributions.areas,
    resources: uiResources('ru'),
    session,
  }),
);
