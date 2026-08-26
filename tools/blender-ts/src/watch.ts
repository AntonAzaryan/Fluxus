/**
 * Watch-режим конвейера (BLND-12): «сохранил в Blender — увидел в кадре
 * движка». Слежение за экспортом источника, импорт на изменение, последний
 * валидный результат при ошибке.
 *
 * Модуль разложен на три независимые части, и это не украшение, а условие
 * проверяемости: настоящее `fs.watch` в тесте — это ожидание чужих таймингов,
 * которое в CI либо флакает, либо не проверяет ничего.
 *
 * 1. **Цикл** (`createImportCycle`) — «прочитать источник, импортировать,
 *    рассказать». Ничего не знает ни о файловой системе, ни о таймерах: ему
 *    дают хост дерева (ED-12), и тест зовёт его напрямую.
 * 2. **Триггер** (`createWatchTrigger`) — дебаунс и сериализация: пачка
 *    событий сохранения даёт один прогон, событие во время прогона — ровно один
 *    следующий. Таймеры инжектируются (`WatchTimers`), поэтому в тесте время
 *    двигает тест.
 * 3. **Наблюдение** (`watchSourceFile`) — единственное место, где есть
 *    `node:fs`.
 *
 * ## Почему наблюдение за каталогом, а не за файлом
 *
 * Экспорт из Blender (аддон, `save_post`, задача 8.6) и всякий приличный
 * писатель файла кладут результат во временный файл и переименовывают его на
 * место. `fs.watch(file)` на POSIX держит inode: после подмены он смотрит на
 * файл, которого в дереве больше нет, и молчит навсегда — watch «работает», а
 * правки не доезжают. Поэтому наблюдается запись каталога, а события фильтруются
 * по имени.
 *
 * Страховочный опрос (`pollMs`) существует по второй причине того же рода:
 * inotify не работает на части сетевых и виртуальных ФС, и там наблюдение молчит
 * без единой ошибки. Опрос сравнивает отпечаток файла и стоит один `stat` в
 * секунду; расхождения он не создаёт — отпечаток обновляется и по событию
 * наблюдателя, поэтому уже отработанная правка вторым циклом не приходит.
 *
 * ## Ошибка не роняет цикл
 *
 * Отказ импорта — это `ok: false` и ни одного записанного байта: атомарность
 * записи даёт «последний валидный кадр» даром (BLND-6), и watch'у остаётся
 * назвать находки с адресами объектов и продолжить слежение. Исключения
 * (источник исчез посреди записи, файл не разбирается) ловятся здесь же и
 * становятся тем же самым отказом: watcher, падающий от битого файла, требовал
 * бы от автора перезапуска ровно там, где он и без того исправляет ошибку.
 *
 * Канала «документы обновились» этот модуль не содержит намеренно: его несёт
 * dev-сервер редактора, который и так наблюдает за деревом контента
 * (`editor/ui-ts/app/contentEndpoint.ts`, ED-12). Импорт пишет документы,
 * сервер видит запись, открытый кадр перечитывает — сокет-клиента в инструменте
 * авторинга при этом не заводится (design, решение 12). В клиент матча watch не
 * встраивается ни в каком виде (BLND-7).
 */
import { realpathSync, watch as watchFs } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  ContentPath,
  ContentTreeHost,
  ContributionReader,
  DocumentId,
  ValidationRule,
} from '@fluxus/editor-core';
import { runImport, type ImportResult } from './importer.js';
import { importResources, reportFindings, type ReportIo } from './report.js';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ------------------------------------------------------------------- цикл

export interface ImportCycleOptions {
  /** Дерево контента через хост среды (ED-12) — единственный канал чтения и записи. */
  readonly host: ContentTreeHost;
  readonly source: ContentPath;
  /** Манифест визуалов; `null` — ссылки `visual` не проверять. */
  readonly manifest?: ContentPath | null;
  readonly rules?: ContributionReader<ValidationRule>;
  readonly locale?: string;
  readonly io: ReportIo;
}

