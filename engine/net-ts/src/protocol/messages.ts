/**
 * Закрытый набор сообщений протокола (NTR-4) и разбор входящего.
 *
 * Разбор живёт здесь, а не в сервере: сообщение с провода недоверенное, и
 * граница, на которой оно становится доверенным, обязана быть одна. Цена
 * пропущенной проверки видна в ядре: `InputSystem` бросает на неизвестном
 * игроке и на фрейме слота без живой сущности (TICK-5), то есть непроверенный
 * ввод роняет весь матч, включая честного игрока, а не одного отправителя.
 *
 * `playerId` во входящем кадре ввода отсутствует намеренно: личность даёт
 * соединение, а не содержимое сообщения. Поле в кадре означало бы, что клиент
 * вправе назваться чужим слотом, и это пришлось бы отдельно опровергать.
 */
import type { Fixed, InputFrame, PlainSnapshot, ScenarioSpawn } from '@game-mvp/core';

/** Пара версии игры (NET-16): непрозрачный идентификатор сборки и хеш контент-пака (NET-17). */
export interface GameVersion {
  readonly buildId: string;
  readonly contentPackHash: string;
}

/**
 * Исходы отказа во входе. Половина версии названа отдельно (NET-16): «обновить
 * сборку» и «обновить контент» — разные действия игрока, и это единственная
 * причина, по которой версия является парой, а не строкой.
 */
export type RejectReason =
  | 'build-mismatch'
  | 'content-mismatch'
  | 'match-in-progress'
  | 'unknown-player'
  | 'slot-taken'
  | 'observer-not-allowed'
  | 'protocol-error';

export type EndReason = 'player-silent' | 'player-left' | 'server-stopped';

/** Исходы, по которым соединение рвёт сам клиент. Отделены от `RejectReason`: это его решение, не серверное. */
export type ClientCloseReason = 'data-mismatch' | 'rejected' | 'ended' | 'protocol-error';

/**
 * Кадр ввода на проводе (TICK-2) — плоский: `Vec2` разложен в пару полей, чтобы
 * форма кадра не зависела от того, как ядро упаковывает вектор.
 */
export interface WireInput {
  readonly tick: number;
  readonly seq: number;
  readonly moveX: Fixed;
  readonly moveY: Fixed;
  readonly aimDir: Fixed;
  readonly buttons: number;
}

// ------------------------------------------------------------ client → server

export interface HelloMessage {
  readonly type: 'Hello';
  readonly playerId: string;
  readonly version: GameVersion;
  readonly observer: boolean;
}

/**
 * Эпоха живёт на сообщении, а не на `WireInput`: `InputFrame` — контракт ядра
 * (TICK-2), он едет в канонический `inputs[]` и в golden-эталоны, а эпоха —
 * величина слоя матча (NTR-16). Это эпоха, против которой ввод порождён, то
 * есть эпоха последнего применённого клиентом снапшота (NTR-7).
 */
export interface InputMessage {
  readonly type: 'Input';
  readonly epoch: number;
  readonly frames: readonly WireInput[];
}

export interface ByeMessage {
  readonly type: 'Bye';
  readonly reason: string;
}

export type ClientMessage = HelloMessage | InputMessage | ByeMessage;

// ------------------------------------------------------------ server → client

/**
 * Данные конкретного матча (NET-16): сцена названа ссылкой, потому что она —
 * контент-пак, а раздавать контент-пак матча сервер MUST NOT. Стартовая
 * расстановка едет значением: это данные матча, а не правила.
 */
export interface MatchDescriptor {
  readonly sceneRef: string;
  readonly initial: readonly ScenarioSpawn[];
}

export interface Pacing {
  readonly tickRate: number;
  readonly snapshotRate: number;
  readonly inputDelay: number;
  /** Верхняя граница окна приёма ввода в тиках (NTR-7): конечная и заданная конфигом матча, а не клиентом. */
  readonly inputWindow: number;
}

export interface WelcomeMessage {
  readonly type: 'Welcome';
  readonly slot: number;
  readonly players: readonly string[];
  readonly seed: number;
  readonly match: MatchDescriptor;
  readonly worldInitHash: string;
  readonly pacing: Pacing;
}

