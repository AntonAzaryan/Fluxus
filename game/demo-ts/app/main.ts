/**
 * Демо воркер-сборки (client-shell SHELL-1..7): состояние производит воркер,
 * здесь — только THREE, ввод и UI. Presentation-состояние приезжает конвертами
 * тиков через `RemoteHost`; подсистемы террейна и моделей — те же, что в
 * однопоточной сборке (SHELL-2), обратный канал — `sendInput`/`control`
 * (SHELL-6).
 *
 * Воркер-сторон три, и выбирается она ПРИ СТАРТЕ страницы (SHELL-8, `mode.ts`):
 * дефолт — матч против бота на сетевом стеке (сервер вкладки `serverWorker.ts`
 * плюс тонкий клиент `clientWorker.ts`, design D1), `?server=ws://…` — тот же
 * тонкий клиент против выделенного стенда, `?solo` — прежняя одиночная
 * симуляция (`worker.ts`), где живут пауза и отладочная перемотка. Главный
 * поток об этом различии не знает ничего, кроме режима из handshake: конверты
 * тиков одни и те же (SHELL-8).
 *
 * Кадр отвязан от тика (REND-2): `remote.frame(now)` интерполирует между
 * двумя последними доставленными тиками по часам этого потока (SHELL-7).
 */
import * as THREE from 'three';
import { ABILITY_STEPS, loadScene, type EntityId, type SceneDef } from '@game-mvp/core';
import {
  AssetService,
  createManifestLoader,
  cubeLutLoader,
  curvatureLoader,
  gltfLoader,
  mdxLoader,
  particleEffectLoader,
  pngTextureLoader,
  presentationLoader,
  presentationPathOf,
  type AssetSource,
  type AssetState,
  type PresentationScene,
  type VisualManifest,
} from '@game-mvp/assets';
import {
  AbilityPreviewSubsystem,
  CAMERA_CONFIG_DESCRIPTION,
  CAMERA_EFFECTS_DESCRIPTION,
  CameraEffectsDirector,
  CameraRig,
  DecorationSet,
  decorationInstanceOf,
  EffectsSubsystem,
  FogSubsystem,
  LightingSubsystem,
  ModelsSubsystem,
  ParticlesSubsystem,
  PostprocessSubsystem,
  RenderDebugLayer,
  TerrainSubsystem,
  ViewportPicking,
  VisualSurfaceSource,
  applyCameraPose,
  cameraConfigFromManifest,
  costCountersDebugSource,
  createCameraInput,
  deliveryDebugSource,
  resetCameraInput,
  resolveFogConfig,
  terrainGroundApi,
  type CameraBounds,
  type CameraPose,
  type AbilitySlotStatNames,
  type DecorationInstance,
  type RenderContext,
} from '@game-mvp/render';
import type { HudCameraContract } from '@game-mvp/hud';
import {
  GamepadSource,
  InputSampler,
  KeyboardMouseSource,
  RemoteHost,
  TouchSource,
  aimAngle,
  navigatorGamepad,
  shellPort,
  toWorldFixed,
  validateBindings,
  type AimPoint,
  type AimResolution,
  type InputSource,
} from '@game-mvp/client';
import {
  ACTION_BITS,
  CHARGE_PREVIEW_MIN_TICKS,
  PREVIEW_SLOTS,
  RESPAWN_EVENT,
  STATE_COMPONENTS,
  STATS,
} from './sim.js';
import { createChargeBalls, type ChargeBalls } from './chargeBalls.js';
import { attachBenchProbe, benchRequested, type BenchProbe, type BenchProbeHost } from './benchProbe.js';
import {
  attachDebugGlobal,
  createDebugPanel,
  restoreDebugSources,
  storedDebugSources,
  type DebugGlobalHost,
  type DebugPanel,
} from './debugPanel.js';
import {
  cameraDebugSource,
  dynamicCollidersDebugSource,
  inspectorDebugSource,
  staticCollidersDebugSource,
} from './debugSources.js';
import { demoEdgePan } from './cameraInput.js';
import { createDemoHud, demoHudComposition, markHoldOnlyAbilities } from './hud.js';
import { prewarmPresentation } from './prewarm.js';
import { DEMO_STAND_SERVICE, demoStandHost } from './desktopStand.js';
import { demoMode, demoServerUrl, localModeUrl, serverModeUrl, type DemoMode } from './mode.js';
import {
  QUALITY_PRESET_NAMES,
  createDemoQuality,
  createQualitySelection,
  qualityPresetName,
  qualityStorageOf,
  rememberQualityPreset,
  storedQualityPreset,
  type QualityPresetName,
} from './quality.js';
import { isDemoNotice, isDemoServerReady, type DemoClientInit, type DemoServerInit } from './wiring.js';
import bindingsJson from './bindings.json';
import sceneJson from '../../../content/scenes/duel.scene.json';

/** Высота уровня террейна в мировых единицах — параметр рендера (REND-7). */
const HEIGHT_STEP = 0.6;

// ------------------------------------------------------------------ three.js

const appElement = document.getElementById('app');
if (appElement === null) throw new Error('демо: в index.html нет контейнера #app');
/** Контейнер вьюпорта; тип без null — narrowing не пересекает границы замыканий. */
const app: HTMLElement = appElement;

const renderer3 = new THREE.WebGLRenderer({ antialias: true });
renderer3.setSize(window.innerWidth, window.innerHeight);
renderer3.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// Теневые карты включает ВЛАДЕЛЕЦ рендерера (design D8): рендерер принадлежит
// сборке, а не подсистемам. Включённый shadowMap без кастеров бесплатен —
// фактическую стоимость задаёт действующий режим теней секции `lighting`.
//
// Тип — `PCFShadowMap`, а не `PCFSoftShadowMap`: последний в three `^0.185`
// объявлен устаревшим, и рендерер сам молча подменяет его первым, оставляя в
// консоли предупреждение. Писать в коде тип, которого рендерер не исполняет,
// значило бы обещать кадру мягкость, которой в нём нет.
renderer3.shadowMap.enabled = true;
renderer3.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer3.domElement);

const scene3 = new THREE.Scene();
scene3.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 300);
camera.up.set(0, 0, 1);

/**
 * Камера — конвейер позы (CAM-1): rig режимов + стек эффектов живут в
 * render-ts как чистые данные; здесь — только сбор ввода и применение
 * финальной позы к THREE-камере (единственная точка).
 */
let rig: CameraRig | null = null;
/** Диспетчер эффектов появляется вместе с манифестом (ASSET-7, см. main). */
let director: CameraEffectsDirector | null = null;
const camInput = createCameraInput();
// Света здесь нет намеренно: источники арены создаёт подсистема освещения из
// секции `lighting` парного документа (PRES-2), и потребитель рендера своих
// добавлять не вправе — иначе свет удвоился бы, а кадры клиента и вьюпорта
// редактора разошлись бы числами в двух местах (`editor` ED-22).

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer3.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------- ассеты

/** Источник байтов демо: корень дерева контента (`content/`) отдаёт vite как статику. */
const assetSource: AssetSource = {
  async read(id: string): Promise<ArrayBuffer> {
    const response = await fetch(`/${id}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} за ассетом "${id}"`);
    return response.arrayBuffer();
  },
};

const assets = new AssetService(assetSource);
assets.registerLoader(mdxLoader);
assets.registerLoader(gltfLoader);
assets.registerLoader(pngTextureLoader);
// Эмиттерный ассет (ASSET-14): без него ссылка записи манифеста на эффект
// частиц разрешалась бы в `failed` «нет загрузчика под пару вид+формат»
// (ASSET-3), и подсистема частиц молча пропускала бы каждую запись.
assets.registerLoader(particleEffectLoader);
// Описание типов эффектов камеры (CAM-9) подаёт тот, кто собирает клиента:
// модуль ассетов о типах не знает, а с описанием проверяет по нему и секцию
// эффектов манифеста (ASSET-8). Тем же порядком приезжает описание конфига
// камеры (CAM-1): с ним неизвестный параметр секции конфига (ASSET-10)
// становится предупреждением на загрузке манифеста.
assets.registerLoader(
  createManifestLoader({
    cameraEffects: CAMERA_EFFECTS_DESCRIPTION,
    cameraConfig: CAMERA_CONFIG_DESCRIPTION,
  }),
);
assets.registerLoader(curvatureLoader);
// Таблица цветокоррекции кадра (`rendering` REND-34): без загрузчика ссылка
// подсекции `postprocess.lut` разрешалась бы в `failed` «нет загрузчика под пару
// вид+формат» (ASSET-3), и кадр рисовался бы без LUT с предупреждением.
assets.registerLoader(cubeLutLoader);
// Парный presentation-документ сцены (PRES-1): декорации арены и секция `fog`
// (FOW-10). Ассет наравне с манифестом — тем же реестром загрузчиков (ASSET-3).
assets.registerLoader(presentationLoader);

