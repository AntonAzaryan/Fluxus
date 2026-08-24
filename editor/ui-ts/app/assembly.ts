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
  isJsonObject,
  pairingGroups,
  registerBuiltinOperations,
  registerValidationRules,
  saveDocuments,
  type ContentTreeHost,
  type DocumentId,
  type EditorSession,
  type EnvironmentHost,
  type LocaleId,
  type StringResources,
  type ValidationRule,
  type ViewportToolContribution,
} from '@fluxus/editor-core';
import {
  createWorkspaceFrame,
  issueText,
  registerFieldEditors,
  registerShellCommands,
  uiResources,
  type FieldEditor,
  type PaletteCommand,
  type UiText,
  type WorkspaceArea,
  type WorkspaceFrame,
} from '../src/index.js';
import { presentationPathOf } from '@fluxus/assets';
import {
  BLENDER_BUNDLES,
  SOURCE_EXTENSIONS,
  createSourceCache,
  registerBlenderOperations,
  sourcePathOf,
  spatialLayerSyncRule,
  type SpatialLayerSourceCache,
} from '@fluxus/blender-ts';
import { watchExternalDocuments } from './documentRefresh.js';
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
import {
  DECORATION_LIST,
  PLACEMENT_LIST,
  SCENE_KINDS,
  TERRAIN_ASSET,
  openSceneProject,
  sceneValidationRules,
  type SceneProjectIds,
} from '../src/areas/sceneProject.js';
import { registerPlacementOperations } from '../src/areas/scenePlacement.js';
import { registerDecorationOperations } from '../src/areas/sceneDecorations.js';
import { registerTerrainOperations } from '../src/areas/sceneTerrain.js';
import {
  OBJECTS_AREA_ID,
  createObjectsArea,
  type ObjectsAreaState,
} from '../src/areas/objects.js';
import { registerPairOperations } from '../src/areas/objectsOperations.js';
import { registerSchemaOperations } from '../src/areas/objectsSchemas.js';
import { SYSTEMS_AREA_ID, createSystemsArea, type SystemsAreaState } from '../src/areas/systems.js';
import { registerSystemOperations } from '../src/areas/systemsOperations.js';

export interface EditorAppOptions {
  readonly host: EnvironmentHost;
  /** Локаль автора — настройка пользователя, а не свойство проекта (ED-27). */
  readonly locale?: LocaleId;
}

/**
 * Уходит ли парный presentation-документ (PRES-1) на диск этим сохранением.
 *
 * Открыт он ВСЕГДА — в том числе на сцене, у которой файла в дереве ещё нет
 * (`sceneProject.ts`): расстановка декораций и перевод prop → decoration
 * безусловны (ED-16, PRES-5). Записывать его при этом есть смысл не всегда, и
 * условий ровно три:
 *
 * - в слое что-то есть — тогда файл и рождается правкой, а не «ради пустого
 *   слоя», чего PRES-1 не допускает;
 * - в документе есть секция помимо декораций (свет, постобработка, туман —
 *   PRES-2): она от отсутствующего файла ОТЛИЧИМА — без файла действуют
 *   умолчания рендера, — и правка её обязана доехать до диска, иначе
 *   сохранение отметило бы её сохранённой, не записав ничего (ED-21);
 * - файл уже лежит в дереве — тогда опустевший слой обязан доехать до диска,
 *   иначе удаление последней декорации потерялось бы.
 *
 * Пустой слой сцены без файла не пишется вовсе: отсутствующий и пустой список
 * неразличимы (PRES-2), и документ с `"decorations": []` сказал бы ровно то же,
 * что его отсутствие, — ценой файла, которого автор не заводил.
 */
