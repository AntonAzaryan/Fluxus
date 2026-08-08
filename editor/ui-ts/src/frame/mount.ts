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
 * Клавиатура слушается на документе, а не на корне: горячая клавиша области
 * (ED-23) и отмена операции (ED-18) обязаны срабатывать независимо от того,
 * где сейчас фокус, — иначе «сквозная история» перестаёт быть сквозной ровно
 * тогда, когда автор стоит в поле ввода.
 */
import { renderInto } from '../dom/render.js';
import { ROVING_ATTR } from '../dom/roving.js';
import { installStylesheet } from '../tokens/stylesheet.js';
import { TOKEN_SCOPE_CLASS } from '../tokens/css.js';
import { mountEditorRoot } from '../root.js';
import type { WorkspaceFrame } from './frame.js';
import { keyStrokeOf } from './keys.js';
import { createCoalescingRedraw, type RedrawSchedule } from './redraw.js';

export interface MountedFrame {
  readonly root: HTMLElement;
  /** Снимает подписки и слушателя клавиатуры. */
  dispose(): void;
}

/** Контейнер, в котором сейчас фокус, — по нему фокус и возвращается. */
function focusedContainer(doc: Document): string | undefined {
  const active = doc.activeElement;
  const container = active === null ? null : active.closest(`[${ROVING_ATTR}]`);
  return container?.getAttribute(ROVING_ATTR) ?? undefined;
}

/** Единственная остановка Tab внутри контейнера — она же место фокуса. */
function restoreFocus(root: ParentNode, containerId: string | undefined): void {
  if (containerId === undefined) return;
  const target = root.querySelector(`[${ROVING_ATTR}="${containerId}"] [tabindex="0"]`);
  if (target instanceof HTMLElement) target.focus();
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

  const onKeyDown = (event: KeyboardEvent): void => {
    if (frame.handleKey(keyStrokeOf(event))) event.preventDefault();
  };

  // Оповещений об одной авторской порции работы приходит несколько (пакет по
  // мультивыделению — оповещение на запись), и отрисовка сводит их в одну
  // (`redraw.ts`). Первая сборка при этом синхронна: страница обязана
  // существовать к возврату из монтирования.
  const redraw = createCoalescingRedraw(draw, options.schedule);

  doc.addEventListener('keydown', onKeyDown);
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
      doc.removeEventListener('keydown', onKeyDown);
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
  };
}
