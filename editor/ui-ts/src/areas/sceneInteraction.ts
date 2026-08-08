/**
 * @contribution Инструмент вьюпорта сцены: выделение, picking и расстановка
 * (ED-16, ED-17) — вклад области, а не часть каркаса.
 *
 * Ни DOM, ни THREE здесь нет намеренно: инструмент — политика над двумя
 * сервисами, и оба он видит через узкие интерфейсы (`ScenePicker` для попадания,
 * сессия для правки). Поэтому вся его логика проверяется headless, а картинку
 * проверяет глаз на живой сцене.
 *
 * ## Что здесь политика, а чего здесь быть не может
 *
 * REND-15 и REND-16 нормируют механизм: рендер разрешает курсор по видимому
 * изображению и рисует декларативный набор наложений. ЧТО значит попадание —
 * выделить, начать перетаскивание, поставить объект — знает только редактор
 * (ED-25), и знает это вот здесь. Обратного тоже не бывает: своего рисующего
 * слоя у инструмента нет (REND-16), подсветка уходит набором наложений, а не
 * вызовом «обведи вот это».
 *
 * ## Одно взаимодействие — одна запись истории (ED-18)
 *
 * «Непрерывный мазок кисти SHALL считаться одной операцией», и перетаскивание —
 * тот же случай: от нажатия до отпускания идёт ОДНА транзакция сессии.
 * `beginOperation` открывает её на первом сдвиге, `extend` продолжает на каждом
 * последующем кадре и на каждом объекте мультивыделения, `commit` закрывает
 * одной записью. Прежние значения сессия берёт с первого касания места, поэтому
 * undo возвращает позиции, бывшие ДО нажатия, а не позиции предпоследнего кадра.
 *
 * Транзакция открывается не раньше первого сдвига: клик без движения — это
 * выделение, и запись истории «подвинул на ноль» была бы undo, который ничего не
 * делает.
 *
 * Закрыться она обязана в любом исходе. Штатный — отпускание (`commit`).
 * Нештатных три, и все три идут одним путём (`cancel`): отпускание, до вьюпорта
 * не дошедшее (фаза `cancel` — окно потеряло фокус, кадр снесён), нажатие поверх
 * незакрытого перетаскивания и отказ ядра посреди него (величина вне Q16.16,
 * FP-1). Оставленная открытой транзакция — не косметика: пока она открыта,
 * сессия не даёт ни следующей операции, ни undo.
 *
 * ## Отклик вьюпорта во время взаимодействия (ED-15)
 *
 * Применение внутри ещё не закрытой транзакции сессия объявляет событием
 * наравне с записанным в историю, поэтому кадр сводится с документами сам:
 * держать эту гарантию инструменту нечем и не нужно — объект едет во вьюпорте
 * по ходу перетаскивания, а не в момент отпускания.
 *
 * ## Привязка к сетке
 *
 * ED-16: «Привязка к сетке террейна SHALL быть опциональным инструментом ввода,
 * а не свойством формата: документ хранит позицию, а не клетку». Поэтому шаг
 * привязки живёт в инструменте, а в документ уходит мировая величина,
 * проквантованная в Q16.16, — индекса клетки в записи нет и появиться неоткуда.
 *
 * ## Два документа, один инструмент (ED-17, ED-19)
 *
 * Unit и prop — сим-сущности, и их размещение живёт в поле `initial` конфига
 * сцены (SER-7, SER-8); decoration существует только в парном
 * presentation-документе (`presentation-scene` PRES-1, PRES-2). Документа два,
 * а инструмент один, и это требование, а не удобство: «сим-объекты и
 * decorations SHALL выделяться единообразно» (ED-17).
 *
 * Держится единообразие на том, что обе стороны — записи списков ОДНОЙ сессии,
 * адресуемые дескрипторами (ED-29). Поэтому выделение — плоский список ключей
 * без разделения на два, попадание разрешается одним `pick`, подсветка уходит
 * одним набором наложений, а «удалить выделенное» — одна операция
 * `document.list.remove`, отличающаяся между сторонами только тем, какой
 * документ назван параметром (сценарий ED-16). Одна операция значит одну запись
 * истории: автор удалял один раз и отменять будет один раз.
 *
 * Различаются стороны ровно там, где различаются форматы: величины сим-объекта
 * квантуются в Q16.16 (FP-1), величины decoration — десятичным шагом (PRES-3).
 * Различие это несёт ПАРАМЕТР операции (`layer`), а не вторая операция:
 * перетаскивание смешанного выделения — одно взаимодействие, а второй
 * транзакции поверх открытой сессия не даст (ED-18). Инструмент называет слой по
 * тому, в каком наборе лежит ключ, и второго признака различения не заводит.
 *
 * Пары «prefab — запись манифеста» (ED-19) и разрешимости ссылки `visual`
 * (PRES-2) инструмент не проверяет: это делают правила валидации
 * `editor.visualForPrefab` и `editor.decorationVisual` в `editor-core`, и вторая
 * их реализация расходилась бы с первой (ED-1, ED-30).
 */