async function presentationGoesToDisk(
  session: EditorSession,
  host: ContentTreeHost,
  presentation: DocumentId,
): Promise<boolean> {
  if (!session.isOpen(presentation)) return false;
  if (session.descriptors(presentation, DECORATION_LIST).length > 0) return true;
  const value = session.documentValue(presentation);
  if (isJsonObject(value) && Object.keys(value).some((key) => key !== 'decorations')) return true;
  return (await host.stat(presentation))?.kind === 'file';
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
  // Бандл вкладов конвейера Blender (ED-27) вливается в ресурсы здесь же, где
  // регистрируются сами вклады: описание операции в каталоге (ED-30) и причина
  // находки правила принадлежат объявившему их пакету, и второй их копии в
  // редакторе не заводится (ED-28).
  const resources = uiResources(options.locale ?? 'ru', undefined, BLENDER_BUNDLES);

  // Модуль ассетов один на редактор (ASSET-2): им рисует вьюпорт сцены, им же
  // просмотрщик отвечает на вопрос «загрузился ли этот ассет» (ED-20, ASSET-4).
  // Контекст рендера при этом у каждого кадра свой — обоснование в шапке
  // `src/areas/assetModule.ts`.
  const assets = createAssetModule(host);

  /**
   * Обход дерева — ОДИН на одно открытие, и делает его сборка, а не области.
   * Областей у проекта четыре (сцена, системы, объекты и просмотрщик
   * манифеста), и каждая со своим обходом нашла бы свою пару: между двумя
   * обходами дерево успевает измениться, и «конфиг сцены + манифест»
   * перестали бы быть парой (ED-19, ED-21). Поэтому найденное живёт здесь, а
   * области спрашивают его.
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

  // Операции расстановки, кистей, записей манифеста, объектов и систем —
  // вклады областей, а не часть ядра редактора (ED-25, ED-29): реестр один и
  // тот же для интерфейса и для вызова без него. Сессия заводится ДО областей,
  // потому что открытие документов проекта — тоже дело сборки (см. ниже).
  //
  // Операция импорта конвейера Blender (`blender-pipeline` BLND-5) стоит в том
  // же ряду и по тому же основанию: «импорт запускают командой workspace и
  // операцией из работающего редактора — оба пути исполняют одну и ту же
  // зарегистрированную операцию». Незарегистрированная в сборке, она была бы
  // видна командной строке и не видна редактору — то есть путей стало бы два.
  const session = createEditorSession({
    operations: registerBlenderOperations(
      registerSystemOperations(
        registerPairOperations(
          registerSchemaOperations(
            registerCameraEffectsOperations(
              registerVisualsOperations(
                registerTerrainOperations(
                  registerDecorationOperations(
                    registerPlacementOperations(registerBuiltinOperations(createOperationRegistry())),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  });

  /**
   * Состояние источников конвейера (BLND-2): байты `.glb`/`.gltf`, лежащих
   * рядом со сценами, разобранные один раз на набор байтов (ED-8).
   *
   * Живёт в сборке, а не в правиле, потому что чтение дерева асинхронно (ED-12),
   * а правила исполняются синхронно на каждую правку (ED-8). Обновляется ровно
   * двумя поводами, и оба — здесь: открытие проекта (до первого прогона правил)
   * и правка дерева извне (канал ED-12, тот же, которым едет hot-reload BLND-12).
   *
   * Двоичные источники эта среда читает: `host.content.read` — тот же шов, по
   * которому модуль ассетов берёт модели и текстуры (ASSET-2), и `.glb` для
   * него ничем не отличается от `.mdx`. Среда, у которой чтения нет (статическая
   * выкладка без эндпойнта дерева — см. шапку `src/host/web.ts`), отказывает
   * причиной, и причину показывает та же находка правила: «прочитать не
   * удалось» и «расхождения нет» — разные ответы (ED-12, ED-20).
   */
  const sources: SpatialLayerSourceCache = createSourceCache(host.content);

  /**
   * Открытие документов проекта — ОДНО на весь редактор, и делает его сборка.
   *
   * Конфиг сцены правят три области (сцена, объекты, системы), а сессия
   * открывает документ однажды: повторный `openDocument` отказывает, и
   * отслеживаемые списки записей вторым вызовом не дописываются. Дай каждой
   * области открывать его самой — и кто успел первым, тот и назвал списки:
   * соседи получили бы либо отказ «документ уже открыт», либо документ без
   * своих списков. Поэтому обещание открытия здесь одно и общее: первая
   * спросившая область его заводит, остальные получают то же самое, а списки
   * названы целиком (`PROJECT_LISTS`).
   *
   * Сбрасывается оно ровно там, где проект перестаёт быть прежним, — в
   * `openProject`: после переоткрытия документы другие (ED-24, ED-21).
   */
  let opening: Promise<SceneProjectIds | null> | null = null;

  const openScene = (): Promise<SceneProjectIds | null> => {
    opening ??= (async () => {
      // Перечисления в этой среде нет — это причина, а не пустой проект:
      // статике перечислять дерево нечем (см. шапку `src/host/web.ts`), и
      // подменять это сообщением «сцен не найдено» значило бы соврать автору о
      // его дереве.
      if (failure !== null) throw new Error(failure);
      if (current === null) return null;
      await openSceneProject(session, host.content, current);
      // Источник читается ДО того, как области спросят открытый проект, то есть
      // до первого прогона правил: правило синхронно и ждать чтения не умеет, а
      // «не читан» — это находка (BLND-2), а не молчание. Отказ чтения сюда не
      // приходит — кэш возвращает его состоянием, и показывает его та же
      // находка.
      await sources.refresh(current.config);
      return current;
    })();
    return opening;
  };

  /** Найти проект заново: только отсюда редактор и ходит в дерево за составом. */
  const openProject = async (): Promise<void> => {
    const found = await discoverProject(host);
    failure = found.failure;
    current = found.scenes[0] ?? null;
    // Прежнее открытие относилось к прежним документам: держать его значило бы
    // отдать областям проект, которого больше нет. Запомненные источники — тоже:
    // они относились к прежним сценам.
    sources.forget();
    opening = null;
  };

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
  // Правило синхронизации пространственного слоя с источником Blender (BLND-2:
  // «правка производных данных мимо импорта SHALL подсвечиваться валидацией
  // редактора на общих основаниях (ED-8) правилом-вкладом (ED-25)»). Реестр тот
  // же, что у остальных правил, — иначе находка была бы видна не там, где
  // видны все прочие. Раскладку документов приносит сборка, как и соседям: и
  // расстановка (SER-8), и ассет террейна (TERR-2) лежат полями конфига сцены.
  registerValidationRules(contributions.validationRules, [
    spatialLayerSyncRule({
      sources,
      kinds: {
        scene: SCENE_KINDS.config,
        presentation: SCENE_KINDS.presentation,
        manifest: SCENE_KINDS.visuals,
        curvature: SCENE_KINDS.curvature,
      },
      initialPath: PLACEMENT_LIST,
      decorationsPath: DECORATION_LIST,
      terrainPath: TERRAIN_ASSET,
    }),
  ]);

  contributions.areas.register(
    createSceneArea({
      host,
      assets,
      open: openScene,
      validationRules: contributions.validationRules,
    }),
  );
  // Область систем (ED-4, ED-5) — такой же вклад, и регистрация её ровно такая
  // же строка: ED-25 требует, чтобы новая область не правила ни каркас, ни
  // соседние вклады. Правит она список JSON-систем того же конфига сцены
  // (SYS-1, SER-7), поэтому и открытый проект у неё тот же — и спрашивается он
  // тем же способом, что у соседей.
  contributions.areas.register(
    createSystemsArea({
      host,
      open: async () => (await openScene())?.config ?? null,
    }),
  );
  // Область объектов (ED-6, ED-7, ED-19, ED-23) правит ОБЕ половины пары: схемы
  // и prefab'ы лежат в конфиге сцены, записи визуалов — в манифесте. Пару
  // называет сборка (ED-19), а не область: «какой манифест открыт» обязано быть
  // одним ответом на весь редактор.
  contributions.areas.register(
    createObjectsArea({
      host,
      open: async () => {
        const ids = await openScene();
        return ids === null ? null : { config: ids.config, visuals: ids.visuals };
      },
    }),
  );
  // Просмотрщик ассетов (ED-20) — такой же вклад: манифест визуалов он правит
  // тот же, что открывает область сцены, поэтому его ID приходит от того же
  // открытия, а кадр собирается на общем модуле ассетов.
  contributions.areas.register(
    createAssetArea({
      host,
      // Тот же открытый проект, что у области сцены, и спрашивается он тем же
      // способом: манифест — половина пары ED-19, и «какой манифест открыт»
      // обязано быть одним ответом на весь редактор, а не снимком, взятым при
      // сборке. После переоткрытия проект другой (ED-24, ED-21). Тем же
      // способом — значит через то же общее открытие: спроси просмотрщик ID
      // раньше, чем документы открылись, и манифест открылся бы дважды.
      open: async () => (await openScene())?.visuals ?? null,
      stage: assetStageFactory(assets),
      // Тот же модуль подаётся и напрямую: состояние ассета (ASSET-4)
      // просмотрщик спрашивает у него, а не у кадра, и там, где кадра нет
      // вовсе (среда без WebGL), ответ обязан остаться тем же самым — иначе
      // «загрузился ли этот ассет» отвечалось бы двумя способами (ASSET-2).
      assets,
    }),
  );

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
      // Переоткрываются ВСЕ области проекта: оставшаяся на прежних документах
      // правила бы то, чего в группе записи уже нет (ED-19, ED-21).
      (target.stateOf(SCENE_AREA_ID) as SceneAreaState).reopen();
      (target.stateOf(SYSTEMS_AREA_ID) as SystemsAreaState).reopen();
      (target.stateOf(OBJECTS_AREA_ID) as ObjectsAreaState).reopen();
      (target.stateOf(ASSETS_AREA_ID) as AssetAreaState).reopen();
      target.setNotice(null);
    },
    dirty: (target) => target.session.dirtyDocumentIds().length > 0,
    save: async (target) => {
      const presentation = current === null ? null : presentationPathOf(current.config);
      const writesPresentation =
        presentation !== null &&
        (await presentationGoesToDisk(session, host.content, presentation));
      const result = await saveDocuments({
        session,
        host: host.content,
        rules: contributions.validationRules,
        // Тройка «конфиг сцены + парный presentation-документ + манифест»
        // уходит на диск одной записью (ED-21, ED-19). Что эти документы
        // значат, знает сборка; сохранение знает только «группа документов».
        //
        // Парный документ входит и в группу, и в саму запись ровно тогда, когда
        // ему есть что сказать диску (`presentationGoesToDisk`): пустой слой
        // сцены, у которой файла нет, — законное состояние, и файла ради него
        // не появляется (PRES-1). В группу его при этом нельзя внести, не внеся
        // в запись: член группы с правками, оставленный несохранённым, — то
        // самое нарушение, которое фаза записи и отвергает.
        ...(current === null
          ? {}
          : {
              groups: pairingGroups([
                {
                  scene: current.config,
                  manifest: current.visuals,
                  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- baseline
                  ...(writesPresentation && presentation !== null ? { presentation } : {}),
                },
              ]),
            }),
        ...(presentation === null || writesPresentation
          ? {}
          : { documentIds: session.dirtyDocumentIds().filter((id) => id !== presentation) }),
      });
      // Правки пустого слоя, которого на диске нет, записью не стали — но
      // несохранёнными они и не остаются: отсутствие файла и пустой список
      // неразличимы (PRES-2), то есть документ уже совпадает с деревом, и метка
      // «есть несохранённое» держалась бы на различии, которого нет (ED-21).
      if (
        presentation !== null &&
        !writesPresentation &&
        !result.refused &&
        session.isOpen(presentation) &&
        session.document(presentation).dirty
      ) {
        session.markSaved(presentation);
      }
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

  /**
   * Правка дерева извне (ED-12) — цикл hot-reload конвейера Blender (BLND-12).
   *
   * Канал внешних изменений приносит среда (`main.ts` — сокет dev-сервера), а
   * перечитывание в сессию делает `documentRefresh.ts`; отсюда правка едет во
   * вьюпорт теми же событиями сессии, что и всякая другая (ED-15, REND-11,
   * REND-14, REND-17, REND-18, CAM-7). Подписка живёт здесь по той же причине,
   * по которой здесь живёт открытие проекта: какие документы открыты — знает
   * сборка, а не каркас (ED-25).
   *
   * Показывается только то, чего автор иначе не заметил бы: перечитанный
   * документ виден в кадре сам, а НЕ перечитанный — нет. Причина при этом
   * приходит ресурсом (ED-27), а адрес документа — машинным хвостом к нему, как
   * у подсказки с сочетанием клавиш.
   */
  const refreshNotice = (key: string, id: DocumentId): UiText => {
    const suffix = ` — ${id}`;
    return { origin: 'resource', value: `${resources.text(key)}${suffix}`, key, suffix };
  };
  watchExternalDocuments({
    session,
    host: host.content,
    report: (outcome) => {
      if (outcome.kind === 'kept') frame.setNotice(refreshNotice('ui.app.externalKept', outcome.id));
      if (outcome.kind === 'failed') {
        frame.setNotice(refreshNotice('ui.app.externalFailed', outcome.id));
      }
    },
  });

  /**
   * Второй потребитель того же канала — источники конвейера (BLND-2, BLND-12).
   *
   * Экспорт `.glb` документом сессии не является и перечитыванию не подлежит:
   * его читает не редактор, а правило синхронизации — через кэш. Поэтому здесь
   * обновляется кэш, а не документ, и прогон правил зовётся явно: правка файла
   * рядом с документом события сессии не порождает, и отчёт без этого вызова
   * остался бы утверждением о состоянии, которого больше нет.
   *
   * Зовётся он только на СМЕНУ состояния источника: перезапись файла теми же
   * байтами прогоном правил не оплачивается (ED-8), а кэш отвечает на это той
   * же записью.
   */
  host.content.watch((change) => {
    if (change.kind === 'removed') return;
    const scene = current?.config;
    // Пара считается ОТ СЦЕНЫ (BLND-2): «источник этой сцены — вот этот файл».
    // Обратное правило («сцена этого источника») знает суффикс `.scene.json`
    // соглашения репозитория, а редактор открывает сцену, найденную по
    // содержимому, и имя её файла произвольно.
    if (scene === undefined) return;
    if (!SOURCE_EXTENSIONS.some((extension) => sourcePathOf(scene, extension) === change.path)) {
      return;
    }
    const before = sources.stateOf(scene);
    void sources.refresh(scene).then((after) => {
      if (after === before) return;
      (frame.stateOf(SCENE_AREA_ID) as SceneAreaState).revalidate();
    });
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
