/**
 * Изображения HUD по asset ID (HUD-4, design Decision 7): ссылка на иконку в
 * композиции и данных виджетов — asset ID дерева контента (ASSET-2), а не URL,
 * и резолвится он ТЕМ ЖЕ asset-слоем, что у рендера.
 *
 * «Тем же слоем» здесь значит буквально тот же объект: `AssetService`, которым
 * живут модели арены и стенд портрета (HUD-7, ASSET-2). Иконка проходит его
 * путём наравне с моделью — общий кэш по ID, общий источник байтов (какой бы
 * он ни был: HTTP, архив, память), наблюдаемые состояния загрузки и подписка
 * (ASSET-4). Второго кэша над тем же деревом не заводится, и второго способа
 * адресовать контент — тоже: сборка не даёт HUD ни корня, ни адреса, а даёт
 * сервис.
 *
 * Формат иконки превращается в `src` элемента `<img>` загрузчиком вида «иконка
 * HUD» (`hudIconLoader`), зарегистрированным в общем реестре загрузчиков
 * (ASSET-3): множество видов ассета там открыто ровно для таких случаев.
 *
 * Таблица «идентификатор из симуляции → asset ID» — данные контента по
 * образцу таблицы визуальных типов handshake (SHELL-5): симуляция доставляет
 * идентификатор (имя семантического действия, тип предмета), картинку знает
 * контент. Таблица — JSON-значение и живёт в params записи композиции, а
 * значит переезжает в JSON-документ HUD вместе с ней. Симуляция и доставляемая
 * плоская форма сведений об изображениях не несут — они здесь и не читаются.
 */
import type { AssetLoader, AssetService, AssetState } from '@fluxus/assets';
import type { HudJsonValue } from './composition.js';

/**
 * Вид ассета иконки HUD (ASSET-3). Свой, а не `texture`: текстура — данные для
 * GPU (декодированные пиксели), а иконке нужна строка, годная в `src` элемента
 * `<img>`. Ключ реестра загрузчиков — пара «вид + расширение», поэтому `.png`
 * под этим видом и `.png` под видом текстуры друг друга не вытесняют.
 */
export const HUD_ICON_ASSET_KIND = 'hud-icon';

/** Загруженная иконка: строка, которую можно поставить элементу `<img>`. */
export interface HudIconImage {
  readonly src: string;
}

/**
 * Формат → MIME. Список закрыт намеренно: расширение, которого здесь нет, не
 * объявлено и загрузчиком (`extensions` ниже), поэтому сервис ответит `failed`
 * с внятной причиной «нет загрузчика под пару вид+формат» (ASSET-3), а не
 * отдаст браузеру data-URI с угаданным типом.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

/** Расширение ID в нижнем регистре (с точкой); пустая строка — расширения нет. */
function extensionOf(id: string): string {
  const slash = Math.max(id.lastIndexOf('/'), id.lastIndexOf('\\'));
  const dot = id.lastIndexOf('.');
  return dot <= slash ? '' : id.slice(dot).toLowerCase();
}

/**
 * Размер куска перевода в base64. Кусками, а не одним
 * `String.fromCharCode(...bytes)`: длина списка аргументов ограничена стеком, и
 * на файле в сотни килобайт единственный вызов упал бы.
 */
const BASE64_CHUNK = 0x2000;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

/**
 * Загрузчик иконки HUD (ASSET-3): байты файла → `src`.
 *
 * Data-URI, а не `URL.createObjectURL`: объектная ссылка требует отзыва и от
 * прогона к прогону разная, то есть результат загрузчика стал бы непроверяемым
 * тестом и завёл бы виджету жизненный цикл, которого у него нет. Иконки — файлы
 * в единицы килобайт, и накладной расход base64 на них неощутим.
 */
export const hudIconLoader: AssetLoader<HudIconImage> = {
  kind: HUD_ICON_ASSET_KIND,
  extensions: Object.keys(MIME_BY_EXTENSION),
  load: (bytes, ctx) => {
    const mime = MIME_BY_EXTENSION[extensionOf(ctx.id)];
    if (mime === undefined) {
      throw new Error(`иконка "${ctx.id}": формат не поддержан видом "${HUD_ICON_ASSET_KIND}"`);
    }
    return Object.freeze({ src: `data:${mime};base64,${base64(new Uint8Array(bytes))}` });
  },
};

