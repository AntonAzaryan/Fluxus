/**
 * Оснастка тестов демо: заглушки швов оболочки (`RenderContext` без THREE и
 * синхронная пара портов канала) плюс дерево контента как источник байтов.
 *
 * Копии таких же заглушек живут в `engine/client-ts/test/fixtures.ts` — и это
 * не дублирование контента, а две независимые реализации ОДНОГО шва
 * (`client-shell` SHELL-2, SHELL-3): там ими пинают саму оболочку, здесь —
 * сборку игры поверх неё. Общей фикстуры у них быть не должно: пакет оболочки
 * не вправе зависеть от игры, а игра — от тестовой оснастки чужого пакета.
 *
 * Источник байтов здесь — оболочка прогона в Node (`game-content` CONT-5): им
 * тесты читают документы контент-пака ТЕМ ЖЕ загрузчиком, каким их читает
 * страница из раздачи.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetSource } from '@fluxus/assets';
import type { RenderContext } from '@fluxus/render';
import type { ShellPort } from '@fluxus/client';
import { loadDemoDocuments, type DemoDocuments } from '../app/match.js';

/** Корень дерева контента репозитория: тест ИГРЫ читает его законно (CONT-1, CONT-4). */
const CONTENT_ROOT = fileURLToPath(new URL('../../../content/', import.meta.url));

/**
 * Источник байтов дерева контента с файловой системы (ASSET-2): та же роль, что
 * у `fetch('/<id>')` страницы, — «путь до корня дерева есть свойство оболочки»
 * (CONT-5), и оболочка здесь — прогон в Node. Второй раскладки ID в путь не
 * появляется: ID и есть путь от корня.
 */
export function contentSource(root: string = CONTENT_ROOT): AssetSource {
  return {
    async read(id: string): Promise<ArrayBuffer> {
      // Копия, а не `buffer` прочитанного: `Buffer` живёт в общем пуле Node, и
      // его `ArrayBuffer` больше самого файла.
      return new Uint8Array(await readFile(join(root, id))).buffer;
    },
  };
}

/**
 * Документы контент-пака демо, прочитанные ТЕМ ЖЕ загрузчиком, что и страницей
 * (CONT-5): тесты поднимают матч по прочитанному дереву, а не по снимку,
 * запечённому в сборку теста, — иначе они пинали бы не ту дорогу, которой ходит
 * игрок.
 */
export function demoDocuments(): Promise<DemoDocuments> {
  return loadDemoDocuments(contentSource());
}

/** RenderContext для RemoteHost без THREE: подсистемы в тестах его не трогают. */
export function dummyContext(): RenderContext {
  return { scene: {}, assets: {}, config: { heightStep: 1 } } as unknown as RenderContext;
}

/** Синхронная пара портов: доставка немедленная, без клона — для unit-тестов. */
export function syncPortPair(): [ShellPort, ShellPort] {
  const handlers: (((message: unknown) => void) | null)[] = [null, null];
  const make = (self: number, other: number): ShellPort => ({
    post(message) {
      handlers[other]?.(message);
    },
    onMessage(handler) {
      handlers[self] = handler;
    },
  });
  return [make(0, 1), make(1, 0)];
}
