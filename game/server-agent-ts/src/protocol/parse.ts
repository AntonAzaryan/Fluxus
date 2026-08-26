/**
 * Разбор сообщений управляющего протокола (SRV-2, решение D3).
 *
 * Разбор живёт рядом со словарём и отдельно от обеих сторон — по той же причине,
 * по которой он вынесен из сервера матча (`protocol/messages.ts` пакета net):
 * сообщение с провода недоверенное, и граница, на которой оно становится
 * доверенным, обязана быть ОДНА. Управляющий канал недоверен вдвойне: за ним
 * стоят операции над чужими процессами.
 *
 * Незнакомый тип, отсутствующее поле и значение вне закрытого перечня —
 * НАЗВАННЫЙ отказ (`ControlProtocolError` с причиной из `REFUSAL_REASONS`), а не
 * умолчание: молча подставленное значение здесь означало бы админ-операцию,
 * которой никто не просил.
 */
import {
  ADMIN_OPS,
  MATCH_PHASES,
  PAUSE_STATES,
  REFUSAL_REASONS,
  SERVER_STATES,
  SLOT_STATUSES,
  type AdminOp,
  type ControlRequest,
  type ControlResponse,
  type MatchPhase,
  type PauseStateView,
  type RefusalReason,
  type ServerEntry,
  type ServerMetricsView,
  type ServerState,
  type SlotStatus,
  type SlotView,
  type StartParams,
} from './messages.js';

/** Отказ разбора: несёт причину, которая уедет клиенту названной (SRV-2). */
export class ControlProtocolError extends Error {
  readonly reason: RefusalReason;

