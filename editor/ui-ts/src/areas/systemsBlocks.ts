/* eslint-disable max-lines -- baseline */
/**
 * @contribution Блочная сборка действий и выражений (ED-5) — вклад, а не часть
 * каркаса.
 *
 * ED-5: «Действия и выражения SHALL собираться визуально из блоков; на диск
 * уходит JSON-AST». Здесь — только «визуально»: чем блок является, знает модель
 * DSL пакета `@fluxus/editor-core` (`dsl/`), и ни одного правила языка этот
 * файл не заводит (ED-1).
 *
 * Что откуда берётся:
 *
 * - **какие блоки бывают** — `dslCatalog()`: закрытые наборы `actionNames`
 *   (ACT-1) и `operators` (EXPR-6) ядра. Перечня имён в интерфейсе нет;
 * - **из чего состоит блок действия** — слоты конвенции SYS-3
 *   (`CONVENTION_SLOTS`), одни и те же у всех действий. Персонального набора
 *   аргументов ядро не публикует, и таблица «действие → его аргументы» в
 *   редакторе была бы второй реализацией семантики DSL. Следствие принимается
 *   честно: автору может быть предложен слот, который выбранное действие
 *   игнорирует, — стоит он ноль, потому что незаполненный слот в документ не
 *   пишется, а что осмысленно, объясняет описание блока (ресурс `action.*`,
 *   ED-28);
 * - **что предложить в слоте** — `DslWorldView`: имена компонентов, полей,
 *   prefab'ов и их компонентов поднятого мира, то есть ровно те множества,
 *   которые принимает валидатор ядра в этом месте. Аффорданс производный,
 *   вердикт всегда за ядром (решение 5 design'а);
 * - **какие переменные видны** — `boundNamesAt`: правило связывания SYS-3.
 *   Ошибка подсказки не проходит молча — несвязанное имя отвергает
 *   `checkExpression` находкой на записи системы (ED-8).
 *
 * Чего здесь нет: проверок. Арность и литеральные позиции ядро проверяет на
 * регистрации (SYS-3, EXPR-8) — вердикт выносит `validateSystem` находкой на
 * записи системы (ED-8), а не второй проверяльщик в интерфейсе. Типы значений
 * остаются ошибкой времени вычисления (EXPR-7, SYS-9), и ответ на это — превью
 * (ED-9).
 *
 * ## Числовой литерал и Q16.16
 *
 * Числа DSL — целые: в симуляции всё либо `i32`, либо кванты Q16.16 (FP-1), и
 * дробь в JSON означала бы float в игровой математике. Поэтому дробный ввод не
 * отвергается и не округляется правилом редактора, а квантуется ЯДРОМ
 * (`fixed.fromFloat`) — той же функцией, которой это делает редактор поля
 * `fixed` в инспекторе. Второй реализации перевода в кванты здесь нет (ED-1), а
 * в документ уходит ровно то, что ядро в нём ожидает.
 */
import { fixed } from '@fluxus/core';
import {
  CONVENTION_SLOTS,
  QUERY_SLOTS,
  actionBlock,
  actionCatalog,
  boundNamesAt,
  conventionSlot,
  formatPath,
  isJsonArray,
  isJsonObject,
  operatorBlock,
  operatorCatalog,
  pathKey,
  readActionNode,
  readExpressionNode,
  type ConventionSlot,
  type DslWorldView,
  type JsonPath,
  type JsonValue,
  type NameSource,
  type OperatorArg,
  type StringResources,
} from '@fluxus/editor-core';
import { children, documentValue, el, resourceText, type UiNode } from '../dom/node.js';
import { button } from '../widgets/button.js';
import { statusChip } from '../widgets/chip.js';
import { numberField, select, textField, toggle } from '../widgets/field.js';
import { icon } from '../widgets/icon.js';

/**
 * Что блочный редактор получает на отрисовку. Правки уходят наружу тремя
 * вызовами: записать, снять, дописать в конец. Ни одного обращения к сессии
 * здесь нет — правит область зарегистрированной операцией (ED-29), а блок
 * только говорит, что и куда.
 */
