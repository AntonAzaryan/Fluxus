/**
 * Счётчики сетевого слоя (NTR-11).
 *
 * Раздельные по причине, а не сведённые в одну «потери»: вопрос, ради которого
 * сетевой прототип заводится, звучит как «дэш вялый — это задержка канала,
 * потерянный ввод или буфер интерполяции», и слитая метрика на него не
 * отвечает. Три причины — три счётчика.
 *
 * Ни одно значение отсюда не попадает ни в мир, ни в канонический `inputs[]`:
 * величина, измеренная внешним слоем, в мире сделала бы состояние зависящим от
 * сети, а прогон записи — невоспроизводимым (NTR-11, OBS-2).
 */

export interface SlotCounters {
  /** Кадры, применённые как пришли. */
  applied: number;
  /** Кадры, подставленные повтором последнего: ввод не успел к дедлайну (TICK-2). */
  predicted: number;
  /** Кадры, пришедшие на уже исполненный тик. Мир назад не переигрывается (NET-1). */
  late: number;
  /** Кадры с тиком за пределами окна: не опоздание, а рассинхронизация или мусор. */
  outOfWindow: number;
  /** Подряд идущие предсказанные тики — то, по чему считается порог молчания (NTR-6). */
  silentTicks: number;
}

export interface ServerMetrics {
  readonly slots: readonly SlotCounters[];
  snapshotsSent: number;
  bytesSent: number;
  /** Сообщения, отвергнутые разбором или состоянием соединения (NTR-4). */
  rejectedMessages: number;
}

export function createServerMetrics(slotCount: number): ServerMetrics {
  return {
    slots: Array.from({ length: slotCount }, () => ({
      applied: 0,
      predicted: 0,
      late: 0,
      outOfWindow: 0,
      silentTicks: 0,
    })),
    snapshotsSent: 0,
    bytesSent: 0,
    rejectedMessages: 0,
  };
}

export interface ClientMetrics {
  snapshotsApplied: number;
  /**
   * Снапшот, пара `(эпоха, тик)` которого не больше применённой (NTR-16,
   * NTR-10): условие работы на неупорядоченном канале. Считается по паре, а не
   * по тику, — при перемотке номера тиков идут назад, и «устаревший» от
   * «перемотанного» отличает только эпоха.
   */
  snapshotsDropped: number;
  inputsSent: number;
  /**
   * Кадры кольца, оставшиеся в эпохах старше текущей, — сколько ввода игрока
   * унесла перемотка (NTR-10). Величина клиентская и наблюдательная: в мир и в
   * канонический `inputs[]` она не попадает (NTR-11).
   */
  inputsStranded: number;
  bytesReceived: number;
  /**
   * Задержка «нажал → увидел», мс: от отправки кадра до появления его `seq` в
   * снапшоте. Именно она, а не круг до сервера, отвечает на вопрос «вяло ли
   * ощущается дэш»: в неё входят и канал, и буфер задержки ввода, и темп
   * рассылки — то есть всё, что игрок чувствует как отклик.
   */
  inputToVisibleMs: number | undefined;
  inputToVisibleMinMs: number | undefined;
  inputToVisibleMaxMs: number | undefined;
  /** Отставание буфера интерполяции, мс: сколько мы отстаём от последнего пришедшего состояния. */
  bufferLagMs: number | undefined;
}

export function createClientMetrics(): ClientMetrics {
  return {
    snapshotsApplied: 0,
    snapshotsDropped: 0,
    inputsSent: 0,
    inputsStranded: 0,
    bytesReceived: 0,
    inputToVisibleMs: undefined,
    inputToVisibleMinMs: undefined,
    inputToVisibleMaxMs: undefined,
    bufferLagMs: undefined,
  };
}

export function recordInputToVisible(metrics: ClientMetrics, ms: number): void {
  metrics.inputToVisibleMs = ms;
  metrics.inputToVisibleMinMs = metrics.inputToVisibleMinMs === undefined ? ms : Math.min(metrics.inputToVisibleMinMs, ms);
  metrics.inputToVisibleMaxMs = metrics.inputToVisibleMaxMs === undefined ? ms : Math.max(metrics.inputToVisibleMaxMs, ms);
}
