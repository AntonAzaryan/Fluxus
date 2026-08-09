/**
 * Единственное место каркаса, которому нужен документ среды: отрисовка,
 * клавиатура и фокус.
 *
 * Отрисовка тотальная — страница строится заново на каждое изменение, — и
 * потому сведённая: оповещений об одной авторской порции работы приходит
 * несколько, а собирается страница по ним один раз (`redraw.ts`).
 * Реактивности в пакете нет намеренно (ноль новых зависимостей), и за это
 * платится ровно одним: после замены поддерева фокус клавиатуры оказывается на
 * `body`. Поэтому здесь же живёт его возврат — по пометке `data-roving`
 * контейнера, в котором фокус был. Без возврата клавиатурный обход рассыпается
 * на первом же нажатии стрелки: строка выделяется, а фокус уезжает в начало
 * страницы.
 *
 * Возврат этот покрывает ровно roving-контейнеры — списки, рельс и палитру
 * команд, то есть то, ради чего он и заведён. Фокус на одиночном элементе вне
 * такого контейнера (кнопка бара, строка поиска, кнопка на поверхности правки)
 * перерисовку не переживает: у одиночного элемента нет устойчивой приметы, по
 * которой его можно найти в заново построенном дереве.
 *
 * Палитра (ED-24) под это подстроена и потому набор в ней не прерывается: она
 * объявляет себя roving-контейнером, а единственная её остановка Tab — строка
 * запроса, и после каждой пересборки фокус возвращается ровно туда. Поле
 * инспектора остаётся одиночным элементом сознательно: границей его правки
 * служит подтверждение ввода (`change`, ED-18 — одна операция на одно
 * взаимодействие), то есть перерисовка случается тогда, когда автор из поля уже
 * вышел. Приметой фокусируемых полей придётся заняться в тот день, когда
 * появится контрол, пишущий в документ по ходу ввода, а не по его завершении.
 *
 * ## Порядок разбора нажатия (ED-32)
 *
 * Клавиатура слушается на документе, а не на корне: горячая клавиша области
 * (ED-23) и отмена операции (ED-18) обязаны срабатывать независимо от того,
 * где сейчас фокус, — иначе «сквозная история» перестаёт быть сквозной ровно
 * тогда, когда автор стоит в поле ввода. Подписок на документе поэтому две, и
 * они и есть три ступени порядка ED-32:
 *
 * - **захват** — сквозные сочетания каркаса. Они обязаны срабатывать и из поля
 *   ввода, поэтому идут раньше всех;
 * - **виджет под фокусом** — между двумя подписками. Дерево, список и палитра
 *   потребляют своё нажатие вызовом `preventDefault` (`widgets/rows.ts`,
 *   `dom/roving.ts`), и признак «потреблено» тем самым уже существует;
 * - **всплытие** — клавиши активной области, и только если нажатие не
 *   потреблено. Спрашивать вместо этого `document.activeElement` и сверяться со
 *   списком виджетов нельзя: список пришлось бы держать рядом с виджетами, и
 *   расходился бы он с ними ровно так же, как ручная таблица «поле → ключ»
 *   в ED-28.
 *
 * Сам порядок записан функцией `areaGetsKey` (`keys.ts`), а не тремя условиями
 * по месту: без DOM его иначе не проверить, а «стрелка в дереве камеру не
 * двигает» — утверждение о порядке, а не о том, куда уехал фокус. Здесь
 * остаётся только подписка и перевод события среды в её аргументы.
 *
 * Отпускание и потеря фокуса окном идут мимо порядка: «клавиша больше не
 * зажата» — утверждение о клавиатуре, а не просьба что-то сделать, и
 * пропущенное оно оставило бы область панорамирующей вечно.
 */
import { renderInto } from '../dom/render.js';
import { ROVING_ATTR } from '../dom/roving.js';
import { installStylesheet } from '../tokens/stylesheet.js';
import { TOKEN_SCOPE_CLASS } from '../tokens/css.js';
import { mountEditorRoot } from '../root.js';
import type { WorkspaceFrame } from './frame.js';
import { areaGetsKey, keyStrokeOf, type KeyTarget } from './keys.js';
import { SURFACE_FOCUS_ID } from './skeleton.js';
import { createCoalescingRedraw, type RedrawSchedule } from './redraw.js';

export interface MountedFrame {
  readonly root: HTMLElement;
  /** Снимает подписки и слушателя клавиатуры. */
  dispose(): void;
}

/**
 * Контейнер, в котором сейчас фокус, — по нему фокус и возвращается. Поверхность
 * правки roving-контейнером не является, но местом фокуса по умолчанию является
 * (ED-32), и перерисовка не должна выбрасывать из неё автора так же, как не
 * должна выбрасывать из списка.
 */
