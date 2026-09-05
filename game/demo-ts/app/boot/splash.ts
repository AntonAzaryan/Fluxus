/**
 * DOM-адаптер сплеша (`game-boot` BOOT-2): слой уже есть в разметке страницы —
 * скрипт его ВЕДЁТ, а не создаёт.
 *
 * Это несущее, а не стиль: первый кадр, который видит игрок, обязан нести сплеш,
 * а к моменту исполнения модулей приложения он уже нарисован (в десктоп-
 * контейнере — тем же окном, показанным по готовности, DSK-1). Создай сплеш
 * скрипт — до его загрузки игрок видел бы фон страницы и пустой канвас.
 *
 * Виджетом HUD (`match-hud`) сплеш не является и лежать внутри `#app` не может:
 * HUD — экранный слой ИДУЩЕГО матча, а сплеш ему предшествует и переживёт
 * появление меню. Порядок слоёв страницы (z-index) держит разметка: сплеш выше
 * вьюпорта, но ниже органов страницы и сообщений сборки — дорога со сломанной
 * страницы видна под любым сплешем (BOOT-2).
 *
 * Медиа — данные документа (BOOT-2): `none` — оформление разметки и заголовок,
 * `image`/`video` — файл дерева контента по asset id (ASSET-2), доставляемый тем
 * же корнем, что и остальные ассеты страницы. Недоступное медиа старта НЕ
 * задерживает: узел снимается, сплеш остаётся оформлением, а отказ едет в
 * диагностику (BOOT-5).
 */
import type { BootSplash } from './bootDocument.js';
import type { BootMedia, BootState } from './bootSequence.js';

/**
 * Элемент глазами адаптера — ровно та поверхность DOM, которой он пользуется, и
 * ни строчкой больше: прогон тестов идёт в Node, где браузера нет вовсе.
 */
export interface SplashElement {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): SplashElement | null;
  append(node: SplashElement): void;
  /** Снять узел со страницы: недоехавшее медиа не занимает места (BOOT-2). */
  remove(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  readonly style: { setProperty(name: string, value: string): void };
}

/** Тот же вопрос к среде, что у остальных DOM-модулей демо: есть ли документ. */
export interface SplashDom {
  createElement(tag: string): SplashElement;
}

export interface SplashOptions {
  /** Корень сплеша из разметки (`#boot`). */
  readonly root: SplashElement;
  /** Секция сплеша действующего документа старта (BOOT-3). */
  readonly splash: BootSplash;
  /** Чем создавать узел медиа; нет — медиа не показывается вовсе. */
  readonly dom?: SplashDom;
  /** asset id → адрес байтов; тот же корень, что у остальных ассетов страницы. */
  readonly assetUrl?: (id: string) => string;
  /** Отложенный вызов запасного таймера угасания; по умолчанию `setTimeout`. */
  readonly schedule?: (ms: number, run: () => void) => void;
  /** Угасание закончилось — вход машины `fadeEnded()` (BOOT-2). */
  readonly onFadeEnded?: () => void;
}

export interface Splash {
  /** Показать состояние старта: текст ожидания отличим от текста прогрева. */
  show(state: BootState): void;
  /** Ход стадий полосой прогресса: сколько из скольких получило исход. */
  progress(settled: number, total: number): void;
  /** Угасание за `fadeMs` документа; конец — `onFadeEnded` (BOOT-2). */
  fade(): void;
  /** Исход медиа — в отчёт старта (BOOT-5). */
  readonly media: BootMedia;
}

/**
 * Тексты состояний — интерфейс игры, а не данные машины: состояний у неё пять,
 * а сказать человеку надо две разные вещи — «идёт загрузка» и «ждём соперника»
 * (BOOT-4). Пустая строка гасит показанное: у раскрытия своего текста нет.
 */
