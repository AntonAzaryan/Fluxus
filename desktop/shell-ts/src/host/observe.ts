/**
 * Наблюдение за каталогом — единственное место слоя хоста, где есть `node:fs`
 * во времени, а не по запросу.
 *
 * Вынесено отдельным модулем и инжектируется по той же причине, по которой это
 * сделано в watch-режиме конвейера Blender (`tools/blender-ts/src/watch.ts`):
 * настоящий `fs.watch` в тесте — это ожидание чужих таймингов, которое в CI
 * либо флакает, либо не проверяет ничего. Семантику событий (что считается
 * созданием, правкой и удалением) проверяет контрактный сьют на подставленном
 * наблюдателе, а живой `fs.watch` — один тест с ожиданием условия по крайнему
 * сроку.
 *
 * Наблюдение рекурсивное: корень контента — дерево, и следить за одним верхним
 * уровнем значило бы не следить ни за чем. Платформа, где рекурсивного
 * наблюдения нет, получает честный отказ (`active === false`) и молчание, а не
 * видимость работы: приложение обязано пережить отсутствие уведомлений —
 * страдает свежесть картинки, а не корректность (то же правило, что у шва среды
 * редактора, ED-12).
 */
import { realpathSync, watch } from 'node:fs';

export interface DirectoryObserverOptions {
  /** Абсолютный путь наблюдаемого каталога. */
  readonly directory: string;
  /**
   * Что-то изменилось. `relative` — путь от каталога в разделителях ОС; `null`
   * — платформа имени не сообщила, и вызывающий обязан считать изменившимся всё.
   */
  readonly changed: (relative: string | null) => void;
  /** Куда сказать о том, чего среда не даёт: тишина без объяснения — хуже. */
  readonly report?: (text: string) => void;
}

export interface DirectoryObservation {
  /** Ведётся ли наблюдение на самом деле. `false` — событий не будет. */
  readonly active: boolean;
  close(): void;
}

export type DirectoryObserver = (options: DirectoryObserverOptions) => DirectoryObservation;

/**
 * Каталог в том написании, в каком его понимает сама система.
 *
 * `fs.watch` получает КАНОНИЧЕСКИЙ путь, а не тот, что назвал вызывающий, и это
 * не косметика. На Windows путь может прийти с коротким именем 8.3
 * (`C:\Users\3EC2~1\…` — так, в частности, выглядит `%TEMP%` у профиля с
 * кириллицей): наблюдение за таким каталогом роняет ПРОЦЕСС на внутреннем
 * assert'е libuv, потому что имена, которые приносит система, короткому
 * написанию каталога уже не соответствуют. Отказ наблюдения этот модуль
 * переживает (`active === false`), а падение процесса — нет и не может.
 *
 * Путь, который не разрешается, остаётся как есть: тогда `fs.watch` откажет
 * сам, названной причиной, — а это и есть предусмотренный здесь исход.
 */
function canonicalDirectory(directory: string): string {
  try {
    return realpathSync.native(directory);
  } catch {
    return directory;
  }
}

/** Наблюдатель поверх `fs.watch` — тот, с которым контейнер работает вживую. */
export const NODE_OBSERVER: DirectoryObserver = (options) => {
  const report = options.report ?? ((): void => undefined);
  try {
    const watcher = watch(canonicalDirectory(options.directory), { recursive: true }, (_event, filename) => {
      options.changed(filename);
    });
    watcher.on('error', (error: unknown) => {
      report(
        `наблюдение за "${options.directory}" сорвалось: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return {
      active: true,
      close: () => {
        watcher.close();
      },
    };
  } catch (error) {
    report(
      `наблюдение за "${options.directory}" недоступно: ${
        error instanceof Error ? error.message : String(error)
      }; уведомлений об изменениях извне не будет`,
    );
    return { active: false, close: () => undefined };
  }
};