import type {
  DocumentId,
  EditorSession,
  JsonPath,
  OperationParams,
  OperationTransaction,
} from '@game-mvp/editor-core';
import type { OverlayCells, OverlayGizmo, OverlayGrid } from '@game-mvp/render';
import type { AreaSelection, SelectionRef } from '../frame/selection.js';
import type {
  PlacementLayer,
  PositionBinding,
  SceneDecoration,
  ScenePlacement,
} from './sceneDocuments.js';
import { PLACEMENT_OPERATIONS, bindingParam } from './scenePlacement.js';
import { DECORATION_OPERATIONS } from './sceneDecorations.js';

// --------------------------------------------------------------- сервисы кадра

/**
 * Попадание курсора (REND-15), переведённое в термины документа. Копия, а не
 * возвращаемый рендером объект: тот переиспользуется до следующего запроса, а
 * инструмент держит попадание от нажатия до отпускания.
 */
export interface ScenePick {
  /** Во что разрешился курсор: ручка наложения, размещённый объект, поверхность. */
  readonly kind: 'handle' | 'entity' | 'surface';
  readonly handle: string | null;
  /**
   * Ключ размещённого объекта документа — его даёт тот набор, которому инстанс
   * принадлежит: `DocumentSource.keyOf` (REND-11) либо `DecorationSet.keyOf`
   * (REND-18).
   */
  readonly key: string | null;
  /** Попадание пришлось на декорацию, а не на сим-объект (REND-18). */
  readonly decoration: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly cell: number;
  readonly cellX: number;
  readonly cellY: number;
  /** В клетке нет пола (REND-7): дыра, но клетка сетки. */
  readonly noFloor: boolean;
  readonly wall: boolean;
}

/** Чем инструмент видит кадр (REND-15). Вьюпорт это умеет; тест подставляет дубль. */
export interface ScenePicker {
  /** Ручки → объекты → поверхность; null — курсор не пришёлся ни на что нарисованное. */
  pick(x: number, y: number): ScenePick | null;
  /** Только поверхность: точка нужна и тогда, когда над ней стоит объект. */
  pickSurface(x: number, y: number): ScenePick | null;
}

/**
 * Подсветка размещённого объекта. Адресуется ключом документа, а не сущностью
 * presentation-состояния: сущность знает набор инстансов (REND-11), и перевод
 * делает он, а не инструмент.
 */
export interface StageHighlight {
  readonly kind: 'highlight';
  /** Ключ наложения в наборе (REND-16) — устойчивый и уникальный. */
  readonly key: string;
  readonly placement: string;
  /** Подсвечивается декорация: ключ искать в наборе REND-18, а не REND-11. */
  readonly decoration?: boolean;
}

/** Набор наложений вьюпорта в терминах редактора (REND-16). */
export type SceneOverlay = StageHighlight | OverlayGizmo | OverlayCells | OverlayGrid;

/**
 * Фаза указателя, дошедшая до инструмента. Кнопки камеры сюда не попадают
 * (CAM-3). `cancel` — отпускание, до вьюпорта не дошедшее (окно потеряло фокус,
 * область снесена): взаимодействие обязано закрыться и в этом случае, иначе оно
 * остаётся открытым навсегда, а открытое взаимодействие в сессии запрещает и
 * следующую операцию, и undo (ED-18).
 */
export type StagePointerPhase = 'down' | 'move' | 'up' | 'cancel';

