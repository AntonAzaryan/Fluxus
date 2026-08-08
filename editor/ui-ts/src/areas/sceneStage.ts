/**
 * @contribution Сборка вьюпорта сцены — часть вклада области, а не каркаса.
 *
 * Здесь редактор встречается с рендером движка, и вся встреча — регистрация
 * подсистем и подача документного набора. Собственного рендера у редактора нет
 * (ED-1): террейн рисует `TerrainSubsystem` (REND-7, REND-9), модели —
 * `ModelsSubsystem` (REND-3..6, REND-10), служебные наложения —
 * `OverlaySubsystem` (REND-16), а presentation-состояние наполняет
 * `DocumentSource` (REND-11) — тот же вход подсистем, что у потока тиков.
 *
 * Тика в режиме правки нет (ED-15): кадровый цикл не двигает мир, а только
 * сводит документный набор, считает позу камеры конвейером (ED-13) и рисует.
 *
 * ## Отклик не позже следующего кадра
 *
 * ED-15 требует показать правку не позже следующего кадра. Механизм — один и
 * простой: `submit` кладёт новое состояние документов и поднимает флаг, а
 * ближайший кадр сводит его с нарисованным. Считать в `submit` нельзя: за один
 * кадр правок бывает несколько (мазок кисти — операция на кадр, ED-18), и
 * пересчёт на каждую делал бы работу, которую всё равно перекроет последняя.
 *
 * Кадр, который не рисуется (автор ушёл в другую область — узла нет в
 * странице), флаг не гасит: правка дождётся возвращения вьюпорта, а не
 * потеряется в кадре, которого никто не видел.
 *
 * ## Что делает сорвавшийся кадр
 *
 * Ошибка внутри кадра — сведения набора или самой отрисовки — не имеет права
 * ни увести цикл (иначе вьюпорт замирает навсегда), ни промолчать (иначе автор
 * видит прежнюю картинку и считает её ответом на свою правку). Поэтому кадр
 * ловит её, оставляет нарисованным последнее целое и называет причину полем
 * `failure`, о смене которого сообщает `onChange` — теми же иконкой и текстом,
 * какими область показывает сломанный документ (ED-8, ED-22).
 *
 * Живут эти две причины по-разному, и это не мелочь. Сорвавшееся сведение
 * повторить не на чем — флаг погашен, документы те же, — и погасить причину
 * следующим удавшимся кадром значило бы показать её ровно на один кадр, то
 * есть не показать: она держится до следующей подачи. Сорвавшаяся отрисовка
 * повторяется каждый кадр сама и гаснет тем кадром, который прошёл.
 *
 * ## Почему смена режима камеры объявляется, а не спрашивается
 *
 * Режим — состояние конвейера (CAM-2), и переключатель до него доходит вводом:
 * `toggleFly` взводит фронт, а применяет его ближайший кадр rig'а. Спросить
 * `flying` сразу после нажатия значит получить прежний ответ, поэтому смену
 * режима объявляет сам кадр (`onChange`) — иначе подпись бара показывала бы
 * один режим, пока камера в другом (ED-26). Тем же путём объявляется и `F`.
 *
 * ## Почему холст живёт вне дерева описания
 *
 * Каркас перерисовывает страницу целиком (`frame/mount.ts`), заменяя поддерево
 * узла. Холст рендера такого не переживает, поэтому он принадлежит вьюпорту, а
 * не описанию: каждый кадр проверяется, лежит ли он в текущем узле кадра
 * (`hostId`), и при необходимости возвращается на место. Это не обход каркаса —
 * содержимое кадра и по контракту `viewportFrame` приносит рендер, а не
 * интерфейс.
 */
