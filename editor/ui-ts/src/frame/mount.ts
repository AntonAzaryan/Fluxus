/**
 * Единственное место каркаса, которому нужен документ среды: отрисовка,
 * клавиатура и фокус.
 *
 * Отрисовка тотальная — страница строится заново на каждое изменение.
 * Реактивности в пакете нет намеренно (ноль новых зависимостей), и за это
 * платится ровно одним: после замены поддерева фокус клавиатуры оказывается на
 * `body`. Поэтому здесь же живёт его возврат — по пометке `data-roving`
 * контейнера, в котором фокус был. Без возврата клавиатурный обход рассыпается
 * на первом же нажатии стрелки: строка выделяется, а фокус уезжает в начало
 * страницы.
 *
 * Возврат этот покрывает ровно roving-контейнеры — списки и рельс, то есть то,
 * ради чего он и заведён. Фокус на одиночном элементе вне такого контейнера
 * (кнопка бара, строка поиска, кнопка на поверхности правки) перерисовку не
 * переживает: у одиночного элемента нет устойчивой приметы, по которой его
 * можно найти в заново построенном дереве, и приметы этой пока никто не даёт.
 * Названо это здесь, а не подразумевается: правка поля инспектора (W2-3) идёт
 * ровно этим путём — операция, оповещение, полная перерисовка, — и приметой
 * фокусируемых элементов придётся заняться там, иначе ввод в поле будет
 * прерываться на каждом подтверждении.
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

export function mountWorkspaceFrame(doc: Document, frame: WorkspaceFrame): MountedFrame {
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

  doc.addEventListener('keydown', onKeyDown);
  const unsubscribes = [frame.subscribe(draw)];
  draw();

  return {
    root,
    dispose() {
      doc.removeEventListener('keydown', onKeyDown);
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
  };
}
