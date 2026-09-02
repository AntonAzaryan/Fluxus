/**
 * Расписание с фиксированным темпом без дрейфа (NTR-7).
 *
 * `setInterval(fn, 1000 / 60)` темпом 60 Гц не является. Дробную часть периода
 * отбрасывают и Node (`uv_timer` считает целые миллисекунды), и браузер
 * (`setInterval` принимает WebIDL `long`): 16,67 мс становятся 16, и «60 Гц»
 * оказываются 62,5, а с накладными расходами цикла событий — 61–62. Сервер
 * матча исполняет за секунду не `tickRate` тиков, а клиент и сервер дрейфуют
 * друг относительно друга: сторона, отстающая на процент, раз в сотню тиков
 * перешагивает номер тика при подтягивании оценки (`resyncTick`, NTR-10), и
 * тик остаётся без кадра — сервер живёт его повтором (TICK-2). Дрейф этот —
 * не свойство канала, и контроллер запаса разметки его лечить не должен.
 *
 * Здесь следующий шаг назначается от ТОЧКИ ОТСЧЁТА — `origin + n · period`, а
 * не от момента предыдущего срабатывания: округление каждой задержки до целых
 * миллисекунд усредняется, и средний темп равен заданному. Догон после задержки
 * цикла событий ограничен `MAX_CATCHUP_STEPS`: короткую задержку (сборка
 * мусора, занятый поток) расписание отрабатывает шагами подряд — сервер
 * исполняет пропущенные тики, клиент доводит оценку тика, — а после длинной
 * (пауза отладчика, свёрнутая вкладка) точка отсчёта переносится: залп в сотни
 * тиков дал бы залп снапшотов, а не расписание.
 *
 * Шаг за вызов ровно один, и следующий назначается ПОСЛЕ него: догон идёт по
 * макрозадаче на шаг, между шагами цикл событий отдаёт сокеты и порты, и
 * доставка каждого шага уходит до следующего.
 */

/**
 * Сколько периодов отставания расписание догоняет шагами подряд; большее
 * отставание переносит точку отсчёта. Половина секунды при 60 Гц: дольше этого
 * поток не задерживает ни сборка мусора, ни занятый тик, а зависание на секунды
 * — не задержка, а остановка.
 */
export const MAX_CATCHUP_STEPS = 30;

export interface PacedTimer {
  stop(): void;
}

/** Часы и таймер — параметры ради тестов: расписание проверяется без ожидания реального времени. */
export interface PacedTimerDeps {
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Запускает `step` с периодом `periodMs`, отсчитывая каждый следующий шаг от
 * точки отсчёта, а не от предыдущего срабатывания.
 */
export function startPaced(periodMs: number, step: () => void, deps: PacedTimerDeps = {}): PacedTimer {
  if (!(periodMs > 0) || !Number.isFinite(periodMs)) {
    throw new Error(`startPaced: период должен быть положительным конечным числом, получено ${periodMs}`);
  }
  const now = deps.now ?? ((): number => performance.now());
  const setTimer = deps.setTimer ?? ((callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>); });

  let origin = now();
  let steps = 0;
  let handle: unknown;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    const target = origin + (steps + 1) * periodMs;
    const lag = now() - target;
    if (lag > MAX_CATCHUP_STEPS * periodMs) {
      // Пропущенные шаги не исполняются: точка отсчёта переносится так, чтобы
      // следующий шаг стал ближайшим к «сейчас», а не первым из сотен.
      const skipped = Math.floor(lag / periodMs);
      origin += skipped * periodMs;
    }
    const delay = Math.max(0, origin + (steps + 1) * periodMs - now());
    handle = setTimer(tick, delay);
  };

  const tick = (): void => {
    if (stopped) return;
    steps++;
    try {
      step();
    } finally {
      // Исключение шага уходит наверх, как и из колбэка `setInterval`, но
      // расписание не умирает вместе с ним: следующий шаг назначен — если
      // сам шаг не остановил расписание (`schedule` это проверяет).
      schedule();
    }
  };

  schedule();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimer(handle);
    },
  };
}
