/**
 * Документ старта демо (`game-boot` BOOT-3, BOOT-1) — ПОЛИТИКА игры над
 * механизмами прогрева (`rendering` REND-45) и готовности оболочки
 * (`client-shell` SHELL-10).
 *
 * ## Почему документ, а не список вызовов
 *
 * Состав и строгость прогрева — данные (BOOT-3): какие стадии исполняются, какая
 * из них обязательна, сколько её ждать, сколько тёплых кадров идёт под сплешем и
 * куда передать управление после раскрытия. Прецедент — пресеты качества
 * (`render-quality` QUAL-1, `quality.ts`): реестр собирает сборка сцены, документ
 * проверяется против него адресно, а отвергнутый документ не останавливает старт
 * — действует умолчание, и причина названа вслух.
 *
 * ## Словарь стадий: второго списка имён нет
 *
 * Имена складываются из двух источников (BOOT-3): встроенные стадии оболочки и
 * сборки (`handshake`, `firstDelivery`, `scene`, `warmFrames`) и стадии подсистем
 * `prewarm.<подсистема>` — по одной на подсистему рендера, объявившую точку
 * прогрева (REND-45). Имя стадии подсистемы ЕСТЬ имя подсистемы: списка имён
 * подсистем здесь не заводится, иначе он расходился бы с реестром сцены молча.
 *
 * ## Чего у стадий не бывает
 *
 * Таймаута у `handshake` и `firstDelivery` нет по построению (BOOT-4): ждать
 * соперника раскрытие обязано без потолка, а показывается это ожидание
 * состоянием `waiting`, а не продолжением загрузки. Документ, обещающий им
 * таймаут, обещал бы то, чего машина не исполняет, — поэтому такое поле
 * отвергается адресно, а не игнорируется.
 */

/** Медиа сплеша (BOOT-2): оформление разметки, картинка или видео. */
export const SPLASH_KINDS = ['none', 'image', 'video'] as const;

export type SplashKind = (typeof SPLASH_KINDS)[number];

/**
 * Встроенные стадии — те, которыми машина закрывает СОБЫТИЯ, а не промисы
 * раннеров (`handshake`, `firstDelivery`, `warmFrames`), плюс компиляция
 * программ сцены кадра (`scene`).
 */
export const BUILT_IN_STAGES = ['handshake', 'firstDelivery', 'scene', 'warmFrames'] as const;

/** Стадии, которые машина закрывает событием оболочки или кадром (BOOT-3). */
export const EVENT_STAGES = ['handshake', 'firstDelivery', 'warmFrames'] as const;

/** Стадии, у которых таймаута нет по построению (BOOT-4). */
export const UNTIMED_STAGES = ['handshake', 'firstDelivery'] as const;

/** Префикс стадии подсистемы: имя стадии = префикс + имя подсистемы (REND-45). */
export const PREWARM_PREFIX = 'prewarm.';

/** Стадия тёплых кадров: её потолок — единственный, что есть у их ожидания. */
const WARM_FRAMES_STAGE = 'warmFrames';

/**
 * Словарь назначений (BOOT-1): куда передаётся управление после раскрытия.
 * `menu` зарезервировано — значение допустимо для валидатора, но пока сборка
 * такого назначения не зарегистрировала, документ отвергается адресно.
 */
export const DESTINATIONS = ['scene', 'menu'] as const;

export type Destination = (typeof DESTINATIONS)[number];

/** Запасное назначение сборки: сцена матча. */
export const DEFAULT_DESTINATION: Destination = 'scene';

/** Умолчание таймаута стадии; переопределяется полем `timeoutMs` записи. */
export const DEFAULT_STAGE_TIMEOUT_MS = 10_000;

/**
 * Умолчание числа тёплых кадров под сплешем (BOOT-4). Действует, когда документ
 * называет стадию `warmFrames`: у ожидания кадров потолок — её таймаут.
 */
export const DEFAULT_WARM_FRAMES = 2;

/** Умолчание длительности угасания сплеша (BOOT-2). */
export const DEFAULT_FADE_MS = 400;

