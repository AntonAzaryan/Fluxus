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
 * ## Привязка к сетке
 *
 * ED-16: «Привязка к сетке террейна SHALL быть опциональным инструментом ввода,
 * а не свойством формата: документ хранит позицию, а не клетку». Поэтому шаг
 * привязки живёт в инструменте, а в документ уходит мировая величина,
 * проквантованная в Q16.16, — индекса клетки в записи нет и появиться неоткуда.
 *
 * ## Чего здесь нет: decorations (ED-19)
 *
 * Unit и prop — сим-сущности, и их размещение живёт в поле `initial` конфига
 * сцены (SER-7, SER-8): их этот инструмент и ставит. Decoration существует
 * только в парном presentation-документе, формат которого нормативно не
 * определён (`presentation-scene-layer` — стаб), поэтому расстановки декораций
 * здесь нет вовсе. Это не пробел реализации: писать её было бы изобретением
 * формата, а не следованием ему.
 *
 * Пары «prefab — запись манифеста» (ED-19) инструмент не проверяет: это делает
 * правило валидации `editor.visualForPrefab` в `editor-core`, и вторая его
 * реализация расходилась бы с первой (ED-1, ED-30).
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
import type { ScenePlacement, PositionBinding } from './sceneDocuments.js';
import { TURN_RADIANS } from './sceneDocuments.js';
import { PLACEMENT_OPERATIONS, bindingParam } from './scenePlacement.js';

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
  /** Ключ размещённого объекта документа — его даёт `DocumentSource.keyOf` (REND-11). */
  readonly key: string | null;
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
}

/** Набор наложений вьюпорта в терминах редактора (REND-16). */
export type SceneOverlay = StageHighlight | OverlayGizmo | OverlayCells | OverlayGrid;

/** Фаза указателя, дошедшая до инструмента. Кнопки камеры сюда не попадают (CAM-3). */
export type StagePointerPhase = 'down' | 'move' | 'up';

export interface StagePointer {
  readonly phase: StagePointerPhase;
  /** Положение указателя в координатах окна — прямоугольник кадра знает вьюпорт. */
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
  /** Шаг привязки в мировых единицах (размер клетки); 0 — привязки нет. */
  readonly snapStep: number;
  /** Имена префабов, доступных к постановке, — в порядке документа. */
  readonly prefabs: readonly string[];
}

export interface PlacementToolOptions {
  readonly session: EditorSession;
  /** Конфиг сцены: сим-объекты живут в его расстановке (SER-7). */
  readonly documentId: DocumentId;
  /** Путь списка расстановки в конфиге (SER-8). */
  readonly list: JsonPath;
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
  let snapping = false;
  let input: PlacementToolInput | null = null;
  let drag: DragState | null = null;

  const placements = (): readonly ScenePlacement[] => input?.placements ?? [];

  /** Ссылки выделения, за которыми стоит размещённое: узлы дерева сюда не попадают. */
  const selectedKeys = (): readonly string[] => {
    const refs = input?.selection.current() ?? [];
    const known = new Set(placements().map((item) => item.key));
    return refs.filter((ref) => known.has(ref));
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

  /** Применяет перемещение всего выделенного одним продолжением взаимодействия. */
  const moveTo = (state: DragState, dx: number, dy: number): void => {
    for (const start of state.starts) {
      const params: OperationParams = {
        ...bound,
        document: options.documentId,
        record: start.key,
        x: snap(start.x + dx),
        y: snap(start.y + dy),
      };
      if (state.transaction === null) {
        state.transaction = session.beginOperation(PLACEMENT_OPERATIONS.move, params);
      } else {
        state.transaction.extend(params);
      }
    }
  };

  const place = (event: StagePointer): void => {
    const picker = input?.picker;
    if (picker == null || prefab === null) return;
    // Точка на поверхности, а не под объектом: ставят на арену, а не на юнита.
    const hit = picker.pickSurface(event.x, event.y);
    if (hit === null) return;
    const outcome = session.applyOperation(PLACEMENT_OPERATIONS.add, {
      ...bound,
      document: options.documentId,
      list: options.list,
      prefab,
      x: snap(hit.x),
      y: snap(hit.y),
    });
    // Поставленное сразу и выделено: следующее действие автора почти всегда о нём.
    if (typeof outcome.result === 'string') select([outcome.result]);
    else refresh();
  };

  const down = (event: StagePointer): void => {
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
    const starts = selectedKeys().flatMap((selected) => {
      const placement = placements().find((item) => item.key === selected);
      return placement === undefined ? [] : [{ key: selected, x: placement.x, y: placement.y }];
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
    moveTo(state, dx, dy);
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

    attach(next) {
      input = next;
      // Префаб по умолчанию — первый в документе: инструмент постановки без
      // выбранного префаба был бы видимо доступен и молча не срабатывал (ED-26).
      if (prefab === null || !next.prefabs.includes(prefab)) prefab = next.prefabs[0] ?? null;
    },

    pointer(event) {
      if (event.phase === 'down') down(event);
      else if (event.phase === 'move') move(event);
      else up();
    },

    overlays() {
      // Набор — функция выделения, а не история вызовов (REND-16).
      return selectedKeys().map((key) => ({
        kind: 'highlight' as const,
        key: `selection:${key}`,
        placement: key,
      }));
    },

    rotate(turns) {
      const spin = binding?.rotation;
      const keys = selectedKeys();
      if (spin === undefined || keys.length === 0 || session.pending) return;
      let transaction: OperationTransaction | null = null;
      for (const key of keys) {
        const placement = placements().find((item) => item.key === key);
        const current = (placement?.yaw ?? 0) / TURN_RADIANS;
        const params: OperationParams = {
          ...bound,
          document: options.documentId,
          record: key,
          turns: current + turns,
        };
        if (transaction === null) {
          transaction = session.beginOperation(PLACEMENT_OPERATIONS.rotate, params);
        } else {
          transaction.extend(params);
        }
      }
      transaction?.commit();
      refresh();
    },

    remove() {
      const keys = selectedKeys();
      if (keys.length === 0 || session.pending) return;
      // Мультивыделение уходит одной записью истории: автор удалял один раз.
      let transaction: OperationTransaction | null = null;
      for (const key of keys) {
        const params: OperationParams = { document: options.documentId, record: key };
        if (transaction === null) {
          transaction = session.beginOperation(PLACEMENT_OPERATIONS.remove, params);
        } else {
          transaction.extend(params);
        }
      }
      transaction?.commit();
      select([]);
    },
  };
}
