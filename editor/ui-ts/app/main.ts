/**
 * Точка входа веб-приложения редактора (ED-12, веб-среда).
 *
 * Здесь и только здесь редактор собирается из частей: реестры вкладов, сессия
 * с одной историей на всех (ED-18, ED-23), ресурсы строк и каркас рабочих
 * областей. Всё, что этот файл делает с областями, — регистрирует их. Ни
 * порядка зон, ни переключения, ни истории он не задаёт: это каркас, и он
 * одинаков при любом наборе вкладов (ED-25).
 *
 * Добавить область — значит дописать сюда одну строку регистрации. Ни каркас,
 * ни уже зарегистрированные области при этом не правятся, и проверяет это не
 * обещание в комментарии, а `test/frameExtension.test.ts`.
 */
import {
  createEditorContributions,
  createEditorSession,
  createOperationRegistry,
  registerBuiltinOperations,
} from '@game-mvp/editor-core';
import { createWorkspaceFrame, mountWorkspaceFrame, uiResources } from '../src/index.js';
import type { WorkspaceArea } from '../src/index.js';
import { sceneArea } from '../src/areas/scene.js';
import { systemsArea } from '../src/areas/systems.js';

const contributions = createEditorContributions<WorkspaceArea>();
contributions.areas.register(sceneArea);
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