import * as THREE from 'three';
import {
  AssetService,
  curvatureLoader,
  gltfLoader,
  manifestLoader,
  mdxLoader,
  pngTextureLoader,
  type AssetSource,
  type VisualManifest,
} from '@game-mvp/assets';
import {
  DocumentSource,
  ModelsSubsystem,
  OverlaySubsystem,
  PresentationStage,
  TerrainSubsystem,
  VisualSurfaceSource,
  applyCameraPose,
  type RenderContext,
} from '@game-mvp/render';
import type { TerrainGrid } from '@game-mvp/core';
import {
  CAMERA_KEYS,
  createSceneCamera,
  type PointerSample,
  type SceneCamera,
} from './sceneCamera.js';
import type { SceneDraft } from './sceneDocuments.js';

/** Шаг высоты уровня в мировых единицах — параметр рендера (REND-7). */
const HEIGHT_STEP = 0.6;

/** Кнопка мыши: средняя — drag-панорама (CAM-3), правая — осмотр в облёте. */
const MIDDLE_BUTTON = 1;
const RIGHT_BUTTON = 2;

export interface SceneStageOptions {
  /** Идентификатор узла кадра — тот же, что у `viewportFrame`. */
  readonly hostId: string;
  /** Источник байтов ассетов (ASSET-2) — поверх хоста среды (ED-12). */
  readonly assets: AssetSource;
  /** Манифест визуалов (ASSET-6): без него подсистеме моделей нечего строить. */
  readonly visuals: VisualManifest;
  /** Документ среды; по умолчанию — документ вкладки. */
  readonly document?: Document;
  readonly heightStep?: number;
  /**
   * Вьюпорт сообщает о том, что изменилось у него самого и видно в интерфейсе:
   * режим камеры (CAM-2) и причина сорвавшегося кадра. Зовётся из кадра и
   * только на смену, а не на каждый кадр.
   */
  readonly onChange?: () => void;
}

export interface SceneStage {
  /** Новое состояние документов; кадр покажет его не позже следующего (ED-15). */
  submit(draft: SceneDraft): void;
  /** Идёт ли облёт (CAM-2) — это показывает бар области. */
  readonly flying: boolean;
  toggleFly(): void;
  zoom(steps: number): void;
  /** Сколько инстансов в наборе сейчас — по этому видно, что кадр не пуст. */
  readonly instanceCount: number;
  /** Почему сорвался кадр; `null` — последний кадр прошёл целиком (ED-8). */
  readonly failure: string | null;
  dispose(): void;
}

/**
 * Есть ли в этой среде чем рисовать. Проверка, а не try/catch: headless-прогон
 * (тесты пакета, ED-29) обязан собирать область без единого обращения к
 * WebGL, и решать это должен явный вопрос к среде.
 */
export function canRender(doc?: Document): boolean {
  return (
    typeof requestAnimationFrame === 'function' &&
    (doc ?? (typeof document === 'undefined' ? null : document)) !== null
  );
}

