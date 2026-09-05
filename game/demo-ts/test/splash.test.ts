/**
 * DOM-адаптер сплеша (`game-boot` BOOT-2): скрипт ВЕДЁТ слой, который уже есть в
 * разметке страницы, — атрибут состояния, тексты, длительность угасания и узел
 * медиа.
 *
 * Браузера в прогоне нет: DOM здесь — мини-заглушка ровно на ту поверхность,
 * которую зовёт адаптер (тот же приём, что у панели отладки демо). Проверяется
 * контракт разметки, а не воспроизведение видео: сыграет ли оно, решает браузер,
 * а BOOT-2 требует от нас атрибутов и того, что отказ медиа старт не задержит.
 */
import { describe, expect, it } from 'vitest';
import { bindSplash, type SplashElement } from '../app/boot/splash.js';
import type { BootSplash } from '../app/boot/bootDocument.js';

/** Ровно та поверхность DOM, которую зовёт адаптер, — и ни строчкой больше. */
class FakeElement implements SplashElement {
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly attributes = new Map<string, string>();
  readonly properties = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  textContent: string | null = null;

  constructor(
    readonly tag: string,
    readonly className = '',
  ) {}

  readonly style = {
    setProperty: (name: string, value: string): void => {
      this.properties.set(name, value);
    },
  };

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  querySelector(selector: string): SplashElement | null {
    for (const node of this.walk()) {
      if (`.${node.className}` === selector) return node;
    }
    return null;
  }

  append(node: SplashElement): void {
    const child = node as FakeElement;
    child.parent = this;
    this.children.push(child);
  }

  /** Снятие узла со страницы — как в браузере: узел уходит от родителя. */
  remove(): void {
    const parent = this.parent;
    if (parent === null) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== listener),
    );
  }

  /** Событие браузера: тест зовёт обработчики, как это сделал бы он. */
  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  *walk(): Generator<FakeElement> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }
}

/** Разметка `#boot` из `index.html` — заголовок, строка состояния, слот медиа. */
function markup(): FakeElement {
  const root = new FakeElement('div');
  root.append(new FakeElement('div', 'boot__media'));
  root.append(new FakeElement('div', 'boot__title'));
  root.append(new FakeElement('div', 'boot__status'));
  return root;
}

function splashDoc(overrides: Partial<BootSplash> = {}): BootSplash {
  return { kind: 'none', title: 'Fluxus', src: null, minMs: 0, fadeMs: 400, ...overrides };
}

function nodeOf(root: FakeElement, className: string): FakeElement {
  return [...root.walk()].find((node) => node.className === className)!;
}

describe('сплеш ведётся по состояниям старта (BOOT-2, BOOT-4)', () => {
  it('состояние едет атрибутом, а ожидание матча отличимо от прогрева', () => {
    const root = markup();
    const splash = bindSplash({ root, splash: splashDoc() });
    expect(nodeOf(root, 'boot__title').textContent).toBe('Fluxus');
    // Длительность угасания — из документа: CSS знает переменную, число живёт
    // там же, где `minMs`.
    expect(root.properties.get('--boot-fade')).toBe('400ms');

    splash.show('warming');
    expect(root.attributes.get('data-state')).toBe('warming');
    const warming = nodeOf(root, 'boot__status').textContent;
    splash.show('waiting');
    expect(root.attributes.get('data-state')).toBe('waiting');
    // Ожидание матча — не загрузка (BOOT-4): игрок обязан видеть разницу.
    expect(nodeOf(root, 'boot__status').textContent).not.toBe(warming);
    expect(nodeOf(root, 'boot__status').textContent).toContain('соперник');
  });

  it('ход стадий — долей в переменной, а не шириной в пикселях', () => {
    const root = markup();
    const splash = bindSplash({ root, splash: splashDoc() });
    splash.progress(2, 8);
    expect(root.properties.get('--boot-progress')).toBe('0.25');
    splash.progress(8, 8);
    expect(root.properties.get('--boot-progress')).toBe('1');
  });
});

