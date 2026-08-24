/**
 * Фикстура просмотрщика ассетов: дерево контента в памяти, дубль вьюпорта и
 * дубль модуля ассетов.
 *
 * Дубли ровно два, и оба по одной причине — их настоящие половины требуют того,
 * чего в headless-прогоне нет: вьюпорту нужен WebGL, модулю ассетов — файлы
 * форматов, которые он парсит. Проверяется поэтому не картинка и не парсер, а
 * то, ЧТО просмотрщик отдаёт рендеру (набор REND-11 и манифест REND-17) и как
 * он показывает состояния ассета (ASSET-4). Дерево контента при этом настоящее:
 * `createMemoryHost` — тот же тестовый хост среды, что у области сцены.
 */
import {
  createMemoryHost,
  type ContentEntry,
  type ContentPath,
  type ContentTreeHost,
  type EnvironmentHost,
  type MemoryHost,
} from '@fluxus/editor-core';
import type { AssetKind, AssetState, Handle, NormalizedModel } from '@fluxus/assets';
import { createAssetArea, type AssetAreaState } from '../../src/areas/assets.js';
import type { AssetStates } from '../../src/areas/assetPreview.js';
import type { WorkspaceArea } from '../../src/frame/area.js';
import { buildFrame, type FrameFixture } from './frame.js';
import { fakeStage, settle, type FakeStage } from './project.js';

export const ASSET_IDS = {
  visuals: 'visuals/manifest.json',
  hero: 'visuals/models/hero.mdx',
  broken: 'visuals/models/broken.mdx',
  skin: 'visuals/textures/hero-red.png',
} as const;

/**
 * Манифест фикстуры: одна запись с моделью и одним скином. Настоящий —
 * проходит `validateManifest`, иначе проверка проверяла бы только саму себя.
 */
export const ASSET_VISUALS = {
  entities: {
    Hero: {
      model: ASSET_IDS.hero,
      skins: { blue: { '0': 'visuals/textures/hero-blue.png' } },
      animations: { states: { idle: 'Stand' } },
    },
  },
};

/** Модель, какой её отдаёт загрузчик (ASSET-5): клипы и слоты — то, из чего выбирает автор. */
export const HERO_MODEL = {
  bones: [],
  meshes: [],
  sequences: [
    { name: 'Stand', duration: 1, boneTracks: [], partVisibility: [] },
    { name: 'Walk', duration: 1, boneTracks: [], partVisibility: [] },
  ],
  materials: [],
  textureSlots: [{ slot: 0, source: 'none' as const }],
  height: 1,
} as unknown as NormalizedModel;

export function assetHost(): MemoryHost {
  return createMemoryHost({
    name: 'assets-fixture',
    root: { label: 'fixture' },
    files: {
      [ASSET_IDS.visuals]: JSON.stringify(ASSET_VISUALS),
      [ASSET_IDS.hero]: 'MDLX',
      [ASSET_IDS.broken]: 'not a model',
      [ASSET_IDS.skin]: 'PNG',
      'visuals/notes.txt': 'формат без загрузчика — в дереве виден, открыть нечем',
    },
  });
}

/**
 * Хост, у которого перечисления нет: так ведёт себя веб-сборка, выложенная
 * статикой (ED-12). Чтение при этом работает — статика есть статика.
 */
export function hostWithoutListing(reason: string): EnvironmentHost {
  const host = assetHost();
  const content: ContentTreeHost = {
    read: (path: ContentPath) => host.content.read(path),
    write: (path: ContentPath, bytes: Uint8Array) => host.content.write(path, bytes),
    stat: (path: ContentPath) => host.content.stat(path),
    list: (): Promise<readonly ContentEntry[]> => Promise.reject(new Error(reason)),
    watch: (listener) => host.content.watch(listener),
  };
  return { name: host.name, root: host.root, content, picker: host.picker, window: host.window };
}

/** Дубль модуля ассетов: состояния ставит тест, как поставил бы их загрузчик. */
export interface FakeAssets extends AssetStates {
  /** Смена состояния ассета — тем же путём, каким о ней узнаёт подписчик (ASSET-4). */
  settle(id: string, state: AssetState<unknown>): void;
  /** Что и в каком виде запрашивали: повторный запрос обязан быть даром (ASSET-2). */
  readonly requests: readonly { readonly kind: AssetKind; readonly id: string }[];
  /** Чем ответит повторная попытка (ASSET-4): её тоже ставит тест, а не догадка. */
  onRetry(id: string, state: AssetState<unknown>): void;
  /** ID, для которых просили повторить, — в порядке просьб. */
  readonly retries: readonly string[];
  /** Кэш выброшен: так о пересоздании сервиса сообщает настоящий модуль. */
  invalidate(): void;
}

