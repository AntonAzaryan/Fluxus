/**
 * Клиент матча (NTR-10): шлёт ввод, применяет authoritative-снапшоты, ничего не
 * симулирует. `tick()` отсюда не вызывается — предсказания пока нет.
 *
 * Как и сервер, это чистый цикл без ввода-вывода: сообщения приходят вызовом,
 * исходящие забираются `drain()`, момент времени приезжает аргументом. Часов
 * внутри нет по той же причине, что у сервера, — иначе матч не прогнать в тесте.
 *
 * Шов под предсказание (NET-2/4/5) держится двумя вещами, и обе нужны уже
 * сейчас: кольцо своих кадров (метрика отклика) и локально поднятый `worldInit`
 * (сверка хешей, NTR-5). Включение предсказания добавит цикл симуляции, а
 * протокол не тронет: клиент с предсказанием и без для сервера неразличимы,
 * потому что оба шлют только ввод (NET-7).
 */
import {
  snapshotFromPlain,
  type ComponentSchema,
  type Fixed,
  type InputFrame,
  type PhysicsOptions,
  type PlainSnapshot,
  type SceneDef,
  type Snapshot,
  type Vec2,
  type NavigationOptions,
  type VisibilityOptions,
  type WorldMode,
  type WorldState,
} from '@fluxus/core';
import { buildMatchWorld, orderedSchemas } from '../match/world.js';
import { createClientMetrics, recordInputToVisible, type ClientMetrics } from '../metrics.js';
import { ownInputSeq } from './echo.js';
import { InputRing, DEFAULT_RING_TICKS } from './inputRing.js';
import { LeadController } from './lead.js';
import {
  InterpolationBuffer,
  type InterpolationSample,
  type PresentedState,
} from './interpolation.js';
import type {
  ClientCloseReason,
  ClientMessage,
  ConnectionRole,
  EventBatch,
  EventsMessage,
  GameVersion,
  MatchDescriptor,
  Pacing,
  ServerMessage,
  WireSnapshot,
} from '../protocol/messages.js';
import { applyPause, frozenByMatch, type DeliveredPause } from './pause.js';

/** Контент-пак клиента: сцена резолвится по ссылке локально — сервер её не раздаёт (NET-16). */
export interface ContentPack {
  scene(sceneRef: string): SceneDef | undefined;
}

export interface MatchClientOptions {
  readonly playerId: string;
  readonly version: GameVersion;
  readonly content: ContentPack;
  /**
   * Роль соединения в слоте (NTR-18). Отсутствие поля — `owner`: клиент входит
   * за СВОЙ слот, пока сборка не сказала обратного, и заместителем становятся
   * намеренно (`bot-player` BOT-14), а не по невнимательности.
   *
   * Умолчание живёт здесь и только здесь: на проводе поле обязательно (NTR-4),
   * и разбор входящего умолчаний не знает.
   */
  readonly role?: ConnectionRole;
  readonly observer?: boolean;
  /** Зависимости сборки (DI-3): приезжают со сборкой клиента, а не с провода. */
  readonly physics?: PhysicsOptions;
  readonly visibility?: VisibilityOptions;
  /**
   * Включение и параметры поиска пути (NTR-14): зависимость сборки наравне с
   * физикой и пересчётом видимости, приезжает из одного описания матча обеим
   * сторонам — иначе предсказание водило бы NPC не там, где сервер.
   */
  readonly navigation?: NavigationOptions;
  readonly inputRingTicks?: number;
  readonly interpolationDelayMs?: number;
  /**
   * Бит действия, которым ведётся скраб перемотки (NET-11) — тот же номер, что
   * у `rewind.holdButton` матча. Пока доставленный мир не в `Running`, кадры
   * уезжают с ЭТИМ битом и ни с чем больше (см. `pushInput`).
   *
   * Поля нет — маска пуста: клиент сборки без ульты отката шлёт в замороженном
   * мире пустые кадры. Держать здесь номер, а не «маску», намеренно: раскладку
   * битов знает сборка игры, и она же настраивает ею сервер.
   */
  readonly holdButton?: number;
  /** Имена компонентов ввода и слота — параметры `InputSystem` (TICK-4), не конвенция ядра. */
  readonly playerComponent?: string;
  readonly slotField?: string;
  readonly inputComponent?: string;
}

export interface InputSample {
  readonly move: Vec2;
  readonly aimDir: Fixed;
  /**
   * Точка прицела (TICK-2); `undefined` — источник точкой не владел. Поле
   * необязательно ровно затем, чтобы «прицела нет» и «прицел в начале
   * координат» оставались разными высказываниями.
   */
  readonly target?: Vec2;
  readonly buttons: number;
}

/**
 * Доставка состояния рендеру: пара снапшотов с долей между ними (NET-3) плюс
 * признак разрыва непрерывности.
 *
 * Признак едет ИМЕННО здесь, а не рядом отдельным вызовом: «Признаки разрыва
 * непрерывности (rewind/replay, смена режима мира) SHALL передаваться в
 * доставке состояния» (`client-shell` SHELL-7). Состояние и указание рисовать
 * его snap'ом обязаны приезжать вместе, иначе между чтением одного и другого
 * появляется окно, в котором рендер уже знает новое состояние, но ещё не знает,
 * что интерполировать к нему нечего (REND-2).
 */
export interface MatchSample extends InterpolationSample {
  /** Состояние принадлежит другой ветви истории — рисовать snap'ом (SHELL-7, NTR-10). */
  readonly discontinuity: boolean;
}

