/**
 * Общая сборка каркаса для тестов и три поисковых помощника по описанию узлов.
 *
 * DOM в прогоне нет и не нужен: каркас — чистое описание (`view()` возвращает
 * узел), а всё, что требует документа, вынесено в `frame/mount.ts`. Поэтому
 * тесты каркаса ходят по `UiNode`, как и тесты визуального языка.
 */
import {
  ContributionRegistry,
  createEditorContributions,
  createEditorSession,
  createOperationRegistry,
  registerBuiltinOperations,
  registerValidationRules,
  type ContributionReader,
  type EditorSession,
  type MemoryHost,
  type StringResources,
  type ValidationRule,
} from '@game-mvp/editor-core';
import type { FieldEditor } from '../../src/inspector/index.js';
import type { PaletteCommand } from '../../src/palette/palette.js';
import { findAll, walk, type UiNode } from '../../src/dom/node.js';
import { createWorkspaceFrame, type WorkspaceFrame } from '../../src/frame/frame.js';
import type { WorkspaceArea } from '../../src/frame/area.js';
import { uiResources } from '../../src/i18n/uiBundles.js';
import { createSceneArea, sceneArea, type SceneAreaState } from '../../src/areas/scene.js';
import { sceneValidationRules } from '../../src/areas/sceneProject.js';
import type { StagePointer } from '../../src/areas/sceneInteraction.js';
import { registerPlacementOperations } from '../../src/areas/scenePlacement.js';
import { registerDecorationOperations } from '../../src/areas/sceneDecorations.js';
import { registerTerrainOperations } from '../../src/areas/sceneTerrain.js';
import { registerVisualsOperations } from '../../src/areas/assetVisuals.js';
import { registerCameraEffectsOperations } from '../../src/areas/assetCameraEffects.js';
import type { CameraEffectsDescription } from '@game-mvp/assets';
import { stubArea } from './stubArea.js';
import { previewProbe, type PreviewProbe } from './preview.js';
import { FIXTURE_IDS, fakeStage, fixtureHost, settle, type FakeStage } from './project.js';

export interface FrameFixture {
  readonly frame: WorkspaceFrame;
  readonly session: EditorSession;
  readonly resources: StringResources;
  /** Сам реестр: каркас видит его только на чтение, а сборка — целиком. */
  readonly areas: ContributionRegistry<WorkspaceArea>;
}

/**
 * Чем сборка каркаса отличается от умолчаний. Всё это — реестры вкладов
 * (ED-25): их приносит тот, кто собирает редактор, и тест здесь стоит на его
 * месте.
 */
export interface FrameExtras {
  /** Реестр редакторов поля (ED-25); нет — набор по умолчанию. */
  readonly fieldEditors?: ContributionReader<FieldEditor>;
  /** Команды палитры (ED-24, ED-25); нет — реестр пуст. */
  readonly commands?: ContributionReader<PaletteCommand>;
  /**
   * Машинное описание типов эффектов камеры (`camera` CAM-9), с которым
   * собираются операции секции. Приносит его сборка — тому же описанию она
   * подаёт область и правила валидации, — и подставленное здесь описание с
   * новым типом обязано работать без правок редактора (ED-14).
   */
  readonly cameraEffects?: CameraEffectsDescription;
}

/**
 * Каркас с набором областей. По умолчанию — область сцены и фикстурная область
 * набора (`stubArea`): каркас обязан проверяться на двух непохожих областях, и
 * вторая из них принадлежит тестам, а не приложению.
 */
