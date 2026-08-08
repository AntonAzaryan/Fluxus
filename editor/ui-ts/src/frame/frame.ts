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
import type { ContributionReader, EditorSession, StringResources } from '@game-mvp/editor-core';
import { el, type UiNode } from '../dom/node.js';
import { APP_CLASS } from '../tokens/css.js';
import type { AreaSetup, AreaState, WorkspaceArea } from './area.js';
import {
  DISMISS_KEY,
  FRAME_BINDINGS,
  REDO_BINDING,
  UNDO_BINDING,
  matchesBinding,
  sameBinding,
  type KeyStroke,
} from './keys.js';
import type { EditorMode, PreviewRun, PreviewSource } from './preview.js';
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

export function createWorkspaceFrame(options: WorkspaceFrameOptions): WorkspaceFrame {
  const { areas, resources, session } = options;
  const selection = options.selection ?? createSelectionModel();
  const states = createAreaStateStore();
  const setup: AreaSetup = { session };
  const listeners = new Set<() => void>();

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
  let query = '';
  let focusRequest: string | undefined;
  let mode: EditorMode = 'edit';
  let run: PreviewRun | null = null;
  let previewFailure: string | null = null;

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
  // обязана быть видна так же, как своя.
  session.subscribe(notify);

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

  const frame: WorkspaceFrame = {
    areas,
    session,
    selection,
    activeAreaId: () => activeId,
    activate,
    stateOf: (areaId) => states.of(requireArea(areaId), setup),
    searchQuery: () => query,
    setSearchQuery(next) {
      // Без оповещения: запрос — состояние сессии, а не повод перерисовать
      // страницу. Показывать по нему результаты будет палитра (W2-3).
      query = next;
    },
    // Пока идёт взаимодействие (перетаскивание, мазок кисти), сессия отменять
    // отказывается — записи, которую отменять, ещё нет (ED-18). Отказ этот
    // виден как недоступность, а не как исключение из обработчика клавиатуры:
    // недоступное показано недоступным (ED-26), и путь клавиши тот же, что путь
    // кнопки бара, — иначе Ctrl+Z посреди мазка ронял бы разбор нажатия.
    //
    // В превью отмена и повтор недоступны по той же причине, по какой недоступны
    // инструменты: это операции авторинга, а ED-9 запрещает их на время прогона.
    canUndo: () => mode === 'edit' && !session.pending && session.canUndo(),
    canRedo: () => mode === 'edit' && !session.pending && session.canRedo(),
    undo() {
      if (frame.canUndo() && session.undo()) notify();
    },
    redo() {
      if (frame.canRedo() && session.redo()) notify();
    },
    mode: () => mode,
    canPreview: () => run !== null || previewSource() !== null,
    previewFailure: () => previewFailure,
    togglePreview() {
      if (run !== null) {
        frame.stopPreview();
        return;
      }
      const source = previewSource();
      if (source === null) return;
      try {
        // Режим ставится ПОСЛЕ удавшегося запуска: прогон, не начавшийся из-за
        // сломанного документа, оставляет автора в правке с названной причиной,
        // а не в превью без прогона (ED-8).
        run = source.start();
        previewFailure = null;
        mode = 'preview';
      } catch (error) {
        previewFailure = reasonOf(error);
      }
      notify();
    },
    stopPreview() {
      const current = run;
      if (current === null) return;
      // Режим гасится ДО остановки: вклад, возвращающий вьюпорт документам,
      // спрашивает у каркаса режим, и «ещё превью» на выходе означало бы, что
      // он подаст документы в чужой продюсер.
      run = null;
      mode = 'edit';
      try {
        current.stop();
        previewFailure = null;
      } catch (error) {
        previewFailure = reasonOf(error);
      }
      notify();
    },
    handleKey(stroke) {
      if (matchesBinding(stroke, UNDO_BINDING)) {
        frame.undo();
        return true;
      }
      if (matchesBinding(stroke, REDO_BINDING)) {
        frame.redo();
        return true;
      }
      if (stroke.key === DISMISS_KEY && !stroke.ctrl && !stroke.alt) {
        // Escape возвращает фокус к рельсу — к тому единственному месту,
        // которое одинаково во всех областях. Гашение всплывающего (палитра,
        // подсказка) — за тем, кто его показал, и до каркаса эта клавиша тогда
        // не доходит.
        focusRequest = RAIL_ROVING_ID;
        notify();
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
          refresh: notify,
        });
      } finally {
        rendering = false;
      }
      return el('div', {
        classes: [APP_CLASS, 'fx-frame'],
        children: [
          frameTopBar({
            resources,
            query,
            canUndo: frame.canUndo(),
            canRedo: frame.canRedo(),
            mode,
            canPreview: frame.canPreview(),
            previewFailure: previewFailure,
            onQuery: (next) => {
              frame.setSearchQuery(next);
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
        ],
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
