/**
 * Книга процессов агента (решение D5): что было поднято, с какими параметрами и
 * каким процессом ОС.
 *
 * Заведена ради ровно одного положения дел: агента перезапустили, а серверы
 * живы. Их процессы пережили менеджер и агента (они дети процесса, но не его
 * зависимость), матчи в них идут, и потерять управление ими значило бы оставить
 * админа с чужими процессами на своей машине.
 *
 * На старте книга СВЕРЯЕТСЯ с живыми процессами: запись без процесса помечается
 * `stopped`. Перезагрузка хоста серверы не воскрешает — и не должна: агент
 * супервизор, а не менеджер автозапуска (Non-Goals дизайна).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Запись книги: столько, сколько нужно, чтобы узнать процесс после рестарта агента. */
export interface BookEntry {
  readonly id: string;
  readonly pid: number;
  readonly port: number;
  readonly match: string;
  readonly startedAt: number;
  /**
   * Момент старта процесса относительно загрузки системы (Linux — поле 22
   * `/proc/<pid>/stat`); `0` — прочитать не удалось.
   *
   * Заведён против переиспользования PID: голого «процесс с этим PID жив» мало —
   * после перезагрузки хоста тот же номер носит ЧУЖОЙ процесс, и `adopt`
   * воскресил бы фантомный сервер, а `stop` убил бы постороннего. Совпадение
   * момента старта отличает наш процесс от занявшего его номер (D5:
   * «перезагрузка хоста серверы не воскрешает»).
   */
  readonly startProc: number;
}

export interface ProcessBook {
  /** Живые записи книги — те, чьи процессы отвечают на проверку существования. */
  readonly entries: readonly BookEntry[];
  add(entry: BookEntry): void;
  remove(id: string): void;
  /** Сверка с живыми процессами: записи без процесса — либо занятого чужим — уходят (D5). */
  reconcile(): readonly BookEntry[];
}

/** Жив ли процесс: сигнал `0` ничего не делает, но отвечает на вопрос существования. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM означает «процесс есть, но он не наш» — для вопроса «жив ли» это да.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Момент старта процесса относительно загрузки системы (Linux, поле 22
 * `/proc/<pid>/stat`); `0` — прочитать не удалось (не Linux, нет прав, нет
 * процесса). Имя процесса в поле 2 бывает со скобками и пробелами, поэтому счёт
 * полей ведётся ПОСЛЕ последней `)`.
 */
export function processStartTicks(pid: number): number {
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    // После `)` первым идёт поле 3 (`state`), значит `starttime` (поле 22) —
    // индекс 19.
    const starttime = Number(tail[19]);
    return Number.isFinite(starttime) ? starttime : 0;
  } catch {
    return 0;
  }
}

/**
 * Тот ли это процесс, что записан в книгу: жив И его момент старта совпадает с
 * запомненным. Совпадение момента и отличает наш процесс от занявшего его PID
 * после перезагрузки. Момент неизвестен (не Linux, `startProc === 0`) — падаем
 * на голую проверку существования: лучшего на этой ОС у нас нет.
 */
export function sameProcess(entry: Pick<BookEntry, 'pid' | 'startProc'>): boolean {
  if (!processAlive(entry.pid)) return false;
  if (entry.startProc === 0) return true;
  const current = processStartTicks(entry.pid);
  return current === 0 || current === entry.startProc;
}

export function processBook(file: string): ProcessBook {
  const read = (): BookEntry[] => {
    if (!existsSync(file)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? (parsed as BookEntry[]) : [];
    } catch {
      // Книга — не источник истины о мире, а подсказка: испорченную честнее
      // считать пустой, чем гадать по половине.
      return [];
    }
  };

  let entries = read();
  const write = (): void => {
    // Атомарно, как и файл токенов: обрыв на середине записи оставил бы половину
    // JSON, разбор честно счёл бы книгу пустой — и пережившие агента серверы
    // (решение D5) стали бы неуправляемыми процессами, которых никто не найдёт.
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`);
    renameSync(temporary, file);
  };

  return {
    get entries(): readonly BookEntry[] {
      return entries;
    },
    add(entry) {
      entries = [...entries.filter((existing) => existing.id !== entry.id), entry];
      write();
    },
    remove(id) {
      entries = entries.filter((existing) => existing.id !== id);
      write();
    },
    reconcile() {
      // Живой И тот же процесс: голого «PID существует» мало — после
      // перезагрузки его носит чужой процесс (`sameProcess`).
      const live = entries.filter((entry) => sameProcess(entry));
      const changed = live.length !== entries.length;
      entries = live;
      if (changed) write();
      return live;
    },
  };
}

/**
 * Остановка процесса, которым агент не владеет: сперва вежливо, потом жёстко.
 *
 * Сигнал шлётся ТОЛЬКО тому процессу, чей момент старта совпадает с запомненным
 * (`sameProcess`): за время между сверкой книги и остановкой PID мог
 * переиспользоваться, и SIGKILL постороннему процессу — куда худший исход, чем
 * не остановленный сервер.
 *
 * Живёт здесь, рядом с книгой, а не в реестре: книга и есть то, что помнит PID и
 * момент старта, а «тот же ли это процесс» — её собственный вопрос.
 *
 * Исход НАЗЫВАЕТСЯ. `ESRCH` — процесс ушёл сам между проверкой и сигналом, это и
 * есть цель. Всё остальное (в первую очередь `EPERM`: процесс ЖИВ, но чужой —
 * агент перезапущен под другим пользователем) — отказ: сказать человеку
 * «остановлено» и вычеркнуть из книги сервер, который держит свой порт, значит
 * потерять его навсегда. И SIGKILL сверяется: «послали» и «ушёл» — разные факты.
 */
export async function stopProcessByPid(
  pid: number,
  startProc: number,
  fail: (detail: string) => Error,
): Promise<void> {
  const ours = (): boolean => sameProcess({ pid, startProc });
  const signal = (kind: 'SIGTERM' | 'SIGKILL'): boolean => {
    try {
      process.kill(pid, kind);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      const why = error instanceof Error ? error.message : String(error);
      throw fail(`процесс ${String(pid)}: ${kind} не прошёл — ${why}`);
    }
  };
  const settle = async (steps: number): Promise<void> => {
    for (let i = 0; i < steps && ours(); i++) {
      await new Promise((done) => setTimeout(done, 100));
    }
  };
  if (!ours() || !signal('SIGTERM')) return;
  await settle(30);
  if (!ours() || !signal('SIGKILL')) return;
  await settle(20);
  if (ours()) throw fail(`процесс ${String(pid)} жив после SIGKILL`);
}