function focusedContainer(doc: Document): string | undefined {
  const active = doc.activeElement;
  if (active === null) return undefined;
  const container = active.closest(`[${ROVING_ATTR}]`);
  if (container !== null) return container.getAttribute(ROVING_ATTR) ?? undefined;
  return active.id === SURFACE_FOCUS_ID ? SURFACE_FOCUS_ID : undefined;
}

/**
 * Единственная остановка Tab внутри контейнера — она же место фокуса. Место по
 * умолчанию контейнером не является и адресуется своим идентификатором.
 */
function restoreFocus(root: ParentNode, containerId: string | undefined): void {
  if (containerId === undefined) return;
  const target =
    root.querySelector(`[${ROVING_ATTR}="${containerId}"] [tabindex="0"]`) ??
    root.querySelector(`#${containerId}`);
  if (target instanceof HTMLElement) target.focus();
}

/** Цель события в том виде, в каком её читает порядок разбора (`keys.ts`). */
function keyTarget(target: EventTarget | null): KeyTarget | null {
  if (!(target instanceof Element)) return null;
  return {
    tagName: target.tagName,
    editable: target instanceof HTMLElement && target.isContentEditable,
  };
}

export interface MountOptions {
  /**
   * Чем откладывается сведённая отрисовка (`redraw.ts`). Подменяется тем, кто
   * держит свой кадровый цикл; по умолчанию — микрозадача.
   */
  readonly schedule?: RedrawSchedule;
}

export function mountWorkspaceFrame(
  doc: Document,
  frame: WorkspaceFrame,
  options: MountOptions = {},
): MountedFrame {
  const root = mountEditorRoot(doc);
  installStylesheet(doc);
  // Корень — область действия токенов: всё, что красит хром, лежит внутри неё,
  // и только вьюпорт из неё вычтен (ED-22).
  root.classList.add(TOKEN_SCOPE_CLASS);

  const draw = (): void => {
    const previous = focusedContainer(doc);
    renderInto(root, frame.view());
    restoreFocus(root, frame.takeFocusRequest() ?? previous);
  };

  // Ступень первая (ED-32): сквозные сочетания каркаса, на фазе захвата.
  const onFrameKey = (event: KeyboardEvent): void => {
    if (frame.handleKey(keyStrokeOf(event))) event.preventDefault();
  };

  // Ступень третья: клавиши активной области, на всплытии. Ступень вторая —
  // виджет под фокусом — стоит между ними сама: она уже вызвала
  // `preventDefault`, и признак этот здесь и читается.
  const onAreaKey = (event: KeyboardEvent): void => {
    const gate = {
      defaultPrevented: event.defaultPrevented,
      target: keyTarget(event.target),
      ctrl: event.ctrlKey || event.metaKey,
      shift: event.shiftKey,
      alt: event.altKey,
    };
    if (!areaGetsKey(gate)) return;
    if (frame.handleAreaKey({ code: event.code, phase: 'down', repeat: event.repeat })) {
      event.preventDefault();
    }
  };

  // Отпускание области отдаётся без разбора порядка: «клавиша больше не
  // зажата» — утверждение о клавиатуре, а не просьба что-то сделать, и
  // пропущенное оно оставило бы область панорамирующей навсегда.
  const onKeyUp = (event: KeyboardEvent): void => {
    frame.handleAreaKey({ code: event.code, phase: 'up', repeat: false });
  };
  const onBlur = (): void => {
    frame.handleAreaKey({ code: '', phase: 'blur', repeat: false });
  };

  // Оповещений об одной авторской порции работы приходит несколько (пакет по
  // мультивыделению — оповещение на запись), и отрисовка сводит их в одну
  // (`redraw.ts`). Первая сборка при этом синхронна: страница обязана
  // существовать к возврату из монтирования.
  const redraw = createCoalescingRedraw(draw, options.schedule);

  doc.addEventListener('keydown', onFrameKey, true);
  doc.addEventListener('keydown', onAreaKey);
  doc.addEventListener('keyup', onKeyUp);
  const window_ = doc.defaultView;
  window_?.addEventListener('blur', onBlur);
  const unsubscribes = [
    frame.subscribe(() => {
      redraw.request();
    }),
  ];
  draw();

  return {
    root,
    dispose() {
      redraw.cancel();
      // Прогон живёт дольше страницы (ED-9: у него свой поток), и снос страницы
      // обязан его закончить — иначе воркер переживает окно, которое его завело.
      frame.stopPreview();
      doc.removeEventListener('keydown', onFrameKey, true);
      doc.removeEventListener('keydown', onAreaKey);
      doc.removeEventListener('keyup', onKeyUp);
      window_?.removeEventListener('blur', onBlur);
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
  };
}