export interface BlockEnvironment {
  readonly resources: StringResources;
  /** Кандидаты пикеров; `null` — сцена не поднимается, предлагать нечего. */
  readonly world: DslWorldView | null;
  /** Запись системы целиком: из неё считается область видимости `var` (SYS-3). */
  readonly system: JsonValue | undefined;
  /** Правка недоступна: превью (ED-9, ED-26) либо проект не открыт. */
  readonly disabled: boolean;
  /** Черновики палитр: место → выбранное, но ещё не поставленное имя. */
  readonly drafts: Record<string, string>;
  /** Записать значение по пути внутри записи системы. */
  set(path: JsonPath, value: JsonValue): void;
  /** Снять значение по пути внутри записи; у списка — вырезать узел. */
  remove(path: JsonPath): void;
  /** Дописать узел в конец списка по пути внутри записи. */
  append(path: JsonPath, node: JsonValue): void;
  refresh(): void;
}

/**
 * Класс строки блочного редактора. Строка блока — не строка списка: в ней лежит
 * собранный блок (карточка оператора, стопка вложенных слотов, поле с подписью
 * сверху), а высота плотного списка ей потолок, а не мерка. Правило класса
 * (`tokens/stylesheet.ts`) берёт ту же плотность тем же токеном, но `min-height`
 * вместо `height`: однострочная строка блока по-прежнему ровно плотная, а
 * вложенное перестаёт налезать на соседнее.
 */
export const BLOCK_ROW = 'fx-row--block';

/** Ключ черновика: место плюс роль — у одного места ролей бывает две. */
function draftKey(path: JsonPath, role: string): string {
  return `${pathKey(path)}#${role}`;
}

function draftOf(env: BlockEnvironment, path: JsonPath, role: string): string {
  return env.drafts[draftKey(path, role)] ?? '';
}

function setDraft(env: BlockEnvironment, path: JsonPath, role: string, value: string): void {
  env.drafts[draftKey(path, role)] = value;
  env.refresh();
}

/** Подсказка блока: ключ описания выводится из пути (ED-28), таблицы нет. */
function hint(env: BlockEnvironment, key: string): UiNode {
  const text = resourceText(env.resources, key);
  return el('button', {
    classes: ['fx-hint'],
    attrs: { type: 'button' },
    labels: { title: text, ariaLabel: text },
    children: [icon({ name: 'hint' })],
  });
}

/** Опции палитры из закрытого набора ядра: имена — идентификаторы, не подписи. */
function nameOptions(names: readonly string[]): readonly { value: string; label: ReturnType<typeof documentValue> }[] {
  return names.map((name) => ({ value: name, label: documentValue(name) }));
}

const ACTION_NAMES: readonly string[] = actionCatalog().map((block) => block.name);
const OPERATOR_NAMES: readonly string[] = operatorCatalog().map((block) => block.name);

/** Имена всех действий закрытого набора ядра — палитра блоков ED-5. */
export function actionPalette(): readonly string[] {
  return ACTION_NAMES;
}

/** Имена всех операторов закрытого набора ядра. */
export function operatorPalette(): readonly string[] {
  return OPERATOR_NAMES;
}

/** Пустое значение слота по его виду: то, чем блок ставится и ещё не заполнен. */
function emptySlotValue(slot: ConventionSlot): JsonValue {
  switch (slot.kind) {
    case 'actions':
      return [];
    case 'fields':
    case 'overrides':
    case 'query':
      return {};
    case 'expression':
      return 0;
    case 'literal':
      return '';
  }
}

/** Кандидаты имён для слота: ровно то множество, которое принимает ядро. */
function candidates(
  env: BlockEnvironment,
  source: NameSource | undefined,
  args: Readonly<Record<string, JsonValue>>,
  path: JsonPath,
): readonly string[] | null {
  // Имена области видимости считаются по месту в записи, а не по миру: тем же
  // спуском, каким их получает пикер `var` (`scope.ts`).
  if (source === 'variable') return boundNamesAt(env.system ?? null, path);
  const world = env.world;
  if (world === null || source === undefined || source === 'free') return null;
  switch (source) {
    case 'component':
      return world.componentNames;
    case 'prefab':
      return world.prefabNames;
    case 'componentField': {
      const component = args.component;
      return typeof component === 'string' ? world.fieldNames(component) : null;
    }
    case 'prefabComponent': {
      const prefab = args.prefab;
      return typeof prefab === 'string' ? world.prefabComponentNames(prefab) : null;
    }
  }
}

