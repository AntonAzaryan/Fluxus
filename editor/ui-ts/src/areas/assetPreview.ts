/**
 * @contribution Превью presentation-ассета — часть вклада просмотрщика (ED-25),
 * а не каркаса: доменные имена («модель», «скин», «манифест») здесь и должны
 * быть.
 *
 * REND-11 нормирует превью буквально: «Превью presentation-ассета (`editor`
 * ED-20) SHALL быть ВЫРОЖДЕННЫМ СЛУЧАЕМ документного источника — набором из
 * одного инстанса без сцены и террейна, — а не третьим продюсером». Отсюда весь
 * этот модуль: он не рисует ничего и ничего не знает о THREE — он строит ровно
 * две вещи, которые вьюпорт и подсистемы уже умеют принимать:
 *
 * - **набор** из одного инстанса с `grid === null` и `curvature === null`;
 * - **манифест** из одной записи — вход переподачи (REND-17), потому что запись,
 *   которой рисуется превью, редактор собирает в памяти и ассетом она не
 *   является.
 *
 * Второго пути отрисовки не появляется, и появиться ему неоткуда: ни одной
 * подсистемы, ни одного материала этот модуль не создаёт.
 *
 * ## Клип и скин выбирает автор
 *
 * ED-20 требует превью «включая анимации и скины записи», а REND-11 говорит,
 * чем это делается: «Клип SHALL задаваться самим набором инстансов — по
 * умолчанию клип состояния покоя из манифеста, с возможностью явно назвать
 * другой; производить его от состояния сущности нечем, а просмотрщику ассетов
 * клип нужно уметь выбирать». Поэтому выбор автора уезжает полями `clip` и
 * `skin` набора, а не правкой записи: правка записи была бы записью в документ
 * (ED-29), а посмотреть на другую анимацию — не правка.
 *
 * ## Что показывается ДО выбора
 *
 * «Превью показывает модель с её анимациями до выбора, а в запись манифеста
 * попадает ID ассета» (ED-20). Значит, рисуется запись манифеста с ПОДМЕНЁННОЙ
 * моделью — той, что выбрана в дереве, — и подмена эта живёт только здесь, в
 * памяти. Документ до нажатия «назначить» не меняется ни в одном байте.
 *
 * ## Состояния ассета
 *
 * ASSET-4 даёт ровно три наблюдаемых состояния, и `failed` — с причиной. Здесь
 * они и хранятся: причина нужна интерфейсу (ED-20 требует показать ошибку с
 * причиной), а изоляция — тем, что состояние каждого ассета своё. Ассет,
 * не прошедший загрузку, ничего не роняет: он остаётся записью со статусом
 * `failed`, а соседние — своими состояниями.
 */
import type {
  AssetKind,
  AssetState,
  EntityVisual,
  Handle,
  NormalizedModel,
  VisualManifest,
} from '@fluxus/assets';
import type { StageDraft } from './sceneStage.js';
import { reasonOf } from '../reason.js';

/**
 * Что просмотрщику нужно от модуля ассетов (ASSET-2, ASSET-4). Объявлено
 * структурно, а не типом `AssetService`, по той же причине, по которой
 * структурно объявлен `HttpRequest` веб-хоста: headless-прогон подставляет сюда
 * объект из трёх строк, а не поднимает загрузку файлов, и подпись обязана это
 * допускать. Настоящий сервис ей удовлетворяет как есть.
 */
export interface AssetStates {
  request<T>(kind: AssetKind, id: string): Handle<T>;
  state<T>(handle: Handle<T>): AssetState<T>;
  subscribe<T>(handle: Handle<T>, listener: (state: AssetState<T>) => void): () => void;
  /**
   * Ещё одна попытка для отказавшего (ASSET-4: «повторный явный запрос MAY
   * инициировать новую попытку загрузки»). Здесь она нужна не ради полноты
   * подписи: ED-20 обязывает показать отказавший ассет причиной, а автор,
   * починивший файл, обязан иметь способ спросить заново — иначе причина
   * остаётся на экране до перезапуска редактора.
   */
  retry(handle: Handle): void;
  /**
   * Подписка на инвалидацию кэша: держатель сервиса выбросил его целиком, и
   * прежние хэндлы ему больше не принадлежат (`assetModule.ts`). Метод
   * необязателен — у сервиса самого по себе такого события нет и быть не должно
   * (ASSET-2), это событие держателя.
   */
  onInvalidate?(listener: () => void): () => void;
}

type AssetStatus = 'loading' | 'ready' | 'failed';