export function fakeAssets(initial: Readonly<Record<string, AssetState<unknown>>> = {}): FakeAssets {
  const states = new Map<string, AssetState<unknown>>(Object.entries(initial));
  const listeners = new Map<string, Set<(state: AssetState<unknown>) => void>>();
  const requests: { kind: AssetKind; id: string }[] = [];
  const retries: string[] = [];
  const afterRetry = new Map<string, AssetState<unknown>>();
  const invalidated = new Set<() => void>();

  const settle = (id: string, state: AssetState<unknown>): void => {
    states.set(id, state);
    for (const listener of [...(listeners.get(id) ?? [])]) listener(state);
  };

  return {
    request: <T,>(kind: AssetKind, id: string): Handle<T> => {
      requests.push({ kind, id });
      return { id, kind };
    },
    state: <T,>(handle: Handle<T>): AssetState<T> =>
      (states.get(handle.id) ?? { status: 'loading' }) as AssetState<T>,
    subscribe: <T,>(handle: Handle<T>, listener: (state: AssetState<T>) => void): (() => void) => {
      const set = listeners.get(handle.id) ?? new Set();
      listeners.set(handle.id, set);
      const cast = listener as (state: AssetState<unknown>) => void;
      set.add(cast);
      cast(states.get(handle.id) ?? { status: 'loading' });
      return () => set.delete(cast);
    },
    retry(handle) {
      retries.push(handle.id);
      // Настоящий сервис перезапускает загрузку и объявляет её результат
      // подписчикам (ASSET-4); чем она кончится, здесь решает тест.
      const next = afterRetry.get(handle.id);
      if (next !== undefined) settle(handle.id, next);
    },
    onInvalidate(listener) {
      invalidated.add(listener);
      return () => invalidated.delete(listener);
    },
    settle,
    onRetry(id, state) {
      afterRetry.set(id, state);
    },
    invalidate() {
      // Прежние подписки принадлежали выброшенному сервису — как и у
      // настоящего модуля, они не переживают пересоздания.
      listeners.clear();
      for (const listener of [...invalidated]) listener();
    },
    retries,
    requests,
  };
}

/**
 * Хост, который об изменениях дерева не сообщает: шов это прямо допускает
 * («хост, который не умеет наблюдать за деревом, возвращает из `watch` отписку и
 * не уведомляет никогда», ED-12). Ровно в такой среде повторная попытка
 * (ASSET-4) — единственный способ узнать, что автор починил файл.
 */
export function hostWithoutWatching(host: EnvironmentHost): EnvironmentHost {
  const content: ContentTreeHost = {
    read: (path: ContentPath) => host.content.read(path),
    write: (path: ContentPath, bytes: Uint8Array) => host.content.write(path, bytes),
    stat: (path: ContentPath) => host.content.stat(path),
    list: (path: ContentPath) => host.content.list(path),
    watch: () => () => undefined,
  };
  return { name: host.name, root: host.root, content, picker: host.picker, window: host.window };
}

export interface AssetFixture extends FrameFixture {
  readonly host: EnvironmentHost;
  readonly area: WorkspaceArea<AssetAreaState>;
  readonly state: AssetAreaState;
  readonly stage: FakeStage;
  readonly assets: FakeAssets;
}

export interface AssetFixtureOptions {
  readonly host?: EnvironmentHost;
  readonly assets?: FakeAssets;
  readonly locale?: string;
}

/** Каркас с одним вкладом — просмотрщиком: остальные области ему не нужны. */
export async function buildAssetFrame(
  options: AssetFixtureOptions = {},
): Promise<AssetFixture> {
  const host = options.host ?? assetHost();
  const assets = options.assets ?? fakeAssets();
  const built: FakeStage[] = [];
  const area = createAssetArea({
    host,
    visuals: ASSET_IDS.visuals,
    assets,
    stage: (_host, hooks) => {
      const made = fakeStage(hooks.announce);
      built.push(made);
      return made;
    },
  });
  const fixture = buildFrame([area], options.locale ?? 'ru');
  const state = fixture.frame.stateOf(area.id) as AssetAreaState;
  await settle();
  const stage = built[0];
  if (stage === undefined) throw new Error('кадр превью фикстуры не собрался');
  fixture.frame.view();
  return { ...fixture, host, area, state, stage, assets };
}