/**
 * Строка блока: подпись места и контрол правки. Подпись — имя из документа.
 * `at` — адрес места внутри записи: по нему строку находят и глаз, и проверка,
 * и он же тот путь, которым сюда пишет операция (ED-29).
 */
function slotRow(name: string, control: UiNode, remove: UiNode | undefined, at?: JsonPath): UiNode {
  return el('div', {
    classes: ['fx-row', BLOCK_ROW],
    attrs: { 'data-slot': name, ...(at === undefined ? {} : { 'data-at': pathKey(at) }) },
    children: children(
      el('span', { classes: ['fx-row__secondary'], text: documentValue(name) }),
      control,
      remove,
    ),
  });
}

function removeButton(env: BlockEnvironment, path: JsonPath): UiNode {
  return button({
    label: resourceText(env.resources, 'ui.action.remove'),
    variant: 'ghost',
    disabled: env.disabled,
    onPress: () => {
      env.remove(path);
    },
  });
}

// ------------------------------------------------------------- выражения

/**
 * Числовой литерал выражения. Показывается тем, что лежит в документе, — целым
 * числом квантов, — а дробный ввод квантуется ядром (см. шапку файла).
 */
function numberLiteral(env: BlockEnvironment, path: JsonPath, value: number): UiNode {
  return numberField({
    label: documentValue(formatPath(path)),
    value: documentValue(String(value)),
    readOnly: env.disabled,
    onCommit: (raw) => {
      const parsed = Number(raw.trim());
      if (raw.trim() === '' || !Number.isFinite(parsed)) return;
      env.set(path, Number.isInteger(parsed) ? parsed : fixed.fromFloat(parsed));
    },
  });
}

/**
 * Выбор оператора: им литерал становится узлом, а узел — другим узлом.
 *
 * Узел выражения — объект с ОДНИМ ключом (EXPR-1), поэтому смена оператора и
 * есть замена узла целиком. Уже собранные аргументы переезжают под новый
 * оператор: автор менял оператор, а не собранное под ним, и арность нового
 * рассудит регистрация системы, а не редактор (SYS-3).
 */
function operatorPicker(env: BlockEnvironment, path: JsonPath, value: JsonValue): UiNode {
  const node = readExpressionNode(value);
  const picker = select({
    label: resourceText(env.resources, 'ui.area.systems.operator'),
    value: draftOf(env, path, 'operator'),
    options: [
      { value: '', label: resourceText(env.resources, 'ui.area.systems.none') },
      ...nameOptions(OPERATOR_NAMES),
    ],
    disabled: env.disabled,
    onSelect: (next) => {
      if (next === '' || next === node?.operator) {
        setDraft(env, path, 'operator', next);
        return;
      }
      env.set(path, { [next]: node === undefined ? [] : [...node.args] });
      setDraft(env, path, 'operator', '');
    },
  });
  // Оболочка несёт адрес: у вложенных выражений пикеров столько же, сколько
  // узлов, и различает их место в документе, а не порядок в разметке.
  return el('div', { classes: ['fx-cluster'], attrs: { 'data-picker': pathKey(path) }, children: [picker] });
}

/**
 * Аргумент известной формы (`checkExpression`) — единственное, что ядро знает.
 *
 * `kinds` — форма аргументов ЭТОГО оператора целиком, а не только вид текущего:
 * поле сверяется со схемой того компонента, который называет соседний аргумент,
 * и место соседа берётся из каталога (`kinds.indexOf('component')`), а не из
 * знания о том, как устроен `getComponent`. Позиция, вписанная числом, была бы
 * той самой второй реализацией формы DSL, которую запрещает ED-1: каталог
 * пометит новый оператор иначе — и число разошлось бы с ним молча.
 */
