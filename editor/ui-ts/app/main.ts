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
  buildEditorCatalog,
  catalogDescriptions,
  createEditorContributions,
  createEditorSession,
  createOperationRegistry,
  describeOperations,
  registerBuiltinOperations,
  registerValidationRules,
  type ContentChangeKind,
  type ContentPath,
  type ValidationRule,
  type ViewportToolContribution,
} from '@game-mvp/editor-core';
import {
  createWebHost,
  createWorkspaceFrame,
  mountWorkspaceFrame,
  registerFieldEditors,
  uiResources,
} from '../src/index.js';
import type { FieldEditor, PaletteCommand, WorkspaceArea } from '../src/index.js';
import { createAssetArea } from '../src/areas/assets.js';
import { registerVisualsOperations } from '../src/areas/assetVisuals.js';
import { DEFAULT_SCENE_IDS, createSceneArea } from '../src/areas/scene.js';
import { sceneValidationRules } from '../src/areas/sceneProject.js';
import { registerPlacementOperations } from '../src/areas/scenePlacement.js';
import { registerTerrainOperations } from '../src/areas/sceneTerrain.js';
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

const contributions = createEditorContributions<
  WorkspaceArea,
  ViewportToolContribution,
  FieldEditor,
  PaletteCommand,
  ValidationRule
>();
// Редакторы поля — такой же вклад (ED-25): набор, который редактор везёт с
// собой, регистрируется здесь же, и проект вправе перекрыть любой из них.
registerFieldEditors(contributions.fieldEditors);
// Правила валидации — такой же вклад, как область (ED-25), и реестр у них один
// на редактор: раскладку документов проекта приносит область, а не правило.
registerValidationRules(contributions.validationRules, sceneValidationRules());
contributions.areas.register(
  createSceneArea({ host, validationRules: contributions.validationRules }),
);
contributions.areas.register(systemsArea);
// Просмотрщик ассетов (ED-20) — такой же вклад: манифест визуалов он правит тот
// же, что открывает область сцены, поэтому его ID приходит одной настройкой.
contributions.areas.register(
  createAssetArea({ host, visuals: DEFAULT_SCENE_IDS.visuals }),
);

// Операции расстановки, кистей и записей манифеста — вклады областей, а не
// часть ядра редактора (ED-25, ED-29): реестр один и тот же для интерфейса и
// для вызова без него.
const session = createEditorSession({
  operations: registerVisualsOperations(
    registerTerrainOperations(
      registerPlacementOperations(registerBuiltinOperations(createOperationRegistry())),
    ),
  ),
});

const resources = uiResources('ru');

mountWorkspaceFrame(
  document,
  createWorkspaceFrame({
    areas: contributions.areas,
    resources,
    session,
    fieldEditors: contributions.fieldEditors,
    commands: contributions.commands,
    // Машинное само-описание редактора (ED-30) собирается из ВСЕХ реестров
    // сборки, а не из тех, что видит каркас: палитра показывает операции из
    // того же каталога, который получает внешний потребитель, и второго
    // описания не заводится.
    catalog: () =>
      buildEditorCatalog({
        contributions,
        operations: () => describeOperations(session.operations),
        descriptions: catalogDescriptions(resources),
      }),
  }),
);
