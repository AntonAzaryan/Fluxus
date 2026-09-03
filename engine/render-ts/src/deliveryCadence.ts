/**
 * Каденс доставок глазами главного потока (`client-shell` SHELL-7) и то, что из
 * него выводится: темп часов презентации на обратном ходе (REND-25),
 * знаменатель альфы интерполяции и ОТСТАВАНИЕ ПОКАЗА под джиттер (REND-2,
 * change `delivery-interpolation-and-dirty-extract`, design D1–D2).
 *
 * Врозь с буфером состояния потому, что это разные вещи: там — записи сущностей
 * и их пары интерполяции, здесь — три сглаженные оценки по режимам мира и
 * арифметика над ними. Часов у наблюдателя своих нет: моменты доставок ему
 * приносит буфер, у которого они и есть (SHELL-7).
 *
 * Оценки ведутся ПО РЕЖИМАМ (REND-25): скраб и живой мир идут разным каденсом,
 * и общая оценка смешала бы их. Оценка скраба заводится заново на каждом входе
 * в перемотку — шаг ведения точки задаёт матч, и прошлая перемотка о нынешней
 * ничего не говорит; оценка живого мира копится всю сессию: это темп рассылки.
 */
import type { WorldMode } from '@fluxus/core';
import type { DeliveryCadence } from './types.js';

/**
 * Сглаживание оценок (REND-25): доля новой пробы в экспоненциальном среднем.
 * Сырое отношение дрожало бы от каждой сбитой доставки — conflation (SHELL-4) и
 * потеря снапшота меняют пробу на один шаг, а темп клипов от этого дёргаться не
 * должен. Одна постоянная на все три оценки: дрожание одно — политика одна.
 */
const SMOOTHING = 0.25;

/**
 * Границы темпа обратного хода: скраб быстрее живого мира в 4 раза крутит клипы
 * вчетверо быстрее, дальше — уже не «догоняя движение», а мельтешение. Нижняя
 * граница симметрична и бережёт от деления на дрожащую оценку.
 */
const MIN_REWIND_PACE = 0.25;
const MAX_REWIND_PACE = 4;

/**
 * Отставание показа под джиттер (design D2): `интервал + JITTER_MARGIN ×
 * джиттер`. Двойка — правило «двух сигм» в грубом виде: покрывает подавляющее
 * большинство опозданий, не превращая отставание в задержку управления.
 */
const JITTER_MARGIN = 2;

/**
 * Глубина буфера отложенных доставок В ИНТЕРВАЛАХ: слот на запись один, и
 * отставание больше двух интервалов он не выдержал бы — вторая доставка
 * вытеснила бы первую, то есть отставание не соблюдалось бы всё равно.
 */
const MAX_DELAY_INTERVALS = 2;

/**
 * Потолок отставания по умолчанию, секунды. Сверх этого задержка отклика
 * заметна пальцам, а плавности уже не прибавляет; на игровом каденсе (30–60 Гц)
 * раньше срабатывает жёсткий потолок глубины буфера — два интервала.
 */
export const DEFAULT_MAX_RENDER_DELAY = 0.15;

/**
 * Шаг оценки: ПЕРВАЯ проба задаёт значение целиком, дальше идёт
 * экспоненциальное среднее. Ноль означает «ещё не наблюдали», и он же —
 * непроба: нулевой интервал между доставками каденсом не является (часы стенда
 * вправе стоять на месте), а «ноль тиков за доставку» — тем более.
 */
function observe(current: number, sample: number): number {
  if (sample <= 0) return current;
  return current === 0 ? sample : current + (sample - current) * SMOOTHING;
}

/**
 * Отклонение пробы от оценки — вход джиттера. Пока оценки нет, отклонения нет
 * тоже: дрожание из одной точки не выводится.
 */
function deviation(current: number, sample: number): number {
  return current <= 0 || sample <= 0 ? 0 : Math.abs(sample - current);
}

/** Три оценки одного режима: тиков за доставку, секунд между ними и дрожание. */
interface ModeCadence {
  span: number;
  interval: number;
  jitter: number;
}

export class CadenceTracker {
  /**
   * Наблюдаемые величины наружу (RDBG-7) — стабильный объект, мутируемый на
   * месте: потребитель вправе держать ссылку, а свежая запись на доставку была
   * бы мусором (REND-26).
   */
  readonly probe: DeliveryCadence = { intervalSeconds: 0, jitterSeconds: 0, delaySeconds: 0 };

  private readonly running: ModeCadence = { span: 0, interval: 0, jitter: 0 };
  private readonly rewind: ModeCadence = { span: 0, interval: 0, jitter: 0 };
  private readonly tickSeconds: number;
  private readonly maxDelay: number;
  /** Момент и режим последней продвигающей доставки — база пробы интервала. */
  private lastAdvanceAtMs: number | null = null;
  private lastAdvanceMode: WorldMode = 'Running';
  private lastMode: WorldMode = 'Running';

  constructor(tickSeconds: number, maxDelay: number) {
    this.tickSeconds = tickSeconds;
    this.maxDelay = maxDelay;
  }