function operatorArgControl(
  env: BlockEnvironment,
  kinds: readonly OperatorArg[],
  index: number,
  path: JsonPath,
  value: JsonValue,
  args: readonly JsonValue[],
): UiNode {
  const world = env.world;
  switch (kinds[index]) {
    case 'expression':
      return expressionBlock(env, path, value);
    case 'variable':
      return namePicker(env, path, value, boundNamesAt(env.system ?? null, path));
    case 'component':
      return namePicker(env, path, value, world === null ? null : world.componentNames);
    case 'field': {
      const at = kinds.indexOf('component');
      const component = at < 0 ? undefined : args[at];
      return namePicker(
        env,
        path,
        value,
        world === null || typeof component !== 'string' ? null : world.fieldNames(component),
      );
    }
    case 'eventField':
      // Реестра типов событий и их полей в ядре нет вовсе (EXPR-2): состав
      // данных задаёт эмитент, и подсказывать здесь нечем.
      return namePicker(env, path, value, null);
    case 'tag':
      // Теги объявляет контент в prefab'ах, реестра у ядра нет — как и у
      // `withTag` запроса, кандидатов здесь не бывает (EXPR-8).
      return namePicker(env, path, value, null);
    default:
      // Формы у этого места каталог не назвал: показывается выражением, как
      // любой аргумент, который ядро не структурирует.
      return expressionBlock(env, path, value);
  }
}

/** Пикер имени: выбор из кандидатов, а без них — свободный ввод. */
function namePicker(
  env: BlockEnvironment,
  path: JsonPath,
  value: JsonValue,
  names: readonly string[] | null,
): UiNode {
  const current = typeof value === 'string' ? value : '';
  const label = documentValue(pathKey(path));
  if (names === null) {
    return textField({
      label,
      value: documentValue(current),
      readOnly: env.disabled,
      onCommit: (raw) => {
        env.set(path, raw);
      },
    });
  }
  return select({
    label,
    value: current,
    options: [
      { value: '', label: resourceText(env.resources, 'ui.area.systems.none') },
      ...nameOptions(names),
    ],
    disabled: env.disabled,
    onSelect: (next) => {
      if (next !== '') env.set(path, next);
    },
  });
}

/**
 * Блок выражения (ED-5). Литерал показывается своим контролом, узел — карточкой
 * оператора с его аргументами; на диск и то и другое уходит JSON-AST.
 */
