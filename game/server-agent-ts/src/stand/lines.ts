/**
 * Контракт «агент ↔ процесс сервера» (решение D2): JSON-линии по stdio.
 *
 * Стенд получает флаг control-адаптера и начинает периодически ОТЧИТЫВАТЬСЯ в
 * stdout и принимать КОМАНДЫ из stdin. Одна точка аутентификации и один порт
 * наружу — у агента; свой админ-эндпоинт в каждом процессе сервера означал бы N
 * портов и N точек auth, а агент всё равно нужен для запуска и крашей.
 *
 * Управляющие линии МАРКИРОВАНЫ префиксом, и это не украшение: stdout стенда —
 * это ещё и его отчёт человеку (`bin/demo-serve.mjs` пишет туда фазу, слоты и
 * отказы), а «управляющие сообщения и лог не смешиваются в одном направлении без
 * маркировки» — названный риск дизайна. Строка без префикса есть строка лога, и
 * никакого разбора она не требует.
 *
 * Словарь живёт в пакете АГЕНТА, а не стенда, потому что это его контракт с
 * ЛЮБЫМ стендом: сегодня стенд один (`game/demo-ts`), завтра их может быть
 * несколько, и вторая копия словаря у каждого и есть способ им разойтись.
 *
 * Модуль ничего не импортирует — по тому же основанию, что и словарь протокола:
 * его читают обе стороны, и одна из них — чужой пакет.
 */

/**
 * Префикс управляющей линии. Пробел в конце обязателен: без него `@fx-control{`
 * читалось бы глазами как слипшийся мусор в общем логе.
 */
export const CONTROL_LINE_PREFIX = '@fx-control ';

/** Фаза матча в отчёте стенда — те же три значения, что у сервера (`MatchPhase`). */
export type StandPhase = 'lobby' | 'running' | 'ended';

/** Слот в отчёте стенда: аренда (NTR-17..NTR-19) и счётчики слота (NTR-11). */
export interface StandSlotReport {
  readonly slot: number;
  readonly playerId: string;
  /** Статус игрока (SRV-4) — стенд выводит его из аренды слота, агент лишь передаёт. */
  readonly status: string;
  readonly role: 'owner' | 'substitute' | null;
  readonly rtt: { readonly kind: string; readonly ms?: number };
  /** Серверная половина отклика в мс (NTR-11); `null` — замера не было. */
  readonly serverResponseMs: number | null;
  readonly applied: number;
  readonly predicted: number;
  readonly late: number;
  readonly snapshotBytes: number;
  /** Снапшоты, пропущенные рассылкой из-за очереди отправки соединения (NTR-22). */
  readonly snapshotsSkipped: number;
}

/** Счётчики матча и процесса (NTR-11, решение D9); собираются только по подписке. */
export interface StandMetricsReport {
  readonly tickP99Ms: number;
  readonly tickMeanMs: number;
  readonly broadcastP99Ms: number;
  readonly snapshotsSent: number;
  readonly bytesSent: number;
  readonly eventLoopDelayMs: number;
  readonly rssBytes: number;
}

/** Периодический отчёт стенда (D2): фаза, слоты со статусами, метрики. */
export interface StandReportLine {
  readonly t: 'report';
  readonly phase: StandPhase;
  readonly tick: number;
  readonly round: number;
  readonly pause: 'running' | 'frozen' | 'resuming';
  readonly slots: readonly StandSlotReport[];
  /** `null` — подписки на детали нет, и отчёт метрик не собирался (D9). */
  readonly metrics: StandMetricsReport | null;
}

/** Стенд поднялся и слушает: адрес игрового эндпоинта известен только ему. */
export interface StandReadyLine {
  readonly t: 'ready';
  readonly port: number;
  readonly players: readonly string[];
  readonly buildId: string;
  readonly contentPackHash: string;
}

/** Исход команды (D2): каждая команда получает ответную линию со своим номером. */
export interface StandResultLine {
  readonly t: 'result';
  readonly id: number;
  readonly ok: boolean;
  /** Названная причина отказа; пустая строка — отказа не было. */
  readonly reason: string;
}

export type StandLine = StandReportLine | StandReadyLine | StandResultLine;

/** Команда агента стенду (D2, SRV-5). */
export const STAND_COMMANDS = [
  'disconnect-player',
  'bar-slot',
  'unbar-slot',
  'pause',
  'resume',
  /** Подписка на детали: без неё отчёт метрик не собирается (D9). */
  'subscribe',
  'unsubscribe',
  'stop',
] as const;

export type StandCommandKind = (typeof STAND_COMMANDS)[number];

export interface StandCommand {
  readonly id: number;
  readonly cmd: StandCommandKind;
  /** Слот операции; `-1` — операция матча целиком (пауза, возобновление, стоп). */
  readonly slot: number;
}

/**
 * Управляющая линия в stdout: маркер плюс компактный JSON.
 *
 * Перевод строки стоит и ПЕРЕД маркером. Стенд — не единственный, кто пишет в
 * свой stdout: библиотеки печатают баннеры и прогресс, и написанное без
 * завершающего перевода склеилось бы с маркером — линия перестала бы начинаться
 * с него, разбор счёл бы её обычным логом, и отчёт исчез бы без единой ошибки.
 * Пустая строка агенту ничего не стоит: он их отбрасывает.
 */
export function encodeStandLine(line: StandLine): string {
  return `\n${CONTROL_LINE_PREFIX}${JSON.stringify(line)}\n`;
}

/**
 * Разбор строки stdout стенда: управляющая линия либо `undefined` — обычная
 * строка лога. Отсутствие маркера НЕ является ошибкой: лог и управляющий поток
 * идут одним каналом, и это единственное, что их различает.
 */
export function decodeStandLine(raw: string): StandLine | undefined {
  if (!raw.startsWith(CONTROL_LINE_PREFIX)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(CONTROL_LINE_PREFIX.length));
  } catch {
    // Битая управляющая линия — не отчёт: молча принять её значило бы показать
    // админу состояние, которого стенд не сообщал.
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const line = parsed as { t?: unknown };
  if (line.t !== 'report' && line.t !== 'ready' && line.t !== 'result') return undefined;
  return parsed as StandLine;
}

/** Команда в stdin стенда: JSON-линия без маркера — направление тут одно. */
export function encodeStandCommand(command: StandCommand): string {
  return `${JSON.stringify(command)}\n`;
}

/**
 * Разбор команды на стороне стенда. Незнакомая команда и кривой номер — `undefined`,
 * а не подставленное умолчание: команда, понятая наполовину, означала бы
 * админ-операцию, которой никто не просил.
 */
export function decodeStandCommand(raw: string): StandCommand | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const source = parsed as { id?: unknown; cmd?: unknown; slot?: unknown };
  if (typeof source.id !== 'number' || !Number.isInteger(source.id) || source.id < 1) return undefined;
  if (typeof source.cmd !== 'string') return undefined;
  if (!(STAND_COMMANDS as readonly string[]).includes(source.cmd)) return undefined;
  const slot = typeof source.slot === 'number' && Number.isInteger(source.slot) ? source.slot : -1;
  return { id: source.id, cmd: source.cmd as StandCommandKind, slot };
}
