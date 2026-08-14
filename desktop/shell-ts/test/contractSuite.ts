/**
 * Контрактный сьют границы контейнера (DSK-6): один набор утверждений, через
 * который проходит ЛЮБАЯ реализация.
 *
 * Сьют параметризован реализацией, а не привязан к Electron, потому что
 * нормативна граница, а не технология: «вторая реализация контейнера проходит
 * тот же контрактный сьют, и приложения запускаются в ней без правок» — это
 * сценарий DSK-6, и он обязан быть исполняемым, а не обещанным. Реализация
 * даёт функцию `open(kase)`, которая поднимает контейнер на подготовленном
 * дереве; всё остальное — здесь.
 *
 * Сьют говорит только на словаре границы (DSK-2): пути, байты, события,
 * диалоги, окно. Ни одного типа движка, ни одного документа контента — если бы
 * они здесь понадобились, это и было бы доказательством, что граница протекла.
 *
 * Реализация на чистом Node (`hostBridge.contract.test.ts`) — та, что живёт в
 * гейте. Прогон в настоящем контейнере поднимает ту же функцию `open` поверх
 * Electron и в `npm run check` не входит (DSK-6, «полный прогон в контейнере —
 * отдельная проверка вне гейта»).
 */
import { describe, expect, it } from 'vitest';
import type { BridgeCapability, BridgeChange, DesktopBridge } from '../src/bridge/types.js';

/** Имя корня дерева контента в сьюте: одно на все реализации. */
export const CONTENT = 'content';

export interface ContractCase {
  /** Файлы бандла приложения на старте. */
  readonly bundle?: Readonly<Record<string, string>>;
  /** Файлы дерева контента на старте. */
  readonly content?: Readonly<Record<string, string>>;
  /** Возможности профиля (DSK-5). Пустой список — мост без операций. */
  readonly capabilities: readonly BridgeCapability[];
  /** Открыт ли корень контента на запись. */
  readonly writable: boolean;
}

export interface ContractResponse {
  readonly ok: boolean;
  readonly body?: string;
  readonly mime?: string;
}

