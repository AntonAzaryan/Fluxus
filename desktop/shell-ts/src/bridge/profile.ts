/**
 * Схема профиля приложения (DSK-5): что грузится, где корни и какие
 * возможности моста объявлены.
 *
 * Профиль — данные, а не код: контейнер один на все приложения репозитория
 * (DSK-1), и различаются приложения манифестом, а не второй кодовой базой.
 * Поэтому здесь разбор и проверка сырого JSON, и ни одного импорта — ни
 * `node:path`, ни чего-либо ещё: слой контракта обязан читаться и в главном
 * процессе контейнера, и в странице приложения.
 *
 * Пути профиля (`bundle`, `roots[].directory`) остаются такими, как их написал
 * манифест: превращать их в абсолютные — дело хоста, у которого есть файловая
 * система (`host/app.ts`). Разделение не косметическое: проверка профиля
 * обязана работать там, где диска нет вовсе.
 *
 * Отказ — исключение с русским текстом, называющим поле и манифест. Молчаливое
 * умолчание вместо кривого поля здесь хуже отказа: профиль — это граница
 * доступа, и «не понял, взял по умолчанию» означало бы выданную возможность,
 * которой никто не объявлял.
 */
import { BRIDGE_CAPABILITIES, type BridgeCapability, type BridgeRootId } from './types.js';

/** Корень, объявленный профилем. */
export interface ProfileRoot {
  readonly id: BridgeRootId;
  /** Показываемое имя: наружу, в сессию, выходит только оно. */
  readonly label: string;
  /** Каталог корня — так, как его написал манифест (относительный или абсолютный). */
  readonly directory: string;
  /** Разрешена ли запись. У профиля игры записи нет ни в один корень (DSK-5). */
  readonly writable: boolean;
  /** Раздаётся ли корень поверх бандла тем же адресным пространством (DSK-4). */
  readonly serve: boolean;
}

/** Профиль приложения целиком. */
export interface AppProfile {
  readonly id: string;
  /** Заголовок окна на старте. Дальше его вправе менять приложение (`window`). */
  readonly title: string;
  /** Каталог собранного веб-бандла приложения. */
  readonly bundle: string;
  /** Документ, с которого начинается загрузка; по умолчанию `index.html`. */
  readonly entry: string;
  readonly roots: readonly ProfileRoot[];
  readonly capabilities: readonly BridgeCapability[];
  readonly window: { readonly width: number; readonly height: number };
}

const DEFAULT_ENTRY = 'index.html';
const DEFAULT_WINDOW = { width: 1440, height: 900 } as const;

function fail(where: string, what: string): never {
  throw new Error(`профиль "${where}": ${what} (DSK-5)`);
}

function asRecord(value: unknown, where: string, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(where, `${what} — не объект`);
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown, where: string, field: string): string {
  if (typeof value !== 'string' || value === '') fail(where, `поле "${field}" — не непустая строка`);
  return value;
}

function optionalText(value: unknown, where: string, field: string, fallback: string): string {
  return value === undefined ? fallback : asText(value, where, field);
}

function asFlag(value: unknown, where: string, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(where, `поле "${field}" — не булево`);
  return value;
}

function asSize(value: unknown, where: string, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(where, `поле "${field}" — не целое положительное число`);
  }
  return value;
}

/** Возможности: только известные контракту и без повторов. */
function asCapabilities(value: unknown, where: string): readonly BridgeCapability[] {
  if (!Array.isArray(value)) fail(where, 'поле "capabilities" — не массив');
  const out: BridgeCapability[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !BRIDGE_CAPABILITIES.includes(entry as BridgeCapability)) {
      fail(where, `возможность "${String(entry)}" контракту моста неизвестна`);
    }
    const capability = entry as BridgeCapability;
    if (!out.includes(capability)) out.push(capability);
  }
  return out;
}

function asRoot(value: unknown, where: string, index: number): ProfileRoot {
  const raw = asRecord(value, where, `корень #${index}`);
  const id = asText(raw.id, where, `roots[${index}].id`);
  return {
    id,
    label: optionalText(raw.label, where, `roots[${index}].label`, id),
    directory: asText(raw.directory, where, `roots[${index}].directory`),
    writable: asFlag(raw.writable, where, `roots[${index}].writable`, false),
    serve: asFlag(raw.serve, where, `roots[${index}].serve`, false),
  };
}

/**
 * Разбирает манифест профиля. `where` — имя манифеста для текста отказа.
 *
 * Проверяется и согласованность: корень с записью при профиле без возможности
 * `write` — не мелочь, а ровно то расхождение, из-за которого «игра пытается
 * писать» перестало бы быть невозможным (DSK-5).
 */
export function normalizeAppProfile(raw: unknown, where: string): AppProfile {
  const record = asRecord(raw, where, 'манифест');
  const capabilities = asCapabilities(record.capabilities, where);
  const rootsRaw = record.roots;
  if (!Array.isArray(rootsRaw)) fail(where, 'поле "roots" — не массив');
  const roots = rootsRaw.map((entry, index) => asRoot(entry, where, index));

  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root.id)) fail(where, `корень "${root.id}" объявлен дважды`);
    seen.add(root.id);
    if (root.writable && !capabilities.includes('write')) {
      fail(where, `корень "${root.id}" объявлен на запись, а возможности "write" в профиле нет`);
    }
  }
  if (capabilities.includes('write') && !roots.some((root) => root.writable)) {
    fail(where, 'возможность "write" объявлена, а ни один корень не открыт на запись');
  }

  const windowRaw = record.window === undefined ? {} : asRecord(record.window, where, 'window');
  return {
    id: asText(record.id, where, 'id'),
    title: asText(record.title, where, 'title'),
    bundle: asText(record.bundle, where, 'bundle'),
    entry: optionalText(record.entry, where, 'entry', DEFAULT_ENTRY),
    roots,
    capabilities,
    window: {
      width: asSize(windowRaw.width, where, 'window.width', DEFAULT_WINDOW.width),
      height: asSize(windowRaw.height, where, 'window.height', DEFAULT_WINDOW.height),
    },
  };
}

/** Объявлена ли возможность профилем. */
export function profileGrants(profile: AppProfile, capability: BridgeCapability): boolean {
  return profile.capabilities.includes(capability);
}

/** Корень профиля по имени; `undefined` — такого корня профиль не объявлял. */
export function profileRoot(profile: AppProfile, root: BridgeRootId): ProfileRoot | undefined {
  return profile.roots.find((entry) => entry.id === root);
}
