/**
 * Заглушки швов оболочки для тестов демо: `RenderContext` без THREE и
 * синхронная пара портов канала.
 *
 * Копии таких же заглушек живут в `engine/client-ts/test/fixtures.ts` — и это
 * не дублирование контента, а две независимые реализации ОДНОГО шва
 * (`client-shell` SHELL-2, SHELL-3): там ими пинают саму оболочку, здесь —
 * сборку игры поверх неё. Общей фикстуры у них быть не должно: пакет оболочки
 * не вправе зависеть от игры, а игра — от тестовой оснастки чужого пакета.
 */
import type { RenderContext } from '@fluxus/render';
import type { ShellPort } from '@fluxus/client';

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