/** Разовая загрузка ассета сервисом: promise поверх подписки на состояние. */
function loadAsset<T>(kind: string, id: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = assets.request<T>(kind, id);
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const onState = (s: AssetState<T>): void => {
      if (settled || s.status === 'loading') return;
      settled = true;
      if (s.status === 'ready') resolve(s.data);
      else reject(new Error(s.reason));
      unsubscribe?.();
    };
    unsubscribe = assets.subscribe(handle, onState);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- baseline
    if (settled) unsubscribe();
  });
}

/** Манифест визуалов через тот же сервис (kind 'manifest', ASSET-6). */
function loadManifest(): Promise<VisualManifest> {
  return loadAsset<VisualManifest>('manifest', 'visuals/manifest.json');
}

/**
 * Парный документ сцены демо (PRES-1): путь — правилом имени от пути сцены.
 * Отказ (нет файла, битый JSON) — сцена без декораций и туман на умолчаниях
 * (FOW-10), с предупреждением: дыра в контенте не уносит страницу целиком.
 */
async function loadPresentation(): Promise<PresentationScene | null> {
  try {
    return await loadAsset<PresentationScene>('presentation', presentationPathOf('scenes/duel.scene.json'));
  } catch (error) {
    console.warn('демо: парный presentation-документ не загрузился', error);
    return null;
  }
}

// ---------------------------------------------------------------------- ввод

/** Клавиши камеры (CAM-1..3); ввод героя живёт в источниках сэмплера ниже. */
const keys = new Set<string>();
let currentSkin: 'steel' | 'ember' = 'steel';

/** Последняя позиция указателя — edge-pan считается по кадрам (CAM-3). */
let pointerX = -1;
let pointerY = -1;
/**
 * Счётчик движений указателя. Источник прицела сравнивает его со своим
 * прошлым значением: «указатель двигался с прошлого опроса» — не то же самое,
 * что «указатель где-то стоит» (см. `pointerAimSource`).
 */
let pointerMoves = 0;
/** Зажатые кнопки мыши: 1 — drag-панорама (MMB), 2 — осмотр в fly (Alt+RMB). */
let midDrag = false;
let rightDrag = false;

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
/** Временные значения луча: `groundPoint` зовётся с частотой кадра — не аллоцирует. */
const ndcScratch = new THREE.Vector2();
const hitScratch = new THREE.Vector3();

// --------------------------------------------------------- воркер и рендер

/** Подсистема моделей: появляется после загрузки манифеста (см. main). */
let models: ModelsSubsystem | null = null;
/**
 * Подсистема тумана войны (FOW-7, design D3): появляется в `onReady` сцены с
 * `fog`. Пока её нет (или маска ещё не построена), кадр рисуется по-старому.
 */
let fogSubsystem: FogSubsystem | null = null;
/**
 * Подсистема пост-обработки кадра (REND-34): появляется в `onReady` всегда, а
 * работает — когда секция `postprocess` парного документа её включила. Без
 * секции она не добавляет в кадр ни цели, ни прохода, и `render` делает ровно
 * прямую отрисовку сцены.
 */
let postprocess: PostprocessSubsystem | null = null;
/** ID сущности героя из handshake воркера (helloExtra). */
let heroId: EntityId | null = null;

const context: RenderContext = { scene: scene3, assets, config: { heightStep: HEIGHT_STEP } };
let remote: RemoteHost | null = null;

/**
 * Точка клика на плоскости пола: луч через камеру (по финальной позе —
 * «куда смотрю, туда и кликаю», design Decision 6). Плоскость — высота
 * поверхности под точкой наблюдения камеры, а не уровень героя: в free-RTS
 * герой может быть за экраном.
 */
function groundPoint(clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = renderer3.domElement.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  ndcScratch.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndcScratch, camera);
  groundPlane.constant = -(rig?.groundZ ?? 0);
  return raycaster.ray.intersectPlane(groundPlane, hitScratch) === null
    ? null
    : { x: hitScratch.x, y: hitScratch.y };
}

/**
 * Клавиши камеры и UI (CAM-1): фронты героя (каст, уклон, прыжок, убийство)
 * обрабатывает `KeyboardMouseSource` по биндингам — сюда они не заходят.
 */