describe('угасание сплеша (BOOT-2)', () => {
  it('конец перехода убирает слой и закрывает вход машины', () => {
    const root = markup();
    let ended = 0;
    const splash = bindSplash({
      root,
      splash: splashDoc(),
      schedule: () => {},
      onFadeEnded: () => {
        ended += 1;
      },
    });
    splash.fade();
    expect(root.attributes.get('data-state')).toBe('revealing');
    root.fire('transitionend');
    // После `done` слой убран из потока событий и отрисовки целиком — правилом
    // разметки, а обработчик снят: сплеш не переживает раскрытия.
    expect(root.attributes.get('data-state')).toBe('done');
    expect(ended).toBe(1);
    expect(root.listeners.get('transitionend')).toEqual([]);
  });

  it('перехода не случилось — заканчивает запасной таймер, и ровно один раз', () => {
    // `transitionend` не приходит вовсе при нулевой длительности, в скрытой
    // вкладке и при `prefers-reduced-motion` — сплеш повис бы навсегда, а
    // вечного сплеша не бывает (BOOT-4).
    const root = markup();
    const timers: { ms: number; run: () => void }[] = [];
    let ended = 0;
    const splash = bindSplash({
      root,
      splash: splashDoc({ fadeMs: 300 }),
      schedule: (ms, run) => timers.push({ ms, run }),
      onFadeEnded: () => {
        ended += 1;
      },
    });
    splash.fade();
    expect(timers[0]!.ms).toBeGreaterThan(300);
    timers[0]!.run();
    expect(root.attributes.get('data-state')).toBe('done');
    // Опоздавшее событие перехода второго раскрытия не устраивает.
    root.fire('transitionend');
    expect(ended).toBe(1);
  });
});

describe('медиа сплеша — данные документа (BOOT-2)', () => {
  const dom = { createElement: (tag: string) => new FakeElement(tag) };

  it('картинка монтируется в слот по asset id, а не по пути сборки', () => {
    const root = markup();
    const splash = bindSplash({
      root,
      splash: splashDoc({ kind: 'image', src: 'visuals/splash.png' }),
      dom,
      assetUrl: (id) => `/${id}`,
    });
    const node = nodeOf(root, 'boot__media').children[0]!;
    expect(node.tag).toBe('img');
    expect(node.attributes.get('src')).toBe('/visuals/splash.png');
    expect(splash.media).toBe('ok');
  });

  it('видео — без звука и с автозапуском: звук браузер даёт только по жесту', () => {
    const root = markup();
    bindSplash({ root, splash: splashDoc({ kind: 'video', src: 'visuals/intro.mp4' }), dom });
    const node = nodeOf(root, 'boot__media').children[0]!;
    expect(node.tag).toBe('video');
    for (const attribute of ['muted', 'autoplay', 'playsinline']) {
      expect(node.attributes.has(attribute), attribute).toBe(true);
    }
  });

  it('недоступное медиа старт не задерживает: узел снят, оформление `none`, отказ в отчёт', () => {
    const root = markup();
    const splash = bindSplash({
      root,
      splash: splashDoc({ kind: 'image', src: 'visuals/missing.png' }),
      dom,
    });
    const slot = nodeOf(root, 'boot__media');
    slot.children[0]!.fire('error');
    // Сломанный узел СНИМАЕТСЯ: оставь его на месте — пустая коробка `<video>`
    // заняла бы середину сплеша, а BOOT-2 требует оформления `none` на экране,
    // а не только в переменной отчёта. Пустой слот прячет разметка.
    expect(slot.children).toEqual([]);
    expect(root.attributes.get('data-media')).toBe('none');
    // А в диагностику отказ едет как отказ (BOOT-5).
    expect(splash.media).toBe('failed');
  });

  it('`kind: none` узла не заводит вовсе — у демо своей графики пока нет', () => {
    const root = markup();
    const splash = bindSplash({ root, splash: splashDoc(), dom });
    expect(nodeOf(root, 'boot__media').children).toEqual([]);
    expect(splash.media).toBe('none');
  });
});
