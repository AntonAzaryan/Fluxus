/**
 * Единственный вынужденный повтор в пакете — имена каналов IPC и константы
 * контракта, продублированные в `src/electron/preload.cjs`.
 *
 * Повтор вынужден средой: preload исполняется в песочнице (`sandbox: true`), где
 * `require` соседнего модуля недоступен, поэтому файл самодостаточный и на
 * CommonJS. Разъехавшись, этот повтор ломает мост молча — страница зовёт канал,
 * которого в главном процессе нет, и отказ выглядит как «возможность не
 * работает», а не как опечатка.
 *
 * Тест читает оба файла ТЕКСТОМ и Electron не требует: он про совпадение двух
 * списков, а не про поведение клея (клей проверяется вне гейта — контрактным
 * прогоном в контейнере и smoke-прогоном, DSK-6).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRIDGE_API, BRIDGE_GLOBAL, BRIDGE_VERSION } from '../src/bridge/types.js';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(PACKAGE, path), 'utf8');

/** Пары «имя: 'значение'» объявленного объекта каналов — из любого из двух файлов. */
function channelsIn(source: string): Record<string, string> {
  const block = /CHANNELS\s*=\s*\{([\s\S]*?)\n\}/.exec(source);
  expect(block, 'объект CHANNELS в файле не найден').not.toBeNull();
  return Object.fromEntries(
    [...block![1]!.matchAll(/(\w+):\s*'([^']+)'/g)].map(([, name, value]) => [name!, value!]),
  );
}

describe('клей Electron: повтор имён каналов не разъезжается', () => {
  it('preload объявляет ровно те же каналы, что и главный процесс', () => {
    const declared = channelsIn(read('src/electron/channels.ts'));
    const duplicated = channelsIn(read('src/electron/preload.cjs'));
    // Не «подмножество»: лишний канал в preload — такой же разъезд, как
    // недостающий, и означает он ручку, которой в главном процессе нет.
    expect(duplicated).toEqual(declared);
    expect(Object.keys(declared).length).toBeGreaterThan(0);
  });

  it('preload повторяет константы контракта, а не свои', () => {
    // Имя моста в странице, его версия и глобаль — часть контракта (DSK-2), и
    // расхождение здесь означает мост, которого приложение не опознает.
    const preload = read('src/electron/preload.cjs');
    expect(preload).toContain(`const BRIDGE_API = '${BRIDGE_API}'`);
    expect(preload).toContain(`const BRIDGE_VERSION = ${String(BRIDGE_VERSION)}`);
    expect(preload).toContain(`const BRIDGE_GLOBAL = '${BRIDGE_GLOBAL}'`);
  });

  it('каждый объявленный канал вправду используется главным процессом', () => {
    // Мёртвое имя в списке — тот же разъезд, только в другую сторону: список
    // перестаёт описывать клей.
    const main = read('src/electron/main.ts');
    for (const name of Object.keys(channelsIn(read('src/electron/channels.ts')))) {
      expect(main, name).toContain(`CHANNELS.${name}`);
    }
  });
});