export function createSceneStage(options: SceneStageOptions): SceneStage {
  const doc = options.document ?? document;
  const heightStep = options.heightStep ?? HEIGHT_STEP;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;

  const scene = new THREE.Scene();
  const camera3 = new THREE.PerspectiveCamera(45, 1, 0.1, 300);
  camera3.up.set(0, 0, 1);
  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(8, -12, 18);
  scene.add(sun);

  const assets = new AssetService(options.assets);
  assets.registerLoader(mdxLoader);
  assets.registerLoader(gltfLoader);
  assets.registerLoader(pngTextureLoader);
  assets.registerLoader(manifestLoader);
  assets.registerLoader(curvatureLoader);

  const context: RenderContext = { scene, assets, config: { heightStep } };
  const presentation = new PresentationStage(context);
  const source = new DocumentSource(presentation);

  let surface: VisualSurfaceSource | null = null;
  let terrain: TerrainSubsystem | null = null;
  let camera: SceneCamera | null = null;
  let grid: TerrainGrid | null = null;
  let curvature: SceneDraft['curvature'] = null;

  let draft: SceneDraft | null = null;
  let dirty = false;
  let disposed = false;
  let lastFrameAt: number | null = null;
  /**
   * Две причины, а не одна: сорвавшееся сведение документов держится до
   * следующей подачи (кадр за кадром оно не повторяется, и гасить его удачной
   * отрисовкой значило бы показать причину на один кадр — то есть не показать),
   * сорвавшаяся отрисовка держится, пока кадр не пройдёт.
   */
  let applyFailure: string | null = null;
  let drawFailure: string | null = null;
  const reasonOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  /** Что о вьюпорте уже показано интерфейсом — с этим и сверяется `onChange`. */
  let shownFlying = false;
  let shownFailure: string | null = null;

  const keys = new Set<string>();
  let pointer: PointerSample | null = null;
  let midDrag = false;
  let rightDrag = false;

  // ---------------------------------------------------------------- ввод

  const rect = (): { left: number; top: number; width: number; height: number } => {
    const box = canvas.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // Ввод камеры не пересекает никакой границы (CAM-1): пересекать нечего —
    // симуляции в режиме правки нет.
    if (event.code.startsWith('Arrow')) event.preventDefault();
    if (!event.repeat && event.code === CAMERA_KEYS.flyToggle) camera?.toggleFly();
    keys.add(event.code);
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };
  const onBlur = (): void => keys.clear();
  const onPointerMove = (event: MouseEvent): void => {
    if (midDrag) camera?.drag(event.movementX, event.movementY);
    if (rightDrag) camera?.look(event.movementX, event.movementY);
    pointer = { x: event.clientX, y: event.clientY, rect: rect() };
  };
  const onPointerLeave = (): void => {
    pointer = null;
  };
  const onPointerDown = (event: MouseEvent): void => {
    canvas.focus();
    if (event.button === MIDDLE_BUTTON) {
      event.preventDefault();
      midDrag = true;
    }
    if (event.button === RIGHT_BUTTON) rightDrag = true;
  };
  const onPointerUp = (event: MouseEvent): void => {
    if (event.button === MIDDLE_BUTTON) midDrag = false;
    if (event.button === RIGHT_BUTTON) rightDrag = false;
  };
  const onContextMenu = (event: Event): void => event.preventDefault();
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // ~100 deltaY на щелчок колеса; трекпад копит дробные шаги.
    camera?.zoom(event.deltaY / 100);
  };

  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('blur', onBlur);
  canvas.addEventListener('mousemove', onPointerMove);
  canvas.addEventListener('mouseleave', onPointerLeave);
  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  doc.addEventListener('mouseup', onPointerUp);

  // ------------------------------------------------------------- подсистемы

  /**
   * Первая сетка поднимает подсистемы: до неё рисовать нечего, а размеры арены
   * нужны и поверхности (REND-9), и камере (CAM-7). Порядок регистрации
   * нормативен (REND-8): террейн, модели, наложения.
   *
   * Отсюда следует и сегодняшняя граница: сцена вовсе без террейна кадра не
   * получает. Вырожденный набор без сцены и террейна нужен просмотрщику
   * ассетов (ED-20, REND-11) — там ему и место, вместе с W3-5.
   */
  const build = (first: TerrainGrid): void => {
    surface = new VisualSurfaceSource(first);
    terrain = new TerrainSubsystem(first, { surface });
    presentation.register(terrain);
    presentation.register(new ModelsSubsystem(options.visuals, { surface }));
    // Подсистему наложений регистрирует только вьюпорт редактора (REND-16):
    // в игровом кадре её нет по конструкции. Набор пока пуст — выделение и
    // превью кисти приносят W3-2 и W3-3.
    presentation.register(new OverlaySubsystem({ surface }));
    camera = createSceneCamera({ grid: first, heightStep });
  };

  const applyDraft = (next: SceneDraft): void => {
    if (next.grid !== null && next.grid !== grid) {
      const first = grid === null;
      grid = next.grid;
      if (first) build(next.grid);
      else {
        // Декларативная доставка сетки целиком (REND-14): подсистема сводит её
        // с нарисованным сама, а поверхность и чанки инвалидирует точечно.
        terrain?.applyGrid(next.grid);
        camera?.setGrid(next.grid);
      }
    }
    if (next.curvature !== curvature) {
      curvature = next.curvature;
      // Карта из памяти, а не ассетом: несохранённый документ кисти ассетом ещё
      // не является (ED-11, REND-14).
      surface?.setCurvature(curvature);
    }
    // Полный набор инстансов; что создать, обновить и убрать, решает источник.
    source.apply(next.placements);
  };

  // ----------------------------------------------------------------- кадр

  /** Холст на месте и по размеру узла кадра: перерисовка страницы его вытесняет. */
  let sizedTo = { width: 0, height: 0 };
  const attach = (): boolean => {
    const host = doc.getElementById(options.hostId);
    if (host === null) return false;
    if (canvas.parentElement !== host) host.append(canvas);
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    // Сравнение с запрошенным размером, а не с размером буфера: буфер больше
    // на pixelRatio, и сверка с ним пересоздавала бы его каждый кадр.
    if (sizedTo.width !== width || sizedTo.height !== height) {
      sizedTo = { width, height };
      renderer.setSize(width, height);
      camera3.aspect = width / height;
      camera3.updateProjectionMatrix();
    }
    return true;
  };

  const failureNow = (): string | null => applyFailure ?? drawFailure;

  /** Сообщить интерфейсу, если у вьюпорта изменилось видимое им (CAM-2, ED-8). */
  const publish = (): void => {
    const flying = camera?.flying ?? false;
    const failure = failureNow();
    if (flying === shownFlying && failure === shownFailure) return;
    shownFlying = flying;
    shownFailure = failure;
    options.onChange?.();
  };

  const frame = (now: number): void => {
    if (disposed) return;
    // Планирование до работы: сорвавшийся кадр не имеет права увести цикл.
    requestAnimationFrame(frame);
    // Кадра нет, пока узла нет в странице: правка ждёт возвращения вьюпорта
    // (`dirty` не гаснет), а не теряется в кадре, которого никто не увидел.
    if (!attach()) return;

    const dt = lastFrameAt === null ? 0 : Math.min((now - lastFrameAt) / 1000, 0.25);
    lastFrameAt = now;

    // Флаг гасится до сведения, а не после: сорвавшееся сведение обязано
    // назвать причину, а не повторяться каждый кадр на тех же документах.
    if (dirty && draft !== null) {
      dirty = false;
      try {
        applyDraft(draft);
        applyFailure = null;
      } catch (error) {
        // Последнее целое остаётся нарисованным, причина уходит в интерфейс.
        applyFailure = reasonOf(error);
      }
    }
    try {
      if (camera !== null) {
        camera.sample(keys, pointer);
        // Общая реализация применения позы (CAM-1): своей копии у редактора нет.
        applyCameraPose(camera3, camera.frame(dt));
      }
      // Кадр подсистем: интерполировать нечего, альфа всегда 1 (REND-11).
      source.frame(now);
      renderer.render(scene, camera3);
      drawFailure = null;
    } catch (error) {
      drawFailure = reasonOf(error);
    }
    publish();
  };
  requestAnimationFrame(frame);

  return {
    submit(next) {
      draft = next;
      dirty = true;
    },
    get flying(): boolean {
      return camera?.flying ?? false;
    },
    toggleFly() {
      camera?.toggleFly();
    },
    zoom(steps) {
      camera?.zoom(steps);
    },
    get instanceCount(): number {
      return source.size;
    },
    get failure(): string | null {
      return failureNow();
    },
    dispose() {
      disposed = true;
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('blur', onBlur);
      canvas.removeEventListener('mousemove', onPointerMove);
      canvas.removeEventListener('mouseleave', onPointerLeave);
      canvas.removeEventListener('mousedown', onPointerDown);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
      doc.removeEventListener('mouseup', onPointerUp);
      canvas.remove();
      renderer.dispose();
    },
  };
}