/**
 * Факты одного тика, доставленные потребителю (NTR-15): пачка провода вместе с
 * эпохой своего диапазона. Номер тика едет с фактом, потому что картинка
 * отстаёт на буфер интерполяции (NET-3), и без него звук и VFX не с чем
 * совместить; эпоха — потому что один номер тика после перемотки называет два
 * разных момента матча (NTR-16).
 *
 * Порядок событий внутри пачки — порядок публикации (EVT-2) и сохранён как
 * приехал: сетевой слой его не пересортировывает, иначе представление получило
 * бы меньше, чем знает симуляция.
 */
export interface DeliveredEvents extends EventBatch {
  readonly epoch: number;
}

export type ClientPhase = 'greeting' | 'lobby' | 'playing' | 'closed';

/** Движение в замороженном мире: его нет вовсе (NET-11). Общий литерал — кадр его не мутирует. */
const FROZEN_MOVE: Vec2 = { x: 0, y: 0 };

export class MatchClient {
  readonly metrics: ClientMetrics = createClientMetrics();

  private readonly options: MatchClientOptions;
  private readonly ring: InputRing;
  private readonly buffer: InterpolationBuffer;
  private readonly outbox: ClientMessage[] = [];

  private clientPhase: ClientPhase = 'greeting';
  private reason: ClientCloseReason | undefined;
  private detail = '';

  private assignedSlot: number | undefined;
  private matchPacing: Pacing | undefined;
  private descriptor: MatchDescriptor | undefined;
  /**
   * Адаптивный запас разметки ввода (NTR-7): им помечается кадр вместо
   * константы `inputDelay`. Заводится вместе с темпом матча — границы и
   * стартовое значение приезжают в `Welcome`, и до него запаса не существует.
   *
   * Смену эпохи он переживает (NTR-16, design D3): запас — свойство канала, а
   * не ветви истории, и перемотка о дороге до сервера ничего не сообщает.
   * Переподключение — не переживает и не должно: возвращение поднимает НОВЫЙ
   * `MatchClient` (NTR-17), канал после разрыва мог смениться, и накопленное
   * значение было бы утверждением о канале, которого больше нет.
   */
  private leadControl: LeadController | undefined;

  /** Локально поднятый мир матча: даёт хеш для сверки и порядок компонентов для разбора снапшота. */
  private localWorld: WorldState | undefined;
  private localHash: string | undefined;
  private schemas: ComponentSchema[] | undefined;

  private estimatedTick = 0;
  private lastAppliedTick = -1;
  /**
   * Эпоха последнего применённого снапшота (NTR-16). До первого снапшота — 0:
   * матч начинается нулевой эпохой, и кадр, отправленный до первой рассылки,
   * помечен ею же.
   */
  private lastAppliedEpoch = 0;
  /**
   * Режим последнего применённого состояния (WSM-1). Наблюдательная величина:
   * своей машины состояний у клиента нет и быть не может (NET-11, REW-6), а
   * этот режим — то, что сервер о мире сообщил. Читает его маска ввода
   * замороженного мира (`pushInput`). До первого снапшота — `Running`: матч
   * начинается идущим миром.
   */
  private lastAppliedMode: WorldMode = 'Running';
  /** Разрыв непрерывности мира: взведён сменой эпохи, гасится чтением (SHELL-7). */
  private discontinuityPending = false;
  /**
   * Последнее ДОСТАВЛЕННОЕ состояние паузы (NTR-20). Наблюдательная величина, как
   * и режим мира: своей паузы у клиента нет и быть не может — переходы проводит
   * сервер (NET-11), а здесь лежит то, что он о них сообщил.
   *
   * `undefined` — состояния паузы НЕ ДОСТАВЛЯЛИ, и это не то же самое, что
   * «матч идёт»: доставленное «идёт» есть утверждение сервера, а отсутствие —
   * отсутствие утверждения. Потребитель обязан различать их, иначе на первом же
   * кадре он покажет матч идущим, ничего об этом не зная (HUD-9).
   */
  private pauseState: DeliveredPause | undefined;

  /**
   * Курсор потока событий (NTR-15) — пара `(эпоха, тик)` последнего применённого
   * тика, ОТДЕЛЬНАЯ от пары применённого снапшота выше.
   *
   * Раздельность — требование, а не удобство: снапшот отбрасывается по «не
   * больше применённого» (NTR-10), а события того же тика могут быть ещё не
   * применены — например, когда `Events` этой рассылки потерялся, а следующий
   * привёз его повтором уже после того, как снапшот более позднего тика
   * применён. Один курсор на двоих вернул бы потерю с другой стороны.
   *
   * Тик `-1` до первого применённого тика: тики матча неотрицательны, и события
   * тика 0 обязаны пройти курсор.
   */
  private eventEpoch = 0;
  private eventTick = -1;
  /**
   * Было ли применено хоть одно сообщение потока. Разрыв — это «диапазон
   * начался позже, чем кончился ПОСЛЕДНИЙ ПРИМЕНЁННЫЙ», и пока применённого нет,
   * сравнивать не с чем: первое сообщение разрывом не считается, где бы ни
   * начинался его диапазон.
   */
  private eventsSeen = false;
  /**
   * Доставленные факты, ждущие потребителя. Границы у очереди нет намеренно:
   * молча выброшенный факт есть ровно та потеря, против которой NTR-15 написан,
   * а слить очередь — контракт потребителя (`takeEvents`), а не забота слоя.
   */
  private readonly eventQueue: DeliveredEvents[] = [];
  private nextSeq = 1;
  private lastMeasuredSeq = 0;

  constructor(options: MatchClientOptions) {
    this.options = options;
    this.ring = new InputRing(options.inputRingTicks ?? DEFAULT_RING_TICKS);
    this.buffer = new InterpolationBuffer(
      options.interpolationDelayMs === undefined ? {} : { delayMs: options.interpolationDelayMs },
    );
  }

