/**
 * Сборка редактора — то место, где из частей получается работающее приложение.
 *
 * Здесь и только здесь встречаются: хост среды (ED-12), реестры вкладов
 * (ED-25), сессия с одной историей на всех (ED-18, ED-23), строковые ресурсы
 * (ED-27), рабочие области и каркас. Всё, что сборка делает с областями, —
 * приносит им то, чего они сами о себе не знают: общий модуль ассетов, общий
 * реестр правил и открытый проект.
 *
 * Лежит она в `app/`, а не в `src/`, по одной причине, и причина эта
 * проверяемая: сборка ПО ОПРЕДЕЛЕНИЮ называет редактируемое по имени — сцену,
 * манифест, их пару (ED-19), — а `src/` сканируется на доменные имена (ED-25,
 * `test/frameDomain.test.ts`). Каркас и вклады живут в библиотеке, сборка — вне
 * её; так «каркас не знает доменных имён» остаётся утверждением о коде, а не о
 * дисциплине.
 *
 * Среды здесь нет вовсе: `main.ts` строит хост и отдаёт его сюда. Поэтому этот
 * модуль собирается и в headless-прогоне — с хостом в памяти и без DOM.
 */
import {
  buildEditorCatalog,
  catalogDescriptions,
  createEditorContributions,
  createEditorSession,
  createOperationRegistry,
  describeOperations,
  pairingGroups,
  registerBuiltinOperations,
  registerValidationRules,
  saveDocuments,
  type EnvironmentHost,
  type LocaleId,
  type StringResources,
  type ValidationRule,
  type ViewportToolContribution,
} from '@game-mvp/editor-core';
import {
  createWorkspaceFrame,
  issueText,
  registerFieldEditors,
  registerShellCommands,
  uiResources,
  type FieldEditor,
  type PaletteCommand,
  type WorkspaceArea,
  type WorkspaceFrame,
} from '../src/index.js';
import { presentationPathOf } from '@game-mvp/assets';
import { createAssetModule } from '../src/areas/assetModule.js';
import {
  ASSETS_AREA_ID,
  assetStageFactory,
  createAssetArea,
  type AssetAreaState,
} from '../src/areas/assets.js';
import { registerVisualsOperations } from '../src/areas/assetVisuals.js';
import { registerCameraEffectsOperations } from '../src/areas/assetCameraEffects.js';
import { SCENE_AREA_ID, createSceneArea, type SceneAreaState } from '../src/areas/scene.js';
import { discoverProject, type DiscoveredProject } from '../src/areas/sceneDiscovery.js';
import { sceneValidationRules, type SceneProjectIds } from '../src/areas/sceneProject.js';
import { registerPlacementOperations } from '../src/areas/scenePlacement.js';
import { registerDecorationOperations } from '../src/areas/sceneDecorations.js';
import { registerTerrainOperations } from '../src/areas/sceneTerrain.js';

export interface EditorAppOptions {
  readonly host: EnvironmentHost;
  /** Локаль автора — настройка пользователя, а не свойство проекта (ED-27). */
  readonly locale?: LocaleId;
}

export interface EditorApp {
  readonly frame: WorkspaceFrame;
  readonly resources: StringResources;
  /** Что нашлось в дереве при открытии — и чего найти не удалось (ED-12). */
  readonly project: DiscoveredProject;
}

/**
 * Собранный редактор. Асинхронна, потому что асинхронно открытие проекта:
 * корень спрашивается у среды, документы ищутся в дереве (`sceneDiscovery.ts`),
 * и до ответа неизвестно даже, есть ли что открывать.
 */
