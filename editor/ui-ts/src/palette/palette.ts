/**
 * Палитра команд и поиск по проекту (ED-24): «способ добраться до объекта,
 * системы, ассета и операции, не проходя дерево навигатора: при сотнях
 * документов дерево перестаёт быть навигацией».
 *
 * Записей в палитре три рода, и все три приходят из реестров, а не из списка,
 * который кто-то поддерживает руками:
 *
 * - **находки поиска** — их приносят рабочие области: что считать находкой и
 *   что значит «открыть её напрямую», знает вклад, а не каркас (ED-25). Каркас
 *   спрашивает области и складывает ответы;
 * - **команды** — вклад «команда палитры» из ED-25. Зарегистрировали — команда
 *   в палитре; каркас при этом не правится;
 * - **операции авторинга** — из машинного каталога ED-30, то есть из того же
 *   описания, которое получает внешний потребитель. Отдельного перечня
 *   операций у палитры нет намеренно: он разошёлся бы с реестром на первой же
 *   новой операции, а требование говорит прямо — «она появляется и в
 *   интерфейсе, и в машинном каталоге; отдельно каталог не правится».
 *
 * ## Почему операция бывает показана недоступной
 *
 * У операции есть параметры (ED-30 требует их в каталоге), и собрать их из
 * одного имени в списке нечем: чем адресована правка и что в неё положить —
 * знание о редактируемом, а каркас его не имеет и иметь не должен (ED-25).
 * Поэтому операция исполняется палитрой ровно тогда, когда её берёт на себя
 * зарегистрированная команда (поле `operation` вклада ED-25) — команда знает,
 * откуда взять параметры. Операция без такой команды из палитры видна, но
 * показана недоступной: элемент, который нельзя применить, обязан быть видимо
 * недоступным, а не молча не срабатывать (ED-26).
 *
 * В превью недоступны все операции авторинга разом — по тому же ED-26 и по
 * тому же основанию, по которому там недоступны инструменты (ED-9).
 */
import type {
  ContributionReader,
  EditorCatalog,
  EditorSession,
  PaletteCommandContribution,
  StringResources,
} from '@game-mvp/editor-core';
import { documentValue, resourceText, type UiText } from '../dom/node.js';
import type { EditorMode } from '../frame/preview.js';
import type { SelectionModel } from '../frame/selection.js';
import type { IconName } from '../widgets/icon.js';

/**
 * Что команде доступно из каркаса. Узко и намеренно: сессия (а в ней — реестр
 * операций и одна на всех история), сквозное выделение и переключение областей.
 * Ничего доменного здесь нет и появиться не может — команда, которой нужно
 * больше, берёт это у своего вклада, а не у каркаса.
 */
export interface CommandTarget {
  readonly session: EditorSession;
  readonly selection: SelectionModel;
  activeAreaId(): string;
  activate(areaId: string): void;
}

/** Команда палитры — вклад ED-25. */
export interface PaletteCommand extends PaletteCommandContribution {
  /** Ключ ресурса подписи (ED-27): текста в коде вклада нет. */
  readonly labelKey: string;
  readonly icon?: IconName;
  /** Применима ли команда сейчас; `false` — показана недоступной (ED-26). */
  enabled?(target: CommandTarget): boolean;
  run(target: CommandTarget): void;
}

/**
 * Находка поиска по проекту. `reveal` — «открыть напрямую» в понимании той
 * области, которая находку принесла: каркас не знает, что стоит за строкой, и
 * переключение на область делает сам.
 */
export interface SearchHit {
  readonly id: string;
  /** Имя найденного — идентификатор документа или записи, он не локализуется (ED-27). */
  readonly label: UiText;
  readonly detail?: UiText;
  readonly icon?: IconName;
  reveal(): void;
}

export type PaletteEntryKind = 'result' | 'command' | 'operation';

/** Строка палитры — то, из чего собран её список. */
export interface PaletteEntry {
  readonly id: string;
  readonly kind: PaletteEntryKind;
  readonly label: UiText;
  /** Машинное имя строки: id операции, адрес найденного. */
  readonly detail?: UiText;
  /**
   * Сочетание клавиш команды. Ресурсом оно не является (подписи приходят из
   * ресурсов, а `F2` не подпись), поэтому идёт тем же путём, что имена
   * документов, — как текст, которого локаль не касается.
   */
  readonly keys?: UiText;
  readonly icon?: IconName;
  /** Показана, но неприменима (ED-26): у операции нет команды, идёт превью. */
  readonly disabled: boolean;
  run(): void;
}