  get phase(): ClientPhase {
    return this.clientPhase;
  }

  get closeReason(): ClientCloseReason | undefined {
    return this.reason;
  }

  get closeDetail(): string {
    return this.detail;
  }

  get slot(): number | undefined {
    return this.assignedSlot;
  }

  get pacing(): Pacing | undefined {
    return this.matchPacing;
  }

  get worldInitHash(): string | undefined {
    return this.localHash;
  }

  get serverTick(): number {
    return this.estimatedTick;
  }

  /**
   * Последнее применённое состояние — вход для рендера и для проверок, в
   * презентационной проекции: снапшот БЕЗ шины (`PresentedState`, NTR-15).
   *
   * Шина в кадре на проводе остаётся и в буфере хранится: это состояние,
   * восстанавливаемое вместе с миром (SNAP-1). Наружу её не отдаёт ни этот
   * геттер, ни `sample()` — единственный источник фактов для представления
   * `takeEvents()`, и «не открывать шину вовсе» (задача 4.4) держится типом, а
   * не примечанием в документации.
   */
  get latest(): PresentedState | undefined {
    return this.buffer.latest;
  }

  /** Эпоха последнего применённого состояния (NTR-16) — вторая половина его номера. */
  get epoch(): number {
    return this.lastAppliedEpoch;
  }

  /**
   * Режим последнего применённого состояния (WSM-1). Наблюдательный: клиент им
   * ничего не решает о мире — только маскирует свой ввод, пока мир не идёт
   * (NET-11).
   */
  get mode(): WorldMode {
    return this.lastAppliedMode;
  }

  /**
   * Доставленное состояние паузы матча (NTR-20); `undefined` — не доставляли.
   * Придумывать его потребителю не из чего: молчание канала — картина сбоя
   * сети, а не паузы (HUD-9).
   */
  get pause(): DeliveredPause | undefined {
    return this.pauseState;
  }

  /**
   * Запрос паузы и снятия (NTR-20) — обратным каналом, тем же соединением, что
   * и ввод. Отдельным сообщением, а не битом ввода: кадры замороженного мира
   * сервер отбрасывает целиком (NET-11), и «снять паузу» не доехало бы ровно в
   * том состоянии, ради которого посылается.
   *
   * Из ЛОББИ запрос уезжает наравне с идущим матчем, и это не послабление:
   * соединение там уже сидит в слоте (`seat` ставит игровую фазу до `Welcome`),
   * поэтому сервер отвечает ему именованным отказом `match-not-running`, а не
   * разрывом. Проглоти этот вызов клиент — игрок, жмущий «Пауза» в ожидании
   * противника, не получил бы НИЧЕГО: ни паузы, ни причины, — а «именованный
   * отказ политики SHALL показываться игроку, а не теряться» (HUD-9).
   *
   * Не уезжает он ровно из двух состояний, и оба не про политику: до хендшейка
   * сообщение недопустимо для состояния соединения и рвёт его (NTR-4), а после
   * закрытия слать некуда.
   */
  requestPause(action: 'pause' | 'resume'): void {
    if (this.clientPhase === 'greeting' || this.clientPhase === 'closed') return;
    this.outbox.push({ type: 'PauseRequest', action });
  }

  /**
   * Признак разрыва непрерывности, взведённый сменой эпохи (NTR-10): состояние
   * принадлежит другой ветви истории, промежуточных положений между ним и
   * предыдущим не существовало, и рисовать его нужно snap'ом (`client-shell`
   * SHELL-7, `rendering` REND-2).
   *
   * Потребителей состояния два, и признак ездит к обоим одинаково — вместе с
   * состоянием и гасясь чтением. Потребитель, берущий состояние `sample()`,
   * читает признак в поле `discontinuity` самого сэмпла и этот метод не зовёт
   * вовсе. Этот метод — для второго: того, кто рисует по `latest`, минуя буфер
   * интерполяции (RenderBridge оболочки). Гасит признак тот, кто первым взял
   * состояние: два независимых потребителя одного клиента поделили бы один
   * признак и один из них нарисовал бы «проезд» между ветвями истории.
   * Подглядеть, не гася, — `discontinuous`.
   *
   * Соседние состояния ОДНОГО скраба разрывом не считаются, хотя эпоха между
   * ними и растёт: непрерывный обратный ход интерполируется как живые тики
   * (REND-2), а snap остаётся входу в перемотку, выходу из неё и любой другой
   * смене ветви (см. `onSnapshot`).
   */
  takeDiscontinuity(): boolean {
    const pending = this.discontinuityPending;
    this.discontinuityPending = false;
    return pending;
  }

  /** Тот же признак, но без гашения — для диагностики и проверок. */
  get discontinuous(): boolean {
    return this.discontinuityPending;
  }