export function expressionBlock(env: BlockEnvironment, path: JsonPath, value: JsonValue): UiNode {
  const node = readExpressionNode(value);
  if (node === undefined) {
    const control =
      typeof value === 'boolean'
        ? toggle({
            label: documentValue(formatPath(path)),
            on: value,
            disabled: env.disabled,
            onChange: (next) => {
              env.set(path, next);
            },
          })
        : typeof value === 'number'
          ? numberLiteral(env, path, value)
          : textField({
              label: documentValue(formatPath(path)),
              value: documentValue(typeof value === 'string' ? value : JSON.stringify(value)),
              readOnly: env.disabled,
              onCommit: (raw) => {
                env.set(path, raw);
              },
            });
    return el('div', {
      classes: ['fx-row', BLOCK_ROW],
      attrs: { 'data-expression': pathKey(path), 'data-literal': 'true' },
      children: [control, operatorPicker(env, path, value)],
    });
  }

  const block = operatorBlock(node.operator);
  const stored = isJsonObject(value) ? value[node.operator] : undefined;
  const asList = isJsonArray(stored);
  const argPath = (index: number): JsonPath =>
    asList ? [...path, node.operator, index] : [...path, node.operator];

  const rows: UiNode[] = [];
  if (block !== undefined && !block.variadic) {
    block.args.forEach((kind, index) => {
      const at = argPath(index);
      if (index < node.args.length) {
        rows.push(
          slotRow(
            String(index),
            operatorArgControl(env, block.args, index, at, node.args[index] ?? null, node.args),
            undefined,
            at,
          ),
        );
        return;
      }
      // Аргумента ещё нет. Дописать можно только следующий: дыра в середине
      // списка в JSON не выражается.
      if (index !== node.args.length || !asList) return;
      rows.push(
        slotRow(
          String(index),
          button({
            label: resourceText(env.resources, 'ui.area.systems.addArgument'),
            variant: 'ghost',
            disabled: env.disabled,
            onPress: () => {
              env.append([...path, node.operator], kind === 'expression' ? 0 : '');
            },
          }),
          undefined,
          at,
        ),
      );
    });
  } else {
    // Литеральных позиций у оператора нет: структурировать в списке нечего, и
    // автор добавляет и убирает выражения сам. Число их рассудит регистрация.
    node.args.forEach((arg, index) => {
      const at = argPath(index);
      rows.push(
        slotRow(
          String(index),
          expressionBlock(env, at, arg),
          asList ? removeButton(env, at) : undefined,
          at,
        ),
      );
    });
    if (asList) {
      rows.push(
        el('div', {
          classes: ['fx-row', BLOCK_ROW],
          // Адрес дописывания — сам список аргументов: у вложенных выражений
          // таких кнопок столько же, сколько узлов.
          attrs: { 'data-append': pathKey([...path, node.operator]) },
          children: [
            button({
              label: resourceText(env.resources, 'ui.area.systems.addArgument'),
              variant: 'ghost',
              disabled: env.disabled,
              onPress: () => {
                env.append([...path, node.operator], 0);
              },
            }),
          ],
        }),
      );
    }
  }

  return el('div', {
    classes: ['fx-card'],
    attrs: { 'data-expression': pathKey(path), 'data-operator': node.operator },
    children: [
      el('div', {
        classes: ['fx-cluster'],
        children: children(
          statusChip({ label: documentValue(node.operator) }),
          block === undefined ? undefined : hint(env, block.descriptionKey),
          operatorPicker(env, path, value),
        ),
      }),
      ...rows,
    ],
  });
}

// ------------------------------------------------------------ карты и запрос

/** Карта «имя → выражение» (`values`/`data`/`bindings`): ключи сверяет `checkFields`. */
function fieldsBlock(
  env: BlockEnvironment,
  path: JsonPath,
  value: JsonValue,
  names: readonly string[] | null,
): UiNode {
  const map = isJsonObject(value) ? value : {};
  const draft = draftOf(env, path, 'key');
  const add = (key: string): void => {
    if (key.trim() === '') return;
    env.set([...path, key], 0);
    setDraft(env, path, 'key', '');
  };
  return el('div', {
    classes: ['fx-stack'],
    attrs: { 'data-fields': pathKey(path) },
    children: [
      ...Object.entries(map).map(([key, entry]) =>
        slotRow(
          key,
          expressionBlock(env, [...path, key], entry),
          removeButton(env, [...path, key]),
          [...path, key],
        ),
      ),
      el('div', {
        classes: ['fx-row', BLOCK_ROW],
        children: children(
          names === null
            ? textField({
                label: resourceText(env.resources, 'ui.area.systems.fieldName'),
                value: documentValue(draft),
                readOnly: env.disabled,
                onCommit: (raw) => {
                  setDraft(env, path, 'key', raw);
                },
              })
            : select({
                label: resourceText(env.resources, 'ui.area.systems.fieldName'),
                value: draft,
                options: [
                  { value: '', label: resourceText(env.resources, 'ui.area.systems.none') },
                  ...nameOptions(names.filter((name) => !Object.hasOwn(map, name))),
                ],
                disabled: env.disabled,
                onSelect: (next) => {
                  setDraft(env, path, 'key', next);
                },
              }),
          button({
            label: resourceText(env.resources, 'ui.area.systems.addField'),
            variant: 'ghost',
            disabled: env.disabled || draft.trim() === '',
            onPress: () => {
              add(draft);
            },
          }),
        ),
      }),
    ],
  });
}