export interface PaletteSpec {
  readonly resources: StringResources;
  /** Запрос поиска — сквозное состояние сессии (ED-23). */
  readonly query: string;
  readonly commands: ContributionReader<PaletteCommand>;
  /** Машинный каталог ED-30: из него палитра берёт операции. */
  readonly catalog: () => EditorCatalog;
  readonly results: readonly SearchHit[];
  readonly target: CommandTarget;
  /** Область, активная сейчас: команда, объявившая области, вне них не показана. */
  readonly areaId: string;
  /** Режим редактора (ED-26): в превью операции авторинга недоступны (ED-9). */
  readonly mode: EditorMode;
}

/**
 * Совпадение с запросом — вхождение подстроки без учёта регистра по всем
 * видимым текстам строки. Ни ранжирования, ни нечёткого поиска: они принимают
 * решения за автора, а первое, что от поиска требуется, — найти документ по
 * куску его имени (ED-24).
 */
export function matchesQuery(query: string, ...texts: readonly (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return texts.some((text) => text !== undefined && text.toLowerCase().includes(needle));
}

function commandEntry(spec: PaletteSpec, command: PaletteCommand): PaletteEntry {
  const label = resourceText(spec.resources, command.labelKey);
  const enabled = command.enabled === undefined || command.enabled(spec.target);
  return {
    id: command.id,
    kind: 'command',
    label,
    detail: documentValue(command.id),
    ...(command.keybinding === undefined ? {} : { keys: documentValue(command.keybinding) }),
    ...(command.icon === undefined ? {} : { icon: command.icon }),
    disabled: !enabled,
    run: () => {
      command.run(spec.target);
    },
  };
}

/** Команды, доступные в этой области: `areas` не объявлены — команда всюду. */
function commandsHere(spec: PaletteSpec): readonly PaletteCommand[] {
  return spec.commands
    .all()
    .filter((command) => command.areas === undefined || command.areas.includes(spec.areaId));
}

function operationEntries(spec: PaletteSpec): readonly PaletteEntry[] {
  const here = commandsHere(spec);
  const preview = spec.mode === 'preview';
  return spec.catalog().operations.map((operation): PaletteEntry => {
    // Команда, взявшая операцию на себя, знает, откуда брать её параметры.
    const command = here.find((candidate) => candidate.operation === operation.id);
    const enabled =
      !preview &&
      command !== undefined &&
      (command.enabled === undefined || command.enabled(spec.target));
    return {
      id: operation.id,
      kind: 'operation',
      // Подпись операции — та же строка, что видит машинный потребитель
      // каталога, только на локали автора: второго набора формулировок ED-30
      // не допускает.
      label: resourceText(spec.resources, operation.descriptionKey),
      detail: documentValue(operation.id),
      disabled: !enabled,
      run: () => {
        if (enabled && command !== undefined) command.run(spec.target);
      },
    };
  });
}

function resultEntry(hit: SearchHit): PaletteEntry {
  return {
    id: `hit:${hit.id}`,
    kind: 'result',
    label: hit.label,
    ...(hit.detail === undefined ? {} : { detail: hit.detail }),
    ...(hit.icon === undefined ? {} : { icon: hit.icon }),
    disabled: false,
    run: () => {
      hit.reveal();
    },
  };
}

/**
 * Строки палитры в порядке «найденное — команды — операции». Порядок этот и
 * есть ответ на вопрос, зачем палитра открыта: с непустым запросом ищут
 * материал, а команды и операции остаются под рукой ниже.
 */
export function paletteEntries(spec: PaletteSpec): readonly PaletteEntry[] {
  const match = (entry: PaletteEntry): boolean =>
    matchesQuery(spec.query, entry.label.value, entry.detail?.value, entry.id);
  return [
    ...spec.results.map(resultEntry),
    ...commandsHere(spec).map((command) => commandEntry(spec, command)),
    ...operationEntries(spec),
  ].filter(match);
}