/** Стадия документа с разрешёнными умолчаниями. */
export interface BootStage {
  /** Имя стадии: встроенное либо `prewarm.<подсистема>`. */
  readonly name: string;
  /** Обязательная стадия задерживает раскрытие до своего исхода (BOOT-4). */
  readonly required: boolean;
  /** Потолок ожидания в миллисекундах; `null` — таймаута нет по построению. */
  readonly timeoutMs: number | null;
}

/** Сплеш: медиа и тайминги (BOOT-2). */
export interface BootSplash {
  readonly kind: SplashKind;
  /** Заголовок поверх сплеша — текст игры. */
  readonly title: string;
  /** asset id медиа от корня дерева контента (`assets` ASSET-2); `null` — нет. */
  readonly src: string | null;
  /** Сплеш держится не меньше этого времени от показа (BOOT-2). */
  readonly minMs: number;
  readonly fadeMs: number;
}

/** Документ старта с разрешёнными умолчаниями — вход машины (BOOT-3). */
export interface BootDocument {
  readonly stages: readonly BootStage[];
  readonly splash: BootSplash;
  readonly warmFrames: number;
  readonly after: string;
}

/** Реестр сборки, против которого проверяется документ (BOOT-3, BOOT-1). */
export interface BootRegistry {
  /** Подсистемы сцены, объявившие точку прогрева (REND-45). */
  readonly declared: ReadonlySet<string>;
  /**
   * Подсистемы, которые сборка УМЕЕТ построить, но строит не на всякой сцене
   * (QUAL-1): их стадия принимается и получает исход `skipped` там, где
   * подсистемы нет. Перечень — тот же, что у пресетов качества; второго не
   * заводится.
   */
  readonly declarable: readonly string[];
  /** Назначения, зарегистрированные сборкой (BOOT-1). */
  readonly destinations: ReadonlySet<string>;
}

/**
 * Умолчание сборки (BOOT-3): встроенные стадии обязательны с одним таймаутом,
 * сплеш — оформлением разметки, назначение — сцена. Им идёт старт, у которого
 * документ не разобран или отвергнут: сплеш, прогрев и раскрытие работают, а
 * причина едет в диагностику (BOOT-5).
 */
export const DEFAULT_BOOT_DOCUMENT: BootDocument = Object.freeze({
  stages: Object.freeze([
    stageOf('handshake', true, null),
    stageOf('scene', true, DEFAULT_STAGE_TIMEOUT_MS),
    stageOf('firstDelivery', true, null),
    stageOf('warmFrames', true, DEFAULT_STAGE_TIMEOUT_MS),
  ]),
  splash: Object.freeze({
    kind: 'none',
    title: '',
    src: null,
    minMs: 0,
    fadeMs: DEFAULT_FADE_MS,
  }),
  warmFrames: DEFAULT_WARM_FRAMES,
  after: DEFAULT_DESTINATION,
});

/**
 * Умолчание сборки, дополненное стадиями ВСЕХ объявленных подсистем: отвергнув
 * документ, старт не должен заодно отменить прогрев — иначе опечатка в одном
 * поле стоила бы игроку всех монтажей в первом кадре.
 */
export function defaultBootDocument(declared: Iterable<string>): BootDocument {
  const prewarm = [...declared].map((name) =>
    stageOf(`${PREWARM_PREFIX}${name}`, true, DEFAULT_STAGE_TIMEOUT_MS),
  );
  // Порядок тот же, что у отгружаемого документа: прогрев между handshake и
  // компиляцией сцены — компилировать тёплые корни, которых ещё нет, нечем.
  const [handshake, scene, ...rest] = DEFAULT_BOOT_DOCUMENT.stages;
  return {
    ...DEFAULT_BOOT_DOCUMENT,
    stages: [handshake!, ...prewarm, scene!, ...rest],
  };
}

function stageOf(name: string, required: boolean, timeoutMs: number | null): BootStage {
  return { name, required, timeoutMs };
}