/** Переопределения полей поверх prefab'а (CMD-6): компонент → карта полей. */
function overridesBlock(
  env: BlockEnvironment,
  path: JsonPath,
  value: JsonValue,
  prefab: string | undefined,
): UiNode {
  const map = isJsonObject(value) ? value : {};
  const world = env.world;
  const available =
    world === null || prefab === undefined
      ? null
      : world.prefabComponentNames(prefab).filter((name) => !Object.hasOwn(map, name));
  const draft = draftOf(env, path, 'component');
  return el('div', {
    classes: ['fx-stack'],
    attrs: { 'data-overrides': pathKey(path) },
    children: [
      ...Object.entries(map).map(([component, fields]) =>
        el('div', {
          classes: ['fx-card'],
          attrs: { 'data-override': component },
          children: [
            el('div', {
              classes: ['fx-cluster'],
              children: [
                statusChip({ label: documentValue(component) }),
                removeButton(env, [...path, component]),
              ],
            }),
            fieldsBlock(
              env,
              [...path, component],
              fields,
              world === null ? null : world.fieldNames(component),
            ),
          ],
        }),
      ),
      el('div', {
        classes: ['fx-row', BLOCK_ROW],
        children: children(
          available === null
            ? textField({
                label: resourceText(env.resources, 'ui.area.systems.componentName'),
                value: documentValue(draft),
                readOnly: env.disabled,
                onCommit: (raw) => {
                  setDraft(env, path, 'component', raw);
                },
              })
            : select({
                label: resourceText(env.resources, 'ui.area.systems.componentName'),
                value: draft,
                options: [
                  { value: '', label: resourceText(env.resources, 'ui.area.systems.none') },
                  ...nameOptions(available),
                ],
                disabled: env.disabled,
                onSelect: (next) => {
                  setDraft(env, path, 'component', next);
                },
              }),
          button({
            label: resourceText(env.resources, 'ui.action.addComponent'),
            variant: 'ghost',
            disabled: env.disabled || draft.trim() === '',
            onPress: () => {
              env.set([...path, draft], {});
              setDraft(env, path, 'component', '');
            },
          }),
        ),
      }),
    ],
  });
}

/** Список имён компонентов запроса (`all`/`any`/`not`): каждое принимает ядро. */
function componentListBlock(env: BlockEnvironment, path: JsonPath, value: JsonValue): UiNode {
  const list = isJsonArray(value) ? value : [];
  const world = env.world;
  const draft = draftOf(env, path, 'component');
  const taken = new Set(list.filter((name): name is string => typeof name === 'string'));
  return el('div', {
    classes: ['fx-stack'],
    attrs: { 'data-names': pathKey(path) },
    children: [
      ...list.map((name, index) =>
        slotRow(
          String(index),
          statusChip({ label: documentValue(typeof name === 'string' ? name : '') }),
          removeButton(env, [...path, index]),
          [...path, index],
        ),
      ),
      el('div', {
        classes: ['fx-row', BLOCK_ROW],
        children: children(
          world === null
            ? textField({
                label: resourceText(env.resources, 'ui.area.systems.componentName'),
                value: documentValue(draft),
                readOnly: env.disabled,
                onCommit: (raw) => {
                  setDraft(env, path, 'component', raw);
                },
              })
            : select({
                label: resourceText(env.resources, 'ui.area.systems.componentName'),
                value: draft,
                options: [
                  { value: '', label: resourceText(env.resources, 'ui.area.systems.none') },
                  ...nameOptions(world.componentNames.filter((name) => !taken.has(name))),
                ],
                disabled: env.disabled,
                onSelect: (next) => {
                  setDraft(env, path, 'component', next);
                },
              }),
          button({
            label: resourceText(env.resources, 'ui.action.addComponent'),
            variant: 'ghost',
            disabled: env.disabled || draft.trim() === '',
            onPress: () => {
              env.append(path, draft);
              setDraft(env, path, 'component', '');
            },
          }),
        ),
      }),
    ],
  });
}

/**
 * Блок запроса (QUERY-1): поля — вторая половина конвенции SYS-3
 * (`QUERY_SLOTS`), и обходятся они тем же способом, что слоты действия.
 */
