/**
 * Каркас рабочих областей (ED-23, ED-24) — то, что складывает верхний бар,
 * рельс и скелет в одну страницу и хранит между переключениями всё, что должно
 * их пережить.
 *
 * Каркас не знает ни одного имени редактируемого (ED-25) и не может узнать: он
 * оперирует реестром областей, непрозрачными записями их состояния и
 * непрозрачными ссылками выделения. Ветвления «если это такая-то область»
 * здесь нет; проверяет это не ревью, а сканер по исходникам
 * (`test/frameDomain.test.ts`), как и в headless-каркасе.
 *
 * Что каркас удерживает на всю сессию:
 *
 * - активную область — одну, потому что окно одно. Отстыковка области в
 *   отдельное окно ED-23 разрешает как удобство хоста среды, но запрещает
 *   делать её условием доступности операции; здесь нет ничего, что второго
 *   окна требовало бы, и появиться этому неоткуда: область отдаёт три узла в
 *   зоны одного скелета;
 * - запись состояния на каждую посещённую область (`state.ts`);
 * - сквозные вещи, которые ED-23 запрещает разводить по областям: выделение
 *   (`selection.ts`), запрос поиска по проекту и историю операций — последняя
 *   не заводится здесь вовсе, а берётся у сессии, где она одна (ED-18);
 * - текущий режим и идущий прогон (`preview.ts`, ED-26): «запуск и выход
 *   доступны из любой рабочей области», а значит место им там же, где
 *   переключение областей. Что именно прогоняется, каркас по-прежнему не знает
 *   — он перебирает вклады и берёт первый готовый прогонять (ED-25).
 *
 * Каркас — чистое описание: `view()` возвращает узел и ничего не рисует. Всё,
 * что требует документа, — в `mount.ts`, и потому этот модуль проверяется без
 * DOM целиком.
 */
import {
  ContributionRegistry,
  buildEditorCatalog,
  catalogDescriptions,
  describeOperations,
  type AuthoringSuspension,
  type Contribution,
  type ContributionKind,
  type ContributionReader,
  type EditorCatalog,
  type EditorSession,
  type SessionEventKind,
  type StringResources,
  type ValidationRuleContribution,
  type ViewportToolContribution,
} from '@game-mvp/editor-core';
import { children, el, type UiNode, type UiText } from '../dom/node.js';
import { defaultFieldEditors, type FieldEditor } from '../inspector/editors.js';
import {
  commandEnabled,
  paletteEntries,
  type PaletteCommand,
  type PaletteEntry,
  type SearchHit,
} from '../palette/palette.js';
import { PALETTE_ROVING_ID, paletteView } from '../palette/view.js';
import { APP_CLASS } from '../tokens/css.js';
import type { AreaSetup, AreaState, WorkspaceArea } from './area.js';
import {
  DISMISS_KEY,
  FRAME_BINDINGS,
  PALETTE_BINDING,
  REDO_BINDING,
  UNDO_BINDING,
  matchesBinding,
  sameBinding,
  type KeyStroke,
} from './keys.js';
import {
  PREVIEW_SUSPENSION_REASON,
  type EditorMode,
  type PreviewRun,
  type PreviewSource,
} from './preview.js';
import { RAIL_ROVING_ID, areaRail } from './rail.js';
import { createSelectionModel, type SelectionModel } from './selection.js';
import { areaSkeleton } from './skeleton.js';
import { createAreaStateStore } from './state.js';
import { frameTopBar } from './topBar.js';

