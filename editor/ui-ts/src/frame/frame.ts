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
 *   не заводится здесь вовсе, а берётся у сессии, где она одна (ED-18).
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
  REDO_BINDING,
  UNDO_BINDING,
  matchesBinding,
  type KeyStroke,
} from './keys.js';
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
  let query = '';
  let focusRequest: string | undefined;

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
    canUndo: () => session.canUndo(),
    canRedo: () => session.canRedo(),
    undo() {
      if (session.undo()) notify();
    },
    redo() {
      if (session.redo()) notify();
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
            canUndo: session.canUndo(),
            canRedo: session.canRedo(),
            onQuery: (next) => {
              frame.setSearchQuery(next);
            },
            onUndo: () => {
              frame.undo();
            },
            onRedo: () => {
              frame.redo();
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