/** Ассет глазами просмотрщика: чем он оказался и почему не открылся (ASSET-4). */
export interface OpenedAsset {
  readonly id: string;
  readonly kind: AssetKind;
  readonly status: AssetStatus;
  /**
   * Причина отказа от модуля ассетов (ASSET-3, ASSET-4). `null` при `failed` —
   * причину назвал не он: открывать ассеты в этой среде нечем, и это утверждение
   * интерфейса, а значит приходит оно из строковых ресурсов (ED-27), а не
   * прозой отсюда.
   */
  readonly reason: string | null;
  /** Разделяемые данные ассета (ASSET-5); `null` — ещё не готов или не открылся. */
  readonly data: unknown;
}

export interface AssetProbeOptions {
  /**
   * Сервис ассетов вьюпорта; `null` — в этой среде открывать ассеты нечем.
   * Отдельный сервис просмотрщику не заводится: кэш один на ID (ASSET-2), и
   * второй грузил бы те же файлы второй раз. Отсюда же и подписка на его
   * инвалидацию, если она у него есть: выброшенный кэш обесценивает всё, что
   * наблюдатель о нём помнит.
   */
  readonly assets: AssetStates | null;
  /** Состояние ассета меняется асинхронно (ASSET-4) — это просьба перерисовать. */
  readonly onChange: () => void;
}

export interface AssetProbe {
  /**
   * Открывает ассет: запрос и подписка на состояние (ASSET-2, ASSET-4).
   * Идемпотентен по ID — повторный вызов ничего не грузит заново.
   */
  open(kind: AssetKind, id: string): OpenedAsset;
  /** Состояние уже открывавшегося ассета; `undefined` — такой не открывали. */
  stateOf(id: string): OpenedAsset | undefined;
  /**
   * Просьба автора попробовать ещё раз (ASSET-4, ED-20). Ничего не делает для
   * того, что не открывали или что не отказывало: «загружается» и «загружен»
   * второй попытки не требуют, и заводить её значило бы грузить готовое.
   */
  retry(id: string): void;
  dispose(): void;
}

/**
 * Наблюдатель за состояниями открытых ассетов.
 *
 * Отказ здесь никуда не распространяется, и это ED-20 буквально: «Ассет, не
 * прошедший загрузку, SHALL показываться в просмотрщике как ошибка с причиной
 * (ASSET-4) и MUST NOT ронять просмотрщик». Ловятся оба вида отказа —
 * асинхронный (`failed` с причиной от загрузчика) и синхронный (запрос ID,
 * закэшированного под другим видом, ASSET-2 отвергает броском), — и оба
 * становятся состоянием ОДНОЙ записи. Остальные записи о нём не знают.
 */
export function createAssetProbe(options: AssetProbeOptions): AssetProbe {
  const opened = new Map<string, OpenedAsset>();
  /** Хэндл на ID: им и адресуется повторная попытка (ASSET-2, ASSET-4). */
  const handles = new Map<string, Handle>();
  const unsubscribes: (() => void)[] = [];
  let disposed = false;
  /** Отписка от инвалидации кэша; ставится ниже, когда `probe` уже собран. */
  let offInvalidate: () => void = () => undefined;

  const failed = (kind: AssetKind, id: string, reason: string | null): OpenedAsset => {
    const entry: OpenedAsset = { id, kind, status: 'failed', reason, data: null };
    opened.set(id, entry);
    return entry;
  };

  const adopt = (kind: AssetKind, id: string, state: AssetState<unknown>): OpenedAsset => {
    const entry: OpenedAsset = {
      id,
      kind,
      status: state.status,
      reason: state.status === 'failed' ? state.reason : null,
      data: state.status === 'ready' ? state.data : null,
    };
    opened.set(id, entry);
    return entry;
  };

  const probe: AssetProbe = {
    open(kind, id) {
      const known = opened.get(id);
      if (known !== undefined) return known;
      const assets = options.assets;
      // Отказ без причины: сказать её модулю ассетов нечем — его здесь нет
      // вовсе. Словами это говорит ресурс интерфейса (ED-27), а не литерал.
      if (assets === null) return failed(kind, id, null);
      let handle: Handle;
      try {
        handle = assets.request<unknown>(kind, id);
      } catch (error) {
        // Синхронный отказ ASSET-2 (тот же ID под другим видом) — состояние
        // этой записи, а не исключение наружу: просмотрщик остаётся живым.
        return failed(kind, id, reasonOf(error));
      }
      handles.set(id, handle);
      // Подписка зовёт слушателя немедленно (ASSET-4), и этот первый вызов
      // перерисовки не просит: страница и так собирается прямо сейчас, а
      // просьба посреди сборки была бы рекурсией.
      let settling = true;
      try {
        unsubscribes.push(
          assets.subscribe<unknown>(handle, (state) => {
            if (disposed) return;
            adopt(kind, id, state);
            if (!settling) options.onChange();
          }),
        );
      } catch (error) {
        return failed(kind, id, reasonOf(error));
      }
      settling = false;
      return opened.get(id) ?? adopt(kind, id, { status: 'loading' });
    },
    stateOf: (id) => opened.get(id),
    retry(id) {
      const known = opened.get(id);
      const handle = handles.get(id);
      const assets = options.assets;
      if (known?.status !== 'failed' || assets === null) return;
      if (handle === undefined) {
        // Хэндла нет — запрос отказал синхронно (ASSET-2) и загрузки не было
        // вовсе. Вторая попытка здесь — это первый запрос, а не повтор.
        opened.delete(id);
        probe.open(known.kind, id);
        options.onChange();
        return;
      }
      try {
        assets.retry(handle);
      } catch (error) {
        // Отказ самой попытки — состояние этой записи, а не исключение наружу:
        // просмотрщик роняться не имеет права (ED-20).
        failed(known.kind, id, reasonOf(error));
      }
      options.onChange();
    },
    dispose() {
      disposed = true;
      offInvalidate();
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      opened.clear();
      handles.clear();
    },
  };

  /**
   * Кэш выброшен целиком (`assetModule.ts`): прежние хэндлы больше не
   * принадлежат сервису, и держать по ним состояния значило бы показывать
   * автору ответ, которого уже никто не даёт. Открытое открывается заново — тем
   * же путём и в том же составе, поэтому «один ответ на ID» (ASSET-2)
   * сохраняется, а не расщепляется на «до» и «после».
   */
  const reopen = (): void => {
    if (disposed) return;
    const known = [...opened.values()].map((entry) => ({ kind: entry.kind, id: entry.id }));
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    opened.clear();
    handles.clear();
    for (const entry of known) probe.open(entry.kind, entry.id);
    if (known.length > 0) options.onChange();
  };
  offInvalidate = options.assets?.onInvalidate?.(reopen) ?? ((): void => undefined);

  return probe;
}