export async function createEditorApp(options: EditorAppOptions): Promise<EditorApp> {
  const { host } = options;
  const resources = uiResources(options.locale ?? 'ru');

  // Модуль ассетов один на редактор (ASSET-2): им рисует вьюпорт сцены, им же
  // просмотрщик отвечает на вопрос «загрузился ли этот ассет» (ED-20, ASSET-4).
  // Контекст рендера при этом у каждого кадра свой — обоснование в шапке
  // `src/areas/assetModule.ts`.
  const assets = createAssetModule(host);

  /**
   * Обход дерева — ОДИН на одно открытие, и делает его сборка, а не области.
   * Областей у проекта две (сцена и просмотрщик манифеста), и каждая со своим
   * обходом нашла бы свою пару: между двумя обходами дерево успевает
   * измениться, и «конфиг сцены + манифест» перестали бы быть парой (ED-19,
   * ED-21). Поэтому найденное живёт здесь, а области спрашивают его.
   */
  const first = await discoverProject(host);
  /**
   * Открывается первая найденная пара — в порядке обхода дерева. Выбора автору
   * здесь не предлагается, и это названная граница, а не умолчание: выбор — это
   * своё место в интерфейсе, а до него остальные находки не пропадают —
   * `project.scenes` перечисляет их все.
   */
  let current: SceneProjectIds | null = first.scenes[0] ?? null;
  /** Почему дерево не перечислено (ED-12); `null` — перечислено. */
  let failure: string | null = first.failure;

  /** Найти проект заново: только отсюда редактор и ходит в дерево за составом. */
  const openProject = async (): Promise<void> => {
    const found = await discoverProject(host);
    failure = found.failure;
    current = found.scenes[0] ?? null;
  };

  const openScene = (): Promise<SceneProjectIds | null> =>
    // Перечисления в этой среде нет — это причина, а не пустой проект: статике
    // перечислять дерево нечем (см. шапку `src/host/web.ts`), и подменять это
    // сообщением «сцен не найдено» значило бы соврать автору о его дереве.
    failure === null ? Promise.resolve(current) : Promise.reject(new Error(failure));

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
  // Правила валидации — такой же вклад, как область (ED-25), и реестр у них
  // один на редактор: раскладку документов проекта приносит область, а не
  // правило. Тот же реестр прогоняет сохранение по состоянию дерева (ED-21).
  registerValidationRules(contributions.validationRules, sceneValidationRules());

  contributions.areas.register(
    createSceneArea({
      host,
      assets,
      open: openScene,
      validationRules: contributions.validationRules,
    }),
  );
  // Области систем в сборке сейчас нет: она стояла на материале-заглушке, и
  // заглушка уехала фикстурой в набор тестов (`src/areas/systems.ts`). Вернётся
  // она настоящей — на списке JSON-систем конфига сцены (ED-4, ED-5), — и
  // регистрация её будет ровно такой же строкой: ED-25 требует, чтобы новая
  // область не правила ни каркас, ни соседние вклады.
  // Просмотрщик ассетов (ED-20) — такой же вклад: манифест визуалов он правит
  // тот же, что открывает область сцены, поэтому его ID приходит от того же
  // открытия, а кадр собирается на общем модуле ассетов.
  contributions.areas.register(
    createAssetArea({
      host,
      // Тот же открытый проект, что у области сцены, и спрашивается он тем же
      // способом: манифест — половина пары ED-19, и «какой манифест открыт»
      // обязано быть одним ответом на весь редактор, а не снимком, взятым при
      // сборке. После переоткрытия проект другой (ED-24, ED-21).
      open: () => Promise.resolve(current === null ? null : current.visuals),
      stage: assetStageFactory(assets),
      // Тот же модуль подаётся и напрямую: состояние ассета (ASSET-4)
      // просмотрщик спрашивает у него, а не у кадра, и там, где кадра нет
      // вовсе (среда без WebGL), ответ обязан остаться тем же самым — иначе
      // «загрузился ли этот ассет» отвечалось бы двумя способами (ASSET-2).
      assets,
    }),
  );

  // Операции расстановки, кистей и записей манифеста — вклады областей, а не
  // часть ядра редактора (ED-25, ED-29): реестр один и тот же для интерфейса и
  // для вызова без него.
  const session = createEditorSession({
    operations: registerCameraEffectsOperations(
      registerVisualsOperations(
        registerTerrainOperations(
          registerDecorationOperations(
            registerPlacementOperations(registerBuiltinOperations(createOperationRegistry())),
          ),
        ),
      ),
    ),
  });

  registerShellCommands(contributions.commands, {
    resources,
    areas: contributions.areas,
    // Открытие проекта — тот же путь, которым области открылись в первый раз
    // (ED-24): второго способа открыть проект не заводится. Дерево обходится
    // ДО того, как области спросят состав, — иначе они рассказали бы друг о
    // друге разное (см. `openProject`), — и переоткрываются обе: проект после
    // команды другой, а область, оставшаяся на прежних документах, правила бы
    // то, чего в группе записи уже нет (ED-19, ED-21).
    open: async (target) => {
      await openProject();
      (target.stateOf(SCENE_AREA_ID) as SceneAreaState).reopen();
      (target.stateOf(ASSETS_AREA_ID) as AssetAreaState).reopen();
      target.setNotice(null);
    },
    dirty: (target) => target.session.dirtyDocumentIds().length > 0,
    save: async (target) => {
      const result = await saveDocuments({
        session,
        host: host.content,
        rules: contributions.validationRules,
        // Тройка «конфиг сцены + парный presentation-документ + манифест»
        // уходит на диск одной записью (ED-21, ED-19). Что эти документы
        // значат, знает сборка; сохранение знает только «группа документов».
        //
        // Парный документ входит в группу, только если он открыт: сцена без
        // декораций — законное состояние (PRES-1), и создавать файл ради
        // пустого слоя нельзя. Открытым он бывает ровно тогда, когда лежит в
        // дереве, — открытие ищет его правилом имени.
        ...(current === null
          ? {}
          : {
              groups: pairingGroups([
                {
                  scene: current.config,
                  manifest: current.visuals,
                  ...(session.isOpen(presentationPathOf(current.config))
                    ? { presentation: presentationPathOf(current.config) }
                    : {}),
                },
              ]),
            }),
      });
      // Отказ показывается причиной самой находки (ED-8, ED-30): текст
      // принадлежит правилу, а не месту показа, и второй его формулировки
      // сборка не заводит. Удавшееся сохранение чужую причину гасит.
      const blocking = result.blocking[0];
      target.setNotice(blocking === undefined ? null : issueText(resources, blocking));
      host.window.setUnsaved(session.dirtyDocumentIds().length > 0);
    },
  });

  const frame = createWorkspaceFrame({
    areas: contributions.areas,
    resources,
    session,
    // Редактор открывается там, где лежит открытый проект. Реестр перечисляет
    // вклады в порядке их идентификаторов — порядок этот про реестр, а не про
    // то, с чего начинать работу, и выбор первой области принадлежит сборке.
    initialAreaId: SCENE_AREA_ID,
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
  });

  // Несохранённое видно снаружи окна (ED-21): вкладка спрашивает о закрытии,
  // десктоп ставит метку. Признак один и тот же, и берётся он у сессии, а не у
  // отдельного счётчика.
  const publishUnsaved = (): void => {
    host.window.setUnsaved(session.dirtyDocumentIds().length > 0);
  };
  session.subscribe(publishUnsaved);
  publishUnsaved();

  // Заголовок окна — тоже видимый автору текст (ED-27), и приходит он из
  // ресурсов; смена языка его переставляет, потому что подписан он на них же.
  const publishTitle = (): void => {
    host.window.setTitle(resources.text('ui.app.title'));
  };
  resources.onChange(publishTitle);
  publishTitle();

  return { frame, resources, project: first };
}