export interface WorkspaceFrameOptions {
  /** Реестр областей. Рельс есть его представление — второго списка областей нет. */
  readonly areas: ContributionReader<WorkspaceArea>;
  readonly resources: StringResources;
  /** Сессия с одной историей на всех (ED-18, ED-23). */
  readonly session: EditorSession;
  /** С какой области начать; по умолчанию — первая в порядке реестра. */
  readonly initialAreaId?: string;
  /** Модель выделения; по умолчанию заводится своя, на сессию. */
  readonly selection?: SelectionModel;
  /**
   * Реестр редакторов поля (ED-25). Один на редактор: он уходит каждой области
   * на отрисовку, и потому вклад, зарегистрированный один раз, подхватывается
   * инспектором всех областей сразу. По умолчанию — набор, который редактор
   * везёт с собой.
   */
  readonly fieldEditors?: ContributionReader<FieldEditor>;
  /** Реестр команд палитры (ED-24, ED-25); по умолчанию пуст. */
  readonly commands?: ContributionReader<PaletteCommand>;
  /**
   * Машинный каталог редактора (ED-30) — из него палитра берёт операции. По
   * умолчанию собирается из того же, что есть у каркаса: реестра областей и
   * реестра операций сессии. Сборка, у которой есть ещё и реестры инструментов
   * и правил, подаёт свой — второго описания при этом не заводится, потому что
   * оба собираются из реестров в момент запроса.
   */
  readonly catalog?: () => EditorCatalog;
}

export interface WorkspaceFrame {
  readonly areas: ContributionReader<WorkspaceArea>;
  readonly session: EditorSession;
  /** Сквозное выделение: адресуемо снаружи, не только активной областью (ED-23). */
  readonly selection: SelectionModel;
  activeAreaId(): string;
  activate(areaId: string): void;
  /** Запись состояния области — та же самая при каждом возврате (ED-23). */
  stateOf(areaId: string): AreaState;
  /** Запрос поиска по проекту — сквозной, переключение области его не теряет. */
  searchQuery(): string;
  setSearchQuery(query: string): void;
  /** Открыта ли палитра команд (ED-24). */
  paletteOpen(): boolean;
  openPalette(): void;
  closePalette(): void;
  /** Строки палитры при текущем запросе: находки поиска, команды, операции. */
  paletteEntries(): readonly PaletteEntry[];
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
  /** Режим редактора — он же виден автору постоянно (ED-26). */
  mode(): EditorMode;
  /** Есть ли что запускать (в превью — всегда: выйти можно всегда). */
  canPreview(): boolean;
  /** Почему прогон не начался или не закончился; `null` — причин нет (ED-8). */
  previewFailure(): string | null;
  /** Запуск и выход одним действием — из любой области и без сохранения (ED-26). */
  togglePreview(): void;
  /** Выход, если прогон идёт; иначе ничего. Им же снос страницы гасит прогон. */
  stopPreview(): void;
  /**
   * Причина отказа последнего действия — видна постоянно, пока её не сменят
   * (ED-8). Каркас её не сочиняет: текст приходит от того, кто отказал.
   */
  notice(): UiText | null;
  setNotice(reason: UiText | null): void;
  /** Разбор нажатия. `true` — каркас его забрал, и вызывающему нечего делать. */
  handleKey(stroke: KeyStroke): boolean;
  /**
   * Куда каркас просит вернуть фокус после ближайшей перерисовки, и забирает
   * просьбу: она одноразовая, иначе фокус уезжал бы на каждую перерисовку.
   */
  takeFocusRequest(): string | undefined;
  view(): UiNode;
  subscribe(listener: () => void): () => void;
}

/**
 * События сессии, после которых причина прежнего отказа перестаёт быть
 * утверждением о настоящем: значения документов изменились.
 *
 * Перечислены именно они, а не «любое событие»: открытие документа, отметка о
 * сохранении и приостановка авторинга (ED-9) значений не меняют, и гасить
 * причину ими значило бы убирать её с глаз событием, к ней не относящимся, —
 * вход в превью стирал бы отказ, который всё ещё верен (ED-8).
 */
const EDITING_EVENTS: ReadonlySet<SessionEventKind> = new Set<SessionEventKind>([
  'applied',
  'extended',
  'undone',
  'redone',
  'cancelled',
]);

/** Пустой реестр: сборка, не принёсшая своего, каталогу его и отдаёт. */
function emptyReader<T extends Contribution>(kind: ContributionKind): ContributionReader<T> {
  return new ContributionRegistry<T>({ kind });
}

