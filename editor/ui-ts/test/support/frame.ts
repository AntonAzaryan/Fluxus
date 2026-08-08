/**
 * Общая сборка каркаса для тестов и три поисковых помощника по описанию узлов.
 *
 * DOM в прогоне нет и не нужен: каркас — чистое описание (`view()` возвращает
 * узел), а всё, что требует документа, вынесено в `frame/mount.ts`. Поэтому
 * тесты каркаса ходят по `UiNode`, как и тесты визуального языка.
 */
import {
  createEditorContributions,
  createEditorSession,
  createOperationRegistry,
  registerBuiltinOperations,
  type EditorSession,
  type StringResources,
} from '@game-mvp/editor-core';
import { findAll, walk, type UiNode } from '../../src/dom/node.js';
import { createWorkspaceFrame, type WorkspaceFrame } from '../../src/frame/frame.js';
import type { WorkspaceArea } from '../../src/frame/area.js';
import { uiResources } from '../../src/i18n/uiBundles.js';
import { sceneArea } from '../../src/areas/scene.js';
import { systemsArea } from '../../src/areas/systems.js';

export interface FrameFixture {
  readonly frame: WorkspaceFrame;
  readonly session: EditorSession;
  readonly resources: StringResources;
}

/** Каркас с набором областей. По умолчанию — те же два вклада, что и в приложении. */
export function buildFrame(
  areas: readonly WorkspaceArea[] = [sceneArea, systemsArea],
  locale = 'ru',
): FrameFixture {
  const contributions = createEditorContributions<WorkspaceArea>();
  for (const area of areas) contributions.areas.register(area);
  const session = createEditorSession({
    operations: registerBuiltinOperations(createOperationRegistry()),
  });
  const resources = uiResources(locale);
  return {
    frame: createWorkspaceFrame({ areas: contributions.areas, resources, session }),
    session,
    resources,
  };
}

export function attr(node: UiNode, name: string): string | undefined {
  return node.attrs?.[name];
}

/** Узлы с заданным машинным атрибутом — в порядке документа. */
export function withAttr(root: UiNode, name: string): UiNode[] {
  return findAll(root, (node) => attr(node, name) !== undefined);
}

/** Кнопка, чья подпись пришла из ресурса с этим ключом. */
export function buttonByKey(root: UiNode, key: string): UiNode | undefined {
  return findAll(root, (node) => node.tag === 'button').find((node) =>
    [...walk(node)].some((inner) => inner.text?.key === key),
  );
}

/** Нажатие: обработчик берётся из описания узла, событие ему не нужно. */
export function press(node: UiNode | undefined, event: Partial<Event> = {}): void {
  const handler = node?.on?.click;
  if (handler === undefined) throw new Error('у узла нет обработчика нажатия');
  handler(event as Event);
}

/** Нажатие клавиши на контейнере: то же, но с клавишей и учётом `preventDefault`. */
export function keydown(node: UiNode | undefined, key: string): boolean {
  const handler = node?.on?.keydown;
  if (handler === undefined) throw new Error('у узла нет обработчика клавиатуры');
  let prevented = false;
  handler({
    key,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as Event);
  return prevented;
}
