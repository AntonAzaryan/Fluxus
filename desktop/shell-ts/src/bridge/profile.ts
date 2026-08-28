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
import {
  BRIDGE_CAPABILITIES,
  type BridgeCapability,
  type BridgeRootId,
  type BridgeServiceId,
} from './types.js';

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

/**
 * Сервис, объявленный профилем (DSK-7).
 *
 * Запускается он ТЕМ ЖЕ рантаймом, что и контейнер: объявляется скрипт, а не
 * исполняемый файл. Иначе упакованному приложению понадобился бы `node` в
 * `PATH` пользовательской машины — которого там может не быть вовсе, — и
 * объявление превратилось бы в командную строку, то есть в ту самую
 * произвольную команду, которой у границы быть не должно.
 *
 * Адрес — единственный источник правды о том, где сервис слушать: в аргументы
 * он приезжает подстановкой `{port}`/`{host}`, а не второй записью числа.
 * Две записи одного порта — это способ им разойтись, а разошедшись, они дают
 * сервис по адресу, где его нет.
 */
export interface ProfileService {
  readonly id: BridgeServiceId;
  /** Скрипт сервиса — так, как его написал манифест (относительный или абсолютный). */
  readonly script: string;
  /**
   * Аргументы запуска; `{port}` и `{host}` подставляются из адреса, а
   * `{addressFile}` — путь, по которому САМ процесс вправе написать свой адрес
   * (DSK-7: «адрес SHALL приходить от объявления профиля либо от самого
   * процесса»). Путь этот выбирает контейнер, а не страница и не манифест.
   *
   * `{pinFile}` — путь, по которому процесс вправе написать закрепление своего
   * сертификата (DSK-8). Отдельного поля у сервиса для этого нет намеренно
   * (решение D2): подстановка и ЕСТЬ признак — объявление, её не подставляющее,
   * закрепления не обещает.
   */
  readonly args: readonly string[];
  /** Адрес, по которому сервис будет доступен: контейнер его не разбирает по смыслу. */
  readonly address: string;
  /**
   * Переживает ли сервис сессию, которая его подняла (DSK-7).
   *
   * Свойство ОБЪЯВЛЕНИЯ, а не решение страницы на живой сессии: иначе
   * «переживёт ли процесс закрытие окна» решал бы тот, кто нажал кнопку, и
   * whitelist профиля перестал бы ограничивать время жизни так же, как он
   * ограничивает состав. Умолчание — `false`: прежнее правило «сервис умирает с
   * сессией» действует для всех, кто отвязываемым себя не объявил.
   */
  readonly detached: boolean;
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
  readonly services: readonly ProfileService[];
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

function asArgs(value: unknown, where: string, service: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(where, `сервис "${service}": поле "args" — не массив`);
  return value.map((entry, index) => asText(entry, where, `services[${service}].args[${index}]`));
}

/**
 * Корни профиля: разбор списка и согласованность с возможностью `write`.
 *
 * Согласованность здесь, а не отдельной проверкой рядом: корень с записью при
 * профиле без возможности `write` — не мелочь, а ровно то расхождение, из-за
 * которого «игра пытается писать» перестало бы быть невозможным (DSK-5).
 */
function asRoots(
  value: unknown,
  where: string,
  capabilities: readonly BridgeCapability[],
): readonly ProfileRoot[] {
  if (!Array.isArray(value)) fail(where, 'поле "roots" — не массив');
  const roots = value.map((entry, index) => asRoot(entry, where, index));
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
  return roots;
}

function asService(value: unknown, where: string, index: number): ProfileService {
  const raw = asRecord(value, where, `сервис #${index}`);
  const id = asText(raw.id, where, `services[${index}].id`);
  return {
    id,
    script: asText(raw.script, where, `services[${index}].script`),
    args: asArgs(raw.args, where, id),
    address: asText(raw.address, where, `services[${index}].address`),
    detached: asFlag(raw.detached, where, `services[${index}].detached`, false),
  };
}

/**
 * Сервисы профиля: разбор списка и согласованность с возможностью `service`.
 *
 * Согласованность в обе стороны — по тому же основанию, что и у корня с
 * записью: набор сервисов и возможность их поднимать обязаны объявляться
 * вместе, иначе профиль описывает доступ, которого не даёт, или даёт доступ,
 * которым нечего открыть (DSK-5).
 */
function asServices(
  value: unknown,
  where: string,
  capabilities: readonly BridgeCapability[],
): readonly ProfileService[] {
  if (value !== undefined && !Array.isArray(value)) fail(where, 'поле "services" — не массив');
  const services = (value ?? []).map((entry, index) => asService(entry, where, index));
  const named = new Set<string>();
  for (const service of services) {
    if (named.has(service.id)) fail(where, `сервис "${service.id}" объявлен дважды`);
    named.add(service.id);
    if (!capabilities.includes('service')) {
      fail(where, `сервис "${service.id}" объявлен, а возможности "service" в профиле нет`);
    }
  }
  if (capabilities.includes('service') && services.length === 0) {
    fail(where, 'возможность "service" объявлена, а ни одного сервиса профиль не объявил');
  }
  return services;
}

/**
 * Разбирает манифест профиля. `where` — имя манифеста для текста отказа.
 *
 * Порядок разбора — часть ответа: возможности читаются первыми, потому что с
 * ними сверяются и корни (`asRoots`), и сервисы (`asServices`).
 */
export function normalizeAppProfile(raw: unknown, where: string): AppProfile {
  const record = asRecord(raw, where, 'манифест');
  const capabilities = asCapabilities(record.capabilities, where);
  const roots = asRoots(record.roots, where, capabilities);
  const services = asServices(record.services, where, capabilities);
  const windowRaw = record.window === undefined ? {} : asRecord(record.window, where, 'window');
  return {
    id: asText(record.id, where, 'id'),
    title: asText(record.title, where, 'title'),
    bundle: asText(record.bundle, where, 'bundle'),
    entry: optionalText(record.entry, where, 'entry', DEFAULT_ENTRY),
    roots,
    capabilities,
    services,
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

/** Сервис профиля по имени; `undefined` — такого сервиса профиль не объявлял. */
export function profileService(
  profile: AppProfile,
  service: BridgeServiceId,
): ProfileService | undefined {
  return profile.services.find((entry) => entry.id === service);
}
