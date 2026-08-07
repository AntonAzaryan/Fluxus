/**
 * Точка входа веб-приложения редактора (ED-12, веб-среда). Здесь только
 * монтирование корня и постановка таблицы стилей визуального языка: всё
 * остальное — каркас областей и вклады — приходит реестрами (ED-25), а не
 * вызовами из этого файла.
 *
 * Пока каркаса нет, монтируется контрольный случай визуального языка (ED-22):
 * страница, на которой плотность инспектора на сорок с лишним строк не
 * утверждается словами, а видна. Задача W2-2 заменит её каркасом областей.
 */
import {
  TOKEN_SCOPE_CLASS,
  installStylesheet,
  mountEditorRoot,
  renderInto,
  uiResources,
} from '../src/index.js';
import {
  SAMPLE_DESCRIPTIONS,
  controlCasePage,
  initialGalleryState,
} from '../src/gallery/controlCase.js';

const root = mountEditorRoot(document);
installStylesheet(document);
// Корень — область действия токенов: всё, что красит хром, лежит внутри неё,
// и только вьюпорт из неё вычтен (ED-22).
root.classList.add(TOKEN_SCOPE_CLASS);

const resources = uiResources('ru', SAMPLE_DESCRIPTIONS);
const state = initialGalleryState();

function draw(): void {
  renderInto(root, controlCasePage(resources, state, draw));
}

resources.onChange(draw);
draw();