/** Стадии, объявленные подсистемами, но не названные документом (BOOT-3). */
export function notWarmedStages(doc: BootDocument, declared: Iterable<string>): string[] {
  const named = new Set(doc.stages.map((stage) => stage.name));
  const out: string[] = [];
  for (const subsystem of declared) {
    const name = `${PREWARM_PREFIX}${subsystem}`;
    if (!named.has(name)) out.push(name);
  }
  return out;
}

/** Исход разбора документа: что действует, почему и что осталось непрогретым. */
export interface BootPlan {
  /** Действующий документ: разобранный либо умолчание сборки. */
  readonly document: BootDocument;
  /** Причины отказа с именами записей; пусто — документ принят (BOOT-5). */
  readonly rejected: readonly string[];
  /** Объявленные, но не названные документом стадии подсистем (BOOT-3). */
  readonly notWarmed: readonly string[];
}

/**
 * Секция сплеша отдельно от остального документа: реестра сборки ей не нужно, и
 * спрашивается она РАНЬШЕ — сплеш берут в руки до загрузки манифеста, а реестр
 * стадий складывается только со сборкой сцены (BOOT-2, BOOT-3). Поля с
 * негодными значениями получают документированное умолчание, а причина едет
 * тому, кто разберёт документ целиком.
 */
export function resolveSplash(doc: unknown): BootSplash {
  return checkSplash(isRecord(doc) ? doc.splash : undefined, []);
}

/**
 * Документ старта в план: принятый — как написан, отвергнутый — умолчанием
 * сборки с причинами. Старт не останавливается ни в одном случае (BOOT-3).
 *
 * Сплеш умолчания берётся из САМОГО документа: опечатка в имени стадии не повод
 * отменить титры студии, которые страница уже показывает (BOOT-2) — иначе
 * заголовок и тайминги менялись бы на глазах игрока в момент сборки сцены.
 */
export function resolveBootDocument(doc: unknown, registry: BootRegistry): BootPlan {
  const result = validateBootDocument(doc, registry);
  const document = result.ok
    ? result.document
    : { ...defaultBootDocument(registry.declared), splash: resolveSplash(doc) };
  return {
    document,
    rejected: result.ok ? [] : result.errors,
    notWarmed: notWarmedStages(document, registry.declared),
  };
}

// ------------------------------------------------------------- валидация

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Как значение показывается в отказе: строка — в кавычках, число и флаг как
 * есть, остальное — своим родом. Правка документа не должна превращаться в
 * угадывание, а «получено [object Object]» об этом ничего не говорит.
 */
function shown(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return Array.isArray(value) ? 'массив' : typeof value;
}

/** Конечное число не меньше нуля — форма всех таймингов документа. */
function checkMs(where: string, value: unknown, errors: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push(`${where}: ожидалось конечное число миллисекунд не меньше нуля, получено ${shown(value)}`);
    return undefined;
  }
  return value;
}

/**
 * Имя стадии против реестра (BOOT-3). Принимается встроенная и стадия
 * подсистемы, которая либо зарегистрирована с точкой прогрева, либо объявлена
 * сборкой как объявляемая. Всё остальное — отказ С ИМЕНЕМ: незнакомая стадия не
 * пропускается молча, иначе опечатка стоила бы ровно того прогрева, ради
 * которого стадия и написана.
 */
function checkStageName(name: string, registry: BootRegistry, errors: string[]): void {
  if ((BUILT_IN_STAGES as readonly string[]).includes(name)) return;
  if (!name.startsWith(PREWARM_PREFIX)) {
    errors.push(
      `${name}: незнакомая стадия старта — встроенной с таким именем нет ` +
        `(встроенные: ${BUILT_IN_STAGES.join(', ')}), а стадия подсистемы называется "${PREWARM_PREFIX}<подсистема>"`,
    );
    return;
  }
  const subsystem = name.slice(PREWARM_PREFIX.length);
  if (registry.declared.has(subsystem) || registry.declarable.includes(subsystem)) return;
  const known = [...registry.declared, ...registry.declarable].sort();
  errors.push(
    `${name}: подсистема "${subsystem}" точки прогрева не объявляла и сборкой не объявлена ` +
      `(объявлены: ${known.length === 0 ? 'ни одной' : known.join(', ')})`,
  );
}