window.addEventListener('keydown', (e) => {
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  if (e.repeat) {
    keys.add(e.code);
    return;
  }
  if (e.code === 'KeyT') {
    // T — смена скина (REND-6); S свободна под «юг» в WASD.
    currentSkin = currentSkin === 'steel' ? 'ember' : 'steel';
    if (heroId !== null) models?.setSkin(heroId, currentSkin);
    return;
  }
  if (e.code === 'KeyC') camInput.centerTap = true;
  if (e.code === 'KeyY') {
    camInput.followToggle = true;
    // Возврат в follow отменяет отложенный перелёт миникарты — иначе он
    // выстрелил бы в устаревшую точку при следующем откреплении.
    pendingPan = null;
  }
  // V, а не F: F ушла герою под купол замедления, а E — под щит
  // (`bindings.json`), и две роли на одной клавише — это молча несработавшая
  // способность.
  if (e.code === 'KeyV') camInput.flyToggle = true;
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

/**
 * Корень оверлея HUD и признак «курсор над его интерактивом»: события над
 * pointer-events:none частями оверлея таргетируют canvas, над интерактивом —
 * элемент HUD. Пока курсор над HUD, edge-pan не считается: миникарта стоит в
 * краевой полосе, и без этого клик по её краю гасился бы панорамой (CAM-3).
 */
let hudRoot: Element | null = null;
let pointerOverHud = false;

window.addEventListener('mousemove', (e) => {
  pointerOverHud =
    hudRoot !== null && e.target instanceof Element && hudRoot.contains(e.target);
  if (midDrag) {
    camInput.dragDX += e.movementX;
    camInput.dragDY += e.movementY;
  }
  if (rightDrag) {
    camInput.lookDX += e.movementX;
    camInput.lookDY += e.movementY;
  }
  pointerX = e.clientX;
  pointerY = e.clientY;
  pointerMoves += 1;
});

// -------------------------------------------------- источники ввода и сэмплер

/**
 * Слой источников ввода (input-devices INP-1..5): клавиатура+мышь — целевое,
 * тач и геймпад — те же биндинги-данные. Смысл битов — у контента
 * (`ACTION_BITS` в sim.ts), раскладка устройств — `bindings.json`.
 */
const bindings = validateBindings(bindingsJson);
const sampler = new InputSampler({ actionBits: ACTION_BITS });

/**
 * Прицел указателя: точка на полу через raycast (design Decision 6) И угол на
 * неё от героя в единице ядра (FP-7). Null — прицела нет: луч мимо пола, герой
 * ещё не приехал или клик в себя.
 *
 * Отдаётся ОБА, одним разрешением (INP-1, design Decision 12). Угол остаётся —
 * на нём стоит вся сегодняшняя сцена: JSON-системы разворачивают его обратно в
 * вектор оператором `cos`/`sin`, и направление точкой не выражается. Точка
 * нужна цепочке прицеливания способностей (ABIL-5): «сюда» и «в эту сторону» —
 * разные высказывания, и одно из другого не выводится. Считать их двумя
 * лучами нельзя — они разъезжались бы между собой.
 */
function aimAtPointer(clientX: number, clientY: number): AimResolution | null {
  const point = groundPoint(clientX, clientY);
  if (point === null || heroId === null) return null;
  const view = remote?.view?.entities.get(heroId);
  if (view === undefined) return null;
  const dx = point.x - view.currX;
  const dy = point.y - view.currY;
  // Клик в себя — направления нет; точка при этом есть, но без направления она
  // не действие: сцена демо решает по углу.
  if (Math.hypot(dx, dy) < 1e-3) return null;
  return { angle: aimAngle(dx, dy), x: point.x, y: point.y };
}

const kbmSource = new KeyboardMouseSource({
  bindings: bindings.keyboardMouse,
  // Fly владеет клавиатурой — герой стоит (CAM-1, CAM-2).
  movementCaptured: () => rig?.capturesMovement() ?? false,
  // ВАЖНО для действий на кнопках мыши (`cast` на ЛКМ, `shield` на ПКМ):
  // нажатие без разрешённого прицела действием не считается (INP-1) — луч мимо
  // плоскости пола или клик точно в себя не дают ни фронта, ни удержания.
  // Каст этим и жив (стрелять в никуда нечем), а вот щит платит за это ценой:
  // ПКМ с курсором выше горизонта его не поставит. Лечится это не здесь, а
  // источником прицела — сегодня он у демо один и он же луч по полу.
  aimAt: aimAtPointer,
});
sampler.add(kbmSource);
kbmSource.bind(window);

let touchSource: TouchSource | null = null;
if (bindings.touch !== undefined) {
  touchSource = new TouchSource(bindings.touch, () => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  sampler.add(touchSource);
  touchSource.bind(window);
}

if (bindings.gamepad !== undefined) {
  sampler.add(new GamepadSource(bindings.gamepad, navigatorGamepad(window)));
}

/**
 * Прицел этого кадра, посчитанный ОДИН раз (см. `frame`): и сэмплер, и превью
 * зоны захвата берут одно и то же число — иначе превью обещало бы игроку не тот
 * сектор, по которому решит тик. `null` — указатель ещё не двигался или луч
 * прошёл мимо пола.
 */
let frameAim: number | null = null;

/**
 * Точка прицела этого кадра — второй половина того же разрешения (INP-1): её
 * везёт `InputFrame` (TICK-2), и цепочка прицеливания способностей читает
 * именно её, а не угол. Считается тем же единственным лучом, что `frameAim`, и
 * гаснет вместе с ним.
 */
let frameTarget: AimPoint | null = null;

/**
 * Последний НЕПУСТОЙ прицел кадра: им целится шар заряда своего героя. Луч,
 * ушедший мимо плоскости пола, шар не гасит — заряд идёт, а направление у него
 * есть то же самое правило «последнего значения», что у сэмплера (INP-5).
 */
let lastAim: number | null = null;

/**
 * Прицел под курсором как НЕПРЕРЫВНЫЙ источник (INP-1): `KeyboardMouseSource`
 * владеет прицелом только в момент клика, а способностям с удержанием (захват
 * снаряда, заряд каста) направление нужно на каждом тике удержания — иначе
 * отпускание разрешалось бы по направлению последнего клика. Органов управления
 * источник не держит (`held` не реализует), поэтому на биты кнопок он не влияет
 * вовсе; сэмплер берёт прицел у того источника, который менял его последним
 * (INP-5).
 *
 * Прицел отдаётся в опрос после движения указателя — ЛИБО пока зажата
 * способность с удержанием. Без второго условия он менялся бы на каждом опросе
 * сам собой — герой идёт, курсор стоит, угол «герой → курсор» плывёт, — и по
 * правилу «последний менявший» этот источник навсегда перебивал бы стик
 * геймпада и тач, у которых прицел при неподвижном стике замирает. Но пока
 * человек ДЕРЖИТ мышью захват или заряд, он заведомо целится ею: без живого
 * прицела нарисованный сектор захвата разъезжался бы с тем `aimDir`, по
 * которому решит тик (герой сместился, курсор нет), — то есть превью обещало бы
 * не ту зону. Молчание источника прицел не гасит: сэмплер держит последнее
 * направление (INP-5).
 */
let polledPointerMoves = -1;
/** Способности демо, которые целятся мышью всё время удержания (см. выше). */
const POINTER_HELD_ACTIONS: readonly string[] = ['capture', 'cast'];
function pointerAiming(): boolean {
  const held = kbmSource.held();
  // Плоский цикл, а не `some`: функция зовётся каждым опросом сэмплера, то есть
  // покадрово, и замыкание на кадр — политика этого файла (см. `groundPoint`).
  for (const action of POINTER_HELD_ACTIONS) {
    if (held.has(action)) return true;
  }
  return false;
}
const pointerAimSource: InputSource = {
  id: 'pointer-aim',
  start: () => {},
  stop: () => {},
  poll: () => {
    const moved = pointerMoves !== polledPointerMoves;
    polledPointerMoves = pointerMoves;
    const aiming = moved || pointerAiming();
    return {
      moveX: 0,
      moveY: 0,
      aim: aiming ? frameAim : null,
      target: aiming ? frameTarget : null,
    };
  },
};
// ПОСЛЕДНИМ, и это несущее: сэмплер выбирает прицел источника с самым свежим
// изменением строгим сравнением (INP-5), а при РАВНОЙ свежести побеждает тот,
// кто добавлен раньше. То есть в тик, где стик тача или геймпада двинулся
// одновременно с курсором, выигрывает стик — устройство, которым игрок
// действительно целится. Переставить этот `add` выше значило бы отдать мыши
// молчаливый приоритет над обоими.
sampler.add(pointerAimSource);

// ------------------------------------------------- превью каста (REND-28)
//
// Фигура шага рисуется ПОДСИСТЕМОЙ рендера, а не главным потоком: она читает то
// же определение сцены, что и симуляция (ABIL-5), а рукописные `capturePreview`
// и `chargeBalls` этой сборки на нём и держались — на втором описании тех же
// способностей. Сборке остаётся ровно три шва: каталог определений в
// конструктор, имена статов слотов (`extractor.ts`) и покадровый локальный
// сэмпл ввода — тот же, что уезжает в тик.

/**
 * Подсистема превью каста: регистрируется в `onReady` вместе с остальными —
 * поверхность и каталог к тому моменту есть, а до первого доставленного тика
 * рисовать всё равно нечего (REND-28).
 */
let abilityPreview: AbilityPreviewSubsystem | null = null;

/**
 * Визуальная поверхность кадра (REND-9) — общая с подсистемами террейна,
 * моделей и эффектов; появляется вместе с сеткой в `onReady`. Шар заряда
 * садится на НЕЁ, а не на `pose.z` инстанса: в прыжке и рывке поза поднята
 * дугой манёвра (REND-12), а шар висит перед кастером на своей высоте.
 */
let visualSurface: VisualSurfaceSource | null = null;

/**
 * Точка пола под интерполированной позой инстанса. Горизонталь — ровно та
 * позиция, по которой решает тик (REND-2), высота — поверхность под ней.
 *
 * Отдаётся ОДНА переиспользуемая запись: функция зовётся по разу на каждый шар
 * заряда в кадре, а свежий объект на каждый вызов — мусор на кадре (та же
 * политика, что у `ndcScratch`/`hitScratch`). Значение читается сразу и между
 * кадрами не хранится.
 */
const groundScratch = { x: 0, y: 0, z: 0 };
function groundUnder(instance: { pose: { x: number; y: number; z: number } }): {
  x: number;
  y: number;
  z: number;
} {
  const surface = visualSurface?.current ?? null;
  const x = instance.pose.x;
  const y = instance.pose.y;
  groundScratch.x = x;
  groundScratch.y = y;
  groundScratch.z = surface === null ? instance.pose.z : surface.heightAt(x, y);
  return groundScratch;
}

/**
 * Шары заряда каста: собираются в `main` ПОСЛЕ манифеста — цвет, базовый радиус
 * и высоту они берут из его записей `effects.byKind` (`chargeBalls.ts`).
 */
let chargeBalls: ChargeBalls | null = null;

/**
 * Имена статов слотов, доставляемых превью (HUD-8). Список тот же, по которому
 * `extractor.ts` объявляет источники: разойдись они — превью читало бы имена,
 * которых в кадре нет, и молча не рисовало бы ничего.
 */
const PREVIEW_SLOT_STATS: readonly AbilitySlotStatNames[] = PREVIEW_SLOTS.map((ability) => ({
  ability: STATS.slotAbility(ability),
  phase: STATS.slotPhase(ability),
  staged: STATS.slotStaged(ability),
  steps: Array.from({ length: ABILITY_STEPS }, (_unused, step) => ({
    x: STATS.slotStepX(ability, step),
    y: STATS.slotStepY(ability, step),
    entity: STATS.slotStepEntity(ability, step),
  })),
}));

/**
 * Накладка тач-стиков: отрисовка — уровень приложения, источник отдаёт только
 * геометрию (`overlay()`, design D6). База и ручка — по паре кругов на стик.
 */
const touchOverlay = ((): ((state: ReturnType<TouchSource['overlay']>) => void) | null => {
  if (touchSource === null) return null;
  const circle = (size: number, alpha: number): HTMLDivElement => {
    const el = document.createElement('div');
    el.style.cssText =
      `position:fixed;width:${size}px;height:${size}px;border-radius:50%;` +
      `border:2px solid rgba(255,255,255,0.5);background:rgba(255,255,255,${alpha});` +
      'transform:translate(-50%,-50%);pointer-events:none;display:none;z-index:10';
    app.appendChild(el);
    return el;
  };
  const parts = {
    moveStick: { base: circle(96, 0.08), knob: circle(40, 0.25) },
    aimStick: { base: circle(96, 0.08), knob: circle(40, 0.25) },
  };
  const place = (el: HTMLDivElement, x: number, y: number): void => {
    el.style.display = 'block';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };
  return (state) => {
    for (const key of ['moveStick', 'aimStick'] as const) {
      const stick = state[key];
      const { base, knob } = parts[key];
      if (stick === null) {
        base.style.display = 'none';
        knob.style.display = 'none';
        continue;
      }
      place(base, stick.centerX, stick.centerY);
      place(knob, stick.knobX, stick.knobY);
    }
  };
})();

window.addEventListener('mousedown', (e) => {
  if (e.button === 1) {
    // MMB — drag-панорама (CAM-3); default — autoscroll браузера.
    e.preventDefault();
    midDrag = true;
    return;
  }
  // ПКМ с Alt — осмотр в режиме облёта (CAM-1); без Alt правая кнопка
  // принадлежит герою: её действие (`shield`) обрабатывает
  // `KeyboardMouseSource.bind` выше — тем же путём, что ЛКМ (каст). Что именно
  // Alt отдаёт камере, а не миру, сказано ОДИН раз и в данных — оговоркой
  // `suppressedBy` той же записи раскладки (INP-4): здесь только вторая
  // половина того же решения.
  if (e.button === 2 && e.altKey) rightDrag = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 1) midDrag = false;
  if (e.button === 2) rightDrag = false;
});
window.addEventListener('contextmenu', (e) => { e.preventDefault(); });
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  // ~100 deltaY на щелчок колеса; трекпад копит дробные шаги.
  camInput.wheelSteps += e.deltaY / 100;
}, { passive: false });