/**
 * Иконки HUD поверх РАЗДЕЛЯЕМОГО сервиса ассетов (HUD-4, HUD-7).
 *
 * Класс, а не интерфейс, который сборка вправе реализовать по-своему: интерфейс
 * был бы приглашением завести вторую адресацию контента — ровно ту, которую
 * HUD-4 и HUD-7 запрещают. Построить объект можно только из `AssetService`, и
 * сборка обязана передать ТОТ ЖЕ сервис, которым живёт рендер арены: модель и
 * иконка тогда лежат в одном кэше и приезжают одним источником байтов.
 *
 * Загрузчик регистрируется здесь же: вид `hud-icon` принадлежит HUD, и знать о
 * нём сборке незачем. Повторная регистрация той же пары «вид + формат» —
 * штатная операция реестра (ASSET-3), поэтому несколько панелей с иконками над
 * одним сервисом друг другу не мешают.
 */
export class HudIcons {
  private readonly assets: AssetService;

  constructor(assets: AssetService) {
    this.assets = assets;
    assets.registerLoader(hudIconLoader);
  }

  /**
   * Подписка на состояние иконки (ASSET-4): колбэк зовётся немедленно текущим
   * состоянием и затем на каждую смену. Возвращает отписку — виджет обязан
   * позвать её на `dispose`.
   *
   * Повторный запрос того же ID возвращает тот же handle и тот же ассет из
   * кэша: файл не читается и не разбирается второй раз (ASSET-2).
   */
  subscribe(assetId: string, onState: (state: AssetState<HudIconImage>) => void): () => void {
    const handle = this.assets.request<HudIconImage>(HUD_ICON_ASSET_KIND, assetId);
    return this.assets.subscribe(handle, onState);
  }
}

/**
 * Таблица иконок: идентификатор из симуляции → asset ID. Значение
 * JSON-сериализуемо и целиком помещается в params композиции (HUD-4).
 */
export type HudIconTable = Readonly<Record<string, string>>;

/**
 * Похоже ли значение на URL, а не на asset ID. Проверка нарочно грубая: её
 * дело — поймать `https://…`, `data:…` и абсолютный путь в композиции, где
 * обязан быть путь от корня дерева контента (ASSET-2). URL в композиции минует
 * манифест и ломает переносимость дерева контента (design Decision 7).
 */
function looksLikeUrl(value: string): boolean {
  return value.includes('://') || value.startsWith('/') || value.startsWith('data:');
}

/**
 * Проверяет значение из params как asset ID: непустая строка и не URL. Ошибка —
 * до монтирования и с местом в композиции, как у резолва имён (`registry.ts`).
 * Одно место проверки на все виджеты с иконками: URL в композиции минует
 * манифест и ломает переносимость дерева контента (design Decision 7).
 */
export function assetIdParam(value: HudJsonValue | undefined, where: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${where}: asset ID обязан быть строкой`);
  }
  if (value === '') {
    throw new Error(`${where}: пустой asset ID`);
  }
  if (looksLikeUrl(value)) {
    throw new Error(
      `${where}: "${value}" выглядит как URL — в композиции допустим только asset ID, путь от корня дерева контента (ASSET-2)`,
    );
  }
  return value;
}

/**
 * Asset ID иконки по идентификатору из симуляции.
 *
 * Идентификатор без записи в таблице — ошибка с именем идентификатора, а не
 * молчаливый fallback: таблица — конфигурация контента, и дырка в ней — дефект
 * КОМПОЗИЦИИ, который надо назвать до монтирования (образец — резолв имён в
 * `registry.ts`). Отсутствие или порча самого ФАЙЛА — другое дело: это дефект
 * контента, он приезжает состоянием `failed` сервиса (ASSET-4) и виден на
 * кнопке. Иконка-заглушка, если она нужна арене, — это ЗАПИСЬ таблицы, то есть
 * политика в данных, а не в коде (ср. политику таблицы маркеров HUD-6).
 */
export function iconAssetId(table: HudIconTable, simId: string): string {
  const assetId = table[simId];
  if (assetId === undefined) {
    throw new Error(`иконка для идентификатора "${simId}" не объявлена в таблице иконок (HUD-4)`);
  }
  return assetId;
}
