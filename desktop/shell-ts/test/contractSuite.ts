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
 * гейте. Ту же функцию `open` поверх настоящего контейнера поднимает
 * `test/electron/contract.ts` (`npm run contract:electron`): окно, preload,
 * IPC, protocol handler. В `npm run check` этот прогон не входит — «полный
 * прогон в контейнере — отдельная проверка вне гейта» (DSK-6).
 */
import { describe, expect, it } from 'vitest';
import type { BridgeCapability, BridgeChange, DesktopBridge } from '../src/bridge/types.js';

/** Имя корня дерева контента в сьюте: одно на все реализации. */
export const CONTENT = 'content';

/**
 * Имя сервиса, объявляемого профилем прогона (DSK-7). Чем он запускается и по
 * какому адресу слушает — дело реализации: сьют знает только имя, как и
 * страница.
 */
export const SERVICE = 'stand';

export interface ContractCase {
  /** Файлы бандла приложения на старте. */
  readonly bundle?: Readonly<Record<string, string>>;
  /** Файлы дерева контента на старте. */
  readonly content?: Readonly<Record<string, string>>;
  /** Возможности профиля (DSK-5). Пустой список — мост без операций. */
  readonly capabilities: readonly BridgeCapability[];
  /** Открыт ли корень контента на запись. */
  readonly writable: boolean;
  /**
   * Объявлен ли сервис профиля ОТВЯЗЫВАЕМЫМ (DSK-7): такой переживает сессию, а
   * его адрес пере-обнаруживается следующей. Свойство объявления, поэтому оно
   * здесь, а не в вызове страницы.
   */
  readonly detachedService?: boolean;
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
  /**
   * Кладёт по `path` внутри дерева ссылку на каталог ВНЕ корня, в котором лежит
   * `secret.txt`. Так дерево приезжает из дистрибутива или от чужого
   * инструмента; страница ссылок не делает. Реализация, которой ссылки
   * недоступны, метода не даёт — и проверка обхода пропускается.
   */
  linkOutside?(path: string): Promise<void>;
  /**
   * Ждёт, пока поданное мосту доедет до реализации. Нужен там, где сьют правит
   * дерево МИМО моста: подписка объявлена синхронной, но у реализации, где мост
   * едет через IPC, она устанавливается за границей окна, и правка, поданная в
   * ту же миллисекунду, обгоняет её. Реализация, у которой ждать нечего, метода
   * не даёт.
   */
  flush?(): Promise<void>;
  /** Что лежит на диске мимо моста: проверка, что запись доехала. */
  peek(path: string): Promise<string | undefined>;
  /**
   * Сколько процессов сервисов контейнер держит прямо сейчас. Не поверхность
   * границы, а взгляд снаружи — как `peek` для дерева: «второго процесса не
   * появилось» и «закрытие сессии его сняло» иначе не отличить от обещания.
   * Отвечать обязан и ПОСЛЕ `close`. Реализация, которой считать нечем, метода
   * не даёт — и обе проверки пропускаются.
   */
  serviceProcesses?(): Promise<number>;
  /**
   * Жив ли процесс сервиса ПРЯМО СЕЙЧАС — взгляд снаружи границы, как `peek`
   * для дерева. Отвечает и после `close`: иначе «отвязываемый пережил сессию»
   * осталось бы обещанием. Реализация, которой смотреть нечем, метода не даёт.
   */
  serviceAlive?(): Promise<boolean>;
  /**
   * Сколько РАЗ процесс сервиса поднимался за всё время. По записи контейнера
   * этого не разглядеть — она перезаписывается, — а «второго процесса не
   * появилось» держится именно на этом числе.
   */
  serviceStarts?(): Promise<number>;
  /**
   * Новая сессия ТОГО ЖЕ профиля на том же состоянии: так открывают приложение
   * во второй раз. Реализация, которая так не умеет, метода не даёт — и
   * проверки через границу сессий пропускаются.
   */
  reopen?(): Promise<ContractSession>;
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