  /**
   * Факты, доставленные с прошлого вызова (NTR-15), по возрастанию пары
   * `(эпоха, тик)`; внутри тика — в присланном порядке публикации (EVT-2).
   *
   * Наблюдаемый выход клиента — принятые снапшоты и счётчики (NTR-12), и
   * поток событий встаёт туда же третьим наблюдаемым: не рядом с состоянием, а
   * рядом с ним. Отдельно от `sample()` он именно потому, что сэмпл — состояние
   * на момент времени, отдаваемое буфером интерполяции и не отдаваемое вовсе,
   * пока буфер не набрался; факт же однократен, и связать его доставку с
   * готовностью буфера значило бы терять факты ровно там, где картинка ещё не
   * поехала. Когда проигрывать факт относительно интерполированной картинки —
   * политика потребителя (REND-2), и механизм её не выбирает: он отдаёт факт с
   * номером тика.
   *
   * Слив, а не подписка и не накопление: очередь пустеет чтением, и потому
   * каждый факт достаётся потребителю ровно один раз — то же правило и по той
   * же причине, что у `takeDiscontinuity()`. Подглядеть, не сливая, —
   * `pendingEvents`.
   *
   * Единственный источник фактов — этот метод (NTR-15, «Шина внутри
   * снапшота»). Шина остаётся в кадре на проводе и в буфере как СОСТОЯНИЕ,
   * восстанавливаемое вместе с миром (SNAP-1), но презентационная поверхность
   * её не отдаёт: и `latest`, и `sample()` дают `PresentedState` — снапшот без
   * шины. Прочитай представление шину — события тиков рассылки проигрались бы
   * дважды.
   *
   * Факты стёртой перемоткой ветви, уже попавшие в очередь и ещё не слитые,
   * потребителю ДОЕДУТ: очередь — доставленное, а не предсказание того, что
   * доставку переживёт. Отличить их даёт `DeliveredEvents.epoch`, и решение —
   * проиграть или выбросить — принимает потребитель (решение 8 дизайна): для
   * него граница эпохи и так разрыв, рисуемый snap'ом (SHELL-7).
   */
  takeEvents(): DeliveredEvents[] {
    if (this.eventQueue.length === 0) return [];
    return this.eventQueue.splice(0, this.eventQueue.length);
  }

  /** Та же очередь, но без слива — для диагностики и проверок. */
  get pendingEvents(): readonly DeliveredEvents[] {
    return this.eventQueue;
  }

  /**
   * Предъявление версии (NET-16) — первое, что уходит в соединение.
   *
   * Реконнект в идущий матч (NTR-17) идёт этим же путём и другого не имеет:
   * клиент одноразовый, и возвращение — это НОВЫЙ клиент с чистыми курсорами,
   * пустым буфером интерполяции и оценкой тика, которую синхронизирует первый
   * принятый снапшот. «Оживление» старого инстанса потребовало бы вручную
   * сбрасывать каждый курсор и доказывать полноту сброса.
   */
  start(): void {
    this.outbox.push({
      type: 'Hello',
      playerId: this.options.playerId,
      version: this.options.version,
      role: this.options.role ?? 'owner',
      observer: this.options.observer === true,
    });
  }

  drain(): ClientMessage[] {
    if (this.outbox.length === 0) return [];
    return this.outbox.splice(0, this.outbox.length);
  }

  /**
   * Состояние на момент `nowMs` вместе с признаком разрыва (SHELL-7).
   *
   * Признак гасится ровно тогда, когда сэмпл отдан: доставки состояния не
   * случилось — гасить нечего, и разрыв дождётся следующего вызова. Второй
   * потребитель, читающий `latest` мимо буфера, берёт тот же признак
   * `takeDiscontinuity()`; контракт описан там.
   */
  sample(nowMs: number): MatchSample | undefined {
    const sampled = this.buffer.sample(nowMs);
    if (sampled === undefined) return undefined;
    this.metrics.bufferLagMs = sampled.lagMs;
    return { ...sampled, discontinuity: this.takeDiscontinuity() };
  }

  /**
   * Локальная оценка серверного тика, продвигаемая драйвером в темпе `tickRate`.
   *
   * Компенсации дороги здесь нет НАМЕРЕННО (design D5): оценка значит «где
   * сервер по последнему доказательству» и остаётся привязанной к снапшотам, а
   * запас на дорогу живёт в разметке кадра — адаптивным `lead` (NTR-7). Одно
   * место вместо двух: сложи компенсацию ещё и сюда, и та же величина вошла бы
   * в разметку дважды, а `serverTick` перестал бы означать наблюдение.
   */
  advance(): void {
    // В ЗАМОРОЗКЕ матча оценка стоит. Тиков в ней нет (NTR-20), снапшотов
    // сервер не шлёт — и оценка, идущая своим темпом, уезжает ровно на
    // длительность паузы: полуминутная пауза даёт разницу в 1800 тиков.
    // Пересинхронизация первым снапшотом после возобновления вернёт её назад, но
    // всё это время `serverTick` наблюдаем и просто неверен, кадры уходят
    // помеченными будущим, а те, что были в полёте, ложатся в счётчик
    // «разъехавшейся оценки» (NTR-11) — величину, которая должна говорить о
    // канале, а не о паузе.
    if (this.clientPhase === 'playing' && !frozenByMatch(this.pauseState)) this.estimatedTick++;
  }