export interface RejectMessage {
  readonly type: 'Reject';
  readonly reason: RejectReason;
  readonly detail: string;
}

export interface StartMessage {
  readonly type: 'Start';
  readonly tick: number;
}

/**
 * Номер авторитетного состояния — пара `(epoch, tick)` (NTR-16): номер тика при
 * перемотке идёт назад, и один он состояние не называет.
 */
export interface SnapshotMessage {
  readonly type: 'Snapshot';
  readonly epoch: number;
  readonly tick: number;
  readonly snapshot: PlainSnapshot;
}

export interface EndMessage {
  readonly type: 'End';
  readonly reason: EndReason;
  readonly tick: number;
}

export type ServerMessage =
  | WelcomeMessage
  | RejectMessage
  | StartMessage
  | SnapshotMessage
  | EndMessage;

// ------------------------------------------------------------------- разбор

/** Отказ разбора. Несёт исход, который уедет в `Reject` до разрыва (NTR-4). */
export class ProtocolError extends Error {
  readonly reason: RejectReason;

  constructor(message: string, reason: RejectReason = 'protocol-error') {
    super(message);
    this.name = 'ProtocolError';
    this.reason = reason;
  }
}

/** Ширина `buttons` нормирована TICK-2 и здесь только повторяется, а не переопределяется. */
const BUTTONS_MAX = 65535;
/** Границы i32: поля Q16.16 приезжают в контейнере i32 (FP-1). */
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${what}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

function str(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw new ProtocolError(`${what}: поле "${key}" — непустая строка`);
  }
  return value;
}

function int(source: Record<string, unknown>, key: string, what: string, lo: number, hi: number): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) {
    throw new ProtocolError(`${what}: поле "${key}" — целое в [${lo}, ${hi}]`);
  }
  return value;
}

function version(value: unknown): GameVersion {
  const source = object(value, 'Hello.version');
  return {
    buildId: str(source, 'buildId', 'Hello.version'),
    contentPackHash: str(source, 'contentPackHash', 'Hello.version'),
  };
}

/**
 * Кадр ввода с провода. Проверяется всё, на что дальше по стеку полагается
 * ядро: `buttons` в пределах u16 (TICK-2), поля Q16.16 в пределах i32 (FP-1),
 * номер тика и `seq` — неотрицательные целые. Окно допустимых тиков зависит от
 * текущего тика матча и потому проверяется сервером, а не здесь.
 */
function wireInput(value: unknown): WireInput {
  const source = object(value, 'Input.frames[]');
  return {
    tick: int(source, 'tick', 'Input.frames[]', 0, Number.MAX_SAFE_INTEGER),
    seq: int(source, 'seq', 'Input.frames[]', 0, Number.MAX_SAFE_INTEGER),
    moveX: int(source, 'moveX', 'Input.frames[]', I32_MIN, I32_MAX),
    moveY: int(source, 'moveY', 'Input.frames[]', I32_MIN, I32_MAX),
    aimDir: int(source, 'aimDir', 'Input.frames[]', I32_MIN, I32_MAX),
    buttons: int(source, 'buttons', 'Input.frames[]', 0, BUTTONS_MAX),
  };
}

/** Потолок кадров в одном сообщении: пачка на порядок больше буфера задержки — уже не догоняющий клиент, а мусор. */
const MAX_FRAMES_PER_MESSAGE = 64;

