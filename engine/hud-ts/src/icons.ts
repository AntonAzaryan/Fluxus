/**
 * Изображения HUD по asset ID (HUD-4, design Decision 7): ссылка на иконку в
 * композиции и данных виджетов — asset ID дерева контента (ASSET-2), а не URL.
 * Резолв «asset ID → URL» — шов `HudIconSource`, который реализует сборка
 * клиента поверх того же корня дерева контента, что и `AssetSource` рендера
 * (в демо это `fetch('/<id>')` от корня, который vite отдаёт как статику):
 * второго способа адресовать контент не появляется.
 *
 * Таблица «идентификатор из симуляции → asset ID» — данные контента по
 * образцу таблицы визуальных типов handshake (SHELL-5): симуляция доставляет
 * идентификатор (имя семантического действия, тип предмета), картинку знает
 * контент. Таблица — JSON-значение и живёт в params записи композиции, а
 * значит переезжает в JSON-документ HUD вместе с ней. Симуляция и доставляемая
 * плоская форма сведений об изображениях не несут — они здесь и не читаются.
 */
import type { HudJsonValue, HudParams } from './composition.js';

/**
 * Шов резолва иконок: asset ID (путь от корня дерева контента, ASSET-2) →
 * URL, по которому браузер получит байты. Реализует сборка клиента тем же
 * корнем, каким её `AssetSource` кормит рендер, — HUD корня не знает и не
 * выбирает.
 */
export interface HudIconSource {
  resolveIconUrl(assetId: string): string;
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

function assertAssetId(value: string, where: string): void {
  if (value === '') {
    throw new Error(`${where}: пустой asset ID`);
  }
  if (looksLikeUrl(value)) {
    throw new Error(
      `${where}: "${value}" выглядит как URL — в композиции допустим только asset ID, путь от корня дерева контента (ASSET-2)`,
    );
  }
}

function isRecord(value: HudJsonValue | undefined): value is Readonly<Record<string, HudJsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Читает таблицу иконок из params записи композиции и проверяет её форму:
 * каждое значение — строка-`asset ID`, не URL. Ошибка — до монтирования, с
 * именем параметра и записи, как у резолва композиции (`registry.ts`).
 */
export function iconTableFromParams(params: HudParams, key: string): HudIconTable {
  const raw = params[key];
  if (!isRecord(raw)) {
    throw new Error(`параметр "${key}": ожидалась таблица «идентификатор → asset ID»`);
  }
  const table: Record<string, string> = {};
  for (const [id, assetId] of Object.entries(raw)) {
    if (typeof assetId !== 'string') {
      throw new Error(`параметр "${key}", запись "${id}": asset ID обязан быть строкой`);
    }
    assertAssetId(assetId, `параметр "${key}", запись "${id}"`);
    table[id] = assetId;
  }
  return table;
}

/**
 * Иконка по идентификатору из симуляции: таблица даёт asset ID, шов — URL.
 *
 * Идентификатор без записи в таблице — ошибка с именем идентификатора, а не
 * молчаливый fallback: таблица — конфигурация контента, и дырка в ней — дефект
 * композиции, который надо назвать до монтирования (образец — резолв имён в
 * `registry.ts`). Иконка-заглушка, если она нужна арене, — это ЗАПИСЬ таблицы,
 * то есть политика в данных, а не в коде (ср. политику таблицы маркеров HUD-6).
 */
export function resolveIcon(table: HudIconTable, source: HudIconSource, simId: string): string {
  const assetId = table[simId];
  if (assetId === undefined) {
    throw new Error(`иконка для идентификатора "${simId}" не объявлена в таблице иконок (HUD-4)`);
  }
  return source.resolveIconUrl(assetId);
}