export interface StagePointer {
  readonly phase: StagePointerPhase;
  /** Положение указателя в координатах окна; у `cancel` смысла не имеет. */
  readonly x: number;
  readonly y: number;
  /** Модификатор мультивыделения (ED-17): добавить к выделению, а не заменить его. */
  readonly additive: boolean;
}

// ------------------------------------------------------------------ инструмент

/** Режим инструмента: выделять существующее или ставить новое (ED-16, ED-17). */
export type PlacementMode = 'select' | 'place';

/** Что инструмент правит и чем видит кадр; подаётся отрисовкой области. */
export interface PlacementToolInput {
  /** Сквозное выделение, суженное до области (ED-23). */
  readonly selection: AreaSelection;
  /** Кадр вьюпорта; null — в этой среде рисовать нечем, и попадать не во что. */
  readonly picker: ScenePicker | null;
  /** Текущий набор размещённого: из него берутся позиции начала перетаскивания. */
  readonly placements: readonly ScenePlacement[];
  /**
   * Текущий набор декораций (PRES-2) — вторая половина того же выделения
   * (ED-17). Отдельным полем, а не одним списком с сим-объектами, потому что
   * операции пишут в РАЗНЫЕ документы и разными величинами, и знать, какая
   * запись где, инструмент обязан по построению, а не по догадке.
   */
  readonly decorations: readonly SceneDecoration[];
  /** Шаг привязки в мировых единицах (размер клетки); 0 — привязки нет. */
  readonly snapStep: number;
  /** Имена префабов, доступных к постановке, — в порядке документа. */
  readonly prefabs: readonly string[];
  /** Ключи видов манифеста, доступных к постановке декорацией (ASSET-9). */
  readonly visuals: readonly string[];
}

export interface PlacementToolOptions {
  readonly session: EditorSession;
  /** Конфиг сцены: сим-объекты живут в его расстановке (SER-7). */
  readonly documentId: DocumentId;
  /** Путь списка расстановки в конфиге (SER-8). */
  readonly list: JsonPath;
  /**
   * Парный presentation-документ (PRES-1); `undefined` — сцены без декораций:
   * писать некуда, и расстановка декораций показана недоступной (ED-26).
   */
  readonly presentationId?: DocumentId;
  /** Путь списка декораций в парном документе (PRES-2). */
  readonly decorationList?: JsonPath;
  /** Где у объекта позиция и поворот (ED-16); нет — конвенция ядра. */
  readonly binding?: PositionBinding;
  /** Просьба перерисовать: инструмент изменил выделение или свой режим. */
  readonly refresh?: () => void;
}

export interface PlacementTool {
  readonly mode: PlacementMode;
  setMode(mode: PlacementMode): void;
  /** Префаб, который ставит инструмент; null — ставить нечего. */
  readonly prefab: string | null;
  setPrefab(prefab: string | null): void;
  /**
   * Что ставит инструмент в режиме постановки: сим-объект или декорацию
   * (ED-19). Слой, а не второй инструмент: вьюпорт, выделение и подсветка у них
   * одни и те же (ED-17).
   */
  readonly layer: PlacementLayer;
  setLayer(layer: PlacementLayer): void;
  /** Вид, которым ставится декорация; null — ставить нечего. */
  readonly visual: string | null;
  setVisual(visual: string | null): void;
  /** Есть ли куда писать декорации: нет парного документа — слой недоступен (ED-26). */
  readonly canDecorate: boolean;
  readonly snapping: boolean;
  setSnapping(on: boolean): void;
  /** Умеет ли проект хранить поворот (ED-16): нет — операция недоступна (ED-26). */
  readonly canRotate: boolean;
  /** Идёт ли перетаскивание — по нему видно, что взаимодействие ещё не закрыто. */
  readonly dragging: boolean;
  /** Что сейчас выделено из размещённого, в порядке набора. */
  selected(): readonly string[];
  /** Из чего автор выбирает, что ставить, — тот же список, что подан `attach`. */
  readonly prefabs: readonly string[];
  /** Ключи видов манифеста — тот же список, что подан `attach` (ASSET-9). */
  readonly visuals: readonly string[];
  /** Подаётся отрисовкой области перед любым обращением к инструменту. */
  attach(input: PlacementToolInput): void;
  /** Событие указателя из вьюпорта. */
  pointer(event: StagePointer): void;
  /** Полный набор наложений по текущему состоянию (REND-16). */
  overlays(): readonly SceneOverlay[];
  /** Повернуть выделенное на долю оборота (ED-16). */
  rotate(turns: number): void;
  /** Удалить выделенное (ED-16). */
  remove(): void;
  /**
   * Перевести выделенное между слоями (ED-19, PRES-5): decoration становится
   * prop'ом к названному префабу, prop — декорацией к своему виду.
   * Возможен перевод, только когда выделение однородно и парный документ есть:
   * смешанное выделение перевести некуда — половина уже в приёмнике.
   */
  readonly convertible: PlacementLayer | null;
  convert(prefab: string | null): void;
}