/** Сэмпл осей камеры на кадр: стрелки, edge-pan, удержания, fly-перемещение. */
function sampleCameraInput(): void {
  camInput.panX = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
  camInput.panY = (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0);
  const rect = renderer3.domElement.getBoundingClientRect();
  // Край экрана — политика сборки (`cameraInput.ts`): в follow он инертен, и
  // прицел мышью у кромки арены больше не срывает слежение за героем (CAM-2).
  const edge = demoEdgePan({
    mode: rig?.mode ?? null,
    pointerOverHud,
    pointerX,
    pointerY,
    rect,
    margin: rig?.config.edgeMarginPx ?? 0,
  });
  camInput.edgeX = edge.x;
  camInput.edgeY = edge.y;
  camInput.centerHeld = keys.has('KeyC');
  const fly = rig?.capturesMovement() ?? false;
  camInput.moveX = fly ? (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) : 0;
  camInput.moveY = fly ? (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) : 0;
  // Вертикаль облёта — `Q`/`Z`, а не привычная пара `Q`/`E`: `Q` в раскладке
  // демо занята отменой шага прицеливания (`bindings.json`), а `KeyboardMouseSource`
  // гасит в режиме облёта только ОСИ движения (`movementCaptured`), не биты
  // действий, — то есть облёт вверх заодно шлёт в мир отмену. Пара выбрана
  // так, чтобы вторая клавиша (`Z`) не значила в мире ничего. Направление у
  // `Q` при этом ОБРАТНОЕ редакторскому (`editor/ui-ts`: `E` — вверх, `Q` —
  // вниз): мышечная память между двумя сборками не переносится.
  // У правой кнопки та же коллизия решена в ДАННЫХ: осмотр требует Alt, а
  // раскладка объявляет `shield` подавленным этим же модификатором, — одно
  // сочетание, один смысл (INP-4).
  camInput.moveZ = fly ? (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyZ') ? 1 : 0) : 0;
}

/**
 * Канонический ввод в воркер (SHELL-6): сэмплер сводит источники, латчит
 * фронты и квантует в Q16.16 (input-devices INP-2, INP-3, INP-5); фронты
 * дальше латчатся воркером до ближайшего тика — нажатие между тиками не
 * теряется. `tick`/`seq` канонического InputFrame ставит воркер.
 */
function pushInput(): void {
  if (remote === null) return;
  const input = sampler.sample();
  remote.sendInput(input.move, input.aimDir, input.buttons, input.target);
}

// ------------------------------------------------------------- HUD и цикл

/**
 * Ничтожный «ввод панорамы» для открепления камеры от героя: follow не даёт
 * кадрированию хода (CAM-2 — панорама открепляет, кадрирование нет), поэтому
 * клик миникарты сначала открепляет камеру тем же правилом, что ручная
 * панорама. Сдвиг от этого значения — единицы микрон мира, глазу не виден.
 */
const PAN_DETACH_PX = 1e-4;

/**
 * Просьба кадрирования от миникарты, отложенная до кадра, в котором камера
 * уже откреплена: поданная в кадр с «вводом панорамы» она была бы им же и
 * погашена (CAM-3 — ввод отменяет разовые перелёты).
 */
let pendingPan: { x: number; y: number } | null = null;

/**
 * Прямоугольник кадрирования вокруг точки клика миникарты: полуразмер подобран
 * так, чтобы перелёт (CAM-8) сажал камеру на базовую дистанцию конфига —
 * обратная формула вертикального ограничения `frameBounds`:
 * `d = along · (sin p / tan v + cos p)` ⇒ `along = d / (…)`, а полуразмер
 * квадрата — `along / (|cos yaw| + |sin yaw|)` (опорная функция квадрата).
 */
function panFramingRect(cfg: CameraRig['config'], x: number, y: number): CameraBounds {
  const tanV = Math.tan(((cfg.fovDeg / 2) * Math.PI) / 180);
  const along = cfg.distance / (Math.sin(cfg.pitch) / tanV + Math.cos(cfg.pitch));
  const half = along / Math.max(Math.abs(Math.cos(cfg.yaw)) + Math.abs(Math.sin(cfg.yaw)), 1e-6);
  return { minX: x - half, maxX: x + half, minY: y - half, maxY: y + half };
}

/**
 * Контракт камеры для presentation-действий HUD (HUD-2): узкая поверхность
 * над тем же конвейером позы (CAM-1), что у клавиш и колеса, — второго способа
 * двигать камеру не появляется. В воркер отсюда не уходит ничего.
 */
const hudCamera: HudCameraContract = {
  panTo(x: number, y: number): void {
    if (rig === null) return;
    if (rig.mode === 'follow') camInput.dragDX += PAN_DETACH_PX;
    pendingPan = { x, y };
  },
  focusOnHero(): void {
    // Тот же фронт, что клавиша C: перелёт центрирования к герою (CAM-2).
    camInput.centerTap = true;
  },
};

let lastFrameAt: number | null = null;

/**
 * Probe стадий кадра (`performance-budget` PERF-2, PERF-7) — только под
 * `?bench=1`. Выключенный (обычный запуск демо) он и есть `null`, и кадру
 * стоит ровно одной проверки на `null` в `frame`: ни обращения к часам, ни
 * записи в буфер (PERF-3 «выключенный учёт бесплатен»). Ручка отчёта живёт на
 * `window` — её читает браузерный бенч (`bin/bench-demo.mjs`).
 */
const benchProbe: BenchProbe | null = benchRequested(window.location.search)
  ? attachBenchProbe(window as BenchProbeHost)
  : null;

/**
 * Стадия `input`: прицел кадра, отложенное кадрирование миникарты, сэмпл осей
 * камеры, канонический ввод в воркер и накладка тач-стиков.
 *
 * Прицел кадра — ОДИН raycast на кадр (design Decision 6): его читают и
 * сэмплер через `pointerAimSource`, и превью каста. Считается ДО
 * конвейера камеры — по той же позе, по которой игрок видел кадр, когда ставил
 * курсор, и одинаково для обоих потребителей.
 *
 * Тиков здесь нет (SHELL-1): симуляция идёт в воркере своим тикером, кадр
 * только шлёт ввод и интерполирует доставленное (REND-2).
 */
function sampleFrameInput(): void {
  const resolved = pointerX < 0 ? null : aimAtPointer(pointerX, pointerY);
  frameAim = resolved === null ? null : resolved.angle;
  frameTarget = resolved;
  if (frameAim !== null) lastAim = frameAim;

  // Отложенное кадрирование миникарты — когда камера уже не follow (см. panTo).
  if (pendingPan !== null && rig !== null && rig.mode !== 'follow') {
    rig.frameBounds({ rect: panFramingRect(rig.config, pendingPan.x, pendingPan.y), aspect: camera.aspect });
    pendingPan = null;
  }
  sampleCameraInput();
  pushInput();
  // Третий шов превью (REND-28): локальный, ещё не подтверждённый сэмпл — та же
  // точка и то же квантование, что уедут в мир `InputFrame`'ом (INP-3), а не
  // второе округление той же точки. Обратного канала нет: подсистема её только
  // читает.
  //
  // Гейт короткого заряда — здесь, а не в подсистеме: «одиночный клик превью не
  // показывает» — правило ИГРЫ, а рендер рисует фигуру шага, пока идёт фаза
  // (REND-28), и решать за игру, какая фаза достойна картинки, ему нечем.
  // Сэмпл без точки гасит превью ровно так же, как его отсутствие.
  abilityPreview?.applyLocalInput(
    heroId === null || chargeTooYoung()
      ? null
      : {
          entity: heroId,
          target:
            frameTarget === null
              ? null
              : { x: toWorldFixed(frameTarget.x), y: toWorldFixed(frameTarget.y) },
        },
  );
  if (touchSource !== null) touchOverlay?.(touchSource.overlay());
}

/**
 * Идёт ли заряд каста своего героя короче порога (`CHARGE_PREVIEW_MIN_TICKS`).
 * Величина — ДОСТАВЛЕННАЯ (стат `charge`, HUD-1), а не счётчик главного потока:
 * о нажатиях кадр не помнит, и помнить не должен — заряд считает симуляция.
 * Стата нет — заряда нет, и гасить нечего.
 */
function chargeTooYoung(): boolean {
  if (heroId === null) return false;
  const ticks = remote?.view?.entities.get(heroId)?.stats?.get(STATS.charge);
  return ticks !== undefined && ticks < CHARGE_PREVIEW_MIN_TICKS;
}

/**
 * Поза, которой нарисован ПОСЛЕДНИЙ кадр (CAM-1) — уже с эффектами. Её же
 * читают отладочный инспектор (picking по видимому, REND-15) и источник камеры:
 * второго конвейера позы не заводится, и луч под курсором совпадает с картинкой.
 */
let lastPose: CameraPose | null = null;

/**
 * Стадия `camera` — конвейер камеры (CAM-1): follow-цель — интерполированная
 * горизонталь инстанса (x/y; высоту rig берёт с поверхности, CAM-2), поза →
 * эффекты → применение к THREE-камере.
 *
 * ДО кадра подсистем, а не после: отсечение и выбор уровня детализации идут
 * по матрицам камеры (REND-21, REND-22), и камера, посаженная после кадра,
 * отсекала бы по пирамиде ПРОШЛОГО кадра — быстрым разворотом инстансы
 * вырезались бы у края экрана. Цель слежения при этом на кадр старше, но
 * конвейер камеры её и так сглаживает — тот же порядок у сцены редактора.
 */
function cameraFrame(dtSec: number): void {
  if (rig === null) return;
  // Цель слежения — видимая поза инстанса (REND-3): узла сцены рендер наружу
  // не отдаёт, и камера ведёт по тем же числам, которыми он нарисован.
  const instance = heroId === null ? null : (models?.instanceFor(heroId) ?? null);
  const heroView = heroId === null ? undefined : remote?.view?.entities.get(heroId);
  const target =
    instance === null
      ? null
      : {
          x: instance.pose.x,
          y: instance.pose.y,
          snap: (heroView?.snap ?? false) || (remote?.view?.snapAll ?? false),
        };
  const logical = rig.update(camInput, dtSec, target);
  resetCameraInput(camInput);
  // Эффекты камеры (тряска, покачивание) — часть картинки МИРА, а не главного
  // потока: стоящий мир с трясущейся камерой показывает движение, которого в
  // симуляции нет (REND-25, тот же довод, что у клипов). Собственный гейт
  // заморозки у `EffectStack` есть, но сюда стек ведёт демо своим циклом и
  // своим положительным dt — гейт остаётся недостижимым, если не обнулить
  // время здесь. Сама же камера (`rig.update`) продолжает слушаться игрока:
  // осмотреться в замороженном мире — ровно то, ради чего перемотку и смотрят.
  const worldDt = (remote?.view?.mode ?? 'Running') === 'Running' ? dtSec : 0;
  const applied = director === null ? logical : director.stack.apply(logical, worldDt);
  lastPose = applied;
  applyCameraPose(camera, applied);
}

/**
 * Стадия `present`: покадровое обновление подсистем (`frame` — интерполяция
 * поз, отсечение, выбор уровня детализации). Шар заряда — следом и здесь же: он
 * садится на позу инстанса ЭТОГО кадра, не прошлого.
 *
 * Приёма доставки (`syncTick`) здесь НЕТ: подсистемам его раздаёт `RemoteHost`
 * на приход сообщения из воркера (SHELL-3), то есть между кадрами. Стоимость
 * приёма меряют счётчики (PERF-3, PERF-4), а не браузерный замер — см. шапку
 * `benchProbe.ts`.
 */
function presentFrame(now: number): void {
  remote?.frame(now);
  chargeBalls?.update();
  // Отладочный слой ведёт себя сам: доставленное состояние и кадровые величины
  // он получает своей точкой у сцены (REND-27) — сразу после подсистем, то есть
  // по позам ЭТОГО кадра. Приложению остаётся текстовая часть панели (RDBG-3), и
  // собирается она по часам кадра, а не каждым кадром: дамп снимается по
  // запросу (RDBG-7).
  debugPanel?.update(now);
}

/**
 * Стадия `draw`: кадр с туманом идёт пост-проходом подсистемы (FOW-7,
 * design D2); без неё — кадром подсистемы пост-обработки (REND-34), которая
 * при выключенной цепочке делает ровно прежний прямой рендер. Своей
 * пост-обработки поверх подсистем сборка не ведёт (REND-34, ED-22).
 */
function drawScene(): void {
  if (fogSubsystem !== null) fogSubsystem.render(renderer3, camera);
  else if (postprocess !== null) postprocess.render(renderer3, camera);
  else renderer3.render(scene3, camera);
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = lastFrameAt === null ? 0 : Math.min(now - lastFrameAt, 250);
  lastFrameAt = now;
  const dtSec = dt / 1000;

  // Одна проверка на кадр — и это ВСЯ цена выключенного замера (PERF-3):
  // включённый probe отбивает те же четыре стадии отметками часов, выключенного
  // в кадре нет вовсе.
  if (benchProbe === null) {
    sampleFrameInput();
    cameraFrame(dtSec);
    presentFrame(now);
    drawScene();
    return;
  }
  benchProbe.begin(now);
  sampleFrameInput();
  benchProbe.mark();
  cameraFrame(dtSec);
  benchProbe.mark();
  presentFrame(now);
  benchProbe.mark();
  drawScene();
  benchProbe.mark();
  // Каденс тика выводится пассивно — из номера последней доставки (SHELL-1).
  benchProbe.end(remote?.view?.tick ?? -1);
}

// -------------------------------------------------------------------- запуск

/**
 * Воркер-сторона режима (SHELL-8). Соло-режим — один воркер с симуляцией;
 * сетевые — воркер тонкого клиента, которому сборка сообщает, как добраться до
 * сервера матча: порт матча своей вкладки либо адрес стенда (SES-1).
 *
 * Порт участника создаёт сервер вкладки и присылает сюда — главный поток лишь
 * передаёт его клиенту transfer'ом. Своего пути в матч у него нет: он не
 * участник, он рисует (SHELL-2).
 */
function spawnShellWorker(mode: DemoMode): Worker {
  if (mode.kind === 'solo') {
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  }
  const client = new Worker(new URL('./clientWorker.ts', import.meta.url), { type: 'module' });
  client.addEventListener('message', (event: MessageEvent) => {
    if (isDemoNotice(event.data)) showNotice(event.data.message);
  });
  if (mode.kind === 'server') {
    const init: DemoClientInit = { t: 'demo-client-init', url: mode.url };
    client.postMessage(init);
    return client;
  }
  const server = new Worker(new URL('./serverWorker.ts', import.meta.url), { type: 'module' });
  server.addEventListener('message', (event: MessageEvent) => {
    if (!isDemoServerReady(event.data)) return;
    const init: DemoClientInit = { t: 'demo-client-init', port: event.data.port };
    client.postMessage(init, [event.data.port]);
  });
  const init: DemoServerInit = { t: 'demo-server-init' };
  server.postMessage(init);
  return client;
}

/**
 * Записи `decorations` парного документа → набор decoration-инстансов
 * (PRES-2 → REND-18): конверсия — общий `decorationInstanceOf` рендера, а не
 * своя копия правила. Ключ — индекс записи: набор в матче подаётся один раз,
 * правок соседей, которые ключ обязан переживать (ED-29), здесь не бывает.
 */
function demoDecorations(presentation: PresentationScene): DecorationInstance[] {
  return presentation.decorations.map((record, index) => decorationInstanceOf(record, `#${index}`));
}

/**
 * Сообщение человеку поверх вьюпорта: матч занят, сервер не отвечает,
 * «возвращаюсь в матч» после разрыва (`netcode-transport` NTR-17, design D8).
 *
 * Пустая строка ГАСИТ показанное: состояние переподключения обязано исчезать,
 * когда игрок снова в бою, — иначе висящая надпись пережила бы то, о чём
 * сообщала.
 */
function showNotice(message: string): void {
  const notice = document.getElementById('notice');
  if (notice === null) return;
  notice.textContent = message;
  notice.style.display = message === '' ? 'none' : 'block';
}

/**
 * Кнопка подключения — DOM демо-приложения, а не виджет HUD (design D4):
 * композиция HUD описывает то, что живёт внутри матча, а это переход между
 * режимами страницы, то есть новый старт оболочки (SHELL-8).
 */
function wireConnectButton(mode: DemoMode): void {
  const button = document.getElementById('connect');
  if (!(button instanceof HTMLAnchorElement)) return;
  if (mode.kind === 'server') {
    button.textContent = '← матч с ботом';
    button.title = `сейчас: ${mode.url}`;
    button.href = localModeUrl(window.location.href);
    return;
  }
  button.textContent = 'играть по сети →';
  // Адрес выводится из САМОЙ СТРАНИЦЫ (`demoServerUrl`): второй игрок открывает
  // её по адресу первого, и зашитый loopback увёл бы его на его же машину.
  // Константой сборки остаётся порт (D4) — списка серверов у демо нет.
  button.title = `подключиться к стенду ${demoServerUrl(window.location)}`;
  button.href = serverModeUrl(window.location.href);

  // На десктопе стенд поднимает сам контейнер (`desktop-shell` DSK-7): кнопка
  // сначала публикует сессию (SES-3), а потом уводит страницу на полученный
  // адрес. Смена режима остаётся переходом по URL — оболочка стартует заново
  // (SHELL-8), — и ветка кончается этой строкой: дальше сетевой режим один.
  const host = demoStandHost(globalThis);
  if (host === undefined) return;
  button.textContent = 'поднять стенд и играть по сети →';
  button.title = `поднять стенд матча этой машины (${DEMO_STAND_SERVICE})`;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    button.textContent = 'поднимаю стенд…';
    void host.publish().then(
      (address) => {
        window.location.href = serverModeUrl(window.location.href, address);
      },
      (error: unknown) => {
        button.textContent = 'играть по сети →';
        showNotice(`стенд не поднялся: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  });
}

// ------------------------------------------------- качество картинки (QUAL-1)

/**
 * Подписи уровней качества — текст интерфейса, а не данные пресета: документы
 * называют ручки и значения, а как уровень зовут человеку, решает приложение.
 * Запись полная по набору игры, и четвёртый уровень (QUAL-1, сценарий
 * «четвёртый пресет без правки движка») не соберётся без своей подписи.
 */
const QUALITY_LABELS: Readonly<Record<QualityPresetName, string>> = {
  performance: 'производительность',
  balanced: 'баланс',
  ultra: 'ультра',
};

/** Хранилище выбора, если среда его даёт; в воркере и в Node — `undefined`. */
const qualityStorage = qualityStorageOf(globalThis);
/**
 * Живой выбор уровня: запомненный при запуске, обновляемый переключателем и
 * применяемый сборкой сцены (`onReady`). Контроллера до неё нет — применять
 * значения ручек ещё не к чему, — поэтому выбор, сделанный за время загрузки
 * манифеста и ассетов, ЖДЁТ сборку, а не отменяется ею.
 */
const qualitySelection = createQualitySelection(storedQualityPreset(qualityStorage));
/** Сам переключатель: его значением показывается ДЕЙСТВУЮЩИЙ пресет. */
let qualitySelect: HTMLSelectElement | null = null;

// ---------------------------------------- отладочный режим рендера (RDBG-1)

/**
 * Панель отладочных источников (`render-debug` RDBG-1). Появляется вместе со
 * сценой (`onReady`): реестр источников складывается из объявлений подсистем при
 * регистрации (REND-27), и до неё в панели было бы пусто.
 *
 * Сам слой в переменной не держится намеренно: доставленное состояние и кадровые
 * величины он получает своей точкой у сцены (REND-27), а снаружи его адресуют
 * версионированной ручкой `__renderDebug`. Отладка выключена по умолчанию
 * (RDBG-4) — источники включает человек галочкой либо запомненным выбором.
 */
let debugPanel: DebugPanel | null = null;

/**
 * Переключатель качества картинки — DOM демо-приложения, как и кнопка режима
 * (design D4): это настройка страницы, а не действие внутри матча, и в
 * композиции HUD (HUD-4) ему места нет.
 *
 * Список строится из набора пресетов игры, а не из разметки: новый уровень
 * качества — новый документ и подпись к нему, без правок страницы и движка
 * (QUAL-1). Смена идёт контроллером в рантайме — пересборки рендера нет
 * (design D2), и выбор запоминается тем, что применилось: отвергнутый документ
 * уводит демо на запасной, и переключатель обязан показывать применённое, а не
 * нажатое.
 */
function wireQualitySelect(initial: QualityPresetName): void {
  const select = document.getElementById('quality');
  if (!(select instanceof HTMLSelectElement)) return;
  for (const name of QUALITY_PRESET_NAMES) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = QUALITY_LABELS[name];
    select.append(option);
  }
  select.value = initial;
  select.addEventListener('change', () => {
    // Матча может ещё не быть: до `onReady` применять значения не к чему, и
    // выбор копится — сборка сцены возьмёт последний сделанный, а не тот, что
    // лежал в хранилище на старте страницы.
    const applied = qualitySelection.choose(qualityPresetName(select.value));
    select.value = applied;
    rememberQualityPreset(qualityStorage, applied);
  });
  qualitySelect = select;
}

/**
 * Сборка отладочного слоя и его панели (`render-debug` RDBG-1, design D10).
 *
 * Источники здесь — ПОЛИТИКА демо: какие оси наблюдения существуют и из чего они
 * считаются (`debugSources.ts`). Движковые источники приезжают сами — их
 * объявили подсистемы при регистрации (REND-27); сборка добавляет свои: шов
 * доставки, читателя счётчиков стоимости, реконструкцию статики, круги
 * коллайдеров по объявленному стату, инспектор поверх picking'а и камеру.
 *
 * Ни один из них не заводит нового канала к данным (RDBG-6): всё считается из
 * доставленного состояния, сетки handshake (SHELL-5) и позы камеры (CAM-1).
 */
function wireDebugPanel(surface: VisualSurfaceSource, bounds: CameraBounds): void {
  const layer = new RenderDebugLayer(remote!.stage, { scene: scene3, surface });
  // Picking по видимому изображению (REND-15) — ТОТ ЖЕ сервис, что у вьюпорта
  // редактора: второй реализации пересечения не заводится. Прокси инстансов даёт
  // подсистема моделей — она уже `InstanceProxySource`.
  //
  // Камера сервису НЕ передаётся, и это несущее: луч он строит, посадив позу на
  // свою камеру (`ray`), а проба снимается ПОСЛЕ кадра подсистем и ДО рисования
  // (REND-27). Отдай ему камеру кадра — и наведение переписывало бы её
  // соотношение сторон и матрицы между отсечением и рисованием, то есть отладка
  // меняла бы кадр под собой (RDBG-5).
  //
  // Совпадение с картинкой держится тогда не общим объектом, а тем, что у двух
  // камер ОДНИ И ТЕ ЖЕ оси: общая поза (`lastPose`), общий `applyCameraPose`
  // (CAM-1) и общий мировой верх — сервис ставит своей камере тот же (0,0,1),
  // что и эта страница строкой `camera.up.set` выше. Разойдись верх — луч
  // повернулся бы вокруг оси взгляда, и под курсором в углу кадра инспектор
  // показывал бы не то, что там нарисовано (REND-15).
  const picking = new ViewportPicking({
    surface,
    ...(models !== null ? { instances: models } : {}),
  });
  layer
    .register(deliveryDebugSource())
    .register(costCountersDebugSource())
    .register(staticCollidersDebugSource(() => remote?.terrain ?? null))
    .register(dynamicCollidersDebugSource(STATS.colliderRadius))
    .register(
      inspectorDebugSource({
        picking: () => picking,
        pose: () => lastPose,
        point: () => {
          if (pointerX < 0) return null;
          const rect = renderer3.domElement.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          return {
            x: pointerX - rect.left,
            y: pointerY - rect.top,
            width: rect.width,
            height: rect.height,
          };
        },
      }),
    )
    .register(
      cameraDebugSource({
        rig: () => rig,
        pose: () => lastPose,
        bounds: () => bounds,
        viewport: () => {
          const rect = renderer3.domElement.getBoundingClientRect();
          return rect.width === 0 ? null : { width: rect.width, height: rect.height };
        },
      }),
    );
  // Запомненный выбор — после регистрации всех источников: до неё реестр не
  // знал бы половины имён, и восстановление молча потеряло бы их (RDBG-1).
  restoreDebugSources(layer, storedDebugSources(qualityStorage));
  const container = document.getElementById('debug');
  if (container !== null) {
    debugPanel = createDebugPanel({ layer, container, storage: qualityStorage });
    debugPanel.refresh();
  }
  // Ручка дампа на `window` по образцу `__benchProbe` (PERF-7): кладёт её
  // сборка приложения, а собирает дамп рендер.
  attachDebugGlobal(window as DebugGlobalHost, layer);
}

async function main(): Promise<void> {
  // Режим выбирается ОДИН раз, до создания воркеров: переключение режима — это
  // перезагрузка страницы с другим параметром (SHELL-8).
  const mode = demoMode(window.location.search, window.location);
  // Кнопка режима — ДО загрузки манифеста: она и есть дорога со сломанной
  // страницы. Упади манифест (нет ассета, нет сети) — переключиться было бы
  // нечем, а это единственный орган управления, которому матч не нужен вовсе.
  wireConnectButton(mode);
  // Переключатель качества — рядом с кнопкой режима и по той же причине: это
  // орган управления страницей, и матч ему не нужен. Строится он запомненным
  // выбором, а применяется выбор, когда сцена собрана (`onReady`), — и к тому
  // моменту он может быть уже другим.
  wireQualitySelect(qualitySelection.pending);
  const manifest = await loadManifest();
  // Парный presentation-документ (PRES-1) — декорации и секция `fog` (FOW-10).
  // Загружается в обеих воркер-сторонах оболочки одинаково (SHELL-8): документ
  // читает главный поток, и режим симуляции ему не виден.
  const presentation = await loadPresentation();
  const fogEnabled = (sceneJson as unknown as SceneDef).fog === true;
  const fogConfig = resolveFogConfig(presentation?.fog);
  // Шары заряда — после манифеста: цвет, базовый радиус и высоту они берут из
  // записей `effects.byKind.Fireball`/`HeavyFireball`, то есть у тех самых
  // снарядов, один из которых и улетит (`chargeBalls.ts`).
  chargeBalls = createChargeBalls({
    scene: scene3,
    manifest,
    entities: () => remote?.view?.entities,
    instanceFor: (entity) => models?.instanceFor(entity) ?? null,
    heroId: () => heroId,
    lastAim: () => lastAim,
    groundUnder,
  });
  // Каталог определений сцены — первый шов превью (REND-28, design Decision 11):
  // клиент резолвит сцену локально, и таблица строится ТОЙ ЖЕ
  // `compileAbilityCatalog`, что у симуляции, — над тем же документом. Второго
  // описания способности на клиенте не появляется.
  const abilityCatalog = loadScene(sceneJson as unknown as SceneDef).abilities ?? null;
  const worker = spawnShellWorker(mode);

  remote = new RemoteHost(context, {
    onReady: (hello) => {
      heroId = (hello.extra as { hero: EntityId }).hero;
      const grid = remote!.terrain;
      if (grid === null) throw new Error('демо: сцена обязана содержать террейн');
      // Общая визуальная поверхность (REND-9/10): кривизна из манифеста,
      // нет ссылки — плоские ступени REND-7.
      const surface = new VisualSurfaceSource(grid, {
        ...(manifest.terrain?.curvatureMap !== undefined
          ? { curvatureMapId: manifest.terrain.curvatureMap }
          : {}),
      });
      // Та же поверхность — шару заряда: он садится на пол, а не на дугу
      // манёвра инстанса.
      visualSurface = surface;
      // Пост-обработка кадра (REND-34) — ПЕРВОЙ подсистемой: её порт берёт
      // подсистема тумана (FOW-7, design D2), а порт объявляет тот, кто
      // зарегистрирован раньше и снесён будет позже (REND-31). Bloom и tone
      // mapping приходят секцией `postprocess` парного документа (PRES-2); нет
      // секции — цепочка неактивна и кадр байт-в-байт прежний.
      postprocess = new PostprocessSubsystem(
        presentation?.postprocess === undefined ? {} : { config: presentation.postprocess },
      );
      remote!.register(postprocess);
      // Свет арены — подсистемой, а не кодом сборки: источники и теневые карты
      // строятся из секции `lighting` парного документа (PRES-2), а нет секции
      // — из документированных умолчаний, равных прежнему захардкоженному
      // свету. Геометрия сцены ниже отдаёт ей свои корни теневыми кастерами.
      const lighting = new LightingSubsystem({
        grid,
        // Камера кадра — вход отбора активных локальных источников (REND-33):
        // важность источника меряется расстоянием до точки взгляда игрока. Та
        // же самая, что у отсечения инстансов ниже, и позу на неё сажает
        // `applyCameraPose` до кадра подсистем (CAM-1).
        camera,
        ...(presentation?.lighting !== undefined ? { config: presentation.lighting } : {}),
      });
      remote!.register(lighting);
      // Порядок подсистем нормативен (REND-8): сначала террейн, затем модели.
      remote!.register(new TerrainSubsystem(grid, { surface, shadows: lighting }));
      // Перёд модели больше не параметр сборки: он описан в записи манифеста
      // (ASSET-6 `facingDeg`, REND-13), поэтому модели разных форматов с разным
      // передом уживаются в одной сцене без общего для всех значения.
      // Камера подсистеме — вход отсечения невидимых инстансов (REND-21): та же
      // самая, которой рисуется кадр. Её поза здесь на один кадр старше кадра
      // подсистем (цель слежения берётся из уже посаженной позы инстанса), и
      // запас консервативности границ покрывает это наравне с размахом клипов.
      // Возрождение сцены (`Respawn`) снимает фиксацию последнего кадра клипа
      // смерти (REND-4): сущность та же, разрыва доставки нет, и без имени
      // события герой остался бы лежать последним кадром `Death` — у этой
      // модели он гасит ВСЕ геосеты, то есть герой был бы попросту невидим.
      models = new ModelsSubsystem(manifest, {
        surface,
        camera,
        shadows: lighting,
        reviveEvent: RESPAWN_EVENT,
        // Fade «ушла в туман ≠ умерла» (FOW-8, design D7): длительность — из
        // той же секции `fog`, что у подсистемы тумана (FOW-10). Сцена без
        // тумана опции не получает, и исчезновение убирает инстанс сразу.
        ...(fogEnabled ? { fadeSeconds: fogConfig.fadeSeconds } : {}),
      });
      remote!.register(models);
      // Транзиентные эффекты (REND-23) — после моделей: оболочки рисуются
      // поверх инстансов, а шарик снаряда и вовсе заменяет ему модель. Записи
      // — в манифесте (`effects`), кода сцены они не требуют. Список состояний
      // тот же, что у Extractor'а и диспетчера камеры (`sim.ts`): по нему
      // запись `effects.byState` находит свой бит доставленных состояний.
      remote!.register(
        new EffectsSubsystem(manifest, { surface, stateComponents: STATE_COMPONENTS }),
      );
      // Частицы (REND-24) — после моделей: сокет эмиттера снимается с позы узла
      // инстанса, посаженного В ЭТОМ ЖЕ кадре, а не в прошлом. Источник узлов —
      // сама подсистема моделей (`sockets`), словарь состояний — тот же список
      // сборки, что у эффектов и камеры: второго словаря не заводится.
      // Decoration-эмиттеры (факелы арены) приезжают сюда общим входом набора
      // декораций, который хост рассылает всем подсистемам (REND-18).
      const particles = new ParticlesSubsystem(manifest, {
        surface,
        stateComponents: STATE_COMPONENTS,
        sockets: models,
      });
      remote!.register(particles);
      // Превью каста (REND-28) — после частиц и до тумана: контур шага лежит
      // на полу и обязан гаснуть вместе с остальным кадром под маской. Каталог
      // и имена статов — два шва сборки, третий (`applyLocalInput`) зовётся
      // покадрово в стадии `input`. Сцена без определений превью не получает
      // вовсе: рисовать нечего.
      if (abilityCatalog !== null) {
        abilityPreview = new AbilityPreviewSubsystem(abilityCatalog, {
          slots: PREVIEW_SLOT_STATS,
          surface,
        });
        remote!.register(abilityPreview);
      }
      // Туман войны (FOW-7, FOW-9, FOW-10) — только в сборке игрового клиента
      // (design D3): подсистема владеет маской видимости и пост-проходом, кадр
      // рисует `frame` её вызовом. Наблюдатели приезжают статами доставки
      // (`extractor.ts`, design D4), конфиг — секцией `fog` парного документа.
      if (fogEnabled) {
        fogSubsystem = new FogSubsystem({
          grid,
          stats: { visionRadius: STATS.visionRadius, team: STATS.team },
          hero: () => heroId,
          // Порт пост-обработки (REND-34, design D2): при активной цепочке
          // маскирующий проход читает её выход, а сцену туман не рисует —
          // маска остаётся финальным проходом кадра (FOW-7).
          post: postprocess,
          ...(presentation?.fog !== undefined ? { config: presentation.fog } : {}),
          // Канвас слоя миникарты (HUD-6, design D6) — DOM даёт сборка:
          // пакет рендера document не трогает.
          createCanvas: (width, height) => {
            const layer = document.createElement('canvas');
            layer.width = width;
            layer.height = height;
            return layer;
          },
        });
        remote!.register(fogSubsystem);
      }
      // Декорации арены из парного документа (PRES-2 → REND-18): в матче набор
      // подаётся один раз из загруженного документа; рисуют его те же
      // подсистемы и тем же путём, что у сущностей мира.
      if (presentation !== null && presentation.decorations.length > 0) {
        new DecorationSet(remote!.stage).apply(demoDecorations(presentation));
      }

      // Камера: поверхность и границы — из той же сетки, что рендер террейна
      // (CAM-2, CAM-3); эффекты — по таблицам манифеста (ASSET-7, CAM-6).
      const ground = terrainGroundApi(grid, HEIGHT_STEP);
      rig = new CameraRig({
        groundHeightAt: ground.groundHeightAt,
        bounds: ground.bounds,
        // Стартовая цель — середина арены, выведенная из тех же границ сетки
        // (CAM-3), а не записанная числом: размер арены — дело контента, и
        // переехавшая сцена не должна оставлять камеру над прежним углом.
        startX: (ground.bounds.minX + ground.bounds.maxX) / 2,
        startY: (ground.bounds.minY + ground.bounds.maxY) / 2,
        // Настроечные числа кадра — из секции манифеста поверх умолчаний кода
        // (CAM-1, ASSET-10): нет секции или параметра — умолчание кода.
        config: cameraConfigFromManifest(manifest.cameraConfig),
      });
      director = new CameraEffectsDirector({
        tables: manifest.cameraEffects,
        description: CAMERA_EFFECTS_DESCRIPTION,
        // Тот же список, по которому Extractor воркера выставляет биты
        // `EntityView.states` (`sim.ts`): без него запись таблицы `states`
        // манифеста не находит своего бита и эффект не включается никогда.
        stateComponents: STATE_COMPONENTS,
      });
      // Мини-подсистема: события/состояния тика → диспетчер эффектов. syncTick
      // приходит на каждую доставку — события reliable (SHELL-4) не теряются.
      remote!.register({
        name: 'camera-effects',
        init: () => {},
        syncTick: (view) => director?.onTick(view, rig!.focusX, rig!.focusY, heroId),
        updateFrame: () => {},
        // Стоимость объявлена КОНСТАНТНОЙ (QUAL-3): подсистема ничего не
        // рисует — она переводит события и состояния тика в стек эффектов
        // камеры, а его стоимость задана числом одновременных эффектов из
        // таблиц манифеста (CAM-6), а не объёмом контента. Рычага здесь не
        // будет ни при каком пресете, и «метода нет» этого не сказало бы.
        quality: () => ({
          subsystem: 'camera-effects',
          knobs: [],
          constantCost:
            'перевод событий и состояний тика в стек эффектов камеры: работа на доставку, ' +
            'а не на инстанс; число эффектов задают таблицы манифеста (CAM-6)',
        }),
      });

      // HUD на пакете (задача 5.2, HUD-1..7): реестры и композиция — app/hud.ts.
      // Общие объекты сборки: тот же asset-сервис и манифест, что у рендера
      // (HUD-7), сам RemoteHost как источник сетки и обратный канал (SHELL-5,
      // SHELL-6), контракт камеры над конвейером позы (HUD-2). Фасад действий —
      // источник в ТОМ ЖЕ сэмплере, что клавиатура: мировое действие кнопки
      // уходит тем же каноническим вводом (HUD-2); подписка на доставку — тот же
      // register, что у подсистем рендера (HUD-1). apply — после handshake.
      const hud = createDemoHud({
        container: app,
        assets,
        visuals: manifest,
        terrain: remote!,
        camera: hudCamera,
        control: remote!,
        // Слой тумана миникарты (HUD-6): тот же продюсер маски и та же сила
        // затемнения, что у fog-mask основного вида, — сама подсистема тумана.
        ...(fogSubsystem !== null ? { fog: fogSubsystem } : {}),
      });
      sampler.add(hud.facade);
      remote!.register(hud.runtime.subsystem);
      // Состав HUD — от того, что даёт оболочка (design D5): пауза и перемотка
      // существуют только у локальной, и режим приезжает в handshake (SHELL-8),
      // а не выводится наблюдением за потоком доставок.
      hud.runtime.apply(
        demoHudComposition({
          controls: hello.mode === 'local',
          // Длительность тика — из того же handshake: по ней кулдаун переводит
          // доставленные тики в секунды (SHELL-5, HUD-8).
          tickMs: hello.tickSeconds * 1000,
        }),
      );
      hudRoot = hud.root;
      // Ульта кастуется удержанием клавиши, а не кликом (см. `hero.rewind` в
      // `hud.ts`): её кнопка в панели показывает кулдаун и помечена нерабочей —
      // живая на вид кнопка, ведущая в никуда, обещает игроку действие, которое
      // не произойдёт. Раскладка — та же, что у всего ввода (INP-4).
      markHoldOnlyAbilities(hud.root, bindings.keyboardMouse.keys);

      // Пресет качества (QUAL-1, design D4) — ПОСЛЕ регистрации всех
      // подсистем: реестр ручек собирается из их деклараций (design D1), и
      // проверять состав документа раньше было бы не по чему. Путь сборки один
      // на обе воркер-стороны оболочки (SHELL-8) — подсистемы регистрируются
      // здесь независимо от того, кто наполняет тик, — поэтому и переключатель
      // работает в любом режиме страницы, и второй проводки для него нет.
      qualitySelection.attach((preset) => createDemoQuality(remote!.stage, { preset }));
      // Действующий пресет может отличаться от выбранного: отвергнутый документ
      // уводит демо на запасной, и переключатель показывает то, что применено.
      if (qualitySelect !== null) qualitySelect.value = qualitySelection.pending;

      // Отладочная ручка ручного прогона (задача 5.3): read-only точка
      // наблюдения камеры — снаружи конвейера её иначе не видно, а проверке
      // «клик миникарты двигает камеру» нужно на что смотреть.
      (window as { demoCameraFocus?: () => { x: number; y: number } }).demoCameraFocus = () => ({
        x: rig?.focusX ?? 0,
        y: rig?.focusY ?? 0,
      });

      // Отладочный режим рендера (`render-debug` RDBG-1) — ПОСЛЕ регистрации
      // всех подсистем: реестр источников складывается из их объявлений при
      // регистрации (REND-27), ровно как реестр ручек качества. Слой — не
      // подсистема, в списке кадрового пути его нет, и счётчики стоимости
      // (PERF-3) от его подключения не двигаются ни на единицу (RDBG-8).
      wireDebugPanel(surface, ground.bounds);

      // Прогрев презентации (см. `prewarm.ts`): модели, батчи и эффекты частиц
      // строятся и компилируются во время загрузки, а не в кадре первого
      // появления вида — всплеск открытия обзора (FOW-8) монтирует прогретое.
      // Кадровый цикл прогрева не ждёт: не доехавшее монтируется прежним
      // ленивым путём (ASSET-4), а сорвавшийся прогрев — не отказ кадра.
      void prewarmPresentation({
        renderer: renderer3,
        scene: scene3,
        camera,
        models,
        particles,
        fog: fogSubsystem,
      }).catch((e: unknown) => {
        console.warn('демо: прогрев рендера не удался — монтаж останется ленивым', e);
      });

      requestAnimationFrame(frame);
    },
  }).connect(shellPort(worker));
}

void main().catch((e: unknown) => {
  console.error('демо: запуск не удался', e);
});