  /** Ввод игрока: помечается тиком с адаптивным запасом (NTR-7) и уходит на сервер. */
  pushInput(sample: InputSample, nowMs: number): void {
    const lead = this.leadControl;
    // Запас заводится вместе с темпом матча, поэтому его наличие и есть «темп
    // приехал»: второго условия на `matchPacing` рядом не нужно.
    if (this.clientPhase !== 'playing' || lead === undefined) return;
    // Ввод уезжает и в остановленном мире — но ОДНИМ битом ведения скраба.
    //
    // Молчать нельзя: живых тиков в `Rewinding` нет, и контрольный бит едет
    // ровно этими кадрами — второго канала под управление в протоколе нет и
    // заводить его нельзя (`netcode-transport` NTR-8). Слать всё — тоже:
    // возобновление эпохи не двигает (NTR-16), и кадр, отправленный пока игрок
    // смотрел на замороженный мир, доезжает уже после `resume` с ВЕРНОЙ эпохой
    // и верным будущим тиком — то есть проходит `ingest` и ложится на живой
    // мир. Окно у этой дыры размером в круг до сервера, и глубина отката на неё
    // не влияет: NET-11 запрещает такому вводу влиять на симуляцию после
    // возобновления, кроме управления самой перемоткой (REW-5).
    //
    // Поэтому маска, а не подавление: `move` обнуляется, из кнопок остаётся
    // только бит ведения скраба. Серверное подавление (`ingest` бросает кадры
    // не-`Running` целиком) остаётся авторитетным — это второй рубеж, а не
    // замена первому.
    // Пауза МАТЧА маскирует ввод наравне с заморозкой машины перемотки, и по той
    // же причине: игрок смотрит на замороженный мир, а кадр доезжает уже после
    // возобновления — с верной эпохой и верным будущим тиком, то есть проходит
    // `ingest` и ложится на живой мир. Читать здесь один `lastAppliedMode`
    // нельзя: снапшотов в заморозке нет, и он всю паузу говорит `Running`.
    const frozen = this.lastAppliedMode !== 'Running' || frozenByMatch(this.pauseState);
    const holdMask = this.options.holdButton === undefined ? 0 : 1 << this.options.holdButton;
    const frame: InputFrame = {
      // Разметка адаптивна (NTR-7): `serverTick + lead`, где `lead` начинается
      // с `inputDelay` и растёт, пока кадры не начинают успевать. Константа
      // здесь либо не покрывает длинный канал — весь ввод уходит в predicted, и
      // игрок теряет управление, — либо облагает короткий лишним лагом отклика.
      tick: this.estimatedTick + lead.lead,
      playerId: this.options.playerId,
      seq: this.nextSeq,
      move: frozen ? FROZEN_MOVE : sample.move,
      aimDir: sample.aimDir,
      // Точка прицела маской заморозки не гасится — по тому же основанию, что
      // и `aimDir`: это последнее известное состояние ввода, а не действие
      // (TICK-2), и живых тиков, на которых оно могло бы сработать, в
      // замороженном мире всё равно нет (NET-11).
      ...(sample.target === undefined ? {} : { target: sample.target }),
      buttons: frozen ? sample.buttons & holdMask : sample.buttons,
    };
    this.nextSeq++;
    // Сигнал адаптации даёт только ЖИВАЯ отправка (design D1). Кадр
    // замороженного мира сервер отбрасывает целиком (NET-11), снапшотов в
    // заморозке нет вовсе, и эхо `seq` не отстаёт — оно просто не приходит;
    // счёт такой отправки опозданием поднимал бы запас на паузе, то есть мерил
    // бы длительность заморозки вместо длины канала.
    if (!frozen) {
      // Вместе с тиком разметки: сигнал считается в тиковой шкале, и без неё
      // разность «отправлено — применено» мерила бы часы, а не канал (`lead.ts`).
      lead.sent(frame.seq, frame.tick);
      this.metrics.inputLead = lead.lead;
    }
    // Кольцо хранит кадр вместе с эпохой отправки (NTR-10): кадр стёртой
    // эпохи переотправке не подлежит, но остаётся материалом диагностики.
    this.ring.push(frame, nowMs, this.lastAppliedEpoch);
    // Ввод адресуется парой (NTR-7): номер тика без эпохи не называет тик
    // матча, в котором была перемотка, и кадр из стёртой ветви истории
    // применился бы тем успешнее, чем мельче был откат.
    this.outbox.push({
      type: 'Input',
      epoch: this.lastAppliedEpoch,
      frames: [
        {
          tick: frame.tick,
          seq: frame.seq,
          moveX: frame.move.x,
          moveY: frame.move.y,
          aimDir: frame.aimDir,
          // Плоская пара рядом с движением — форма кадра не зависит от того,
          // как ядро упаковывает вектор (design Decision 12).
          ...(frame.target === undefined
            ? {}
            : { targetX: frame.target.x, targetY: frame.target.y }),
          buttons: frame.buttons,
        },
      ],
    });
    this.metrics.inputsSent++;
  }

  receive(message: ServerMessage, nowMs: number): void {
    if (this.clientPhase === 'closed') return;
    switch (message.type) {
      case 'Welcome':
        this.onWelcome(message.slot, message.players, message.match, message.worldInitHash, message.pacing);
        return;
      case 'Reject':
        this.close('rejected', `${message.reason}: ${message.detail}`);
        return;
      case 'Start':
        // Вход в ИДУЩИЙ матч приходит тем же `Start` и с тем же тиком начала
        // матча (NTR-17): для вернувшегося он не «сейчас», а точка отсчёта
        // матча. Оценку серверного тика ставит на место первый принятый
        // снапшот (`resyncTick`) — вторая оценка «где сейчас сервер» рядом
        // означала бы второй источник одной величины.
        this.clientPhase = 'playing';
        this.estimatedTick = message.tick;
        return;
      case 'Snapshot':
        this.onSnapshot(message.epoch, message.tick, message.snapshot, nowMs);
        return;
      case 'Events':
        this.onEvents(message);
        return;
      case 'Pause':
        // Мира не касается вовсе (NTR-20) — учёт целиком в `pause.ts`.
        this.pauseState = applyPause(this.pauseState, message);
        return;
      case 'End':
        this.close('ended', message.reason);
        return;
    }
  }

  /**
   * Канал закрылся не по нашей воле — состояние приводится к тому же виду, но
   * исход НАЗЫВАЕТСЯ отдельно (`disconnected`, а не `ended`): матч, кончившийся
   * `End`, и оборвавшийся канал требуют от сборки разного — во втором случае
   * владелец слота вправе вернуться реконнектом (NTR-17), пока не превышен
   * порог молчания (NTR-6). Слитый исход заставлял бы решать это по тексту.
   */
  onTransportClosed(): void {
    if (this.clientPhase !== 'closed') this.close('disconnected', 'соединение закрыто');
  }