  constructor(message: string, reason: RefusalReason = 'malformed') {
    super(message);
    this.name = 'ControlProtocolError';
    this.reason = reason;
  }
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ControlProtocolError(`${what}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

/** Строка поля; отсутствие — пустая строка: «поля нет» и «поле пустое» здесь одно. */
function text(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new ControlProtocolError(`${what}: поле "${key}" — строка`);
  return value;
}

function int(source: Record<string, unknown>, key: string, what: string, lo: number, hi: number): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) {
    throw new ControlProtocolError(`${what}: поле "${key}" — целое в [${lo}, ${hi}]`);
  }
  return value;
}

/**
 * Неотрицательное КОНЕЧНОЕ число: миллисекунды замера бывают дробными
 * (`performance.now()` отдаёт доли), и требовать от них целочисленности значило
 * бы отвергать честный отчёт. Целыми остаются счётчики и номера.
 */
function amount(source: Record<string, unknown>, key: string, what: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ControlProtocolError(`${what}: поле "${key}" — неотрицательное число`);
  }
  return value;
}

function optionalAmount(source: Record<string, unknown>, key: string, what: string): number | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  return amount(source, key, what);
}

function optionalInt(source: Record<string, unknown>, key: string, what: string): number | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  return int(source, key, what, 0, Number.MAX_SAFE_INTEGER);
}

function flag(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ControlProtocolError(`${what} — одно из: ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Номер операции: по нему клиент сопоставляет исход с запросом (SRV-2). */
function idOf(source: Record<string, unknown>, what: string): number {
  return int(source, 'id', what, 1, Number.MAX_SAFE_INTEGER);
}

function serverOf(source: Record<string, unknown>, what: string): string {
  const id = text(source, 'server', what);
  if (id === '') throw new ControlProtocolError(`${what}: поле "server" — непустая строка`);
  return id;
}

/** Разбор запроса клиента. Одна дверь на весь входящий поток агента. */
export function parseControlRequest(value: unknown): ControlRequest {
  const source = object(value, 'сообщение');
  const t = source.t;
  switch (t) {
    case 'hello':
      return {
        t: 'hello',
        protocol: int(source, 'protocol', 'hello', 0, Number.MAX_SAFE_INTEGER),
        token: text(source, 'token', 'hello'),
        pairingCode: text(source, 'pairingCode', 'hello'),
        label: text(source, 'label', 'hello'),
      };
    case 'list':
      return { t: 'list', id: idOf(source, 'list') };
    case 'matches':
      return { t: 'matches', id: idOf(source, 'matches') };
    case 'start':
      return { t: 'start', id: idOf(source, 'start'), params: startParams(source.params) };
    case 'stop':
      return { t: 'stop', id: idOf(source, 'stop'), server: serverOf(source, 'stop') };
    case 'stop-all':
      return { t: 'stop-all', id: idOf(source, 'stop-all') };
    case 'subscribe':
      return { t: 'subscribe', id: idOf(source, 'subscribe'), server: serverOf(source, 'subscribe') };
    case 'unsubscribe':
      return {
        t: 'unsubscribe',
        id: idOf(source, 'unsubscribe'),
        server: serverOf(source, 'unsubscribe'),
      };
    case 'admin':
      return {
        t: 'admin',
        id: idOf(source, 'admin'),
        server: serverOf(source, 'admin'),
        op: oneOf<AdminOp>(source.op, ADMIN_OPS, 'admin: поле "op"'),
        // `-1` — операция матча целиком (пауза): слота у неё нет и выдумывать
        // его нельзя, иначе пауза выглядела бы адресованной слоту 0.
        slot: int(source, 'slot', 'admin', -1, Number.MAX_SAFE_INTEGER),
      };
    case 'log':
      return { t: 'log', id: idOf(source, 'log'), server: serverOf(source, 'log') };
    case 'tokens':
      return { t: 'tokens', id: idOf(source, 'tokens') };
    case 'revoke':
      return { t: 'revoke', id: idOf(source, 'revoke'), token: text(source, 'token', 'revoke') };
    default:
      // Молча проигнорированное сообщение отлаживается по эффекту, а не по
      // сообщению, — тот же принцип, что в игровом протоколе (NTR-4).
      throw new ControlProtocolError(
        `неизвестный тип сообщения: ${JSON.stringify(t)}`,
        'unknown-message',
      );
  }
}

function startParams(value: unknown): StartParams {
  const source = object(value, 'start.params');
  const match = text(source, 'match', 'start.params');
  if (match === '') throw new ControlProtocolError('start.params: поле "match" — непустая строка');
  return {
    match,
    // `0` легален и означает «порт: авто» (риск дизайна «два сервера на один
    // порт»): молчаливое переназначение ЯВНО заданного порта было бы хуже
    // занятого порта — админ увидел бы сервер не там, где просил.
    port: int(source, 'port', 'start.params', 0, 65535),
    bot: text(source, 'bot', 'start.params'),
    botFillMs: optionalInt(source, 'botFillMs', 'start.params'),
    // Политика разрыва — из ЗАКРЫТОГО набора (SES-2, `standPolicy`), а не
    // свободная строка: стенд принимает флаги в форме `--name=value`, и
    // токен-несущее значение (`--bot=/etc/passwd`) впрыснуло бы флаг, которого
    // протокол не объявлял, обойдя проверку путей `match`/`bot`. Каждое
    // перечислимое поле набора проверяется `oneOf` — это была единственная дыра.
    onDisconnect:
      source.onDisconnect === undefined || source.onDisconnect === ''
        ? ''
        : oneOf(source.onDisconnect, ['bot', 'hold', 'pause'], 'start.params: поле "onDisconnect"'),
    autoRestart: flag(source, 'autoRestart'),
  };
}

// -------------------------------------------------------- ответы агента

function slotView(value: unknown): SlotView {
  const source = object(value, 'слот');
  const rtt = object(source.rtt ?? {}, 'слот.rtt');
  const kind = oneOf(rtt.kind ?? 'unsupported', ['measured', 'pending', 'unsupported'], 'слот.rtt.kind');
  return {
    slot: int(source, 'slot', 'слот', 0, Number.MAX_SAFE_INTEGER),
    playerId: text(source, 'playerId', 'слот'),
    status: oneOf<SlotStatus>(source.status, SLOT_STATUSES, 'слот: поле "status"'),
    role: source.role === 'owner' || source.role === 'substitute' ? source.role : null,
    rtt: kind === 'measured' ? { kind, ms: amount(rtt, 'ms', 'слот.rtt') } : { kind },
    // Миллисекунды отклика и круга — замеры, а не счётчики: дробные значения
    // здесь законны (NTR-11), и целочисленности от них никто не обещал.
    serverResponseMs: optionalAmount(source, 'serverResponseMs', 'слот'),
    applied: int(source, 'applied', 'слот', 0, Number.MAX_SAFE_INTEGER),
    predicted: int(source, 'predicted', 'слот', 0, Number.MAX_SAFE_INTEGER),
    late: int(source, 'late', 'слот', 0, Number.MAX_SAFE_INTEGER),
    snapshotBytes: int(source, 'snapshotBytes', 'слот', 0, Number.MAX_SAFE_INTEGER),
  };
}

function serverEntry(value: unknown): ServerEntry {
  const source = object(value, 'запись реестра');
  const slots = source.slots;
  if (!Array.isArray(slots)) throw new ControlProtocolError('запись реестра: поле "slots" — массив');
  return {
    id: serverOf({ server: source.id }, 'запись реестра'),
    state: oneOf<ServerState>(source.state, SERVER_STATES, 'запись реестра: поле "state"'),
    address: text(source, 'address', 'запись реестра'),
    port: int(source, 'port', 'запись реестра', 0, 65535),
    match: text(source, 'match', 'запись реестра'),
    phase: source.phase === null || source.phase === undefined
      ? null
      : oneOf<MatchPhase>(source.phase, MATCH_PHASES, 'запись реестра: поле "phase"'),
    pause: source.pause === null || source.pause === undefined
      ? null
      // Набор ОДИН — тот же, что у сервера матча (`netcode-transport` NTR-20):
      // переписанный здесь литералом, он разошёлся бы с ним молча на проводе, а
      // не ошибкой типов, — как и говорит комментарий у самой константы.
      : oneOf<PauseStateView>(source.pause, PAUSE_STATES, 'запись реестра: поле "pause"'),
    restarts: int(source, 'restarts', 'запись реестра', 0, Number.MAX_SAFE_INTEGER),
    exitCode: typeof source.exitCode === 'number' ? source.exitCode : null,
    postmortem: typeof source.postmortem === 'string' ? source.postmortem : null,
    postmortemFailure: typeof source.postmortemFailure === 'string' ? source.postmortemFailure : null,
    joinUrl: text(source, 'joinUrl', 'запись реестра'),
    slots: slots.map(slotView),
  };
}

function strings(value: unknown, what: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ControlProtocolError(`${what} — массив строк`);
  }
  return value as readonly string[];
}

/** Симметричный разбор на клиенте: агент недоверен ровно в той мере, в какой недоверен провод. */
export function parseControlResponse(value: unknown): ControlResponse {
  const source = object(value, 'сообщение');
  switch (source.t) {
    case 'welcome': {
      const agent = object(source.agent ?? {}, 'welcome.agent');
      return {
        t: 'welcome',
        protocol: int(source, 'protocol', 'welcome', 0, Number.MAX_SAFE_INTEGER),
        agent: {
          buildId: text(agent, 'buildId', 'welcome.agent'),
          contentPackHash: text(agent, 'contentPackHash', 'welcome.agent'),
          distribution: text(agent, 'distribution', 'welcome.agent'),
        },
        fingerprint: text(source, 'fingerprint', 'welcome'),
        token: text(source, 'token', 'welcome'),
      };
    }
    case 'refused':
      return {
        t: 'refused',
        id: int(source, 'id', 'refused', 0, Number.MAX_SAFE_INTEGER),
        reason: oneOf<RefusalReason>(source.reason, REFUSAL_REASONS, 'refused: поле "reason"'),
        detail: text(source, 'detail', 'refused'),
      };
    case 'result': {
      const servers = source.servers;
      const tokens = source.tokens;
      if (!Array.isArray(servers)) throw new ControlProtocolError('result: поле "servers" — массив');
      if (!Array.isArray(tokens)) throw new ControlProtocolError('result: поле "tokens" — массив');
      return {
        t: 'result',
        id: idOf(source, 'result'),
        servers: servers.map(serverEntry),
        matches: strings(source.matches, 'result.matches'),
        log: strings(source.log, 'result.log'),
        tokens: tokens.map((entry) => {
          const token = object(entry, 'result.tokens[]');
          return {
            id: text(token, 'id', 'result.tokens[]'),
            label: text(token, 'label', 'result.tokens[]'),
            issuedAt: int(token, 'issuedAt', 'result.tokens[]', 0, Number.MAX_SAFE_INTEGER),
          };
        }),
        server: text(source, 'server', 'result'),
      };
    }
    case 'event': {
      const metrics = source.metrics;
      return {
        t: 'event',
        event: oneOf(source.event, ['changed', 'removed'], 'event: поле "event"'),
        server: serverEntry(source.server),
        metrics: metrics === null || metrics === undefined ? null : metricsView(metrics),
        log: strings(source.log, 'event.log'),
      };
    }
    default:
      throw new ControlProtocolError(
        `неизвестный тип сообщения: ${JSON.stringify(source.t)}`,
        'unknown-message',
      );
  }
}

function metricsView(value: unknown): ServerMetricsView {
  const source = object(value, 'event.metrics');
  const number = (key: string): number => {
    const raw = source[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      throw new ControlProtocolError(`event.metrics: поле "${key}" — неотрицательное число`);
    }
    return raw;
  };
  return {
    tickP99Ms: number('tickP99Ms'),
    tickMeanMs: number('tickMeanMs'),
    broadcastP99Ms: number('broadcastP99Ms'),
    snapshotsSent: number('snapshotsSent'),
    bytesSent: number('bytesSent'),
    eventLoopDelayMs: number('eventLoopDelayMs'),
    rssBytes: number('rssBytes'),
  };
}