export function queryBlock(env: BlockEnvironment, path: JsonPath, value: JsonValue): UiNode {
  const map = isJsonObject(value) ? value : {};
  const rows: UiNode[] = [];
  for (const slot of QUERY_SLOTS) {
    const at = [...path, slot.name];
    const entry = map[slot.name];
    if (entry === undefined) {
      rows.push(
        slotRow(
          slot.name,
          button({
            label: resourceText(env.resources, 'ui.area.systems.addSlot'),
            variant: 'ghost',
            disabled: env.disabled,
            onPress: () => {
              env.set(at, slot.kind === 'componentNames' ? [] : slot.kind === 'literal' ? '' : {});
            },
          }),
          undefined,
          at,
        ),
      );
      continue;
    }
    if (slot.kind === 'componentNames') {
      rows.push(slotRow(slot.name, componentListBlock(env, at, entry), removeButton(env, at), at));
      continue;
    }
    if (slot.kind === 'literal') {
      rows.push(
        slotRow(
          slot.name,
          textField({
            label: documentValue(slot.name),
            value: documentValue(typeof entry === 'string' ? entry : ''),
            readOnly: env.disabled,
            onCommit: (raw) => {
              env.set(at, raw);
            },
          }),
          removeButton(env, at),
          at,
        ),
      );
      continue;
    }
    const nested = isJsonObject(entry) ? entry : {};
    rows.push(
      slotRow(
        slot.name,
        el('div', {
          classes: ['fx-stack'],
          children: (slot.fields ?? []).map((field) =>
            slotRow(
              field,
              nested[field] === undefined
                ? button({
                    label: resourceText(env.resources, 'ui.area.systems.addSlot'),
                    variant: 'ghost',
                    disabled: env.disabled,
                    onPress: () => {
                      env.set([...at, field], 0);
                    },
                  })
                : expressionBlock(env, [...at, field], nested[field] ?? null),
              nested[field] === undefined ? undefined : removeButton(env, [...at, field]),
              [...at, field],
            ),
          ),
        }),
        removeButton(env, at),
        at,
      ),
    );
  }
  return el('div', {
    classes: ['fx-stack'],
    attrs: { 'data-query': pathKey(path) },
    children: rows,
  });
}

// ------------------------------------------------------------ блок действия

/** Слот действия по его виду. Вид приходит из конвенции, а не из имени действия. */
function slotControl(
  env: BlockEnvironment,
  slot: ConventionSlot,
  path: JsonPath,
  value: JsonValue,
  args: Readonly<Record<string, JsonValue>>,
): UiNode {
  switch (slot.kind) {
    case 'actions':
      return actionListBlock(env, path, value);
    case 'fields':
      return fieldsBlock(env, path, value, candidates(env, slot.names, args, path));
    case 'expression':
      return expressionBlock(env, path, value);
    case 'query':
      return queryBlock(env, path, value);
    case 'overrides': {
      const prefab = args.prefab;
      return overridesBlock(env, path, value, typeof prefab === 'string' ? prefab : undefined);
    }
    case 'literal':
      return namePicker(env, path, value, candidates(env, slot.names, args, path));
  }
}

/** Порядок слотов узла: конвенция сперва, аргументы вне конвенции — следом. */
function orderedArgNames(args: Readonly<Record<string, JsonValue>>): readonly string[] {
  const given = Object.keys(args);
  const known = CONVENTION_SLOTS.map((slot) => slot.name).filter((name) => given.includes(name));
  return [...known, ...given.filter((name) => !known.includes(name))];
}

/**
 * Блок одного действия (ED-4, ED-5): имя из закрытого набора, слоты конвенции и
 * палитра ненаполненных слотов. Незаполненного слота в документе нет — он
 * появляется тем, что автор его поставил.
 */
