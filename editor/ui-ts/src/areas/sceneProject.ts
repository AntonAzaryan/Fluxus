/**
 * @contribution Открытие документов сцены — часть вклада области, а не каркаса.
 *
 * Сцена — это не один документ: конфиг (SER-7) ссылается на ассет террейна,
 * манифест визуалов (ASSET-6) — на модели, скины и карту кривизны (ASSET-7), а
 * рядом с конфигом лежит парный presentation-документ с декорациями
 * (`presentation-scene` PRES-1). ED-15 требует, чтобы изображение было
 * производным от текущего состояния ИХ ВСЕХ, поэтому все они открываются
 * сессией как документы: правка манифеста и правка кривизны — такие же правки,
 * как правка позиции, и ждать записи на диск ради картинки нельзя (ED-9, ED-21
 * — сохранение отдельная операция).
 *
 * Парный документ находится ПРАВИЛОМ ИМЕНИ, а не ссылкой (PRES-1): ссылок
 * между документами пары нет ни в одну сторону, и спросить о нём конфиг сцены
 * нечем. Отсутствие файла — законное состояние, означающее сцену без
 * декораций, а не отказ открытия: документ тогда открывается пустым в сессии,
 * и слой декораций доступен на сцене, у которой файла ещё нет (ED-16, PRES-5).
 *
 * Читаются они через хост среды (ED-12) и только через него: прямого обращения
 * к файловой системе тут нет и в вебе быть не может.
 */
import {
  crossDocumentRules,
  engineValidationRules,
  openDocumentFromHost,
  type ContentPath,
  type ContentTreeHost,
  type DocumentId,
  type EditorSession,
  type JsonPath,
  type JsonValue,
  type ValidationRule,
} from '@game-mvp/editor-core';
import { presentationPathOf, type VisualManifest } from '@game-mvp/assets';
import { CAMERA_CONFIG_DESCRIPTION, CAMERA_EFFECTS_DESCRIPTION } from '@game-mvp/render';
import { OBJECT_LISTS } from './objects.js';
import { SYSTEM_DOCUMENT_KIND, SYSTEM_LISTS } from './systems.js';
import { systemSites } from './systemsDocuments.js';
import {
  sceneDraft,
  visualsOf,
  type PositionBinding,
  type SceneDraft,
} from './sceneDocuments.js';

/** Путь списка расстановки в конфиге сцены (SER-7, SER-8) — доменное знание вклада. */
export const PLACEMENT_LIST: JsonPath = ['initial'];

/**
 * Где в конфиге сцены лежит ассет террейна (TERR-2, SER-7). Путь, а не «сам
 * документ»: сегодня сетка живёт полем конфига, и кисть уровня (ED-10) правит
 * её там же, где её читает `loadScene`. Отдельным документом ассет террейна
 * стать может — тогда правится этот путь, а не операции кисти, у которых он
 * параметр.
 */
export const TERRAIN_ASSET: JsonPath = ['terrain'];

/** Путь списка декораций в парном документе (PRES-2) — доменное знание вклада. */
export const DECORATION_LIST: JsonPath = ['decorations'];

/**
 * Чем открывается парный документ, которого в дереве ещё нет. Пустой объект, а
 * не `{"decorations": []}`: отсутствующий и пустой список неразличимы (PRES-2),
 * и поле, которого автор не писал, попало бы в дифф первой же правки (ED-21).
 */
const EMPTY_PRESENTATION: JsonValue = Object.freeze({});

/**
 * ВСЕ отслеживаемые списки конфига сцены — одним перечнем, потому что открыть
 * их можно только одним вызовом.
 *
 * Конфиг сцены правят три области: сцена расставляет (`initial`, SER-8),
 * объекты описывают схемы и prefab'ы (`components`, `prefabs`, SER-7), системы
 * — JSON-системы (`systems`, SYS-1). Документ у них ОДИН, и сессия открывает
 * его однажды: `openDocument` на уже открытый документ отказывает, а
 * отслеживаемые списки — свойство открытия и вторым вызовом не дописываются
 * (`document/session.ts`). Поэтому перечень собран здесь целиком, а не по
 * области за раз: открывшая документ первой область, назвавшая только свои
 * списки, оставила бы соседей без адресуемых записей (ED-29), и те показали бы
 * причину «списков не отслеживают» вместо своего материала.
 *
 * Список декораций сюда не входит: он лежит в парном документе (PRES-2), а не
 * в конфиге, и открывается вместе с ним.
 */
