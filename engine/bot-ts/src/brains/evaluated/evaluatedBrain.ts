/**
 * Evaluated-мозг (BOT-8): универсальный evaluator за контрактом BOT-2, чья
 * политика выбора действий целиком приезжает документом поведения из дерева
 * контента. Новое поведение бота — правка документа, а не этого файла.
 *
 * Ровно та же пара, что «JSON-система / ядро-evaluator» у симуляции
 * (`data-driven-systems`): здесь — форма документа и механизм её вычисления,
 * там — содержимое. Имён `pressure`/`kite`/`retreat`/`dodge` в этом файле нет
 * вовсе; закрытый словарь исполнителей живёт в `behavior.ts`, их геометрия — в
 * `layers/plan.ts` (BOT-9).
 *
 * Слои — общие с любым мозгом контракта: восприятие (`layers/perception.ts`),
 * способности (`layers/abilities.ts`), микро (`layers/micro.ts`), сеяная
 * случайность (`layers/random.ts`). Документ заменяет ОДИН слой — выбор
 * маршрута; всё остальное механизм и остаётся кодом.
 *
 * Маршрут и кнопка решаются ПАРАЛЛЕЛЬНО, а не соревнуются: человек кастует на
 * бегу, уклоняется, продолжая отступать, и прыгает, не переставая сближаться.
 *
 * Детерминизм (BOT-11): единственная случайность мозга — сеяный поток
 * `brainRandom` из профиля, wall-clock не читается нигде. Допущение BOT-5 «мозг
 * MAY жить вне детерминизма» этой реализацией сознательно не выбирается: два
 * прогона на одном потоке наблюдений с одним seed дают одну последовательность
 * намерений, и флаки от несеяной случайности не существует.
 */
import type { ClientStep } from '@game-mvp/net';
import { parseBotBehavior, type BotBehaviorDocument, type BotExecutor } from '../../behavior.js';
import type { BotBrain, BotBrainFactory, BotSelf } from '../../brain.js';
import type { BotIntent } from '../../boundary.js';
import type { BotProfile } from '../../profile.js';
import type { BotTerrain } from '../../terrainView.js';
import type { WorldViewNames } from '../../worldView.js';
import { AbilityLayer } from '../layers/abilities.js';
import { MicroLayer } from '../layers/micro.js';
import { Perception, type PerceivedWorld } from '../layers/perception.js';
import { planFor, type ArenaCenter } from '../layers/plan.js';
import { brainRandom, type BrainRandom } from '../layers/random.js';
import {
  FALLBACK_EXECUTOR,
  scoreDocument,
  type BotDecisionSink,
  type ScoringContext,
} from './scoring.js';

export interface EvaluatedBrainOptions {
  /**
   * Документ поведения (BOT-8). Приезжает СБОРКОЙ, тем же путём, что центр
   * арены и рельеф: путь документа называет профиль (`BotProfile.behavior`), а
   * читает дерево контента та сторона, которой это законно, — игра, а не
   * движок (CONT-4).
   */
  readonly behavior: BotBehaviorDocument;
  /** Имена компонентов сцены (TICK-4): умолчания — как у клиента и сцены дуэли. */
  readonly names?: WorldViewNames;
  /**
   * Центр арены. Радиус мозг читает из состояния (`arena` ARENA-1), а центр в
   * компонентах не живёт вовсе — он в ассете сцены, поэтому приезжает сборкой.
   * Умолчание — начало координат: на арене со смещённым центром сборка обязана
   * передать настоящий, иначе «отступить к центру» уводит бота за край.
   */
  readonly center?: ArenaCenter;
  /**
   * Рельеф сцены (`terrainView.ts`) — тем же путём и по тем же основаниям, что
   * центр арены: иммутабельная часть террейна живёт в ассете, а не в снапшоте
   * (TERR-6). Без него бот не запрыгивает на уступы: цель `cliff` в профиле
   * остаётся без очков.
   */
  readonly terrain?: BotTerrain;
  /**
   * Длительность тика, секунды — ПЕРЕОПРЕДЕЛЕНИЕ. Обычно её знать не нужно:
   * темп матча приезжает клиенту в `Welcome` (NTR-7) и достаётся мозгу в
   * `BotSelf.tickRate`. Поле оставлено прогонам, которые двигают бота сами.
   */
  readonly tickSeconds?: number;
  /**
   * Трасса решений (BOT-10): разбор каждого пересчёта — оценки осей, полезности
   * действий, победитель. Чистое НАБЛЮДЕНИЕ: включение колбэка решений не
   * меняет, а выключенная трасса не стоит ничего — записи не строятся.
   *
   * Канал свой, а не диагностика ядра: мозг живёт вне симуляции, и в голдены с
   * трассами ядра его разбор не входит по построению (CLI-7).
   */
  readonly onDecision?: BotDecisionSink;
}