const STATE_TEXT: Readonly<Record<BootState, string>> = {
  splash: 'загрузка…',
  warming: 'прогрев сцены…',
  waiting: 'ждём соперника…',
  revealing: '',
  done: '',
};

/** Запас к таймеру-дублёру угасания: событие перехода вправо не приходит. */
const FADE_FALLBACK_MS = 50;

export function bindSplash(options: SplashOptions): Splash {
  const { root, splash } = options;
  const schedule = options.schedule ?? ((ms, run) => { setTimeout(run, ms); });
  let media: BootMedia = 'none';
  let faded = false;

  text('.boot__title', splash.title);
  text('.boot__status', STATE_TEXT.splash);
  // Длительность угасания — из документа: CSS знает переменную, а число живёт
  // там же, где `minMs`, — в документе игры (BOOT-3).
  root.style.setProperty('--boot-fade', `${String(splash.fadeMs)}ms`);
  media = mountMedia();

  return {
    show(state: BootState): void {
      root.setAttribute('data-state', state);
      text('.boot__status', STATE_TEXT[state]);
    },
    progress(settled: number, total: number): void {
      const done = total <= 0 ? 1 : Math.min(1, Math.max(0, settled / total));
      root.style.setProperty('--boot-progress', String(done));
    },
    fade,
    get media(): BootMedia {
      return media;
    },
  };

  function text(selector: string, value: string): void {
    const node = root.querySelector(selector);
    if (node !== null) node.textContent = value;
  }

  /**
   * Угасание (BOOT-2): состояние `revealing` включает переход прозрачности,
   * `done` убирает слой из потока событий и отрисовки целиком — правилом
   * разметки, а не стилем отсюда.
   *
   * Конец перехода ловится СОБЫТИЕМ, а дублируется таймером: `transitionend` не
   * приходит вовсе, если перехода не случилось (нулевая длительность, скрытая
   * вкладка, `prefers-reduced-motion`), и сплеш повис бы навсегда — ровно тот
   * вечный сплеш, которого BOOT-4 не допускает.
   */
  function fade(): void {
    root.setAttribute('data-state', 'revealing');
    const finish = (): void => {
      if (faded) return;
      faded = true;
      root.removeEventListener('transitionend', finish);
      root.setAttribute('data-state', 'done');
      options.onFadeEnded?.();
    };
    root.addEventListener('transitionend', finish);
    schedule(splash.fadeMs + FADE_FALLBACK_MS, finish);
  }

  /**
   * Узел медиа по документу. Видео — без звука и с автозапуском: звук браузер
   * даёт только по жесту, а озвучка сплеша в BOOT-2 не входит вовсе.
   */
  function mountMedia(): BootMedia {
    const dom = options.dom;
    if (splash.kind === 'none' || splash.src === null || dom === undefined) return 'none';
    const slot = root.querySelector('.boot__media');
    if (slot === null) return 'none';
    const node = dom.createElement(splash.kind === 'image' ? 'img' : 'video');
    node.setAttribute('src', (options.assetUrl ?? ((id) => `/${id}`))(splash.src));
    node.setAttribute('alt', '');
    if (splash.kind === 'video') {
      node.setAttribute('muted', '');
      node.setAttribute('autoplay', '');
      node.setAttribute('playsinline', '');
      node.setAttribute('loop', '');
    }
    // Отказ медиа стартом не является: узел СНИМАЕТСЯ, сплеш остаётся
    // оформлением `none` — пустой слот прячет разметка, — а причина едет в
    // отчёт (BOOT-2, BOOT-5). Оставь мы сломанный `<video>` на месте, он занял
    // бы своей коробкой середину сплеша: «показывается оформлением none» — это
    // про то, что на экране, а не про переменную в отчёте.
    node.addEventListener('error', () => {
      media = 'failed';
      node.remove();
      root.setAttribute('data-media', 'none');
    });
    slot.append(node);
    root.setAttribute('data-media', splash.kind);
    return 'ok';
  }
}