export function createWorkspaceFrame(options: WorkspaceFrameOptions): WorkspaceFrame {
  const { areas, resources, session } = options;
  const selection = options.selection ?? createSelectionModel();
  const states = createAreaStateStore();
  const setup: AreaSetup = { session };
  const listeners = new Set<() => void>();
  const fieldEditors = options.fieldEditors ?? defaultFieldEditors();
  const commands = options.commands ?? emptyReader<PaletteCommand>('command');
  const catalog =
    options.catalog ??
    ((): EditorCatalog =>
      buildEditorCatalog({
        contributions: {
          areas,
          viewportTools: emptyReader<ViewportToolContribution>('tool'),
          validationRules: emptyReader<ValidationRuleContribution>('rule'),
        },
        // Тот же реестр операций, что исполняет правки (ED-29), и то же
        // само-описание, что уходит внешнему потребителю (ED-30).
        operations: () => describeOperations(session.operations),
        descriptions: catalogDescriptions(resources),
      }));

  const registered = areas.all();
  const first = registered[0];
  if (first === undefined) {
    throw new Error('editor-ui: каркас без единой рабочей области показывать нечего');
  }

  let activeId = options.initialAreaId ?? first.id;
  if (!areas.has(activeId)) {
    throw new Error(`editor-ui: рабочая область "${activeId}" не зарегистрирована`);
  }

  // Реестр следит, чтобы на одну клавишу не претендовали две области, но своих
  // сочетаний каркаса он не знает: они не вклад. Область, объявившая отмену
  // или возврат фокуса, не получила бы ни одного нажатия — каркас разбирает их
  // раньше (ED-18, ED-23). Отказ вместо молчания: неработающая горячая клавиша
  // вклада обнаруживалась бы не отказом, а ненажимающейся клавишей.
  for (const area of registered) {
    const hotkey = area.hotkey;
    if (hotkey === undefined) continue;
    const taken = FRAME_BINDINGS.find((binding) => sameBinding(binding, hotkey));
    if (taken !== undefined) {
      throw new Error(
        `editor-ui: сочетание "${hotkey}" занято каркасом, область "${area.id}" его не получит`,
      );
    }
  }
  // Сочетание команды (ED-24, ED-25) проверяется так же и по той же причине,
  // что сочетание области: команда, объявившая занятое каркасом сочетание, не
  // получила бы ни одного нажатия, и обнаруживалось бы это ненажимающейся
  // клавишей, а не отказом. Реестр вкладов следит только за тем, чтобы двое
  // команд не претендовали на одно сочетание, — своих сочетаний каркаса он не
  // знает, они не вклад.
  for (const command of commands.all()) {
    const keybinding = command.keybinding;
    if (keybinding === undefined) continue;
    const takenByFrame = FRAME_BINDINGS.find((binding) => sameBinding(binding, keybinding));
    if (takenByFrame !== undefined) {
      throw new Error(
        `editor-ui: сочетание "${keybinding}" занято каркасом, команда "${command.id}" его не получит`,
      );
    }
    const takenByArea = registered.find(
      (area) => area.hotkey !== undefined && sameBinding(area.hotkey, keybinding),
    );
    if (takenByArea !== undefined) {
      throw new Error(
        `editor-ui: сочетание "${keybinding}" занято областью "${takenByArea.id}", команда "${command.id}" его не получит`,
      );
    }
  }

  let query = '';
  let palette = false;
  /** Строка палитры под подсветкой; пустая — подсвечена первая из показанных. */
  let paletteActive = '';
  let focusRequest: string | undefined;
  let mode: EditorMode = 'edit';
  let run: PreviewRun | null = null;
  /**
   * Право снять приостановку авторинга идущего прогона (ED-9). Лежит рядом с
   * самим прогоном, потому что живёт ровно столько же: снять её может только
   * тот, кто взял, и второго места, где помнят «мы в превью», не заводится.
   */
  let suspension: AuthoringSuspension | null = null;
  let previewFailure: string | null = null;
  let notice: UiText | null = null;

  // Перерисовка во время перерисовки — не оповещение, а рекурсия: область,
  // открывшая документ при заведении своей записи, оповестила бы каркас прямо
  // посреди сборки его же страницы. Собираемая страница изменение уже видит,
  // поэтому такое оповещение и гасится.
  let rendering = false;
  const notify = (): void => {
    if (rendering) return;
    for (const listener of [...listeners]) listener();
  };

  // Смена языка без перезапуска (ED-27) — это перерисовка, а не перезагрузка,
  // и подписан на неё каркас, а не каждая область по отдельности. Отписки нет
  // намеренно: каркас живёт ровно столько же, сколько ресурсы, — сессию.
  resources.onChange(notify);
  // Выделение сквозное, и поставить его может не только активная область
  // (ED-23): показать чужую правку каркас обязан и тогда.
  selection.subscribe(notify);
  // Документ изменился — страница перерисовывается, кто бы его ни изменил.
  // Операции исполнимы и без интерфейса (ED-29), и правка, пришедшая оттуда,
  // обязана быть видна так же, как своя. Перерисовка идёт на всякое событие
  // сессии: недоступность отмены и повтора она объявляет тоже (ED-26).
  //
  // Причина прежнего отказа гаснет только от правки документов: она была
  // утверждением о том их состоянии, которого уже нет, и оставленная на виду
  // отправила бы автора чинить починенное (ED-8). Перечень таких событий — в
  // `EDITING_EVENTS`.
  session.subscribe((event) => {
    if (EDITING_EVENTS.has(event.kind)) notice = null;
    notify();
  });

  const requireArea = (areaId: string): WorkspaceArea => {
    const area = areas.get(areaId);
    if (area === undefined) {
      throw new Error(`editor-ui: рабочая область "${areaId}" не зарегистрирована`);
    }
    return area;
  };

  const activate = (areaId: string): void => {
    const area = requireArea(areaId);
    if (area.id === activeId) return;
    activeId = area.id;
    notify();
  };

  const reasonOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  /**
   * Первый вклад, готовый прогонять сейчас (ED-25): каркас спрашивает реестр, а
   * не знает, у кого прогон есть. Запись состояния при этом заводится только у
   * тех вкладов, что прогон вообще объявили, — то есть у того самого, чьи
   * документы прогон и возьмёт.
   */
  const previewSource = (): PreviewSource | null => {
    for (const area of areas.all()) {
      if (area.preview === undefined) continue;
      const source = area.preview(states.of(area, setup));
      if (source.ready()) return source;
    }
    return null;
  };

  /**
   * Находки поиска по проекту (ED-24). Спрашиваются у областей: что считать
   * находкой, знает вклад, а каркас складывает ответы и добавляет к каждой
   * переход в её область — поиск сквозной (ED-23).
   *
   * Пустой запрос находок не даёт: палитра с пустым запросом показывает, что
   * редактор умеет, а не всё, что в нём открыто.
   */
  const searchResults = (): readonly SearchHit[] => {
    if (query.trim() === '') return [];
    const found: SearchHit[] = [];
    for (const area of areas.all()) {
      if (area.search === undefined) continue;
      const hits = area.search({
        query,
        state: states.of(area, setup),
        selection: selection.in(area.id),
        session,
      });
      for (const hit of hits) {
        found.push({
          ...hit,
          // Область — часть адреса находки: две области вправе назвать свои
          // находки одинаково, и подсветка в списке не должна их путать.
          id: `${area.id}/${hit.id}`,
          reveal: () => {
            activate(area.id);
            hit.reveal();
            notify();
          },
        });
      }
    }
    return found;
  };

  const frame: WorkspaceFrame = {
    areas,
    session,
    selection,
    activeAreaId: () => activeId,
    activate,
    stateOf: (areaId) => states.of(requireArea(areaId), setup),
    searchQuery: () => query,
    setSearchQuery(next) {
      if (next === query) return;
      query = next;
      // Подсветка сбрасывается вместе с запросом: строка, на которой она
      // стояла, следующим списком может и не показаться, а Enter обязан
      // исполнять видимое.
      paletteActive = '';
      // Оповещение обязательно: запрос — сквозное состояние (ED-23), и по нему
      // палитра показывает находки (ED-24). Молчащий запрос не делал бы ничего.
      notify();
    },
    paletteOpen: () => palette,
    openPalette() {
      if (palette) return;
      palette = true;
      paletteActive = '';
      // Фокус уходит в строку запроса палитры: открыть её и заставить автора
      // до неё дотянуться мышью значило бы не дать ему добраться до чего-либо
      // клавиатурой (ED-24).
      focusRequest = PALETTE_ROVING_ID;
      notify();
    },
    closePalette() {
      if (!palette) return;
      palette = false;
      // Фокус возвращается туда же, куда его возвращает отказ от начатого, — к
      // рельсу: он одинаков во всех областях.
      focusRequest = RAIL_ROVING_ID;
      notify();
    },
    paletteEntries: () =>
      paletteEntries({
        resources,
        query,
        commands,
        catalog,
        results: searchResults(),
        target: frame,
        areaId: activeId,
      }),
    // Пока идёт взаимодействие (перетаскивание, мазок кисти), сессия отменять
    // отказывается — записи, которую отменять, ещё нет (ED-18). Отказ этот
    // виден как недоступность, а не как исключение из обработчика клавиатуры:
    // недоступное показано недоступным (ED-26), и путь клавиши тот же, что путь
    // кнопки бара, — иначе Ctrl+Z посреди мазка ронял бы разбор нажатия. Само
    // взаимодействие в ответ сессии не входит намеренно: оно принадлежит
    // каркасу, он его и ведёт.
    //
    // В превью отмена и повтор недоступны потому, что их отклонит сессия:
    // приостановка авторинга (ED-9) — её состояние, и `canUndo` уже его
    // учитывает. Спрашивается поэтому она, а не режим: режим остаётся
    // индикацией для автора (ED-26), а не вторым правилом о доступности,
    // которое кто-то держал бы в согласии с первым руками.
    canUndo: () => !session.pending && session.canUndo(),
    canRedo: () => !session.pending && session.canRedo(),
    undo() {
      if (frame.canUndo() && session.undo()) notify();
    },
    redo() {
      if (frame.canRedo() && session.redo()) notify();
    },
    mode: () => mode,
    notice: () => notice,
    setNotice(reason) {
      // Та же причина второй раз — не событие: перерисовка на каждый её показ
      // сбрасывала бы фокус ради неизменившейся строки.
      if (notice === reason) return;
      notice = reason;
      notify();
    },
    canPreview: () => run !== null || previewSource() !== null,
    previewFailure: () => previewFailure,
    togglePreview() {
      if (run !== null) {
        frame.stopPreview();
        return;
      }
      const source = previewSource();
      if (source === null) return;
      // Авторинг приостанавливается ДО запуска (ED-9): `start` зовёт вход
      // вклада, и к этому моменту незакрытое взаимодействие обязано быть уже
      // снято — снимает его сама приостановка, а не вспомнивший о нём вклад.
      const taken = session.suspendAuthoring(PREVIEW_SUSPENSION_REASON);
      try {
        // Режим ставится ПОСЛЕ удавшегося запуска: прогон, не начавшийся из-за
        // сломанного документа, оставляет автора в правке с названной причиной,
        // а не в превью без прогона (ED-8).
        run = source.start();
        suspension = taken;
        previewFailure = null;
        mode = 'preview';
      } catch (error) {
        // Не начавшийся прогон запрета за собой не оставляет: иначе автор
        // остался бы в правке, где править нечем и отменить нечего.
        taken.resume();
        previewFailure = reasonOf(error);
      }
      notify();
    },
    stopPreview() {
      const current = run;
      if (current === null) return;
      const taken = suspension;
      // Режим гасится ДО остановки: вклад, возвращающий вьюпорт документам,
      // спрашивает у каркаса режим, и «ещё превью» на выходе означало бы, что
      // он подаст документы в чужой продюсер.
      run = null;
      suspension = null;
      mode = 'edit';
      try {
        current.stop();
        previewFailure = null;
      } catch (error) {
        previewFailure = reasonOf(error);
      } finally {
        // Снятие — в `finally`, по тому же основанию, по которому вклад в
        // `finally` возвращает вьюпорт документам: сорвавшийся снос прогона не
        // имеет права оставить авторинг запертым до конца сеанса (ED-9, ED-18).
        taken?.resume();
      }
      notify();
    },
    handleKey(stroke) {
      if (matchesBinding(stroke, PALETTE_BINDING)) {
        // Одно сочетание на открытие и закрытие: состояний ровно два, и второе
        // сочетание было бы вторым местом, где они перечислены.
        if (palette) frame.closePalette();
        else frame.openPalette();
        return true;
      }
      if (matchesBinding(stroke, UNDO_BINDING)) {
        frame.undo();
        return true;
      }
      if (matchesBinding(stroke, REDO_BINDING)) {
        frame.redo();
        return true;
      }
      if (stroke.key === DISMISS_KEY && !stroke.ctrl && !stroke.alt) {
        // Открытую палитру Escape гасит: всплывающее закрывается раньше, чем
        // отменяется что-либо ещё, — иначе одна клавиша делала бы два разных
        // дела в зависимости от того, куда автор смотрит.
        if (palette) {
          frame.closePalette();
          return true;
        }
        // Escape возвращает фокус к рельсу — к тому единственному месту,
        // которое одинаково во всех областях.
        focusRequest = RAIL_ROVING_ID;
        notify();
        return true;
      }
      // Команды разбираются раньше областей: команда сквозная (ED-24 — «способ
      // добраться до операции, не проходя дерево»), а горячая клавиша области
      // переключает область. Сочетание при этом занято ровно одним из них —
      // это проверено при сборке каркаса, а не порядком разбора.
      for (const command of commands.all()) {
        if (command.keybinding === undefined || !matchesBinding(stroke, command.keybinding)) {
          continue;
        }
        // Недоступная команда нажатие всё равно забирает: показана она
        // недоступной (ED-26), и отдать её сочетание области значило бы, что
        // одна клавиша делает разное в зависимости от состояния документов.
        if (commandEnabled(command, frame)) command.run(frame);
        return true;
      }
      // Сквозное разбирается раньше вкладов сознательно: сочетание отмены
      // одинаково во всех областях, и область, объявившая его своим, не должна
      // уметь отобрать его у истории (ED-23).
      for (const area of areas.all()) {
        if (area.hotkey !== undefined && matchesBinding(stroke, area.hotkey)) {
          activate(area.id);
          return true;
        }
      }
      return false;
    },
    takeFocusRequest() {
      const requested = focusRequest;
      focusRequest = undefined;
      return requested;
    },
    view() {
      const area = requireArea(activeId);
      rendering = true;
      let zones;
      try {
        zones = area.render({
          resources,
          state: states.of(area, setup),
          selection: selection.in(area.id),
          session,
          mode,
          fieldEditors,
          refresh: notify,
        });
      } finally {
        rendering = false;
      }
      const entries = palette ? frame.paletteEntries() : [];
      return el('div', {
        classes: [APP_CLASS, 'fx-frame'],
        children: children(
          frameTopBar({
            resources,
            query,
            canUndo: frame.canUndo(),
            canRedo: frame.canRedo(),
            mode,
            canPreview: frame.canPreview(),
            previewFailure: previewFailure,
            notice,
            onQuery: (next) => {
              frame.setSearchQuery(next);
              // Набранный запрос открывает палитру: показать находки больше
              // негде, а ED-24 требует от поиска именно того, чтобы по нему
              // добирались до найденного, а не только хранили строку.
              if (next.trim() !== '') frame.openPalette();
            },
            onUndo: () => {
              frame.undo();
            },
            onRedo: () => {
              frame.redo();
            },
            onPreview: () => {
              frame.togglePreview();
            },
          }),
          el('div', {
            classes: ['fx-frame__body'],
            children: [
              areaRail({
                areas: areas.all(),
                activeId,
                resources,
                onActivate: activate,
              }),
              areaSkeleton(zones, resources),
            ],
          }),
          // Палитра — последним ребёнком страницы: она всплывающее, и лежать
          // ей поверх всего, что каркас показал до неё (ED-24).
          !palette
            ? undefined
            : paletteView({
                resources,
                entries,
                query,
                activeId: paletteActive,
                onQuery: (next) => {
                  frame.setSearchQuery(next);
                },
                onActive: (id) => {
                  paletteActive = id;
                  notify();
                },
                onRun: (id) => {
                  const entry = entries.find((candidate) => candidate.id === id);
                  if (entry === undefined || entry.disabled) return;
                  // Палитра закрывается ДО исполнения: строка, сменившая
                  // область или выделение, оставила бы за собой список,
                  // собранный по прежнему состоянию.
                  frame.closePalette();
                  entry.run();
                },
                onDismiss: () => {
                  frame.closePalette();
                },
              }),
        ),
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return frame;
}