export const PROJECT_LISTS: readonly JsonPath[] = Object.freeze([
  PLACEMENT_LIST,
  ...OBJECT_LISTS,
  ...SYSTEM_LISTS,
]);

/** Виды документов сцены — ими ключуются вклады инспектора и правил валидации (ED-25). */
export const SCENE_KINDS = {
  config: 'scene',
  visuals: 'visuals',
  curvature: 'terrain-curvature',
  presentation: 'presentation',
} as const;

/**
 * Правила валидации ЭТОГО проекта (ED-8): правила движка и междокументные — с
 * его видами документов и его раскладкой.
 *
 * Правило знает отношение, а где лежат его стороны — знает тот, кто собирает
 * редактор (ED-25). Раскладка здесь нестандартная и потому названа целиком: и
 * список расстановки (SER-8), и ассет террейна (TERR-2) лежат полями конфига
 * сцены (SER-7), а не отдельными документами, и правило с умолчаниями на этом
 * проекте не сработало бы ни разу. Дописывать сравнение у себя вместо подачи
 * адресов значило бы завести вторую реализацию правила (ED-1, CORE-3) — ровно
 * то, ради чего адреса и стали параметром.
 *
 * По той же причине здесь и правила движка: их виды документов у этого проекта
 * свои (манифест — `visuals`, карта кривизны — `terrain-curvature`), и с
 * умолчаниями `engineValidationRules` не встали бы ни на один открытый
 * документ. Пока их не приносил никто, ED-8 в собранном редакторе не
 * исполнялся вовсе: подсветку в реальном времени давали только междокументные
 * правила, а `loadScene`, `validateManifest` и остальные владельцы формата
 * молчали.
 *
 * Ассет террейна лежит полем конфига сцены, отдельного документа вида `terrain`
 * у проекта нет: правило террейна названо тем же видом, что конфиг, не будет —
 * оно проверяло бы конфиг целиком конструктором сетки. Поэтому вид у него
 * остаётся умолчальным и правило просто не срабатывает; сетку проверяет
 * `loadScene` в составе конфига.
 *
 * Описание типов эффектов камеры (CAM-9) приносится тем же вызовом: правило
 * `assets.manifest` импортировать его не может (пакет headless), а без него
 * секция эффектов проверялась бы только структурно (ASSET-8, ED-14).
 *
 * Третьим аргументом идут адреса систем (`systemSites`) — по тем же основаниям
 * и тем же приёмом: JSON-системы у этого проекта лежат СПИСКОМ внутри конфига
 * сцены (SYS-1, SER-7), а не отдельными документами. Без них правило встало бы
 * на умолчальный вид `system`, которого у проекта нет вовсе, и не сработало бы
 * ни разу; с ними находка адресует запись системы, а не конфиг целиком (ED-8,
 * ED-30).
 */