export function buildFrame(
  areas: readonly WorkspaceArea[] = [sceneArea, stubArea],
  locale = 'ru',
  extras: FrameExtras = {},
): FrameFixture {
  const contributions = createEditorContributions<WorkspaceArea>();
  for (const area of areas) contributions.areas.register(area);
  // Тот же реестр, что собирает приложение: операции расстановки, кистей и
  // записей манифеста — вклады областей (ED-25), и без них область правит
  // документы нечем (ED-29).
  const session = createEditorSession({
    operations: registerCameraEffectsOperations(
      registerVisualsOperations(
        registerTerrainOperations(
          registerDecorationOperations(
            registerPlacementOperations(registerBuiltinOperations(createOperationRegistry())),
          ),
        ),
      ),
      extras.cameraEffects,
    ),
  });
  const resources = uiResources(locale);
  // Перечислено поимённо, а не спредом: сборка приносит реестры вкладов, и
  // случайно прилетевшее поле не должно уметь подменить сам реестр областей.
  return {
    frame: createWorkspaceFrame({
      areas: contributions.areas,
      resources,
      session,
      ...(extras.fieldEditors === undefined ? {} : { fieldEditors: extras.fieldEditors }),
      ...(extras.commands === undefined ? {} : { commands: extras.commands }),
    }),
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
export async function buildLoadedFrame(
  locale = 'ru',
  options: LoadedFrameOptions = {},
): Promise<LoadedFrameFixture> {
  const host = options.host ?? fixtureHost();
  // Обратный канал вьюпорта дубль получает так же, как настоящий: область
  // отдаёт его сборкой, и через него же приходит просьба перерисовать.
  const built: FakeStage[] = [];
  const pointers: ((event: StagePointer) => void)[] = [];
  // Вторая сторона канала превью — та же подмена и по той же причине, что
  // вьюпорт: настоящего воркера в headless-прогоне нет (ED-9, SHELL-3).
  const preview = previewProbe();
  // Правила валидации — вклад (ED-25): сборка вправе принести свои, и область
  // прогоняет их наравне с теми, что приносит проект сцены.
  const rules = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
  registerValidationRules(rules, [...sceneValidationRules(), ...(options.rules ?? [])]);
  const area = createSceneArea({
    host,
    ids: FIXTURE_IDS,
    validationRules: rules,
    previewBackend: preview.factory,
    stage: (_project, _host, hooks) => {
      const made = fakeStage(hooks.announce);
      built.push(made);
      pointers.push(hooks.pointer);
      return made;
    },
  });
  const fixture = buildFrame([area, stubArea, ...(options.areas ?? [])], locale, options);
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
  return { ...fixture, host, stage, area, state, pointer, preview };
}

export interface LoadedFrameOptions extends FrameExtras {
  /** Дерево контента; нет — фикстура по умолчанию. */
  readonly host?: MemoryHost;
  /** Дополнительные правила валидации (ED-8, ED-25). */
  readonly rules?: readonly ValidationRule[];
  /** Дополнительные области сверх сцены и фикстурной. */
  readonly areas?: readonly WorkspaceArea[];
}

export interface LoadedFrameFixture extends FrameFixture {
  readonly host: MemoryHost;
  readonly stage: FakeStage;
  readonly area: WorkspaceArea<SceneAreaState>;
  readonly state: SceneAreaState;
  /** Вход указателя вьюпорта — тот же канал, которым его зовёт настоящий холст. */
  readonly pointer: (event: StagePointer) => void;
  /** Канал прогона превью: чем он поднят и что через него прошло (ED-9, ED-13). */
  readonly preview: PreviewProbe;
}

export function attr(node: UiNode, name: string): string | undefined {
  return node.attrs?.[name];
}

/**
 * Одна зона скелета (ED-24). Нужна там, где проверяется не «есть ли на
 * странице», а «в каком месте страницы»: находка валидации показывается и в
 * навигаторе, и в инспекторе, и в баре поверхности, и утверждение о ней без
 * зоны стало бы утверждением о числе показов.
 */
export function zoneOf(root: UiNode, name: 'navigator' | 'surface' | 'inspector'): UiNode {
  const found = findAll(root, (node) => attr(node, 'data-zone') === name)[0];
  if (found === undefined) throw new Error(`в скелете нет зоны ${name}`);
  return found;
}

/** Узлы с заданным машинным атрибутом — в порядке документа. */
export function withAttr(root: UiNode, name: string): UiNode[] {
  return findAll(root, (node) => attr(node, name) !== undefined);
}

/**
 * Кнопка, чьё имя пришло из ресурса с этим ключом. Имя — либо видимая подпись,
 * либо доступное имя кнопки-знака (ED-31): у элемента бара подписи не видно, а
 * имя у него обязано быть, и находится он по нему же.
 */
export function buttonByKey(root: UiNode, key: string): UiNode | undefined {
  return findAll(root, (node) => node.tag === 'button').find((node) =>
    [...walk(node)].some(
      (inner) => inner.text?.key === key || inner.labels?.ariaLabel?.key === key,
    ),
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