/** Данные модели открытого ассета; `null` — это не готовая модель (ASSET-5). */
export function modelOf(asset: OpenedAsset | undefined): NormalizedModel | null {
  if (asset?.status !== 'ready' || asset.kind !== 'model') return null;
  return asset.data as NormalizedModel;
}

/** Имена клипов модели — из чего автор выбирает анимацию превью (ED-20, REND-4). */
export function modelClips(model: NormalizedModel | null): readonly string[] {
  return model === null ? [] : model.sequences.map((sequence) => sequence.name);
}

/** Номера слотов текстур модели: скин подменяет их по номеру (ASSET-5, REND-6). */
export function modelSlots(model: NormalizedModel | null): readonly number[] {
  return model === null ? [] : model.textureSlots.map((slot) => slot.slot);
}

/** Ключ единственного инстанса вырожденного набора (REND-11). */
export const PREVIEW_KEY = 'preview.instance';

/**
 * Ключ записи ad-hoc манифеста превью. Он не sim-идентификатор ничего: набор
 * инстансов называет визуальный тип, а тип этот существует ровно на время
 * показа одного ассета.
 */
export const PREVIEW_ENTRY = 'preview.entry';

/** Что автор выбрал показать поверх записи: анимацию и скин (ED-20). */
export interface PreviewChoice {
  readonly clip?: string;
  readonly skin?: string;
}

/**
 * Запись, которой рисуется превью: запись манифеста с моделью, выбранной в
 * дереве. Подмена живёт в памяти и до нажатия «назначить» документа не
 * касается — ED-20 требует показать модель ДО выбора.
 */
export function previewEntry(
  record: EntityVisual | null,
  model: string | null,
): EntityVisual | null {
  const asset = model ?? record?.model ?? null;
  if (asset === null || asset === '') return null;
  return { ...(record ?? {}), model: asset };
}

/**
 * Ad-hoc манифест превью (REND-17): одна запись — ровно та, что рисуется.
 * Переподаётся целиком, потому что императивной правки записи у подсистемы нет
 * и быть не должно: картинка — функция документа, а не истории вызовов.
 */
export function previewManifest(entry: EntityVisual | null): VisualManifest {
  return { entities: entry === null ? {} : { [PREVIEW_ENTRY]: entry } };
}

/**
 * Вырожденный набор REND-11: один инстанс, ни сцены, ни террейна. Уровень нулевой
 * и назван явно — сажать инстанс не на что, визуальной поверхности в этом кадре
 * нет вовсе.
 */
export function previewDraft(entry: EntityVisual | null, choice: PreviewChoice = {}): StageDraft {
  return {
    grid: null,
    curvature: null,
    placements:
      entry === null
        ? []
        : [
            {
              key: PREVIEW_KEY,
              kind: PREVIEW_ENTRY,
              x: 0,
              y: 0,
              level: 0,
              ...(choice.clip === undefined || choice.clip === '' ? {} : { clip: choice.clip }),
              ...(choice.skin === undefined || choice.skin === '' ? {} : { skin: choice.skin }),
            },
          ],
  };
}