export function sceneValidationRules(): readonly ValidationRule[] {
  const kinds = {
    scene: SCENE_KINDS.config,
    manifest: SCENE_KINDS.visuals,
    curvature: SCENE_KINDS.curvature,
    presentation: SCENE_KINDS.presentation,
  };
  return Object.freeze([
    ...engineValidationRules(
      {
        scene: SCENE_KINDS.config,
        // Отдельного документа-ассета террейна у проекта нет (см. выше): вид
        // остаётся умолчальным, и правило просто не срабатывает.
        terrain: 'terrain',
        curvature: SCENE_KINDS.curvature,
        manifest: SCENE_KINDS.visuals,
        // Вид системы-документа проект объявляет (его вносит область систем,
        // ED-30), но своих систем-документов у него нет: где лежат ЕГО
        // системы, говорит третий аргумент.
        system: SYSTEM_DOCUMENT_KIND,
        // Парный presentation-документ сцены (PRES-1): его формат — закрытый
        // состав документа, записи decoration и секции тумана и освещения —
        // проверяет валидатор ассетов, а не правило редактора (ED-1).
        presentation: SCENE_KINDS.presentation,
      },
      // Описания камеры — вход валидации манифеста (ASSET-8, ASSET-10): их
      // приносит собирающий редактор, потому что перечни живут в коде камеры.
      { cameraEffects: CAMERA_EFFECTS_DESCRIPTION, cameraConfig: CAMERA_CONFIG_DESCRIPTION },
      systemSites(SCENE_KINDS.config),
    ),
    ...crossDocumentRules(
      kinds,
      [{ kind: SCENE_KINDS.config, path: PLACEMENT_LIST }],
      [{ kind: SCENE_KINDS.config, path: TERRAIN_ASSET }],
      // Список декораций лежит полем парного документа (PRES-2) — раскладка у
      // этого проекта совпадает с умолчанием правила, но названа явно рядом с
      // остальными: адреса приносит собирающий редактор, а не правило.
      [{ kind: SCENE_KINDS.presentation, path: DECORATION_LIST }],
    ),
  ]);
}

export interface SceneProjectIds {
  /** Конфиг сцены — путь от корня дерева контента, он же ID документа (ASSET-2). */
  readonly config: ContentPath;
  /** Манифест визуалов; карту кривизны он называет сам (`terrain.curvatureMap`). */
  readonly visuals: ContentPath;
  /**
   * Где у сим-объекта позиция (ED-16). Настройка проекта: у ядра понятия
   * позиции нет, и зашивать имя компонента в редактор нельзя. Нет — конвенция
   * ядра (`DEFAULT_POSITION_BINDING`).
   */
  readonly position?: PositionBinding;
}

/** То, что редактор открыл: чем рисовать сцену и где это лежит. */
export interface SceneProject {
  readonly configId: DocumentId;
  readonly visualsId: DocumentId;
  /** Карта кривизны — её ID берётся из манифеста; `null` — арена без кривизны. */
  readonly curvatureId: DocumentId | null;
  /**
   * Парный presentation-документ (PRES-1). ID выводится из пути сцены правилом
   * имени, и документ по нему открыт ВСЕГДА: файла в дереве может ещё не быть —
   * тогда он открыт пустым в сессии. Отдельного «есть ли он» у проекта поэтому
   * нет: расстановка декораций и перевод prop → decoration безусловны (ED-16,
   * PRES-5), а на диск документ уходит сохранением и только с содержимым.
   */
  readonly presentationId: DocumentId;
  /**
   * Манифест НА МОМЕНТ ОТКРЫТИЯ: им поднимается подсистема моделей (REND-8) и
   * по нему находится карта кривизны (ASSET-7). Текущим состоянием манифеста он
   * не является и являться не может — манифест правит просмотрщик (ED-14), и
   * снимок расходится с документом на первой же правке. Всё, что рисует кадр,
   * читает манифест из сессии (`draftOf`), а до подсистемы моделей он доезжает
   * переподачей (REND-17).
   */
  readonly initialVisuals: VisualManifest;
  /** Настройка проекта о позиции (ED-16); её же получит расстановка W3-3. */
  readonly position: PositionBinding | undefined;
}

/**
 * Открывает документы сцены в сессии. Идемпотентно: каркас может завести запись
 * состояния области дважды над одной сессией (`AreaSetup`), и повторное
 * открытие не должно ни перечитывать диск, ни сбрасывать несохранённые правки.
 */
