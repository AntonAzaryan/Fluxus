/**
 * Прогон записанного матча по сегментированному каноническому логу (NTR-16).
 *
 * Отличие от `runScenario` ядра одно: вход не плоский список кадров с ключом-
 * тиком, а последовательность сегментов. Для матча без перемотки сегмент один,
 * и прогон совпадает с прогоном сценария кадр в кадр — сегментация обобщает
 * форму лога, а не отменяет её.
 *
 * Перед первым кадром сегмента мир восстанавливается на предшествующий тик.
 * Путь восстановления нормой не задан (NTR-16): здесь выбран повторный прогон
 * от `worldInit` по уже исполненным сегментам, потому что он не зависит ни от
 * интервала, ни от глубины `HistoryProvider` (SNAP-4) — то есть корректность
 * прогона не становится свойством параметра производительности. Второй путь,
 * ближайший снапшот с реплеем вперёд (REW-2), дал бы побитово то же (DET-1).
 */
import {
  filterSnapshot,
  tick as advanceTick,
  VIEWPOINT_ALL,
  type InputFrame,
  type Snapshot,
} from '@fluxus/core';
import { buildMatchWorld, type MatchWorldDef } from './world.js';

/** Сегмент записи: эпоха и её кадры. Совпадает с `MatchSegment` сервера. */
export interface ReplaySegment {
  readonly epoch: number;
  readonly frames: readonly InputFrame[];
}

export interface SegmentedReplayDef extends MatchWorldDef {
  readonly segments: readonly ReplaySegment[];
}

export interface SegmentedReplayResult {
  readonly worldInitHash: string;
  /** Тик последнего исполненного состояния — конец последнего сегмента. */
  readonly tick: number;
  readonly snapshot: Snapshot;
}

function byTick(frames: readonly InputFrame[]): Map<number, InputFrame[]> {
  const grouped = new Map<number, InputFrame[]>();
  for (const frame of frames) {
    const list = grouped.get(frame.tick);
    if (list !== undefined) list.push(frame);
    else grouped.set(frame.tick, [frame]);
  }
  return grouped;
}

export function replaySegments(def: SegmentedReplayDef): SegmentedReplayResult {
  const { segments, ...worldDef } = def;

  let built = buildMatchWorld(worldDef);
  // Кадры, по которым мир пришёл в состояние тика: ключ — тик, значение —
  // кадры последнего исполнившего его сегмента. Именно этим и восстанавливается
  // «состояние, полученное исполнением предыдущих сегментов до этого тика
  // включительно» (NTR-16): переисполненный тик перекрывает свою прежнюю версию.
  const applied = new Map<number, readonly InputFrame[]>();

  for (const segment of segments) {
    const grouped = byTick(segment.frames);
    if (grouped.size === 0) {
      // Эпоха без исполненных тиков сегмента не порождает (NTR-16), и пустой
      // сегмент в записи означает сломанный лог, а не законный случай.
      throw new Error(`реплей: сегмент эпохи ${segment.epoch} без единого кадра (NTR-16)`);
    }
    const ticks = [...grouped.keys()].sort((a, b) => a - b);
    const first = ticks[0]!;
    const last = ticks[ticks.length - 1]!;
    if (last - first + 1 !== ticks.length) {
      throw new Error(`реплей: сегмент эпохи ${segment.epoch} не сплошной по тикам (NTR-16)`);
    }

    if (built.state.tick !== first - 1) {
      built = buildMatchWorld(worldDef);
      for (let t = 1; t < first; t++) {
        const frames = applied.get(t);
        if (frames === undefined) {
          // Пропуск тика в переигрываемом префиксе — сломанный лог, как пустой
          // и как несплошной сегмент: сегменты покрывают исполненные тики
          // подряд (NTR-16), и дырка означает, что запись не полна. Подставить
          // здесь нулевой ввод значило бы доиграть мир кадрами, которых на
          // сервере не было, и получить состояние, не совпадающее с
          // авторитетным, — то есть тихо ложный прогон (DET-1, NTR-8).
          throw new Error(
            `реплей: тик ${t} перед сегментом эпохи ${segment.epoch} не покрыт ни одним сегментом (NTR-16)`,
          );
        }
        advanceTick(built.sim, built.state, frames);
      }
      if (built.state.tick !== first - 1) {
        throw new Error(
          `реплей: сегмент эпохи ${segment.epoch} начинается с тика ${first}, ` +
            `а предыдущие сегменты доходят только до ${built.state.tick} (NTR-16)`,
        );
      }
    }

    for (let t = first; t <= last; t++) {
      const frames = grouped.get(t)!;
      advanceTick(built.sim, built.state, frames);
      applied.set(t, frames);
    }
  }

  return {
    worldInitHash: built.worldInitHash,
    tick: built.state.tick,
    snapshot: filterSnapshot(built.state, VIEWPOINT_ALL),
  };
}
