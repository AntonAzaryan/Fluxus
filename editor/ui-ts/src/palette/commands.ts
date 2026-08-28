/**
 * Команды, которыми владеет сама оболочка редактора, — вклады реестра (ED-25),
 * а не ветки каркаса.
 *
 * ED-24 требует от палитры быть способом добраться до операции мимо дерева
 * навигатора, а ED-25 говорит, чем команда добавляется: регистрацией вклада.
 * Пустой реестр делает первое требование мёртвым, и здесь он наполняется тем,
 * что оболочка действительно умеет сама: открыть проект, сохранить, сменить
 * язык, отменить и повторить, перейти в область, запустить и остановить прогон.
 *
 * Ни одного доменного имени редактируемого здесь нет и быть не может: всё, чем
 * эти команды пользуются, — `CommandTarget`, то есть каркас. Открытие проекта и
 * сохранение — исключение только на вид: они приходят функциями от сборки,
 * которая знает, ЧТО открывать и какие документы держать вместе (ED-19, ED-21),
 * а этот модуль знает лишь, что такие действия существуют.
 *
 * ## Почему переход в область — команда на область, а не одна с параметром
 *
 * Реестр областей перебирается здесь же, и на каждую заводится своя команда.
 * Так новая область появляется в палитре без правки этого файла (ED-25:
 * «добавление вклада MUST NOT требовать изменений в уже зарегистрированных
 * вкладах и в каркасе»), а автор ищет её по имени области, а не по имени
 * команды с аргументом.
 *
 * ## Почему у отмены и повтора нет сочетания
 *
 * Их сочетания принадлежат каркасу (`keys.ts`, ED-18, ED-23) и разбираются
 * раньше вкладов. Объявить их здесь значило бы объявить сочетание, которого
 * команда никогда не получит; каркас на такое объявление и отвечает отказом.
 */
import type { ContributionRegistry, StringResources } from '@fluxus/editor-core';
import { documentValue } from '../dom/node.js';
import type { WorkspaceArea } from '../frame/area.js';
import type { CommandTarget, PaletteCommand } from './palette.js';
import { reasonOf } from '../reason.js';

/** Идентификаторы команд оболочки — по ним они и адресуются в каталоге ED-30. */
export const SHELL_COMMANDS = {
  openProject: 'command.project.open',
  save: 'command.project.save',
  undo: 'command.history.undo',
  redo: 'command.history.redo',
  preview: 'command.preview.toggle',
  /** Префикс команд перехода: полный id — `command.area.<id области>`. */
  areaPrefix: 'command.area.',
  /** Префикс команд языка: полный id — `command.locale.<локаль>`. */
  localePrefix: 'command.locale.',
} as const;

/** Локали, между которыми переключается редактор (ED-27): обе равноправны. */
const LOCALES: readonly (readonly [string, string])[] = [
  ['ru', 'ui.locale.ru'],
  ['en', 'ui.locale.en'],
];

/**
 * Действие оболочки, которое может отказать: открытие проекта и сохранение оба
 * ходят в дерево контента. Отказ — причина, а не молчание (ED-8).
 */
export type ShellAction = (target: CommandTarget) => Promise<void> | void;

export interface ShellCommandOptions {
  /** Ресурсы: ими же переключается язык без перезапуска (ED-27). */
  readonly resources: StringResources;
  /**
   * Реестр областей (ED-23): на каждую заводится команда перехода. Тот же
   * реестр, что видит рельс, — второго списка областей не заводится.
   */
  readonly areas: ContributionRegistry<WorkspaceArea> | { all(): readonly WorkspaceArea[] };
  /** Чем открывается проект (ED-12); нет — команда не регистрируется. */
  readonly open?: ShellAction;
  /** Чем сохраняется (ED-21); нет — команда не регистрируется. */
  readonly save?: ShellAction;
  /** Есть ли что сохранять сейчас; нет — команда доступна всегда. */
  readonly dirty?: (target: CommandTarget) => boolean;
}

/**
 * Действие с показанной причиной отказа. Асинхронность здесь настоящая — обе
 * половины ходят в дерево, — и брошенный промис оставил бы автора без ответа:
 * поэтому отказ ловится и уезжает в ту же строку бара, что причина
 * несостоявшегося прогона.
 */