  private onWelcome(
    slot: number,
    players: readonly string[],
    match: MatchDescriptor,
    serverHash: string,
    pacing: Pacing,
  ): void {
    const scene = this.options.content.scene(match.sceneRef);
    if (scene === undefined) {
      // Сцены нет в контент-паке — тот же исход, что у разошедшихся ассетов
      // (NTR-5). Досылать её сервер не станет и не должен (NET-16).
      this.close('data-mismatch', `сцена "${match.sceneRef}" отсутствует в контент-паке клиента`);
      return;
    }

    let built;
    try {
      built = buildMatchWorld({
        scene,
        seed: 0,
        players,
        initial: match.initial,
        ...(this.options.physics !== undefined ? { physics: this.options.physics } : {}),
        ...(this.options.visibility !== undefined ? { visibility: this.options.visibility } : {}),
        ...(this.options.navigation !== undefined ? { navigation: this.options.navigation } : {}),
      });
    } catch (error) {
      this.close('data-mismatch', `мир матча не поднимается: ${String(error)}`);
      return;
    }

    // Сверка данных матча (DET-1). Отличается от «версия устарела» исходом, а
    // не только текстом: расхождение здесь означает разные ассеты при одних
    // правилах, и лечится оно иначе (NTR-5).
    if (built.worldInitHash !== serverHash) {
      this.close(
        'data-mismatch',
        `worldInit не совпал: сервер ${serverHash}, клиент ${built.worldInitHash}`,
      );
      return;
    }

    this.assignedSlot = slot;
    this.matchPacing = pacing;
    // Запас разметки заводится ровно здесь: его границы и стартовое значение —
    // параметры конфига матча, присланные в `Welcome` (NTR-7). Публикуется он
    // сразу же, а не с первым кадром: «сколько сейчас запас» — вопрос, на
    // который у вошедшего в матч уже есть ответ (NTR-11).
    this.leadControl = new LeadController(pacing);
    this.metrics.inputLead = this.leadControl.lead;
    this.descriptor = match;
    this.localWorld = built.state.world;
    this.localHash = built.worldInitHash;
    this.clientPhase = 'lobby';
  }

  private onSnapshot(epoch: number, tick: number, plain: unknown, nowMs: number): void {
    // Условие работы на неупорядоченном канале (NTR-10): устаревший снапшот
    // отбрасывается, и картинка назад не прыгает. Сравнение идёт по паре
    // (эпоха, тик) лексикографически, а не по одному тику (NTR-16): при
    // перемотке номера тиков идут назад, и сравнение по тику погасило бы ровно
    // те состояния, которые NET-11 велит показать, — «устаревший» и
    // «перемотанный» снапшоты по одному номеру тика неразличимы.
    //
    // Равная пара отбрасывается вместе с меньшей: одна эпоха и один тик
    // достижимы только повторной рассылкой того же состояния — живой тик
    // исполняется за эпоху один раз, — и другого состояния с этой парой не
    // существует (NTR-16).
    const stale =
      epoch < this.lastAppliedEpoch ||
      (epoch === this.lastAppliedEpoch && tick <= this.lastAppliedTick);
    if (stale) {
      // Асимметрия с правилом дедупа ввода (NTR-7) намеренная: повторно
      // разосланное состояние с равной парой считается здесь наравне с
      // устаревшим, тогда как повторно присланный кадр ввода не считается
      // дефектом нигде. Причина в том, что мерят эти счётчики разное.
      // `snapshotsDropped` — «сколько состояний доехало впустую», и повтор
      // доехал впустую ровно так же, как опоздавший: клиент показывать его не
      // станет. Счётчики NTR-11, которые правило дедупа бережёт, — про дефекты
      // КАНАЛА и отправителя, и избыточная отправка ввода там штатный режим.
      this.metrics.snapshotsDropped++;
      return;
    }
    const world = this.localWorld;
    if (world === undefined) {
      this.close('protocol-error', 'снапшот до Welcome');
      return;
    }

    let snapshot: Snapshot;
    try {
      const wire = plain as WireSnapshot;
      // Проекция с провода не несёт состояний стримов (NET-18), а плоская форма
      // ядра их требует: список стримов восстанавливается ПУСТЫМ, и это не
      // потеря, а состав кадра. Клиент `tick()` не исполняет (NTR-10), то
      // есть тянуть случайность ему нечем и незачем; появится предсказание —
      // источник случайности для него придёт отдельным требованием, а не
      // возвратом серверных стримов в снапшот.
      const form: PlainSnapshot = { ...wire, rng: [] };
      // Порядок компонентов задаёт битовые id (SER-7) и берётся из живого мира
      // клиента, а не пересобирается раскладкой загрузчика (см. `orderedSchemas`).
      this.schemas ??= orderedSchemas(world, form.world);
      // ponytail: каждый снапшот поднимает мир заново, то есть аллоцирует SoA
      // целиком — 30 раз в секунду при `snapshotRate` 30. Применение плоской
      // формы в уже созданный мир снимет аллокации; вводить его имеет смысл по
      // замеру на реальной сцене, а не до него.
      snapshot = snapshotFromPlain(form, this.schemas);
    } catch (error) {
      this.close('data-mismatch', `снапшот не восстанавливается: ${String(error)}`);
      return;
    }

    // Рост эпохи читается как разрыв непрерывности мира (NTR-10) и разбирается
    // до применения состояния: буфер интерполяции сбрасывается, состояние
    // ложится в него первым и потому применяется snap'ом, признак разрыва
    // уходит оболочке (SHELL-7), а оценка серверного тика пересинхронизируется.
    const rewound = epoch > this.lastAppliedEpoch;
    // Скраб внутри одной перемотки: и предыдущее применённое состояние, и это —
    // `Rewinding`. Эпоха между ними растёт на КАЖДОМ восстановлении (NTR-16),
    // иначе упорядочивание по номеру тика погасило бы ровно эти состояния, — но
    // РАЗРЫВА между ними нет: это соседние исторические тики одной ветви, и
    // между ними работает обычная интерполяция (`rendering` REND-2). Признак
    // разрыва, взводимый на каждом таком состоянии, превратил бы весь скраб в
    // череду телепортов у любого потребителя, который его слушает.
    //
    // Вход в перемотку и выход из неё разрывом остаются: там режим МЕНЯЕТСЯ,
    // и условие «оба состояния в `Rewinding`» их не покрывает.
    const scrubbing = this.lastAppliedMode === 'Rewinding' && snapshot.mode === 'Rewinding';
    this.lastAppliedEpoch = epoch;
    this.lastAppliedTick = tick;
    // Режим — часть применённого состояния, а не отдельное сообщение: маска
    // ввода замороженного мира (`pushInput`) читает его отсюда.
    this.lastAppliedMode = snapshot.mode;
    if (rewound) {
      // Сброс буфера остаётся и внутри скраба: порядок в нём держится номером
      // тика, и без сброса состояние с БОЛЬШИМ номером так и осталось бы
      // `latest` — перемотанный мир не показался бы вовсе (см. `reset`).
      this.buffer.reset();
      if (!scrubbing) this.discontinuityPending = true;
      // Сколько ввода игрока унесла перемотка (NTR-10): кадры прежних эпох
      // остаются в кольце ровно ради этого ответа, и здесь у него появляется
      // потребитель. В мир и в канонический лог величина не попадает — она
      // клиентская и наблюдательная (NTR-11).
      this.metrics.inputsStranded = this.ring.strandedBefore(epoch);
      // Наблюдение запаса начинается заново: пара «`seq` — тик» через смену
      // эпохи не сравнима, номера тиков после перемотки идут по-новому (NTR-16).
      // САМ запас при этом не сбрасывается — он свойство канала, а не ветви
      // истории (NTR-7, design D3).
      this.leadControl?.resync();
    }
    this.resyncTick(tick, rewound);
    this.buffer.push(snapshot, nowMs);
    this.metrics.snapshotsApplied++;
    // Живой канал состояний — половина сигнала запаса (NTR-7, design D1): до
    // первого подтверждения «эха нет» одинаково выглядит и на канале длиннее
    // запаса, и на оборванном downlink, а поднимать запас надо только в первом
    // случае. Приехавший снапшот и говорит, что downlink жив (`lead.ts`).
    this.leadControl?.snapshotApplied();
    this.measureResponse(snapshot, nowMs);
  }

