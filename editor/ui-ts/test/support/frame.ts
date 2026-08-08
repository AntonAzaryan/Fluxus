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
  type ContributionRegistry,
  type EditorSession,
  type MemoryHost,
  type StringResources,
} from '@game-mvp/editor-core';
import { findAll, walk, type UiNode } from '../../src/dom/node.js';
import { createWorkspaceFrame, type WorkspaceFrame } from '../../src/frame/frame.js';
import type { WorkspaceArea } from '../../src/frame/area.js';
import { uiResources } from '../../src/i18n/uiBundles.js';
import { createSceneArea, sceneArea, type SceneAreaState } from '../../src/areas/scene.js';
import type { StagePointer } from '../../src/areas/sceneInteraction.js';
import { registerPlacementOperations } from '../../src/areas/scenePlacement.js';
import { registerTerrainOperations } from '../../src/areas/sceneTerrain.js';
import { systemsArea } from '../../src/areas/systems.js';
import { FIXTURE_IDS, fakeStage, fixtureHost, settle, type FakeStage } from './project.js';

export interface FrameFixture {
  readonly frame: WorkspaceFrame;
  readonly session: EditorSession;
  readonly resources: StringResources;
  /** Сам реестр: каркас видит его только на чтение, а сборка — целиком. */
  readonly areas: ContributionRegistry<WorkspaceArea>;
}

/** Каркас с набором областей. По умолчанию — те же два вклада, что и в приложении. */
export function buildFrame(
  areas: readonly WorkspaceArea[] = [sceneArea, systemsArea],
  locale = 'ru',
): FrameFixture {
  const contributions = createEditorContributions<WorkspaceArea>();
  for (const area of areas) contributions.areas.register(area);
  // Тот же реестр, что собирает приложение: операции расстановки и кистей —
  // вклады области (ED-25), и без них область правит документы нечем (ED-29).
  const session = createEditorSession({
    operations: registerTerrainOperations(
      registerPlacementOperations(registerBuiltinOperations(createOperationRegistry())),
    ),
  });
  const resources = uiResources(locale);
  return {
    frame: createWorkspaceFrame({ areas: contributions.areas, resources, session }),
    session,
    resources,
    areas: contributions.areas,
  };
}

/**
 * Каркас с открытым проектом-фикстурой: область сцены получает дерево контента
 * (ED-12) и дубль вьюпорта вместо WebGL. Асинхронность здесь настоящая — так
 * же открывается и настоящий проект, — поэтому сборка ждёт микрозадач.
 */
export async function buildLoadedFrame(locale = 'ru'): Promise<LoadedFrameFixture> {
  const host = fixtureHost();
  // Обратный канал вьюпорта дубль получает так же, как настоящий: область
  // отдаёт его сборкой, и через него же приходит просьба перерисовать.
  const built: FakeStage[] = [];
  const pointers: ((event: StagePointer) => void)[] = [];
  const area = createSceneArea({
    host,
    ids: FIXTURE_IDS,
    stage: (_project, _host, hooks) => {
      const made = fakeStage(hooks.announce);
      built.push(made);
      pointers.push(hooks.pointer);
      return made;
    },
  });
  const fixture = buildFrame([area, systemsArea], locale);
  // Запись состояния заводится лениво — первым обращением к области.
  const state = fixture.frame.stateOf(area.id) as SceneAreaState;
  await settle();
  const stage = built[0];
  const pointer = pointers[0];
  if (stage === undefined || pointer === undefined) {
    throw new Error('вьюпорт фикстуры не собрался');
  }
  // Страница собирается сразу: инструмент получает выделение и кадр отрисовкой,
  // и до неё указатель ему подавать нечего.
  fixture.frame.view();
  return { ...fixture, host, stage, area, state, pointer };
}

export interface LoadedFrameFixture extends FrameFixture {
  readonly host: MemoryHost;
  readonly stage: FakeStage;
  readonly area: WorkspaceArea<SceneAreaState>;
  readonly state: SceneAreaState;
  /** Вход указателя вьюпорта — тот же канал, которым его зовёт настоящий холст. */
  readonly pointer: (event: StagePointer) => void;
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