export interface ContractSession {
  /** Ровно то, что реализация кладёт в страницу. */
  readonly bridge: DesktopBridge;
  /** Правка дерева мимо моста — так дерево правит чужой инструмент. */
  touch(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Что лежит на диске мимо моста: проверка, что запись доехала. */
  peek(path: string): Promise<string | undefined>;
  /** Запрос к раздаче контейнера (DSK-4). */
  fetch(pathname: string): Promise<ContractResponse>;
  /** Контейнер спрашивает страницу о закрытии. */
  requestClose(): Promise<boolean>;
  close(): Promise<void>;
}

export type ContainerUnderTest = (kase: ContractCase) => Promise<ContractSession>;

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * Ждёт условия до крайнего срока. Уведомление о правке дерева контракт обещает,
 * а мгновенности не обещает: у одной реализации оно синхронно, у другой едет
 * через IPC. Ожидание по условию оставляет утверждение сильным и не делает его
 * заложником чужого планировщика.
 */
async function until(condition: () => boolean, deadlineMs = 4000): Promise<boolean> {
  const edge = Date.now() + deadlineMs;
  while (Date.now() < edge) {
    if (condition()) return true;
    await new Promise((done) => setTimeout(done, 10));
  }
  return condition();
}

/** Даёт уведомлениям время НЕ прийти: единственный способ проверить тишину. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 100));

const AUTHORING: readonly BridgeCapability[] = ['read', 'write', 'watch', 'dialog', 'window'];

/** Дерево редактора: две ветки и коллизия имени с бандлом. */
const TREE: Readonly<Record<string, string>> = {
  'scenes/duel.scene.json': '{"scene":"duel"}',
  'scenes/duel.presentation.json': '{"decorations":[]}',
  'visuals/manifest.json': '{"visuals":{}}',
  'index.html': 'дерево',
};

const BUNDLE: Readonly<Record<string, string>> = {
  'index.html': '<!doctype html><title>app</title>',
  'assets/app.js': 'export const app = 1;',
};

async function withSession(
  open: ContainerUnderTest,
  kase: ContractCase,
  body: (session: ContractSession) => void | Promise<void>,
): Promise<void> {
  const session = await open(kase);
  try {
    await body(session);
  } finally {
    await session.close();
  }
}

/** Весь контракт границы одним вызовом. `name` — имя реализации в отчёте. */
export function describeContainerContract(name: string, open: ContainerUnderTest): void {
  const authoring = (body: (session: ContractSession) => void | Promise<void>): Promise<void> =>
    withSession(open, { bundle: BUNDLE, content: TREE, capabilities: AUTHORING, writable: true }, body);

  describe(`${name}: словарь границы — пути, байты, события (DSK-2)`, () => {
    it('чтение отдаёт байты файла дерева', async () => {
      await authoring(async (session) => {
        const bytes = await session.bridge.read!(CONTENT, 'scenes/duel.scene.json');
        expect(decode(bytes)).toBe(TREE['scenes/duel.scene.json']);
      });
    });

    it('stat различает файл, каталог и пустоту', async () => {
      await authoring(async (session) => {
        expect(await session.bridge.stat!(CONTENT, 'scenes/duel.scene.json')).toEqual({
          path: 'scenes/duel.scene.json',
          name: 'duel.scene.json',
          kind: 'file',
        });
        expect((await session.bridge.stat!(CONTENT, 'scenes'))?.kind).toBe('directory');
        expect(await session.bridge.stat!(CONTENT, 'scenes/нет.json')).toBeUndefined();
      });
    });

    it('перечисление даёт один уровень в нормированном порядке', async () => {
      await authoring(async (session) => {
        const entries = await session.bridge.list!(CONTENT, 'scenes');
        expect(entries.map((entry) => entry.name)).toEqual([
          'duel.presentation.json',
          'duel.scene.json',
        ]);
        expect(entries[0]!.path).toBe('scenes/duel.presentation.json');
        // Каталога нет — пустой список, а не отказ: это обычный ответ о дереве.
        expect(await session.bridge.list!(CONTENT, 'нет-такого')).toEqual([]);
      });
    });

    it('чтение отсутствующего файла отказывает, называя путь', async () => {
      await authoring(async (session) => {
        await expect(session.bridge.read!(CONTENT, 'scenes/нет.json')).rejects.toThrow('scenes/нет.json');
      });
    });

    it('путь за пределы корня не проходит ни в одну операцию (DSK-5)', async () => {
      await authoring(async (session) => {
        for (const escape of ['../secret', 'scenes/../../secret', '/etc/passwd/../../secret']) {
          await expect(session.bridge.read!(CONTENT, escape)).rejects.toThrow();
        }
        // Абсолютный путь ОС — не путь дерева: корень задаёт профиль.
        await expect(session.bridge.write!(CONTENT, '../outside.json', encode('{}'))).rejects.toThrow();
        expect(await session.peek('../outside.json')).toBeUndefined();
      });
    });

    it('корень, которого профиль не объявлял, отказывает по имени', async () => {
      await authoring(async (session) => {
        await expect(session.bridge.read!('secrets', 'anything')).rejects.toThrow('secrets');
      });
    });
  });

  describe(`${name}: запись — только байты по пути (DSK-2)`, () => {
    it('запись доезжает до диска и уведомляет наблюдателя', async () => {
      await authoring(async (session) => {
        const seen: BridgeChange[] = [];
        const stop = session.bridge.watch!(CONTENT, (change) => seen.push(change));
        await session.bridge.write!(CONTENT, 'scenes/new.scene.json', encode('{"scene":"new"}'));
        expect(await session.peek('scenes/new.scene.json')).toBe('{"scene":"new"}');
        await until(() => seen.some((change) => change.path === 'scenes/new.scene.json'));
        expect(seen.some((change) => change.path === 'scenes/new.scene.json')).toBe(true);
        expect(seen[0]!.root).toBe(CONTENT);
        stop();
      });
    });

    it('перезапись существующего документа сохраняет ровно поданные байты', async () => {
      await authoring(async (session) => {
        await session.bridge.write!(CONTENT, 'scenes/duel.scene.json', encode('{"scene":"духель"}'));
        expect(await session.peek('scenes/duel.scene.json')).toBe('{"scene":"духель"}');
      });
    });

    it('недостающие каталоги создаёт контейнер', async () => {
      await authoring(async (session) => {
        await session.bridge.write!(CONTENT, 'matches/added/one.match.json', encode('{}'));
        expect(await session.peek('matches/added/one.match.json')).toBe('{}');
      });
    });
  });

  describe(`${name}: события изменения дерева (DSK-2)`, () => {
    it('правка мимо моста приходит подписчику', async () => {
      await authoring(async (session) => {
        const seen: BridgeChange[] = [];
        const stop = session.bridge.watch!(CONTENT, (change) => seen.push(change));
        await session.touch('scenes/duel.scene.json', '{"scene":"правлено"}');
        await until(() => seen.some((change) => change.path === 'scenes/duel.scene.json'));
        expect(seen.map((change) => change.path)).toContain('scenes/duel.scene.json');
        await session.remove('scenes/duel.scene.json');
        await until(() => seen.some((change) => change.kind === 'removed'));
        expect(seen.some((change) => change.kind === 'removed')).toBe(true);
        stop();
      });
    });

    it('отписка прекращает уведомления', async () => {
      await authoring(async (session) => {
        const seen: BridgeChange[] = [];
        const stop = session.bridge.watch!(CONTENT, (change) => seen.push(change));
        stop();
        await session.touch('scenes/duel.scene.json', '{"scene":"после отписки"}');
        await settle();
        expect(seen).toEqual([]);
      });
    });
  });

  describe(`${name}: раздача бандла и дерева (DSK-4)`, () => {
    it('бандл отдаётся по своему пути', async () => {
      await authoring(async (session) => {
        const response = await session.fetch('/index.html');
        expect(response.ok).toBe(true);
        expect(response.body).toBe(BUNDLE['index.html']);
        expect(response.mime).toContain('text/html');
      });
    });

    it('ассет дерева отдаётся по ID-пути — тем же адресом, что и в браузере', async () => {
      await authoring(async (session) => {
        const response = await session.fetch('/visuals/manifest.json');
        expect(response.ok).toBe(true);
        expect(response.body).toBe(TREE['visuals/manifest.json']);
      });
    });

    it('корень запроса отдаёт документ входа бандла', async () => {
      await authoring(async (session) => {
        expect((await session.fetch('/')).body).toBe(BUNDLE['index.html']);
      });
    });

    it('совпадение имени решает порядок слоёв: бандл закрывает дерево', async () => {
      await authoring(async (session) => {
        expect((await session.fetch('/index.html')).body).not.toBe(TREE['index.html']);
      });
    });

    it('чего нет ни в одном слое — того нет', async () => {
      await authoring(async (session) => {
        expect((await session.fetch('/нет-такого.png')).ok).toBe(false);
      });
    });

    it('базовый адрес раздачи приложение получает от контейнера', async () => {
      await authoring((session) => {
        const root = session.bridge.session.roots.find((entry) => entry.id === CONTENT);
        expect(root?.base).not.toBe('');
      });
    });
  });

  describe(`${name}: профиль как whitelist (DSK-5)`, () => {
    it('сессия называет ровно объявленные возможности и корни', async () => {
      await authoring((session) => {
        expect([...session.bridge.session.capabilities].sort()).toEqual([...AUTHORING].sort());
        expect(session.bridge.session.roots.map((root) => root.id)).toEqual([CONTENT]);
        expect(session.bridge.session.roots[0]!.writable).toBe(true);
      });
    });

    it('профиль игры: моста нет вовсе, раздача есть', async () => {
      await withSession(
        open,
        { bundle: BUNDLE, content: TREE, capabilities: [], writable: false },
        async (session) => {
          const bridge = session.bridge;
          expect(bridge.read).toBeUndefined();
          expect(bridge.write).toBeUndefined();
          expect(bridge.watch).toBeUndefined();
          expect(bridge.choose).toBeUndefined();
          expect(bridge.setTitle).toBeUndefined();
          expect(bridge.session.capabilities).toEqual([]);
          expect(bridge.session.roots[0]!.writable).toBe(false);
          // Ассеты игре достаются раздачей — код загрузки клиента тот же, что в
          // браузере (DSK-1, DSK-4).
          expect((await session.fetch('/visuals/manifest.json')).body).toBe(TREE['visuals/manifest.json']);
        },
      );
    });

    it('read-only профиль: записи нет ни в каком виде', async () => {
      await withSession(
        open,
        { bundle: BUNDLE, content: TREE, capabilities: ['read'], writable: false },
        async (session) => {
          expect(session.bridge.write).toBeUndefined();
          expect(await session.bridge.read!(CONTENT, 'visuals/manifest.json')).toBeDefined();
          // И дерево осталось нетронутым: писать было нечем.
          expect(await session.peek('visuals/manifest.json')).toBe(TREE['visuals/manifest.json']);
        },
      );
    });

    it('наблюдение и диалоги приходят только с объявленной возможностью', async () => {
      await withSession(
        open,
        { bundle: BUNDLE, content: TREE, capabilities: ['read', 'watch'], writable: false },
        (session) => {
          expect(session.bridge.watch).toBeDefined();
          expect(session.bridge.choose).toBeUndefined();
          expect(session.bridge.onCloseRequest).toBeUndefined();
        },
      );
    });
  });

  describe(`${name}: оконная интеграция (DSK-2)`, () => {
    it('заголовок и признак несохранённого уходят наружу окна', async () => {
      await authoring(async (session) => {
        session.bridge.setTitle!('duel.scene.json — Fluxus');
        session.bridge.setUnsaved!(true);
        // Контейнер о документе ничего не узнал: наружу ушли строка и флаг.
        expect(await session.requestClose()).toBe(true);
      });
    });

    it('приложение отвечает на запрос закрытия, и ответ доходит до контейнера', async () => {
      await authoring(async (session) => {
        const stop = session.bridge.onCloseRequest!(() => false);
        expect(await session.requestClose()).toBe(false);
        stop();
        expect(await session.requestClose()).toBe(true);
      });
    });
  });
}