  /**
   * Поток фактов тиков (NTR-15). Мира не касается вовсе: события — выход
   * симуляции (OBS-1), а не её вход, и применяются они к очереди потребителя, а
   * не к состоянию.
   *
   * Три исхода, и они разные по смыслу.
   *
   * 1. Сообщение целиком не новее курсора — повтор, которым избыточность и
   *    работает: пачки отброшены, курсор на месте. Сюда же попадает диапазон
   *    стёртой перемоткой эпохи, доехавший после смены эпохи: по паре он меньше
   *    курсора, и другого решения у получателя нет (NTR-16).
   * 2. Диапазон начинается позже, чем кончился последний применённый, в ТОЙ ЖЕ
   *    эпохе — разрыв: сообщений потерялось больше, чем повторяет каждое
   *    следующее. Разрыв считается отдельным счётчиком, курсор перескакивает, и
   *    ничего не восстанавливается: догадка или запрос вернули бы reliable-канал
   *    поверх намеренно ненадёжного (NTR-2), а молчание сделало бы дыру
   *    невидимой.
   * 3. Рост эпохи — НЕ разрыв (NTR-16): номера тиков после перемотки идут
   *    заново, «позже» между эпохами не определено, а сама перемотка наблюдаема
   *    с обеих сторон и дефектом канала не является. Курсор перескакивает на
   *    начало диапазона новой эпохи, счётчик разрывов не растёт.
   */
  private onEvents(message: EventsMessage): void {
    const { epoch, from, to, batches } = message;

    // Сравнение лексикографическое по паре (NTR-16), как у снапшота. По одному
    // номеру тика курсор гасил бы события переисполненных после перемотки
    // тиков — ровно те факты, ради доставки которых поток и заведён.
    const fresh = epoch > this.eventEpoch || (epoch === this.eventEpoch && to > this.eventTick);
    if (!fresh) {
      this.metrics.eventBatchesDropped += batches.length;
      return;
    }

    if (this.eventsSeen && epoch === this.eventEpoch && from > this.eventTick + 1) {
      this.metrics.eventRangeGaps++;
    }

    // Порядок применения — по возрастанию тика (NTR-15), и он берётся из
    // содержимого, а не из веры в порядок пачек на проводе: канал
    // переупорядочивает сообщения (NTR-2), и полагаться на порядок внутри
    // сообщения означало бы полагаться на отправителя там, где проверить
    // дёшево. Внутри тика порядок публикации сохраняется как приехал (EVT-2).
    const ordered = [...batches].sort((left, right) => left.tick - right.tick);
    // Курсор двигается пачка за пачкой, чтобы повтор тика ВНУТРИ сообщения
    // отбрасывался тем же правилом, что и повтор между сообщениями. В новой
    // эпохе прежний тик курсора не сравним ни с чем: пара больше по эпохе.
    let cursor = epoch === this.eventEpoch ? this.eventTick : -1;
    for (const batch of ordered) {
      if (batch.tick <= cursor) {
        this.metrics.eventBatchesDropped++;
        continue;
      }
      this.eventQueue.push({ epoch, tick: batch.tick, events: batch.events });
      this.metrics.eventBatchesDelivered++;
      cursor = batch.tick;
    }

    // Курсор встаёт на конец ОБЪЯВЛЕННОГО диапазона, а не на последнюю непустую
    // пачку: диапазон покрыт полностью, и тик без пачки означает «событий не
    // было», а не «пачка потерялась» (NTR-15). Остановка курсора на последней
    // пачке превратила бы каждую тихую рассылку в разрыв следующей.
    this.eventEpoch = epoch;
    this.eventTick = to;
    this.eventsSeen = true;
  }