function guarded(action: ShellAction): (target: CommandTarget) => void {
  return (target) => {
    try {
      const done = action(target);
      if (done === undefined) return;
      done.catch((error: unknown) => {
        target.setNotice(documentValue(reasonOf(error)));
      });
    } catch (error) {
      target.setNotice(documentValue(reasonOf(error)));
    }
  };
}

function command(spec: PaletteCommand): PaletteCommand {
  return spec;
}

/**
 * Команды оболочки в реестр вкладов. Возвращает тот же реестр — так вызов
 * складывается в цепочку с остальными регистрациями сборки.
 */
export function registerShellCommands<R extends { register(command: PaletteCommand): unknown }>(
  registry: R,
  options: ShellCommandOptions,
): R {
  const { resources } = options;

  if (options.open !== undefined) {
    const open = guarded(options.open);
    registry.register(
      command({
        id: SHELL_COMMANDS.openProject,
        descriptionKey: 'ui.command.openProject.description',
        labelKey: 'ui.command.openProject',
        icon: 'layers',
        run: open,
      }),
    );
  }

  if (options.save !== undefined) {
    const save = guarded(options.save);
    const dirty = options.dirty;
    registry.register(
      command({
        id: SHELL_COMMANDS.save,
        descriptionKey: 'ui.command.save.description',
        labelKey: 'ui.action.save',
        keybinding: 'Ctrl+S',
        icon: 'dot',
        // Сохранять нечего — команда показана недоступной, а не молча ничего не
        // делающей (ED-26). Сохранение при этом не операция авторинга: оно не
        // меняет документов, поэтому в превью оно доступно (ED-9 запрещает там
        // правку, а не запись уже набранного).
        ...(dirty === undefined ? {} : { enabled: dirty }),
        run: save,
      }),
    );
  }

  for (const [locale, labelKey] of LOCALES) {
    registry.register(
      command({
        id: `${SHELL_COMMANDS.localePrefix}${locale}`,
        descriptionKey: 'ui.command.locale.description',
        labelKey,
        // Смена языка без перезапуска (ED-27): ресурсы меняют локаль и
        // оповещают подписчиков; документов это не касается ни в одном байте.
        run: () => {
          resources.setLocale(locale);
        },
      }),
    );
  }

  registry.register(
    command({
      id: SHELL_COMMANDS.undo,
      descriptionKey: 'ui.command.undo.description',
      labelKey: 'ui.frame.undo',
      icon: 'undo',
      enabled: (target) => target.canUndo(),
      run: (target) => {
        target.undo();
      },
    }),
  );
  registry.register(
    command({
      id: SHELL_COMMANDS.redo,
      descriptionKey: 'ui.command.redo.description',
      labelKey: 'ui.frame.redo',
      icon: 'redo',
      enabled: (target) => target.canRedo(),
      run: (target) => {
        target.redo();
      },
    }),
  );

  registry.register(
    command({
      id: SHELL_COMMANDS.preview,
      descriptionKey: 'ui.command.preview.description',
      labelKey: 'ui.action.preview',
      icon: 'play',
      enabled: (target) => target.canPreview(),
      run: (target) => {
        target.togglePreview();
      },
    }),
  );

  // Переход в область — по команде на область (см. шапку). Реестр перебирается
  // в момент регистрации, и набор команд перехода этим вызовом и фиксируется:
  // область, внесённую позже, он не увидит, а второй вызов на том же реестре
  // отвергнет реестр — команда с таким id в нём уже есть. Порядок регистрации
  // — дело сборки, и заводить здесь подписку на реестр областей значило бы
  // решать за неё, когда её состав считается собранным.
  for (const area of options.areas.all()) {
    registry.register(
      command({
        id: `${SHELL_COMMANDS.areaPrefix}${area.id}`,
        descriptionKey: area.descriptionKey,
        labelKey: area.labelKey,
        icon: area.icon,
        // Сочетание области объявлено самой областью и разбирается каркасом
        // (ED-23); объявить его здесь значило бы занять его дважды.
        enabled: (target) => target.activeAreaId() !== area.id,
        run: (target) => {
          target.activate(area.id);
        },
      }),
    );
  }

  return registry;
}