const DEFAULT_SEED = 1;

/**
 * Слой маршрутов: пересчёт по документу с каденсом передумывания из профиля
 * (BOT-6) и гистерезисом между пересчётами — мельтешение между двумя почти
 * равными действиями выглядит как сломанный бот, а не как думающий.
 */
class DecisionLayer {
  private readonly document: BotBehaviorDocument;
  private readonly context: ScoringContext;
  private readonly random: BrainRandom;
  private readonly sink: BotDecisionSink | undefined;
  private chosen: BotExecutor = FALLBACK_EXECUTOR;
  private nextDecisionTick = -Infinity;
  private decidedAtTick = -Infinity;

  constructor(
    document: BotBehaviorDocument,
    context: ScoringContext,
    random: BrainRandom,
    sink: BotDecisionSink | undefined,
  ) {
    this.document = document;
    this.context = context;
    this.random = random;
    this.sink = sink;
  }

  /**
   * Тик последнего пересчёта — ТОТ САМЫЙ «тик решения», которым профиль меряет
   * свои вероятности (BOT-6). Часы решения одни на мозг: слой способностей
   * спрашивает их здесь, а не заводит свои. Заведи он свои — они шли бы со
   * своим джиттером, и «на тике решения» значило бы в одном мозге два разных
   * момента.
   */
  get decisionTick(): number {
    return this.decidedAtTick;
  }

  /**
   * Забыть решение и срок передумывания: мир, для которого они выбирались, стёрт
   * перемоткой (NTR-16). Номера тиков после неё идут назад, и без сброса
   * `nextDecisionTick` остался бы в будущем — слой держал бы действие стёртой
   * ветви ровно столько тиков, сколько унесла перемотка.
   */
  forget(): void {
    this.chosen = FALLBACK_EXECUTOR;
    this.nextDecisionTick = -Infinity;
    this.decidedAtTick = -Infinity;
  }

  choose(world: PerceivedWorld, tick: number): BotExecutor {
    if (tick < this.nextDecisionTick) return this.chosen;
    const decision = scoreDocument(this.document, world, this.context, tick, this.sink !== undefined);
    this.chosen = decision.chosen;
    this.decidedAtTick = tick;
    const { intervalTicks, jitterTicks } = this.context.profile.decision;
    const jitter = jitterTicks === 0 ? 0 : this.random.below(jitterTicks + 1);
    this.nextDecisionTick = tick + intervalTicks + jitter;
    // Трасса отдаётся ПОСЛЕ того, как решение принято и записано: потребитель
    // видит состоявшийся пересчёт, а не намерение его сделать.
    if (decision.record !== undefined) this.sink?.(decision.record);
    return this.chosen;
  }
}

class EvaluatedBrain implements BotBrain {
  private readonly profile: BotProfile;
  private readonly center: ArenaCenter;
  private readonly perception: Perception;
  private readonly decisions: DecisionLayer;
  private readonly abilities: AbilityLayer;
  private readonly micro: MicroLayer;
  private intent: BotIntent | undefined;

  constructor(
    document: BotBehaviorDocument,
    profile: BotProfile,
    self: BotSelf,
    options: EvaluatedBrainOptions,
  ) {
    // Профиль читается ЗДЕСЬ и больше нигде (BOT-6): слои получают его целиком
    // на конструировании, и новый уровень сложности — это документ, а не правка.
    this.profile = profile;
    this.center = options.center ?? { x: 0, y: 0 };
    const random = brainRandom(profile.seed ?? DEFAULT_SEED, `bot-${self.playerId}`);
    this.perception = new Perception(profile, self, random, options.names ?? {});
    this.decisions = new DecisionLayer(
      document,
      { profile, center: this.center },
      random,
      options.onDecision,
    );
    this.abilities = new AbilityLayer(profile, random, {
      ...(options.terrain !== undefined ? { terrain: options.terrain } : {}),
    });
    this.micro = new MicroLayer(profile, random, {
      // Настоящий темп матча, а не константа: на 30 Гц шаг интегрирования
      // steering вдвое длиннее, и зашитые 60 сделали бы микро-слой вдвое
      // резвее реальности (NTR-7).
      tickSeconds: options.tickSeconds ?? 1 / self.tickRate,
    });
  }