export function parseClientMessage(value: unknown): ClientMessage {
  const source = object(value, 'сообщение');
  const type = source['type'];
  switch (type) {
    case 'Hello':
      return {
        type: 'Hello',
        playerId: str(source, 'playerId', 'Hello'),
        version: version(source['version']),
        observer: source['observer'] === true,
      };
    case 'Input': {
      const frames = source['frames'];
      if (!Array.isArray(frames)) throw new ProtocolError('Input: поле "frames" — массив');
      if (frames.length === 0) throw new ProtocolError('Input: пустой массив кадров');
      if (frames.length > MAX_FRAMES_PER_MESSAGE) {
        throw new ProtocolError(`Input: больше ${MAX_FRAMES_PER_MESSAGE} кадров в сообщении`);
      }
      // Эпоха проверяется тем же способом, что и номер тика: целое,
      // неотрицательное. Отсутствующее поле — разрыв соединения (NTR-4), а не
      // умолчание: молча подставленный ноль означал бы, что ввод из стёртой
      // перемоткой ветви истории приезжает помеченным нулевой эпохой и
      // проходит проверку сервера у любого клиента постарше протокола.
      return {
        type: 'Input',
        epoch: int(source, 'epoch', 'Input', 0, Number.MAX_SAFE_INTEGER),
        frames: frames.map(wireInput),
      };
    }
    case 'Bye':
      return { type: 'Bye', reason: typeof source['reason'] === 'string' ? source['reason'] : '' };
    default:
      // Молча проигнорированное сообщение отлаживается по эффекту, а не по
      // сообщению — тот же принцип, по которому `InputSystem` не отбрасывает
      // фрейм без сущности (NTR-4, TICK-5).
      throw new ProtocolError(`неизвестный тип сообщения: ${JSON.stringify(type)}`);
  }
}

/** Симметричный разбор на клиенте: сервер тоже недоверен ровно в той мере, в какой недоверен провод. */
export function parseServerMessage(value: unknown): ServerMessage {
  const source = object(value, 'сообщение');
  const type = source['type'];
  switch (type) {
    case 'Welcome': {
      const match = object(source['match'], 'Welcome.match');
      const initial = match['initial'];
      const players = source['players'];
      const pacing = object(source['pacing'], 'Welcome.pacing');
      if (!Array.isArray(players) || players.some((p) => typeof p !== 'string')) {
        throw new ProtocolError('Welcome: поле "players" — массив строк');
      }
      if (!Array.isArray(initial)) throw new ProtocolError('Welcome.match: поле "initial" — массив');
      return {
        type: 'Welcome',
        slot: int(source, 'slot', 'Welcome', 0, players.length - 1),
        players: players as readonly string[],
        seed: int(source, 'seed', 'Welcome', I32_MIN, I32_MAX),
        match: {
          sceneRef: str(match, 'sceneRef', 'Welcome.match'),
          initial: initial as readonly ScenarioSpawn[],
        },
        worldInitHash: str(source, 'worldInitHash', 'Welcome'),
        pacing: {
          tickRate: int(pacing, 'tickRate', 'Welcome.pacing', 1, 1000),
          snapshotRate: int(pacing, 'snapshotRate', 'Welcome.pacing', 1, 1000),
          inputDelay: int(pacing, 'inputDelay', 'Welcome.pacing', 0, 1000),
          inputWindow: int(pacing, 'inputWindow', 'Welcome.pacing', 0, 1000),
        },
      };
    }
    case 'Reject':
      return {
        type: 'Reject',
        reason: str(source, 'reason', 'Reject') as RejectReason,
        detail: typeof source['detail'] === 'string' ? source['detail'] : '',
      };
    case 'Start':
      return { type: 'Start', tick: int(source, 'tick', 'Start', 0, Number.MAX_SAFE_INTEGER) };
    case 'Snapshot':
      return {
        type: 'Snapshot',
        epoch: int(source, 'epoch', 'Snapshot', 0, Number.MAX_SAFE_INTEGER),
        tick: int(source, 'tick', 'Snapshot', 0, Number.MAX_SAFE_INTEGER),
        snapshot: object(source['snapshot'], 'Snapshot.snapshot') as unknown as PlainSnapshot,
      };
    case 'End':
      return {
        type: 'End',
        reason: str(source, 'reason', 'End') as EndReason,
        tick: int(source, 'tick', 'End', 0, Number.MAX_SAFE_INTEGER),
      };
    default:
      throw new ProtocolError(`неизвестный тип сообщения: ${JSON.stringify(type)}`);
  }
}

/** Кадр с провода становится каноническим вводом ядра, получая личность от соединения (NTR-7). */
export function toInputFrame(wire: WireInput, playerId: string, tick: number): InputFrame {
  return {
    tick,
    playerId,
    seq: wire.seq,
    move: { x: wire.moveX, y: wire.moveY },
    aimDir: wire.aimDir,
    buttons: wire.buttons,
  };
}