/** Одна запись `stages` документа: имя, строгость, таймаут. */
function checkStage(
  entry: unknown,
  index: number,
  registry: BootRegistry,
  seen: Set<string>,
  errors: string[],
): BootStage | undefined {
  if (!isRecord(entry)) {
    errors.push(`stages[${index}]: ожидалась запись стадии, получено ${shown(entry)}`);
    return undefined;
  }
  const name = entry.stage;
  if (typeof name !== 'string' || name === '') {
    errors.push(`stages[${index}]: поле "stage" — имя стадии строкой, получено ${shown(name)}`);
    return undefined;
  }
  if (seen.has(name)) {
    errors.push(`${name}: стадия названа документом дважды — исход у стадии один`);
    return undefined;
  }
  seen.add(name);
  const before = errors.length;
  checkStageName(name, registry, errors);
  const required = entry.required ?? true;
  if (typeof required !== 'boolean') {
    errors.push(`${name}: поле "required" — признак обязательности, получено ${shown(entry.required)}`);
  }
  const timeoutMs = checkStageTimeout(name, entry.timeoutMs, errors);
  if (errors.length > before) return undefined;
  return stageOf(name, required as boolean, timeoutMs);
}

/**
 * Таймаут записи. У `handshake` и `firstDelivery` его нет по построению
 * (BOOT-4): единственное, чего раскрытие ждёт без потолка, — приход соперника,
 * и документ, назначающий ему потолок, описывает не ту машину.
 */
function checkStageTimeout(name: string, value: unknown, errors: string[]): number | null {
  if ((UNTIMED_STAGES as readonly string[]).includes(name)) {
    if (value !== undefined) {
      errors.push(
        `${name}: таймаута у стадии нет по построению (BOOT-4) — раскрытие ждёт handshake ` +
          `и первую доставку без потолка, а ожидание показывается состоянием ожидания матча`,
      );
    }
    return null;
  }
  if (value === undefined) return DEFAULT_STAGE_TIMEOUT_MS;
  return checkMs(`${name}.timeoutMs`, value, errors) ?? DEFAULT_STAGE_TIMEOUT_MS;
}

/** Секция сплеша: медиа и тайминги (BOOT-2). */
function checkSplash(value: unknown, errors: string[]): BootSplash {
  const fallback = DEFAULT_BOOT_DOCUMENT.splash;
  if (value === undefined) return fallback;
  if (!isRecord(value)) {
    errors.push(`splash: ожидалась секция сплеша, получено ${shown(value)}`);
    return fallback;
  }
  const kind = value.kind ?? 'none';
  if (!(SPLASH_KINDS as readonly unknown[]).includes(kind)) {
    errors.push(`splash.kind: ожидалось одно из ${SPLASH_KINDS.join(' | ')}, получено ${shown(kind)}`);
  }
  const title = value.title ?? fallback.title;
  if (typeof title !== 'string') {
    errors.push(`splash.title: ожидалась строка заголовка, получено ${shown(value.title)}`);
  }
  const src = value.src ?? null;
  if (src !== null && typeof src !== 'string') {
    errors.push(`splash.src: ожидался asset id медиа строкой (ASSET-2), получено ${shown(value.src)}`);
  }
  // Медиа без источника — не оформление `none`, а недосказанность: показывать
  // нечего, а документ обещает картинку.
  if ((kind === 'image' || kind === 'video') && typeof src !== 'string') {
    errors.push(`splash.src: медиа "${kind}" названо без пути к нему (BOOT-2, ASSET-2)`);
  }
  const minMs = value.minMs === undefined ? fallback.minMs : checkMs('splash.minMs', value.minMs, errors);
  const fadeMs = value.fadeMs === undefined ? fallback.fadeMs : checkMs('splash.fadeMs', value.fadeMs, errors);
  return {
    kind: (typeof kind === 'string' && (SPLASH_KINDS as readonly string[]).includes(kind)
      ? kind
      : 'none') as SplashKind,
    title: typeof title === 'string' ? title : fallback.title,
    src: typeof src === 'string' ? src : null,
    minMs: minMs ?? fallback.minMs,
    fadeMs: fadeMs ?? fallback.fadeMs,
  };
}