/** Чем кончился один прогон. `result === null` — до импорта дело не дошло. */
export interface CycleOutcome {
  /** Порядковый номер прогона, начиная с 1: по нему видно, что цикл жив. */
  readonly index: number;
  readonly ok: boolean;
  readonly result: ImportResult | null;
  /** Почему прогон не состоялся; у удавшегося — `null`. */
  readonly refusal: string | null;
  readonly written: readonly DocumentId[];
}

export interface ImportCycle {
  /** Один прогон. Не бросает НИКОГДА: отказ — это значение, а не исключение. */
  run(): Promise<CycleOutcome>;
  /** Сколько прогонов было. */
  readonly runs: number;
  /** Последний прогон — каким бы он ни был. */
  last(): CycleOutcome | null;
  /**
   * Последний УДАВШИЙСЯ прогон: то состояние документов, которое сейчас лежит
   * на диске и, значит, показано в кадре (BLND-12). Отказ его не отменяет.
   */
  lastValid(): CycleOutcome | null;
}

export function createImportCycle(options: ImportCycleOptions): ImportCycle {
  const resources = importResources(options.locale ?? 'ru');
  const { io, source } = options;
  let index = 0;
  let last: CycleOutcome | null = null;
  let valid: CycleOutcome | null = null;

  /** Что показано в кадре сейчас — говорится ровно тогда, когда прогон отказал. */
  const keeping = (): void => {
    io.err(
      valid === null
        ? `  валидного импорта ещё не было: документы дерева остаются такими, какими были до watch`
        : `  в кадре остаётся результат прогона ${valid.index}: документы на диске не тронуты (BLND-12)`,
    );
  };

  return {
    get runs(): number {
      return index;
    },
    last: () => last,
    lastValid: () => valid,
    async run(): Promise<CycleOutcome> {
      index += 1;
      let result: ImportResult;
      try {
        result = await runImport({
          host: options.host,
          source,
          ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
          ...(options.rules === undefined ? {} : { rules: options.rules }),
        });
      } catch (error) {
        // Источник исчез посреди записи, не разбирается, сцены рядом нет:
        // всё это — обычный отказ цикла, а не конец watch-режима.
        const outcome: CycleOutcome = {
          index,
          ok: false,
          result: null,
          refusal: message(error),
          written: [],
        };
        last = outcome;
        io.err(`импорт ${index}: ${outcome.refusal}`);
        keeping();
        return outcome;
      }

      reportFindings(result, io.err, resources);
      const outcome: CycleOutcome = {
        index,
        ok: result.ok,
        result,
        refusal: result.refusal,
        written: result.written,
      };
      last = outcome;
      if (!result.ok) {
        io.err(
          result.refusal ?? `импорт ${index} "${source}" отвергнут: на диск не записано ничего (BLND-6)`,
        );
        keeping();
        return outcome;
      }
      valid = outcome;
      io.err(
        result.written.length === 0
          ? `импорт ${index} "${source}": документы уже совпадают с источником (BLND-4)`
          : `импорт ${index} "${source}": записаны ${result.written.join(', ')}`,
      );
      return outcome;
    },
  };
}

// ---------------------------------------------------------------- триггер

/**
 * Отложенный вызов. Инжектируется, потому что дебаунс — единственная часть
 * watch'а, у которой есть своё поведение во времени, и проверять его настоящими
 * таймерами значило бы проверять планировщик ОС.
 */
export interface WatchTimers {
  /** Зовёт `run` через `ms`; возвращённая функция отменяет ещё не случившийся вызов. */
  delay(ms: number, run: () => void): () => void;
}