function actionNodeBlock(env: BlockEnvironment, path: JsonPath, node: JsonValue): UiNode {
  const read = readActionNode(node);
  if (read === undefined) {
    // Узел, у которого не один ключ, — не узел действия (ACT-1). О том, что это
    // такое, говорит ядро находкой; здесь его видно и его можно снять.
    return el('div', {
      classes: ['fx-card'],
      attrs: { 'data-node': pathKey(path), 'data-broken': 'true' },
      children: [
        el('span', { classes: ['fx-row__label'], text: documentValue(JSON.stringify(node)) }),
        removeButton(env, path),
      ],
    });
  }
  const block = actionBlock(read.name);
  const slots = block?.slots ?? CONVENTION_SLOTS;
  const args = read.args;
  const missing = slots.filter((slot) => !Object.hasOwn(args, slot.name));
  const draft = draftOf(env, path, 'slot');

  return el('div', {
    classes: ['fx-card'],
    attrs: { 'data-node': pathKey(path), 'data-action': read.name },
    children: [
      el('div', {
        classes: ['fx-cluster'],
        children: children(
          statusChip({ label: documentValue(read.name) }),
          block === undefined ? undefined : hint(env, block.descriptionKey),
          removeButton(env, path),
        ),
      }),
      ...orderedArgNames(args).map((name) => {
        const at = [...path, read.name, name];
        const slot = conventionSlot(name);
        // Аргумент вне конвенции ядро не структурирует, но исполняет: блок
        // несёт его выражением по тому имени, которое дал автор.
        const control =
          slot === undefined
            ? expressionBlock(env, at, args[name] ?? null)
            : slotControl(env, slot, at, args[name] ?? null, args);
        return slotRow(name, control, removeButton(env, at), at);
      }),
      ...(missing.length === 0
        ? []
        : [el('div', {
            classes: ['fx-row', BLOCK_ROW],
            children: children(
              select({
                label: resourceText(env.resources, 'ui.area.systems.slot'),
                value: draft,
                options: [
                  { value: '', label: resourceText(env.resources, 'ui.area.systems.none') },
                  ...nameOptions(missing.map((slot) => slot.name)),
                ],
                disabled: env.disabled,
                onSelect: (next) => {
                  setDraft(env, path, 'slot', next);
                },
              }),
              button({
                label: resourceText(env.resources, 'ui.area.systems.addSlot'),
                variant: 'ghost',
                disabled: env.disabled || draft === '',
                onPress: () => {
                  const slot = missing.find((candidate) => candidate.name === draft);
                  if (slot === undefined) return;
                  env.set([...path, read.name, slot.name], emptySlotValue(slot));
                  setDraft(env, path, 'slot', '');
                },
              }),
            ),
          })]),
    ],
  });
}

/**
 * Список действий (`do`/`then`/`else`) — тело блока и палитра ED-5 под ним.
 * Имена палитры — закрытый набор ядра целиком: фильтровать его по «уместности»
 * значило бы решать за ядро, что здесь можно (ED-1).
 */
export function actionListBlock(env: BlockEnvironment, path: JsonPath, value: JsonValue): UiNode {
  const list = isJsonArray(value) ? value : [];
  const draft = draftOf(env, path, 'action');
  return el('div', {
    classes: ['fx-stack'],
    attrs: { 'data-actions': pathKey(path) },
    children: [
      ...list.map((node, index) => actionNodeBlock(env, [...path, index], node)),
      el('div', {
        classes: ['fx-row', BLOCK_ROW],
        children: children(
          select({
            label: resourceText(env.resources, 'ui.area.systems.action'),
            value: draft,
            options: [
              { value: '', label: resourceText(env.resources, 'ui.area.systems.none') },
              ...nameOptions(ACTION_NAMES),
            ],
            disabled: env.disabled,
            onSelect: (next) => {
              setDraft(env, path, 'action', next);
            },
          }),
          button({
            label: resourceText(env.resources, 'ui.area.systems.addAction'),
            variant: 'ghost',
            disabled: env.disabled || draft === '',
            onPress: () => {
              // Узел ставится пустым: `{ имя: {} }` — блок, который автор только
              // что поставил и ещё не заполнил (ACT-1). Слоты он добавит сам.
              env.append(path, { [draft]: {} });
              setDraft(env, path, 'action', '');
            },
          }),
        ),
      }),
    ],
  });
}