/**
 * Назначение после раскрытия (BOOT-1). Имя из словаря, которого сборка не
 * зарегистрировала, отвергается АДРЕСНО и со словом «зарезервировано»: `menu`
 * — не опечатка автора, а обещание будущего экрана, и путать эти два отказа
 * значит прятать одно за другим.
 */
function checkDestination(value: unknown, registry: BootRegistry, errors: string[]): string {
  if (value === undefined) return DEFAULT_DESTINATION;
  if (typeof value !== 'string') {
    errors.push(`after: ожидалось имя назначения строкой, получено ${shown(value)}`);
    return DEFAULT_DESTINATION;
  }
  if (registry.destinations.has(value)) return value;
  const registered = [...registry.destinations].sort().join(', ');
  if ((DESTINATIONS as readonly string[]).includes(value)) {
    errors.push(
      `after: назначение "${value}" зарезервировано словарём, но сборкой не зарегистрировано ` +
        `(зарегистрированы: ${registered}) — действует запасное "${DEFAULT_DESTINATION}"`,
    );
    return DEFAULT_DESTINATION;
  }
  errors.push(
    `after: незнакомое назначение "${value}" — ни в словаре (${DESTINATIONS.join(', ')}), ` +
      `ни среди зарегистрированных (${registered})`,
  );
  return DEFAULT_DESTINATION;
}

/**
 * Число тёплых кадров (BOOT-4). Потолок у их ожидания один — таймаут стадии
 * `warmFrames`, и без неё считать кадры было бы нечем остановить: кадрового
 * цикла может не быть вовсе (вкладка в фоне). Поэтому документ, ОБЕЩАЮЩИЙ
 * кадры и не называющий стадии, отвергается адресно, а документ, промолчавший
 * о числе, получает не умолчание, а ноль: обещания он не давал.
 */
function checkWarmFrames(value: unknown, named: boolean, errors: string[]): number {
  if (value === undefined) return DEFAULT_WARM_FRAMES;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    errors.push(`warmFrames: ожидалось целое число кадров не меньше нуля, получено ${shown(value)}`);
    return DEFAULT_WARM_FRAMES;
  }
  if (value > 0 && !named) {
    errors.push(
      `warmFrames: документ обещает ${String(value)} тёплых кадров, но стадии "${WARM_FRAMES_STAGE}" ` +
        `не называет — ждать их было бы без потолка, а бессрочное ожидание у раскрытия одно (BOOT-4)`,
    );
  }
  return value;
}

/**
 * Документ старта против реестра сборки (BOOT-3) — по прецеденту QUAL-1: отказ
 * АДРЕСНЫЙ, с именем записи, а не «документ не подошёл».
 */
export function validateBootDocument(
  doc: unknown,
  registry: BootRegistry,
): { ok: true; document: BootDocument } | { ok: false; errors: string[] } {
  if (!isRecord(doc)) {
    return {
      ok: false,
      errors: [`документ старта: ожидался объект (BOOT-3), получено ${shown(doc)}`],
    };
  }
  const errors: string[] = [];
  const stages: BootStage[] = [];
  const raw = doc.stages;
  if (!Array.isArray(raw)) {
    errors.push(`stages: ожидался список стадий старта (BOOT-3), получено ${shown(raw)}`);
  } else {
    const seen = new Set<string>();
    raw.forEach((entry, index) => {
      const stage = checkStage(entry, index, registry, seen, errors);
      if (stage !== undefined) stages.push(stage);
    });
  }
  const splash = checkSplash(doc.splash, errors);
  const after = checkDestination(doc.after, registry, errors);
  const named = stages.some((stage) => stage.name === WARM_FRAMES_STAGE);
  const warmFrames = checkWarmFrames(doc.warmFrames, named, errors);
  if (errors.length > 0) return { ok: false, errors };
  // Стадии нет — нет и ожидания кадров: считать их было бы нечем остановить,
  // а бессрочное ожидание у раскрытия ровно одно (BOOT-4).
  return { ok: true, document: { stages, splash, warmFrames: named ? warmFrames : 0, after } };
}