/**
 * Сдвиг в мировых единицах, ниже которого нажатие остаётся кликом. Нужен не
 * ради удобства: без него всякий клик по объекту оставлял бы в истории запись
 * «подвинул на ноль», и undo после выделения не делал бы ничего (ED-18).
 */
const DRAG_THRESHOLD = 1e-4;

interface DragStart {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  /** Слой ключа: им операция и различает, куда и чем писать (ED-19, PRES-3). */
  readonly layer: PlacementLayer;
}

interface DragState {
  readonly originX: number;
  readonly originY: number;
  readonly starts: readonly DragStart[];
  transaction: OperationTransaction | null;
}

export function createPlacementTool(options: PlacementToolOptions): PlacementTool {
  const { session } = options;
  const binding = options.binding;
  const refresh = options.refresh ?? ((): void => undefined);
  const bound: OperationParams = bindingParam(binding);

  let mode: PlacementMode = 'select';
  let prefab: string | null = null;
  let visual: string | null = null;
  let layer: PlacementLayer = 'sim';
  let snapping = false;
  let input: PlacementToolInput | null = null;
  let drag: DragState | null = null;

  const placements = (): readonly ScenePlacement[] => input?.placements ?? [];
  const decorations = (): readonly SceneDecoration[] => input?.decorations ?? [];
  /** Есть ли парный документ: без него писать декорации некуда (PRES-1). */
  const canDecorate = (): boolean =>
    options.presentationId !== undefined && options.decorationList !== undefined;

  /**
   * Слой ключа: в каком из двух наборов он лежит. Отвечает на это набор, а не
   * форма ключа: дескрипторы сессии выдаются обоим спискам из одного минтера
   * (ED-29), и различить их по виду нельзя — да и не нужно.
   */
  const layerOf = (key: string): PlacementLayer | null => {
    if (placements().some((item) => item.key === key)) return 'sim';
    if (decorations().some((item) => item.key === key)) return 'decoration';
    return null;
  };

  /** Документ и список слоя — адрес, которым операция и адресуется (ED-29). */
  const documentOf = (target: PlacementLayer): DocumentId =>
    target === 'decoration' ? (options.presentationId ?? '') : options.documentId;

  /**
   * Ссылки выделения, за которыми стоит размещённое: узлы дерева сюда не
   * попадают. Оба слоя одним плоским списком — этого и требует единообразие
   * выделения (ED-17); в каком слое лежит ключ, спрашивается отдельно.
   */
  const selectedKeys = (): readonly string[] => {
    const refs = input?.selection.current() ?? [];
    return refs.filter((ref) => layerOf(ref) !== null);
  };

  const snap = (value: number): number => {
    const step = input?.snapStep ?? 0;
    if (!snapping || step <= 0) return value;
    // Узлы сетки, а не клетки (ED-16): в документ всё равно уходит позиция.
    return Math.round(value / step) * step;
  };

  const select = (refs: readonly SelectionRef[]): void => {
    input?.selection.set(refs);
    refresh();
  };

  const toggled = (refs: readonly SelectionRef[], key: string): SelectionRef[] =>
    refs.includes(key) ? refs.filter((ref) => ref !== key) : [...refs, key];

  /**
   * Применяет перемещение всего выделенного одним продолжением взаимодействия.
   * Слой уходит параметром той же операции: смешанное выделение — по-прежнему
   * одно перетаскивание и одна запись истории (ED-17, ED-18).
   */
  const moveTo = (state: DragState, dx: number, dy: number): void => {
    for (const start of state.starts) {
      const params: OperationParams = {
        ...bound,
        document: documentOf(start.layer),
        record: start.key,
        x: snap(start.x + dx),
        y: snap(start.y + dy),
        layer: start.layer,
      };
      if (state.transaction === null) {
        state.transaction = session.beginOperation(PLACEMENT_OPERATIONS.move, params);
      } else {
        state.transaction.extend(params);
      }
    }
  };

  /**
   * Бросает взаимодействие, вернув документы к состоянию до нажатия. Это же —
   * ответ на отказ посреди перетаскивания: половина мультивыделения, доехавшая
   * до новой позиции, есть состояние, которого не производит ни одна операция
   * целиком, и `commit` записал бы его в историю как достижимое (ED-18).
   */
  const cancelDrag = (): void => {
    const state = drag;
    drag = null;
    if (state?.transaction == null) return;
    state.transaction.cancel();
    refresh();
  };

  /**
   * Пакет по мультивыделению — одно взаимодействие: `beginOperation` на первой
   * записи, `extend` на каждой следующей, `commit` одной записью истории
   * (ED-18). Автор нажал один раз, и отменять он будет тоже один раз.
   *
   * Отказ на середине пакета закрывает взаимодействие тем же путём, что отказ
   * посреди перетаскивания: половина выделения, доехавшая до нового поворота,
   * — состояние, которого не производит ни одна операция целиком, а незакрытая
   * транзакция запретила бы и следующую операцию, и undo до конца сессии
   * (ED-18). Причина при этом наружу поднимается: это отказ операции авторинга,
   * а не курсор, уехавший за пределы Q16.16, и молчать о нём нечестно.
   */
  const batch = (
    operationId: string,
    keys: readonly string[],
    paramsOf: (key: string) => OperationParams,
  ): void => {
    let transaction: OperationTransaction | null = null;
    try {
      for (const key of keys) {
        const params = paramsOf(key);
        if (transaction === null) transaction = session.beginOperation(operationId, params);
        else transaction.extend(params);
      }
    } catch (error) {
      transaction?.cancel();
      throw error;
    }
    transaction?.commit();
  };

  /**
   * Постановка. Слоёв два, и операции постановки у них РАЗНЫЕ — в отличие от
   * перемещения: сим-объект называет prefab, декорация — визуальный вид
   * (ED-19), и это два разных действия, а не одно с параметром.
   */
  const place = (event: StagePointer): void => {
    const picker = input?.picker;
    // Пока идёт чужое взаимодействие, второй операции сессия не начнёт — и
    // отказывает исключением. Отказ здесь тот же, что у поворота и удаления:
    // молча ничего не сделать, а не уронить обработчик указателя.
    if (picker == null || session.pending) return;
    const decorating = layer === 'decoration';
    if (decorating ? visual === null || !canDecorate() : prefab === null) return;
    // Точка на поверхности, а не под объектом: ставят на арену, а не на юнита.
    const hit = picker.pickSurface(event.x, event.y);
    if (hit === null) return;
    const outcome = decorating
      ? session.applyOperation(DECORATION_OPERATIONS.add, {
          document: documentOf('decoration'),
          list: options.decorationList ?? [],
          visual: visual as string,
          x: snap(hit.x),
          y: snap(hit.y),
        })
      : session.applyOperation(PLACEMENT_OPERATIONS.add, {
          ...bound,
          document: options.documentId,
          list: options.list,
          prefab: prefab as string,
          x: snap(hit.x),
          y: snap(hit.y),
        });
    // Поставленное сразу и выделено: следующее действие автора почти всегда о нём.
    if (typeof outcome.result === 'string') select([outcome.result]);
    else refresh();
  };

  const down = (event: StagePointer): void => {
    // Нажатие поверх ещё не закрытого перетаскивания: отпускание до вьюпорта не
    // дошло. Прежнее взаимодействие закрывается здесь, а не забывается ссылкой —
    // забытая транзакция осталась бы открытой в сессии навсегда (ED-18).
    if (drag !== null) cancelDrag();
    if (mode === 'place') {
      place(event);
      return;
    }
    const picker = input?.picker;
    if (picker == null) return;
    const hit = picker.pick(event.x, event.y);
    // Клик по пустому месту снимает выделение (ED-17); с модификатором —
    // не снимает: набирающий мультивыделение промахивается чаще всего.
    if (hit === null || hit.kind !== 'entity' || hit.key === null) {
      if (!event.additive) select([]);
      return;
    }
    const key = hit.key;
    const current = input?.selection.current() ?? [];
    if (event.additive) select(toggled(current, key));
    else if (!current.includes(key)) select([key]);

    const ground = picker.pickSurface(event.x, event.y);
    if (ground === null) return;
    const starts = selectedKeys().flatMap<DragStart>((selected) => {
      const placement = placements().find((item) => item.key === selected);
      if (placement !== undefined) {
        return [{ key: selected, x: placement.x, y: placement.y, layer: 'sim' }];
      }
      const decoration = decorations().find((item) => item.key === selected);
      return decoration === undefined
        ? []
        : [{ key: selected, x: decoration.x, y: decoration.y, layer: 'decoration' }];
    });
    if (starts.length === 0) return;
    drag = { originX: ground.x, originY: ground.y, starts, transaction: null };
  };

  const move = (event: StagePointer): void => {
    const state = drag;
    const picker = input?.picker;
    if (state === null || picker == null) return;
    const ground = picker.pickSurface(event.x, event.y);
    // Курсор ушёл за арену: попадания нет, и двигать не на что. Прежнее
    // положение при этом остаётся — взаимодействие не прерывается.
    if (ground === null) return;
    const dx = ground.x - state.originX;
    const dy = ground.y - state.originY;
    if (state.transaction === null && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    try {
      moveTo(state, dx, dy);
    } catch {
      // Величина, которой ядро не представляет (FP-1), взаимодействие не
      // продолжает: документы возвращаются к состоянию до нажатия, в истории не
      // остаётся ничего. Причина наружу не поднимается намеренно — это не
      // отказ операции авторинга, а курсор, уехавший за пределы Q16.16.
      cancelDrag();
    }
  };

  const up = (): void => {
    const state = drag;
    drag = null;
    if (state?.transaction == null) return;
    // Одна запись истории на всё взаимодействие (ED-18).
    state.transaction.commit();
    refresh();
  };

  return {
    get mode(): PlacementMode {
      return mode;
    },
    setMode(next) {
      if (next === mode) return;
      mode = next;
      refresh();
    },
    get prefab(): string | null {
      return prefab;
    },
    setPrefab(next) {
      prefab = next;
      refresh();
    },
    get layer(): PlacementLayer {
      return layer;
    },
    setLayer(next) {
      if (next === layer) return;
      layer = next;
      refresh();
    },
    get visual(): string | null {
      return visual;
    },
    setVisual(next) {
      visual = next;
      refresh();
    },
    get canDecorate(): boolean {
      return canDecorate();
    },
    get snapping(): boolean {
      return snapping;
    },
    setSnapping(on) {
      snapping = on;
      refresh();
    },
    get canRotate(): boolean {
      return binding?.rotation !== undefined;
    },
    get dragging(): boolean {
      return drag?.transaction != null;
    },
    selected: selectedKeys,
    get prefabs(): readonly string[] {
      return input?.prefabs ?? [];
    },
    get visuals(): readonly string[] {
      return input?.visuals ?? [];
    },

    attach(next) {
      input = next;
      // Префаб и вид по умолчанию — первые в документе: инструмент постановки
      // без выбранного был бы видимо доступен и молча не срабатывал (ED-26).
      if (prefab === null || !next.prefabs.includes(prefab)) prefab = next.prefabs[0] ?? null;
      if (visual === null || !next.visuals.includes(visual)) visual = next.visuals[0] ?? null;
      // Слой без парного документа не держится: писать в него некуда, и
      // оставленный выбранным он показывал бы доступным то, чего нет (PRES-1).
      if (layer === 'decoration' && !canDecorate()) layer = 'sim';
    },

    pointer(event) {
      if (event.phase === 'down') down(event);
      else if (event.phase === 'move') move(event);
      else if (event.phase === 'cancel') cancelDrag();
      else up();
    },

    overlays() {
      // Набор — функция выделения, а не история вызовов (REND-16). Подсветка у
      // сим-объекта и у декорации одна и та же; слой называется затем, чтобы
      // ключ искали в том наборе, который его выдал (REND-18).
      return selectedKeys().map((key) => ({
        kind: 'highlight' as const,
        key: `selection:${key}`,
        placement: key,
        ...(layerOf(key) === 'decoration' ? { decoration: true } : {}),
      }));
    },

    rotate(turns) {
      // Поворот сим-объекта требует привязки проекта (ED-16), поворот декорации
      // — нет: у неё курс лежит полем записи. Поэтому выделение из одних
      // декораций поворачивается и на проекте, не назвавшем, где поворот лежит.
      const keys = selectedKeys().filter(
        (key) => layerOf(key) === 'decoration' || binding?.rotation !== undefined,
      );
      if (keys.length === 0 || session.pending) return;
      batch(PLACEMENT_OPERATIONS.rotate, keys, (key) => {
        const target = layerOf(key) ?? 'sim';
        // Прежний поворот берётся в единице ДОКУМЕНТА — доле оборота, — а не
        // делением радиан рендера: обратный ход через радианы теряет квант, и
        // каждое нажатие уводило бы поворот на него (FP-1, PRES-3).
        const current =
          target === 'decoration'
            ? (decorations().find((item) => item.key === key)?.turns ?? 0)
            : (placements().find((item) => item.key === key)?.turns ?? 0);
        return {
          ...bound,
          document: documentOf(target),
          record: key,
          turns: current + turns,
          layer: target,
        };
      });
      refresh();
    },

    get convertible(): PlacementLayer | null {
      if (!canDecorate()) return null;
      const keys = selectedKeys();
      if (keys.length === 0) return null;
      const layers = new Set(keys.map((key) => layerOf(key)));
      if (layers.size !== 1) return null;
      // Слой ВЫДЕЛЕНИЯ, а не слой приёмника: перевод идёт из него.
      return layers.has('decoration') ? 'decoration' : 'sim';
    },

    /**
     * Перевод выделенного между документами пары (PRES-5). Пакетом по той же
     * причине, что удаление: автор попросил один раз. Каждая запись при этом
     * переезжает ОДНОЙ операцией — существование объекта в обоих документах
     * сразу PRES-5 запрещает, и двумя операциями оно было бы достижимо между
     * ними (ED-18).
     *
     * Вид объекта не переписывается: ключи разделов манифеста лежат в одном
     * пространстве (ASSET-9), и prop, ставший декорацией, ссылается на ту же
     * запись, которой был нарисован. `prefab` нужен обратному направлению —
     * сим-стороны у декорации не было, и её приходится назвать.
     */
    convert(prefab) {
      const from = this.convertible;
      const keys = selectedKeys();
      if (from === null || keys.length === 0 || session.pending) return;
      if (from === 'decoration' && (prefab === null || prefab === '')) return;
      const decorating = from === 'decoration';
      batch(
        decorating ? DECORATION_OPERATIONS.toProp : DECORATION_OPERATIONS.fromProp,
        keys,
        (key) =>
          decorating
            ? {
                ...bound,
                document: documentOf('decoration'),
                record: key,
                target: options.documentId,
                list: options.list,
                prefab,
              }
            : {
                ...bound,
                document: options.documentId,
                record: key,
                target: documentOf('decoration'),
                list: options.decorationList ?? [],
                // Вид переезжает вместе с объектом: у сим-объекта он назван
                // именем prefab'а в манифесте (ASSET-6), и второй записи для
                // декорации не требуется (ASSET-9).
                visual: placements().find((item) => item.key === key)?.kind ?? '',
              },
      );
      // Выделение снимается, как и при удалении: прежних ключей больше нет —
      // записи из документа-источника исчезли, — а новые выдал приёмник, и
      // узнать их пакет не может: результат взаимодействия у сессии один на
      // всё взаимодействие, а не по применению (ED-18).
      select([]);
    },

    remove() {
      const keys = selectedKeys();
      if (keys.length === 0 || session.pending) return;
      // Мультивыделение уходит одной записью истории: автор удалял один раз, и
      // юнит с декорацией — ОДНА операция, отличающаяся между ними только
      // названным документом (сценарий ED-16). Операция та же самая, базовая:
      // доменной обёртки над ней нет ни у одного из слоёв.
      batch(PLACEMENT_OPERATIONS.remove, keys, (key) => ({
        document: documentOf(layerOf(key) ?? 'sim'),
        record: key,
      }));
      select([]);
    },
  };
}