export async function openSceneProject(
  session: EditorSession,
  host: ContentTreeHost,
  ids: SceneProjectIds,
): Promise<SceneProject> {
  if (!session.isOpen(ids.config)) {
    await openDocumentFromHost(session, host, {
      id: ids.config,
      kind: SCENE_KINDS.config,
      // Записи расстановки адресуются дескрипторами сессии: они и служат
      // ключами инстансов документного набора (REND-11). Списки соседних
      // областей открываются здесь же и по той же причине — обоснование
      // перечня в шапке `PROJECT_LISTS`.
      lists: [...PROJECT_LISTS],
    });
  }
  if (!session.isOpen(ids.visuals)) {
    await openDocumentFromHost(session, host, { id: ids.visuals, kind: SCENE_KINDS.visuals });
  }
  const visuals = visualsOf(session.documentValue(ids.visuals));

  const curvatureId = visuals.terrain?.curvatureMap ?? null;
  if (curvatureId !== null && !session.isOpen(curvatureId)) {
    await openDocumentFromHost(session, host, {
      id: curvatureId,
      kind: SCENE_KINDS.curvature,
    });
  }

  // Парный документ ищется ПО ИМЕНИ (PRES-1): ссылок между документами пары нет
  // ни в одну сторону, и спрашивать конфиг сцены о нём нечем — состав его полей
  // закрыт (SER-7). Файла в дереве может не быть, и это законное состояние —
  // сцена без декораций; документ тогда открывается пустым, а не пропускается:
  // ED-16 и PRES-5 требуют расстановки декораций и перевода prop → decoration
  // безусловно, и слой, доступный только там, где файл уже кем-то создан, их не
  // исполняет. Запрет PRES-1 при этом не нарушается: он про документ,
  // заведённый ради пустого слоя, а не про документ, заведённый правкой, — на
  // диск пустой документ не уходит (сохранение сборки, ED-21).
  const presentationId = presentationPathOf(ids.config);
  if (!session.isOpen(presentationId)) {
    const opening = {
      id: presentationId,
      kind: SCENE_KINDS.presentation,
      // Записи decoration адресуются дескрипторами сессии — ровно так же, как
      // записи расстановки, и отсюда единообразие выделения (ED-17, ED-29).
      lists: [DECORATION_LIST],
    };
    if ((await host.stat(presentationId))?.kind === 'file') {
      await openDocumentFromHost(session, host, opening);
    } else {
      session.openDocument({ ...opening, value: EMPTY_PRESENTATION });
    }
  }

  return {
    configId: ids.config,
    visualsId: ids.visuals,
    curvatureId,
    presentationId,
    initialVisuals: visuals,
    position: ids.position,
  };
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Кадр по текущему состоянию открытых документов (ED-15). Ключи записей —
 * дескрипторы сессии: они переживают правку соседей, а значит инстанс не
 * пересоздаётся от правки позиции (REND-11).
 *
 * Манифест читается ИЗ СЕССИИ на каждый пересчёт, а не берётся снимком
 * открытия: он такой же редактируемый документ (ED-14), и снимок означал бы,
 * что назначенная в просмотрщике модель доедет до картинки только переоткрытием
 * проекта — то есть не доедет (ED-15). Сломанный манифест кадра не гасит: его
 * причина складывается с остальными, как и причина сломанной карты кривизны.
 */
export function draftOf(session: EditorSession, project: SceneProject): SceneDraft {
  let visuals: VisualManifest | null = null;
  let broken: string | null = null;
  try {
    visuals = visualsOf(session.documentValue(project.visualsId));
  } catch (error) {
    broken = message(error);
  }
  const presentationOpen = session.isOpen(project.presentationId);
  const draft = sceneDraft({
    config: session.documentValue(project.configId),
    keys: session.descriptors(project.configId, PLACEMENT_LIST),
    visuals,
    ...(project.position === undefined ? {} : { position: project.position }),
    curvature:
      project.curvatureId === null || !session.isOpen(project.curvatureId)
        ? null
        : session.documentValue(project.curvatureId),
    // Слой декораций читается из сессии на каждый пересчёт по той же причине,
    // что и манифест: это такой же редактируемый документ, и картинка есть
    // функция его ТЕКУЩЕГО состояния (ED-15). Отсутствие пары — не ошибка, а
    // сцена без декораций (PRES-1).
    presentation: presentationOpen ? session.documentValue(project.presentationId) : null,
    decorationKeys: presentationOpen
      ? session.descriptors(project.presentationId, DECORATION_LIST)
      : [],
  });
  if (broken === null) return draft;
  return { ...draft, failure: draft.failure === null ? broken : `${broken}; ${draft.failure}` };
}