  observe(step: ClientStep): void {
    this.perception.observe(step);
  }

  sample(tick: number): BotIntent | undefined {
    // Разрыв непрерывности (SHELL-7): ветвь истории, для которой выбирались
    // действие, срок передумывания, кулдаун способности и разгон steering,
    // стёрта — вместе с ней уходят и они. Все четыре величины — сроки в тиках
    // и инерция решения, а номера тиков после перемотки идут НАЗАД (NTR-16):
    // оставленные, они держали бы бота на планах стёртого будущего ровно ту
    // глубину, которую унесла перемотка.
    if (this.perception.takeDiscontinuity()) {
      this.decisions.forget();
      this.abilities.forget();
      this.micro.forget();
      this.intent = this.hold();
    }
    // Мир не идёт — бот не играет (WSM-1). Живых тиков в `Paused`/`Rewinding`
    // нет, ввод замороженного мира клиент и так маскирует (NET-11), и
    // «думать» в эти тики значило бы жечь сроки решений и шума на времени,
    // которого в матче не было. Отдаётся ДЕРЖАНИЕ, а не `undefined`: молчание
    // источника сервер замещает повторением последнего кадра (TICK-2), то есть
    // зажатым направлением движения — бот уезжал бы, пока игрок смотрит откат.
    if (this.perception.mode !== 'Running') return (this.intent = this.hold());
    const world = this.perception.perceive(tick);
    if (world === undefined) return this.intent;
    const executor = this.decisions.choose(world, tick);
    const plan = planFor(executor, world, this.profile, this.center);
    // Способности решаются ПОСЛЕ маршрута и ДО микро-слоя. После — потому что
    // прыжок через обрыв и уклон вбок гейтятся направлением, в которое бот
    // собрался; до — потому что применение вправе перехватить прицел: захват
    // ловит снаряд конусом от него, заряд летит туда, куда кастер смотрел на
    // отпускании.
    // Тик решения у мозга ОДИН, и ведёт его слой маршрутов: ручки профиля,
    // названные «на тике решения» (вероятность отменить каст), меряются им же —
    // иначе в одном мозге было бы двое часов с разным джиттером (BOT-6).
    const ability = this.abilities.step(world, plan, tick, this.decisions.decisionTick === tick);
    const micro = this.micro.step(
      ability.aim === undefined ? plan : { ...plan, aim: ability.aim },
      world,
      tick,
    );
    this.intent = {
      moveX: micro.moveX,
      moveY: micro.moveY,
      aimRadians: micro.aimRadians,
      // Точка и биты шага доезжают до границы как есть: квантование и
      // подмешивание в маску живут в `boundary.ts` и только там (BOT-5).
      ...(ability.target === undefined ? {} : { target: ability.target }),
      ...(ability.confirmBit === undefined ? {} : { confirmBit: ability.confirmBit }),
      ...(ability.cancelBit === undefined ? {} : { cancelBit: ability.cancelBit }),
      buttons: ability.buttons,
    };
    return this.intent;
  }

  /**
   * Держание: стоять, не жать ничего, прицел оставить РОВНО как был — тем
   * самым числом, которое ушло наружу прошлым намерением, вместе с шумом.
   * База микро-слоя (`micro.aim`) шума не содержит, и на профиле с ненулевым
   * `aim.noiseDegrees` держание отдавало бы прицел, отличающийся от последнего
   * отданного на всю амплитуду шума: замирание мира выглядело бы РЫВКОМ
   * прицела, хотя бот именно что перестал думать. Умолчание нужно ровно один
   * раз — на держании до первого намерения, когда отдавать ещё нечего.
   */
  private hold(): BotIntent {
    return {
      moveX: 0,
      moveY: 0,
      aimRadians: this.intent?.aimRadians ?? this.micro.aim,
      buttons: 0,
    };
  }
}

/**
 * Фабрика evaluated-мозга (BOT-2). Подпись — общая для всех реализаций
 * контракта: замена мозга меняет эту ссылку в сборке и ничего больше.
 *
 * Документ проверяется ЗДЕСЬ, на конструировании (BOT-8), даже если сборка уже
 * разобрала его у себя: между сборкой и мозгом лежит граница воркера, и «его уже
 * проверили» там предположение, а не факт. Документ неподдержанной формы —
 * находка валидации, адресованная дизайнеру, а не тихое поведение по умолчанию.
 */
export function evaluatedBrain(options: EvaluatedBrainOptions): BotBrainFactory {
  const document = parseBotBehavior(options.behavior);
  return (profile, self) => new EvaluatedBrain(document, profile, self, options);
}
