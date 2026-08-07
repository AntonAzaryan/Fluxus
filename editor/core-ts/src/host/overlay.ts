/**
 * Хост поверх хоста: чтение сначала из наложения, потом из основы; запись —
 * только в наложение.
 *
 * Нужен ровно там, где состояние документов должно быть видно потребителю,
 * читающему дерево, но на диск попасть не должно:
 *
 * - превью (ED-9) прогоняет текущее состояние документов, включая несохранённые
 *   правки, и при этом MUST NOT записывать что-либо в дерево контента;
 * - просмотрщик ассетов и вьюпорт (ED-20, ED-15) должны видеть правку записи
 *   манифеста до сохранения — манифест такой же редактируемый документ, как
 *   конфиг сцены (ED-19).
 *
 * Наложение — обычный `createMemoryHost`, поэтому второй реализации «дерева в
 * памяти» не появляется: тестовый дубль и подложка несохранённого — один и тот
 * же объект.
 *
 * Надгробий у наложения нет: убрать файл основы им нельзя. Это не пробел —
 * удаления в шве нет вовсе (см. `types.ts`), и вводить его окольным путём через
 * наложение значило бы завести ту же операцию без требования.
 */
import { createMemoryHost, type MemoryHost } from './memory.js';
import { compareContentNames, normalizeContentPath } from './paths.js';
import type { ContentEntry, ContentTreeHost, EnvironmentHost } from './types.js';

export interface OverlayHost extends EnvironmentHost {
  /** Наложение: сюда ложится всё записанное и всё подставленное вместо диска. */
  readonly overlay: MemoryHost;
}

export interface OverlayHostOptions {
  readonly name?: string;
  /** Готовое наложение; по умолчанию создаётся пустое. */
  readonly overlay?: MemoryHost;
}

export function createOverlayHost(base: EnvironmentHost, options: OverlayHostOptions = {}): OverlayHost {
  const overlay = options.overlay ?? createMemoryHost({ name: `${base.name}+overlay` });

  const content: ContentTreeHost = {
    async read(path) {
      const at = normalizeContentPath(path);
      if (overlay.has(at)) return overlay.content.read(at);
      return base.content.read(at);
    },

    write: (path, bytes) => overlay.content.write(path, bytes),

    async stat(path) {
      const at = normalizeContentPath(path);
      return (await overlay.content.stat(at)) ?? (await base.content.stat(at));
    },

    async list(path) {
      const at = normalizeContentPath(path);
      const merged = new Map<string, ContentEntry>();
      for (const entry of await base.content.list(at)) merged.set(entry.name, entry);
      // Наложение поверх: файл, подставленный вместо дискового, остаётся тем же
      // путём, а новый — добавляется. Порядок задаётся сортировкой ниже, а не
      // порядком слияния (ED-12: перечисление одинаково во всех средах).
      for (const entry of await overlay.content.list(at)) merged.set(entry.name, entry);
      return [...merged.values()].sort((a, b) => compareContentNames(a.name, b.name));
    },

    watch(listener) {
      const stopBase = base.content.watch(listener);
      const stopOverlay = overlay.content.watch(listener);
      return () => {
        stopBase();
        stopOverlay();
      };
    },
  };

  return {
    name: options.name ?? `${base.name}+overlay`,
    get root() {
      return base.root;
    },
    content,
    picker: base.picker,
    window: base.window,
    overlay,
  };
}