  /**
   * Доставка наблюдена. `tickAdvanced` — сдвинула ли она тик: доставка
   * замороженного мира пробой не является («ноль тиков за доставку» — не
   * каденс, а его отсутствие).
   */
  observeDelivery(mode: WorldMode, tickAdvanced: boolean, span: number, nowMs: number): void {
    if (mode === 'Rewinding' && this.lastMode !== 'Rewinding') {
      this.rewind.span = 0;
      this.rewind.interval = 0;
      this.rewind.jitter = 0;
    }
    this.lastMode = mode;
    if (!tickAdvanced) return;
    // Проба интервала берётся только между двумя продвигающими доставками
    // ОДНОГО режима: интервал через смену режима мерил бы не каденс, а момент
    // переключения.
    const previous = this.lastAdvanceAtMs;
    const sample =
      previous !== null && this.lastAdvanceMode === mode ? (nowMs - previous) / 1000 : 0;
    this.lastAdvanceAtMs = nowMs;
    this.lastAdvanceMode = mode;
    const cadence = mode === 'Rewinding' ? this.rewind : mode === 'Running' ? this.running : null;
    if (cadence === null) return;
    // Джиттер меряется ДО обновления интервала: отклонение пробы от оценки, а
    // не от самой себя.
    cadence.jitter = observe(cadence.jitter, deviation(cadence.interval, sample));
    cadence.span = observe(cadence.span, span);
    cadence.interval = observe(cadence.interval, sample);
  }

  /**
   * Множитель хода часов презентации (REND-25). Единица везде, кроме перемотки:
   * скраб идёт своим шагом по тикам (REW-13), и клипы обязаны идти назад в том
   * же темпе, иначе бег «отстаёт» от собственных ног.
   *
   * Считается тиками В СЕКУНДУ, а не тиками за доставку: скраб вправе шагать
   * реже живого мира, и «четыре тика за доставку» при вдвое редких доставках
   * означает вдвое, а не вчетверо быстрее. Пока какой-то из каденсов не
   * наблюдался, действует отношение спанов: выводить темп из половины данных
   * хуже, чем не выводить вовсе.
   */
  pace(mode: WorldMode): number {
    if (mode !== 'Rewinding') return 1;
    if (this.running.span <= 0 || this.rewind.span <= 0) return 1;
    const paced = this.running.interval > 0 && this.rewind.interval > 0;
    const ratio = paced
      ? this.rewind.span / this.rewind.interval / (this.running.span / this.running.interval)
      : this.rewind.span / this.running.span;
    return Math.min(Math.max(ratio, MIN_REWIND_PACE), MAX_REWIND_PACE);
  }

  /**
   * Знаменатель альфы интерполяции (REND-2) — сглаженный интервал между
   * продвигающими доставками текущего режима, С ПОЛОМ в длительность тика.
   *
   * Не `tickSeconds`: доставка раз в два тика (conflation SHELL-4, рассылка
   * реже тиков, шаг скраба REW-13) заканчивала бы интерполяцию на половине
   * интервала, и вторую половину сущность стояла бы — 50 % duty-цикл, то есть
   * череда телепортов, которую REND-2 запрещает ровно так же, как «проезд»
   * через пол-арены. Пол нужен затем, что альфа обязана оставаться долей и при
   * доставках чаще тика.
   */
  alphaSeconds(mode: WorldMode): number {
    const observed = this.intervalOf(mode);
    return observed > this.tickSeconds ? observed : this.tickSeconds;
  }

  /** Наблюдаемый интервал доставок режима; 0 — ещё не наблюдался. */
  intervalOf(mode: WorldMode): number {
    return mode === 'Rewinding' ? this.rewind.interval : this.running.interval;
  }

  /**
   * ОТСТАВАНИЕ ПОКАЗА в секундах (REND-2, design D2): `интервал + 2 × джиттер`,
   * с полом в интервал и потолком из конфига, дополнительно ограниченным
   * глубиной буфера.
   *
   * Пол — не запас, а ТОЖДЕСТВО: отставание ровно в один интервал и есть
   * «интерполяция между двумя последними доставленными тиками», то есть
   * поведение до этого буфера. Пока каденс не наблюдался (первая доставка,
   * стенд с неподвижными часами), отставание — номинальный интервал альфы: без
   * него показ считался бы от `prev`, то есть на интервал впереди доставки.
   */
  delay(mode: WorldMode): number {
    const interval = this.intervalOf(mode);
    if (interval <= 0) return this.alphaSeconds(mode);
    const jitter = mode === 'Rewinding' ? this.rewind.jitter : this.running.jitter;
    const ceiling = Math.min(this.maxDelay, interval * MAX_DELAY_INTERVALS);
    return Math.min(Math.max(interval + JITTER_MARGIN * jitter, interval), ceiling);
  }

  /** Наблюдаемые величины в стабильную запись пробы (RDBG-7). */
  publish(mode: WorldMode): void {
    const probe = this.probe as { -readonly [K in keyof DeliveryCadence]: number };
    probe.intervalSeconds = this.intervalOf(mode);
    probe.jitterSeconds = mode === 'Rewinding' ? this.rewind.jitter : this.running.jitter;
    probe.delaySeconds = this.delay(mode);
  }
}