export const REAL_TIMERS: WatchTimers = {
  delay(ms, run) {
    const handle = setTimeout(run, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

export interface WatchTriggerOptions {
  /** Что запускать. Бросать не должно: watch продолжается при любом исходе. */
  readonly cycle: () => Promise<unknown>;
  /** Затишье, после которого прогон запускается; по умолчанию — 150 мс. */
  readonly debounceMs?: number;
  readonly timers?: WatchTimers;
}

export interface WatchTrigger {
  /** Источник изменился: запланировать прогон, отложив уже запланированный. */
  notify(): void;
  /**
   * Прогон сразу, без дебаунса, но тем же насосом, что `notify()`: событие
   * источника, пришедшее во время него, даёт ровно один следующий прогон, а не
   * второй пишущий рядом. Разрешается вместе с прогонами, которые он потянул.
   */
  prime(): Promise<void>;
  /** Идёт ли прогон прямо сейчас. */
  readonly running: boolean;
  /** Ждёт завершения идущего прогона и всех, которые он за собой потянул. */
  settled(): Promise<void>;
  close(): void;
}

/**
 * Дебаунс и сериализация прогонов.
 *
 * Дебаунс — потому что одно сохранение в Blender даёт несколько событий ФС
 * (временный файл, переименование, запись метаданных), и импортировать на
 * каждое значило бы гонять цикл три раза на одну правку автора.
 *
 * Сериализация — потому что два импорта одного дерева одновременно писали бы
 * одни и те же документы: атомарность отдельного импорта (BLND-6) о втором
 * пишущем ничего не обещает. Событие, пришедшее во время прогона, поэтому не
 * теряется и не запускает второй прогон рядом — оно даёт РОВНО ОДИН следующий,
 * каким бы числом событий оно ни было.
 */
export function createWatchTrigger(options: WatchTriggerOptions): WatchTrigger {
  const timers = options.timers ?? REAL_TIMERS;
  const debounceMs = options.debounceMs ?? 150;
  let cancel: (() => void) | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let closed = false;

  const pump = async (): Promise<void> => {
    while (!closed) {
      again = false;
      await options.cycle();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- baseline
      if (!again) return;
    }
  };

  const fire = (): void => {
    cancel = null;
    if (running !== null) {
      again = true;
      return;
    }
    running = pump()
      // Цикл отказы возвращает значением, но watch обязан пережить и то, чего
      // никто не предусмотрел: упавший здесь прогон оставил бы триггер
      // «вечно занятым», и следующее сохранение не запустило бы ничего.
      .catch(() => undefined)
      .then(() => {
        running = null;
      });
  };

  return {
    notify(): void {
      if (closed) return;
      cancel?.();
      cancel = timers.delay(debounceMs, fire);
    },
    prime(): Promise<void> {
      if (closed) return Promise.resolve();
      // Отложенный дебаунсом вызов немедленный прогон поглощает: источник
      // читается сейчас, то есть уже с той правкой, о которой было событие.
      cancel?.();
      fire();
      return running ?? Promise.resolve();
    },
    get running(): boolean {
      return running !== null;
    },
    async settled(): Promise<void> {
      while (running !== null) await running;
    },
    close(): void {
      closed = true;
      cancel?.();
      cancel = null;
    },
  };
}

// ------------------------------------------------------------- наблюдение

export interface SourceWatchOptions {
  /** Абсолютный путь наблюдаемого файла экспорта. */
  readonly file: string;
  /** Файл изменился. Зовётся чаще, чем случаются правки автора: дебаунс — снаружи. */
  readonly changed: () => void;
  /** Период страховочного опроса, мс; `0` — без опроса. По умолчанию 1000. */
  readonly pollMs?: number;
  /** Куда сказать о том, чего среда не даёт (ED-12: честный отказ, а не тишина). */
  readonly report?: (text: string) => void;
}

/**
 * Путь в том написании, в каком его понимает сама система. Не разрешается —
 * остаётся как есть: тогда откажет само наблюдение, названной причиной, и это
 * предусмотренный здесь исход.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Отпечаток файла: правку видно по времени, размеру и inode (подмена файла). */
async function stamp(file: string): Promise<string> {
  try {
    const found = await stat(file);
    return `${found.mtimeMs}:${found.size}:${found.ino}`;
  } catch {
    return '';
  }
}

export function watchSourceFile(options: SourceWatchOptions): () => void {
  const directory = dirname(options.file);
  const name = basename(options.file);
  const pollMs = options.pollMs ?? 1000;
  const report = options.report ?? ((): void => undefined);
  let seen: string | null = null;
  let closed = false;

  /** Отметить текущее состояние файла как уже увиденное. */
  const remember = (): void => {
    void stamp(options.file).then((next) => {
      seen = next;
    });
  };
  remember();

  const announce = (): void => {
    remember();
    options.changed();
  };

  let stopWatch = (): void => undefined;
  try {
    // Каталог, а не файл: переименование на место переживает только запись
    // каталога (см. шапку модуля). `filename === null` бывает на платформах,
    // не сообщающих имя, — тогда событие берётся целиком.
    //
    // Путь уходит в наблюдение КАНОНИЧЕСКИЙ, а не тот, что сложился из корня
    // дерева. На Windows он может содержать короткое имя 8.3 (`C:\Users\3EC2~1\…`
    // — так, в частности, выглядит `%TEMP%` у профиля с кириллицей), а
    // наблюдение за таким каталогом роняет ПРОЦЕСС на внутреннем assert'е libuv:
    // имена, которые приносит система, короткому написанию уже не соответствуют.
    // Отказ наблюдения watch переживает — остаётся опрос, — а падение процесса
    // не переживает никто.
    const watcher = watchFs(canonical(directory), (_event, filename) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- baseline
      if (filename === null || basename(String(filename)) === name) announce();
    });
    watcher.on('error', (error: unknown) => {
      report(`наблюдение за "${directory}" сорвалось: ${message(error)}; остаётся опрос`);
    });
    stopWatch = () => { watcher.close(); };
  } catch (error) {
    report(`наблюдение за "${directory}" недоступно: ${message(error)}; остаётся опрос`);
  }

  let poll: ReturnType<typeof setInterval> | null = null;
  if (pollMs > 0) {
    poll = setInterval(() => {
      void stamp(options.file).then((next) => {
        if (closed) return;
        // Первый опрос только запоминает: watch начинается с импорта, и
        // сообщать «файл изменился» о файле, который просто лежит, незачем.
        if (seen !== null && next !== seen) {
          seen = next;
          options.changed();
        } else {
          seen = next;
        }
      });
    }, pollMs);
  }

  return () => {
    closed = true;
    stopWatch();
    if (poll !== null) clearInterval(poll);
  };
}

// ---------------------------------------------------------------- режим

export interface ImportWatchOptions {
  readonly host: ContentTreeHost;
  /** Абсолютный путь корня дерева контента: по нему находится сам файл источника. */
  readonly root: string;
  readonly source: ContentPath;
  readonly manifest: ContentPath | null;
  readonly rules?: ContributionReader<ValidationRule>;
  readonly locale?: string;
  readonly io: ReportIo;
  readonly debounceMs?: number;
  readonly pollMs?: number;
  readonly timers?: WatchTimers;
  /** Чем watch кончается: сигнал среды или тест. Нет — до завершения процесса. */
  readonly signal?: AbortSignal;
}

/**
 * Watch-режим целиком. Возвращает код выхода: watch кончается не отказом
 * импорта, а тем, что автор его остановил, — поэтому 0 и тогда, когда последний
 * прогон отказал (ошибку он уже назвал, а кадр держит последний валидный
 * результат).
 */
export async function runImportWatch(options: ImportWatchOptions): Promise<number> {
  const cycle = createImportCycle({
    host: options.host,
    source: options.source,
    manifest: options.manifest,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    io: options.io,
  });
  const trigger = createWatchTrigger({
    cycle: () => cycle.run(),
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
  });
  const stop = watchSourceFile({
    file: join(options.root, options.source),
    changed: () => {
      trigger.notify();
    },
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    report: options.io.err,
  });

  options.io.err(`watch: слежу за "${options.source}"; правка источника — импорт (BLND-12)`);
  // Первый прогон — сразу: watch начинается с того, что документы приводятся в
  // соответствие источнику, иначе кадр до первого сохранения показывал бы то,
  // что осталось от прошлого раза. Идёт он ЧЕРЕЗ ТРИГГЕР: наблюдение уже
  // взведено, и сохранение, пришедшее во время первого импорта, обязано дать
  // один следующий прогон, а не второй пишущий рядом с первым (см. триггер).
  await trigger.prime();

  try {
    await new Promise<void>((resolve) => {
      const signal = options.signal;
      if (signal === undefined) return;
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => {
        resolve();
      });
    });
  } finally {
    stop();
    trigger.close();
    await trigger.settled();
  }
  return 0;
}