    it('ссылка из дерева наружу — тот же выход за корень (DSK-5)', async () => {
      await authoring(async (session) => {
        if (session.linkOutside === undefined) return;
        await session.linkOutside('outside');
        // В самом пути нет ни одной точки — наружу выводит дерево, а не
        // вызывающий. Для границы это тот же обходной путь, и отказ тот же.
        await expect(session.bridge.read!(CONTENT, 'outside/secret.txt')).rejects.toThrow();
        await expect(session.bridge.list!(CONTENT, 'outside')).rejects.toThrow();
        await expect(
          session.bridge.write!(CONTENT, 'outside/written.json', encode('{}')),
        ).rejects.toThrow();
        // И раздача — тоже дверь наружу, причём у профиля игры единственная.
        expect((await session.fetch('/outside/secret.txt')).ok).toBe(false);
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
        await session.flush?.();
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
        await session.flush?.();
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
        // Ждём и подписку, и отписку: тишина обязана быть следствием отписки, а
        // не того, что подписка не успела дойти.
        await session.flush?.();
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

  describe(`${name}: объявленные профилем сервисы (DSK-7)`, () => {
    const hosting = (body: (session: ContractSession) => void | Promise<void>): Promise<void> =>
      withSession(
        open,
        { bundle: BUNDLE, content: TREE, capabilities: ['service'], writable: false },
        body,
      );

    it('сессия называет объявленные сервисы, и страница знает о них только имя', async () => {
      await hosting((session) => {
        expect(session.bridge.session.services).toEqual([SERVICE]);
        expect(session.bridge.startService).toBeDefined();
      });
    });

    it('запуск поднимает сервис и отдаёт его адрес', async () => {
      await hosting(async (session) => {
        const started = await session.bridge.startService!(SERVICE);
        expect(started.id).toBe(SERVICE);
        expect(started.running).toBe(true);
        expect(started.address).not.toBe('');
        expect(await session.bridge.serviceState!(SERVICE)).toEqual(started);
      });
    });

    it('повторный запуск возвращает адрес и не плодит процесса', async () => {
      await hosting(async (session) => {
        const first = await session.bridge.startService!(SERVICE);
        const second = await session.bridge.startService!(SERVICE);
        expect(second.address).toBe(first.address);
        if (session.serviceProcesses !== undefined) {
          expect(await session.serviceProcesses()).toBe(1);
        }
      });
    });

    it('останов гасит сервис, и состояние это показывает', async () => {
      await hosting(async (session) => {
        await session.bridge.startService!(SERVICE);
        const stopped = await session.bridge.stopService!(SERVICE);
        expect(stopped.running).toBe(false);
        expect(stopped.address).toBe('');
        expect((await session.bridge.serviceState!(SERVICE)).running).toBe(false);
      });
    });

    it('незнакомое имя — отказ, а не молчание', async () => {
      await hosting(async (session) => {
        await expect(session.bridge.startService!('нет такого')).rejects.toThrow();
        await expect(session.bridge.serviceState!('нет такого')).rejects.toThrow();
      });
    });

    it('сервис не переживает сессию, которая его подняла', async () => {
      const session = await open({
        bundle: BUNDLE,
        content: TREE,
        capabilities: ['service'],
        writable: false,
      });
      await session.bridge.startService!(SERVICE);
      await session.close();
      if (session.serviceProcesses !== undefined) {
        expect(await session.serviceProcesses()).toBe(0);
      }
    });

    it('отвязываемый сервис переживает сессию, а новая находит его по адресу', async () => {
      const session = await open({
        bundle: BUNDLE,
        content: TREE,
        capabilities: ['service'],
        writable: false,
        detachedService: true,
      });
      if (session.reopen === undefined || session.serviceAlive === undefined) {
        await session.close();
        return;
      }
      const first = await session.bridge.startService!(SERVICE);
      expect(first.running).toBe(true);
      await session.close();
      // Сессии нет, а процесс есть: отвязываемость — свойство объявления, и
      // закрытие окна его не отменяет (DSK-7).
      expect(await session.serviceAlive()).toBe(true);

      const next = await session.reopen();
      try {
        const again = await next.bridge.startService!(SERVICE);
        // Тот же адрес и НЕ второй процесс — через границу сессий.
        expect(again.address).toBe(first.address);
        if (next.serviceStarts !== undefined) expect(await next.serviceStarts()).toBe(1);

        // Остановка отвязанного остаётся доступной ЯВНОЙ операцией.
        const stopped = await next.bridge.stopService!(SERVICE);
        expect(stopped.running).toBe(false);
        if (next.serviceAlive !== undefined) expect(await next.serviceAlive()).toBe(false);
      } finally {
        await next.close();
      }
    });

    it('адрес отвязываемого сервиса приходит от САМОГО процесса (DSK-7)', async () => {
      const session = await open({
        bundle: BUNDLE,
        content: TREE,
        capabilities: ['service'],
        writable: false,
        detachedService: true,
      });
      try {
        const started = await session.bridge.startService!(SERVICE);
        // Контейнер строку не строит и не разбирает: он берёт её у объявления
        // либо у процесса и передаёт как есть. Пустой адрес означал бы, что
        // приложению нечего истолковывать.
        expect(started.address).not.toBe('');
        expect(await session.bridge.serviceState!(SERVICE)).toEqual(started);
      } finally {
        await session.bridge.stopService!(SERVICE);
        await session.close();
      }
    });

    it('профиль без возможности сервисов не даёт ни операций, ни имён', async () => {
      await withSession(
        open,
        { bundle: BUNDLE, content: TREE, capabilities: ['read'], writable: false },
        (session) => {
          expect(session.bridge.startService).toBeUndefined();
          expect(session.bridge.stopService).toBeUndefined();
          expect(session.bridge.serviceState).toBeUndefined();
          expect(session.bridge.session.services).toEqual([]);
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
