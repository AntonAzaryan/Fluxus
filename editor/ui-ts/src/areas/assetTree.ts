/**
 * @contribution Дерево контента глазами просмотрщика ассетов — часть вклада
 * области (ED-25), а не каркаса: доменные имена («модель», «текстура»,
 * «манифест») здесь есть и должны быть.
 *
 * ED-20 требует «навигацию по дереву контента». Дерево читает хост среды
 * (ED-12) и только он: прямого обращения к файловой системе тут нет и в вебе
 * быть не может. Обход — `walkContentTree` ядра редактора: он собран из `list`,
 * одинаков в обеих средах и потому в шов не входит; второй его реализации
 * здесь не заводится.
 *
 * ## Честная граница перечисления
 *
 * У HTTP перечисления каталога нет, и веб-хост говорит об этом ошибкой, а не
 * пустым списком (`src/host/web.ts`): в сборке без dev-сервера — выложенной
 * статикой — `list` отказывает, называя путь. Просмотрщик обязан этот отказ
 * донести, а не показать пустое дерево: «ассетов нет» и «перечислить их в этой
 * среде нечем» — разные утверждения, и второе автор обязан прочитать (ED-12).
 * Поэтому неудача обхода — не исключение наружу, а поле `failure` с причиной,
 * и остальная область продолжает работать.
 *
 * ## Откуда известно, что файл — ассет
 *
 * Из самих загрузчиков (ASSET-3): пара «вид + расширения» объявлена загрузчиком,
 * и второго списка расширений редактор не ведёт — он разъехался бы с реестром
 * на первом же новом формате. Файл, под чьё расширение загрузчика нет, в дереве
 * виден (ED-20 требует дерева, а не перечня моделей), но открыть его нечем.
 */
import {
  contentPathExtension,
  contentPathParent,
  walkContentTree,
  type ContentEntry,
  type ContentEntryKind,
  type ContentPath,
  type ContentTreeHost,
} from '@fluxus/editor-core';
import {
  gltfLoader,
  mdxLoader,
  pngTextureLoader,
  type AssetKind,
  type AssetLoader,
} from '@fluxus/assets';

/**
 * Загрузчики, ассеты которых просмотрщик умеет открывать. Тот же список, что
 * регистрирует модуль ассетов (`assetModule.ts`), минус манифест и карта
 * кривизны: они документы редактора (ED-15), их правит область, а не открывает
 * просмотрщик. Минус и эмиттерный ассет (ASSET-14): показывать его просмотрщику
 * нечем — его изображение живёт эмиттером сцены, а не отдельным инстансом
 * (REND-24), — и по расширению `.json` он неотличим от прочих документов.
 */
export const BROWSABLE_LOADERS: readonly AssetLoader[] = Object.freeze([
  mdxLoader,
  gltfLoader,
  pngTextureLoader,
]);

/** Вид presentation-ассета по расширению пути; `null` — загрузчика нет (ASSET-3). */
export function assetKindOf(
  path: ContentPath,
  loaders: readonly AssetLoader[] = BROWSABLE_LOADERS,
): AssetKind | null {
  const extension = contentPathExtension(path);
  if (extension === '') return null;
  for (const loader of loaders) {
    if (loader.extensions.some((known) => known.toLowerCase() === extension)) return loader.kind;
  }
  return null;
}

/** Узел дерева контента: то, что показывает навигатор просмотрщика. */
export interface AssetNode {
  /** Путь от корня дерева — он же ID ассета для файлов (ASSET-2). */
  readonly path: ContentPath;
  readonly name: string;
  readonly kind: ContentEntryKind;
  /** Вид ассета файла; `null` — каталог либо формат без загрузчика. */
  readonly asset: AssetKind | null;
  readonly children: readonly AssetNode[];
}

export interface AssetTree {
  readonly nodes: readonly AssetNode[];
  /**
   * Почему дерева нет; `null` — обход удался. Причину называет хост среды, а не
   * эта функция: она знает, чего у среды нет, и говорит это словами (ED-12).
   */
  readonly failure: string | null;
}

/** Дерева ещё не читали: ни узлов, ни причины их отсутствия. */
export const EMPTY_ASSET_TREE: AssetTree = Object.freeze({ nodes: [], failure: null });

export interface AssetTreeOptions {
  /** Корень обхода; по умолчанию — корень дерева контента. */
  readonly root?: ContentPath;
  readonly loaders?: readonly AssetLoader[];
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface MutableNode extends AssetNode {
  readonly children: AssetNode[];
}

/**
 * Дерево контента одним обходом. Плоский список `walkContentTree` уже
 * упорядочен нормативно (каталог перед своим содержимым, внутри уровня — по
 * имени), поэтому родитель встречается раньше ребёнка, и складывание в дерево
 * идёт одним проходом без сортировки.
 */
export async function loadAssetTree(
  host: ContentTreeHost,
  options: AssetTreeOptions = {},
): Promise<AssetTree> {
  const root = options.root ?? '';
  let entries: readonly ContentEntry[];
  try {
    entries = await walkContentTree(host, root);
  } catch (error) {
    return { nodes: [], failure: message(error) };
  }

  const byPath = new Map<ContentPath, MutableNode>();
  const nodes: AssetNode[] = [];
  for (const entry of entries) {
    const node: MutableNode = {
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      asset: entry.kind === 'file' ? assetKindOf(entry.path, options.loaders) : null,
      children: [],
    };
    byPath.set(entry.path, node);
    const parent = byPath.get(contentPathParent(entry.path));
    // Родителя нет в карте — узел верхнего уровня обхода: его каталог остался
    // за корнем и в дереве не показывается.
    if (parent === undefined) nodes.push(node);
    else parent.children.push(node);
  }
  return { nodes, failure: null };
}

/** Узел по пути; `undefined` — такого в дереве нет. */
export function findAssetNode(tree: AssetTree, path: ContentPath): AssetNode | undefined {
  for (const node of walkAssetNodes(tree.nodes)) {
    if (node.path === path) return node;
  }
  return undefined;
}

/** Обход узлов в порядке дерева — им же строятся строки навигатора. */
export function* walkAssetNodes(nodes: readonly AssetNode[]): Generator<AssetNode> {
  for (const node of nodes) {
    yield node;
    yield* walkAssetNodes(node.children);
  }
}