  /**
   * Оценка серверного тика по пришедшему снапшоту — в обе стороны.
   *
   * Подтягивание вверх очевидно: снапшот тика T доказывает, что сервер уже на T.
   * Ограничение сверху менее очевидно и важнее: собственный таймер клиента идёт
   * не ровно в темпе сервера, и односторонний `max` копил бы расхождение без
   * предела. Кадры уезжали бы всё дальше в будущее, пока не начали бы выпадать
   * из окна приёма (NTR-7) — то есть ввод исчезал бы целиком, и выглядело бы
   * это как «сервер меня не слышит», а не как разъехавшиеся часы.
   *
   * Считается граница по `inputDelay`, а не по текущему `lead`, и это не
   * упущение (design D5): ограничивается ОЦЕНКА, которая остаётся снапшотной,
   * тогда как запас на дорогу живёт в разметке кадра (NTR-7). Втяни сюда
   * растущий `lead` — и оценка поехала бы вверх вместе с ним, то есть запас
   * сложился бы сам с собой, а кадры полетели бы за окно приёма.
   *
   * На смене эпохи (`rewound`) оценка ставится ровно на тик первого снапшота
   * новой эпохи, а не подтягивается постепенно (NTR-10). Постепенное
   * подтягивание её не опустило бы вовсе — `max` держит прежнее значение, —
   * и собственные кадры клиента остались бы адресованными в стёртое будущее:
   * сервер отбрасывал бы их как вышедшие за окно приёма (NTR-7).
   */
  private resyncTick(snapshotTick: number, rewound: boolean): void {
    if (rewound) {
      this.estimatedTick = snapshotTick;
      return;
    }
    const pacing = this.matchPacing;
    if (pacing === undefined) {
      this.estimatedTick = Math.max(this.estimatedTick, snapshotTick);
      return;
    }
    const ceiling = snapshotTick + pacing.tickRate / pacing.snapshotRate + pacing.inputDelay;
    this.estimatedTick = Math.min(Math.max(this.estimatedTick, snapshotTick), ceiling);
  }

  /**
   * Задержка «нажал → увидел» без единого дополнительного сообщения в протоколе
   * плюс сигнал адаптации запаса — из ОДНОГО наблюдения (`echo.ts`).
   *
   * Отдельный Ping/Pong дал бы чистый круг до сервера, но не ответил бы на
   * вопрос, ради которого метрика заводится: в отклик входят и канал, и буфер
   * задержки ввода, и темп рассылки.
   */
  private measureResponse(snapshot: Snapshot, nowMs: number): void {
    const slot = this.assignedSlot;
    if (slot === undefined) return;
    const seq = ownInputSeq(snapshot, slot, this.options);
    if (seq <= 0) return;
    const sent = this.ring.bySeq(seq);
    // Своего кадра с таким `seq` нет: он либо вытеснен из кольца, либо не наш
    // вовсе — возвращение в матч поднимает НОВЫЙ клиент с нумерацией с начала
    // (NTR-17), а в мире до первого своего применённого кадра стоит `seq`
    // прежней сессии. Ни отклик, ни сигнал запаса из такого подтверждения не
    // выводятся.
    if (sent === undefined) return;
    // Тот же `seq` — единственный сигнал адаптации запаса разметки (NTR-7,
    // design D1). Второго источника у неё нет и быть не может: набор сообщений
    // закрыт (NTR-4), а от транспортного RTT адаптация зависеть MUST NOT
    // (NTR-11). Контроллеру он уезжает ПАРОЙ ТИКОВ: тик, которым клиент пометил
    // подтверждённый кадр, и тик снапшота, в котором подтверждение приехало.
    // Обе величины — серверной шкалы, и только в ней «сервер живёт на повторе»
    // отделимо от «часы клиента идут иначе» (`lead.ts`).
    //
    // Учёт идёт ДО дедупа метрики отклика: повтор `seq` контроллеру нужен —
    // тик-то новый, и именно им виден слот, живущий на predicted, — а вот
    // задержка «нажал → увидел» обязана считать каждый `seq` однократно.
    this.leadControl?.applied(sent.frame.tick, snapshot.tick);
    // Каждый `seq` меряется один раз. Predicted-кадр повторяет последний
    // применённый вместе с его `seq` (TICK-2), поэтому одно и то же значение
    // приезжает в каждом следующем снапшоте, пока игрок молчит, — и метрика без
    // этой проверки показывала бы не отклик, а время с последнего нажатия.
    if (seq <= this.lastMeasuredSeq) return;
    this.lastMeasuredSeq = seq;
    recordInputToVisible(this.metrics, nowMs - sent.sentAtMs);
  }

  private close(reason: ClientCloseReason, detail: string): void {
    this.clientPhase = 'closed';
    this.reason = reason;
    this.detail = detail;
  }
}
