/**
 * Раннеры стадий старта (`game-boot` BOOT-3, BOOT-4): что именно исполняет
 * стадия, названная документом по имени.
 *
 * Стадий два рода, и различие несущее. Стадии подсистем (`prewarm.<имя>`) и
 * компиляция программ сцены (`scene`) — РАБОТА: у неё есть промис, исход и
 * длительность. Встроенные `handshake`, `firstDelivery` и `warmFrames` работой
 * не являются вовсе — их закрывают СОБЫТИЯ оболочки и кадры (SHELL-5, SHELL-10,
 * BOOT-4), и раннера у них нет: машина ждёт входа, а не промиса.
 *
 * Отказ раннера наружу не выходит: прогрев — оптимизация, а не условие
 * корректности (BOOT-4), и сорвавшаяся стадия получает исход `failed`, а её вид
 * остаётся ленивому пути монтажа (ASSET-4). Стадия названной подсистемы,
 * которой на этой сцене нет (туман на сцене без тумана, QUAL-1), получает
 * `skipped`: документ написан про сборку, а не про одну сцену.
 */
import type { BootDocument } from './bootDocument.js';
import { EVENT_STAGES, PREWARM_PREFIX } from './bootDocument.js';
import {
  compileForFrameTargets,
  prewarmSubsystem,
  type PrewarmRun,
  type PrewarmSubsystem,
  type PrewarmTargets,
} from '../prewarm.js';

/** Исход стадии — машинно-независимые данные (BOOT-3). */
export type StageOutcome = 'done' | 'timeout' | 'failed' | 'skipped';

/** Стадия-работа: имя документа и то, что по нему исполняется. */
export interface StageRunner {
  readonly name: string;
  run(): Promise<void>;
  /**
   * Свернуть стадию, не дожидаясь её конца (BOOT-4): её исход уже поставлен
   * таймаутом, и тёплые объекты пора вернуть владельцу — иначе «прогрев есть
   * оптимизация, а вид остаётся ленивому пути» было бы неправдой. Идемпотентно
   * и безопасно до старта: сворачивать тогда просто нечего.
   */
  abandon(): void;
}

/** Что сборка даёт раннерам: цели кадра и подсистемы с точкой прогрева. */
export interface StageSources {
  readonly targets: PrewarmTargets;
  /** Подсистемы ЭТОЙ сцены, объявившие точку прогрева (REND-45). */
  readonly subsystems: readonly PrewarmSubsystem[];
}

/**
 * Раннеры стадий действующего документа в его порядке. Стадии-события раннера
 * не получают; названная подсистема, которой на сцене нет, раннера не получает
 * тоже — её исход `skipped` ставит `startBootStages`.
 */
export function createStageRunners(doc: BootDocument, sources: StageSources): StageRunner[] {
  const built = new Map(sources.subsystems.map((subsystem) => [subsystem.name, subsystem]));
  const runners: StageRunner[] = [];
  for (const stage of doc.stages) {
    if ((EVENT_STAGES as readonly string[]).includes(stage.name)) continue;
    if (stage.name === 'scene') {
      runners.push({
        name: stage.name,
        // Программы того, что УЖЕ в сцене кадра: террейн, свет, вода, батчи
        // частиц прогрева. Тёплой сцены здесь нет — компилируется настоящая, и
        // под обе цели кадра, как и тёплые корни соседних стадий.
        run: () => compileForFrameTargets(sources.targets.scene, sources.targets),
        // Возвращать владельцу нечего: своих тёплых объектов у стадии нет —
        // она компилирует то, что и так стоит в сцене кадра.
        abandon: () => undefined,
      });
      continue;
    }
    const subsystem = built.get(stage.name.slice(PREWARM_PREFIX.length));
    if (subsystem === undefined) continue;
    // Прогрев заводится ПЕРВЫМ `run`, а не здесь: раннеры строятся до старта
    // машины, и подсистема не должна строить тёплые объекты, пока их никто не
    // просил компилировать.
    let running: PrewarmRun | null = null;
    runners.push({
      name: stage.name,
      run: () => {
        running ??= prewarmSubsystem(subsystem, sources.targets);
        return running.done;
      },
      abandon: () => running?.abandon(),
    });
  }
  return runners;
}

/**
 * Запускает раннеры и закрывает ими стадии машины. Исключений наружу нет: отказ
 * стадии — её исход, а не отказ старта (BOOT-4). Стадии документа, которой
 * раннера не досталось и события у неё нет, исход ставится сразу — `skipped`.
 */
export function startBootStages(
  doc: BootDocument,
  runners: readonly StageRunner[],
  settled: (name: string, outcome: StageOutcome) => void,
): void {
  const running = new Set(runners.map((runner) => runner.name));
  for (const stage of doc.stages) {
    if (running.has(stage.name)) continue;
    if ((EVENT_STAGES as readonly string[]).includes(stage.name)) continue;
    // Подсистема объявлена сборкой, но на этой сцене не построена (QUAL-1):
    // прогревать нечего, и это не отказ.
    settled(stage.name, 'skipped');
  }
  for (const runner of runners) {
    void runner.run().then(
      () => {
        settled(runner.name, 'done');
      },
      (error: unknown) => {
        console.warn(`демо: стадия старта "${runner.name}" не удалась — монтаж останется ленивым`, error);
        settled(runner.name, 'failed');
      },
    );
  }
}
