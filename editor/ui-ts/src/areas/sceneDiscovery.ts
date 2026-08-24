/**
 * @contribution Открытие проекта: корень спрашивается у среды, документы
 * ИЩУТСЯ в дереве, а не берутся по заранее известному пути.
 *
 * До этого модуля редактор открывал сцену по вписанному в сборку пути. Так
 * нельзя по двум причинам сразу: путь до корня дерева — свойство оболочки, а не
 * документов (CONT-5), а сами документы ссылаются друг на друга относительно
 * корня (CONT-2), поэтому «где лежит сцена» — свойство конкретного дерева, а не
 * редактора. Корень поэтому приходит от хоста среды (ED-12, `picker.chooseRoot`),
 * а содержимое — обходом дерева (`walkContentTree`).
 *
 * ## Почему опознание по содержимому, а не по имени файла
 *
 * `*.scene.json` — соглашение этого репозитория, а не норма: ни `serialization`,
 * ни `game-content` формы имени не требуют. Опознавать документ по имени значило
 * бы завести такое требование в редакторе — и не увидеть сцену, названную иначе.
 * Поэтому кандидаты читаются и различаются по форме значения.
 *
 * Опознание — не валидация (ED-8) и не вторая её реализация (ED-1): здесь
 * решается только «этот документ вообще того рода», а годен ли он, скажет ядро
 * при открытии — `loadScene` для конфига (SER-7) и `validateManifest` для
 * манифеста (ASSET-6). Отсюда и предикаты в две строки: сильнее их делать
 * нельзя, иначе редактор начнёт отвергать документы своим правилом.
 *
 * ## Цена
 *
 * Обход читает каждый `.json` дерева. На дереве репозитория это единицы файлов;
 * на дереве в сотни документов это станет заметно, и ответом будет индекс
 * проекта, а не догадка по имени файла. Названо здесь, чтобы отсутствие индекса
 * не читалось как недосмотр.
 *
 * ## Чего среда может не уметь
 *
 * Перечисления дерева в вебе нет — его даёт эндпойнт оболочки, и статическая
 * выкладка его не содержит (см. шапку `src/host/web.ts`). Обход в такой среде
 * отказывает, и отказ этот доносится причиной (`failure`), а не пустым списком
 * сцен: «сцен не найдено» и «искать нечем» — разные утверждения, и подменять
 * второе первым значило бы врать автору о его проекте.
 */
import {
  contentPathExtension,
  contentPathParent,
  readDocument,
  walkContentTree,
  type ContentEntry,
  type ContentPath,
  type ContentRootInfo,
  type EnvironmentHost,
  type JsonValue,
} from '@fluxus/editor-core';
import type { SceneProjectIds } from './sceneProject.js';

/**
 * Каталоги, внутрь которых обход не заходит. Служебные каталоги инструментов
 * контентом не являются (CONT-1), и попытка прочитать их содержимое как
 * документы проекта — только время и ложные кандидаты.
 */
const SKIPPED_DIRECTORIES: readonly string[] = ['node_modules', '.git'];

/** Что нашлось в дереве и чего в нём найти не удалось. */
export interface DiscoveredProject {
  /** Корень, который назвала среда; `undefined` — среда корня не дала. */
  readonly root: ContentRootInfo | undefined;
  /** Найденные пары «конфиг сцены + манифест визуалов», в порядке обхода. */
  readonly scenes: readonly SceneProjectIds[];
  /** Манифесты визуалов дерева — их бывает больше, чем сцен. */
  readonly manifests: readonly ContentPath[];
  /** Почему дерево не перечислено (ED-12); `null` — перечислено. */
  readonly failure: string | null;
}

export interface DiscoveryOptions {
  /** С какого каталога искать; по умолчанию — весь корень. */
  readonly root?: ContentPath;
  readonly maxDepth?: number;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Конфиг сцены (SER-7). Спрашивается единственное поле, которое формат требует
 * всегда, — перечень схем компонентов: его порядок задаёт битовые id и потому
 * является частью формата, и сцены без него не бывает.
 *
 * Ни террейна, ни prefab'ов сцена иметь не обязана — оба поля необязательны, —
 * и требовать их значило бы завести в редакторе своё требование к документу
 * поверх SER-7: арена без рельефа и сцена, чьи сущности спавнит рантайм, просто
 * не нашлись бы, и не нашлись бы молча.
 */
function looksLikeScene(value: JsonValue): boolean {
  return isObject(value) && Array.isArray(value.components);
}

/**
 * Манифест визуалов (ASSET-6): словарь записей по визуальному типу. Схем
 * компонентов у него нет — тем же полем он от конфига сцены и отличается, и
 * второго признака различения не заводится.
 */
function looksLikeManifest(value: JsonValue): boolean {
  return isObject(value) && isObject(value.entities ?? null) && !Array.isArray(value.components);
}

/**
 * Манифест для сцены. Правило одно и объявлено: ближайший по дереву — сперва в
 * том же каталоге, потом выше, и лишь затем первый найденный. Пара «конфиг —
 * манифест» нормируется ED-19, но где лежит второй, не нормирует никто, и
 * догадка обязана быть предсказуемой, а не «первый попавшийся».
 */
function manifestFor(
  scene: ContentPath,
  manifests: readonly ContentPath[],
): ContentPath | undefined {
  let directory = contentPathParent(scene);
  for (;;) {
    const here = manifests.find((path) => contentPathParent(path) === directory);
    if (here !== undefined) return here;
    if (directory === '') break;
    directory = contentPathParent(directory);
  }
  return manifests[0];
}

/**
 * Что редактору открывать. Корень — от среды (ED-12), состав — из дерева.
 * Сцена без манифеста в результат не попадает: рисовать её нечем (ASSET-6), и
 * отдать её как открываемую значило бы отложить отказ до вьюпорта.
 */
export async function discoverProject(
  host: EnvironmentHost,
  options: DiscoveryOptions = {},
): Promise<DiscoveredProject> {
  const root = await host.picker.chooseRoot();

  let files: readonly ContentEntry[];
  try {
    files = await walkContentTree(host.content, options.root ?? '', {
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
      skipDirectory: (entry) => SKIPPED_DIRECTORIES.includes(entry.name),
      acceptFile: (entry) => contentPathExtension(entry.path) === '.json',
    });
  } catch (error) {
    return { root, scenes: [], manifests: [], failure: message(error) };
  }

  const scenes: ContentPath[] = [];
  const manifests: ContentPath[] = [];
  for (const entry of files) {
    if (entry.kind !== 'file') continue;
    let value: JsonValue;
    try {
      value = (await readDocument(host.content, entry.path)).value;
    } catch {
      // Нечитаемый или неразбираемый файл документом проекта не является, и
      // сказать о нём здесь нечего: об ассете, который не открылся, говорит
      // просмотрщик с причиной от модуля ассетов (ED-20, ASSET-4), а обход
      // ищет открываемое, а не судит найденное.
      continue;
    }
    if (looksLikeScene(value)) scenes.push(entry.path);
    else if (looksLikeManifest(value)) manifests.push(entry.path);
  }

  const paired: SceneProjectIds[] = [];
  for (const config of scenes) {
    const visuals = manifestFor(config, manifests);
    if (visuals !== undefined) paired.push({ config, visuals });
  }
  return { root, scenes: paired, manifests, failure: null };
}
