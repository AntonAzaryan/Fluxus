/**
 * Демо воркер-сборки (client-shell SHELL-1..7): симуляция в dedicated Worker
 * (`worker.ts`), здесь — только THREE, ввод и UI. Presentation-состояние
 * приезжает конвертами тиков через `RemoteHost`; подсистемы террейна и
 * моделей — те же, что в однопоточной сборке (SHELL-2), обратный канал —
 * `sendInput`/`control` (SHELL-6).
 *
 * Кадр отвязан от тика (REND-2): `remote.frame(now)` интерполирует между
 * двумя последними доставленными тиками по часам этого потока (SHELL-7).
 */
import * as THREE from 'three';
import { fixed, type EntityId } from '@game-mvp/core';
import {
  AssetService,
  curvatureLoader,
  manifestLoader,
  mdxLoader,
  pngTextureLoader,
  type AssetSource,
  type AssetState,
  type VisualManifest,
} from '@game-mvp/assets';
import {
  CameraEffectsDirector,
  CameraRig,
  ModelsSubsystem,
  TerrainSubsystem,
  VisualSurfaceSource,
  applyCameraPose,
  createCameraInput,
  edgePanAxes,
  heroMoveFromKeys,
  resetCameraInput,
  terrainGroundApi,
  type RenderContext,
} from '@game-mvp/render';
import { RemoteHost, shellPort } from '@game-mvp/client';
import { CAST_BUTTON, KILL_BUTTON, TURN_UNITS } from './sim.js';

/** Высота уровня террейна в мировых единицах — параметр рендера (REND-7). */
const HEIGHT_STEP = 0.6;

// ------------------------------------------------------------------ three.js

const app = document.getElementById('app');
const hudStatus = document.getElementById('hud-status');
if (app === null) throw new Error('демо: в index.html нет контейнера #app');

const renderer3 = new THREE.WebGLRenderer({ antialias: true });
renderer3.setSize(window.innerWidth, window.innerHeight);
renderer3.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
scene3.add(new THREE.AmbientLight(0xffffff, 0.65));
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
sun.position.set(8, -12, 18);
scene3.add(sun);

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
assets.registerLoader(pngTextureLoader);
assets.registerLoader(manifestLoader);
assets.registerLoader(curvatureLoader);

/** Манифест визуалов через тот же сервис (kind 'manifest', ASSET-6). */
function loadManifest(): Promise<VisualManifest> {
  return new Promise((resolve, reject) => {
    const handle = assets.request<VisualManifest>('manifest', 'visuals/manifest.json');
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const onState = (s: AssetState<VisualManifest>): void => {
      if (settled || s.status === 'loading') return;
      settled = true;
      if (s.status === 'ready') resolve(s.data);
      else reject(new Error(s.reason));
      unsubscribe?.();
    };
    unsubscribe = assets.subscribe(handle, onState);
    if (settled) unsubscribe();
  });
}

// ---------------------------------------------------------------------- ввод

const keys = new Set<string>();
/** Отложенный на ближайший тик каст: угол прицеливания (см. aimAngle). */
let pendingCast: number | null = null;
let pendingKill = false;
let currentSkin: 'steel' | 'ember' = 'steel';

/** Последняя позиция указателя — edge-pan считается по кадрам (CAM-3). */
let pointerX = -1;
let pointerY = -1;
/** Зажатые кнопки мыши: 1 — drag-панорама (MMB), 2 — осмотр в fly (RMB). */
let midDrag = false;
let rightDrag = false;

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

// --------------------------------------------------------- воркер и рендер

/** Подсистема моделей: появляется после загрузки манифеста (см. main). */
let models: ModelsSubsystem | null = null;
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
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  groundPlane.constant = -(rig?.groundZ ?? 0);
  const point = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, point) === null
    ? null
    : { x: point.x, y: point.y };
}

/** Клавиши камеры (CAM-1): их фронты не доходят до `pushInput`. */
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
    updateHud();
    return;
  }
  if (e.code === 'KeyK') {
    pendingKill = true;
    return;
  }
  if (e.code === 'Space') camInput.centerTap = true;
  if (e.code === 'KeyY') camInput.followToggle = true;
  if (e.code === 'KeyF') camInput.flyToggle = true;
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

window.addEventListener('mousemove', (e) => {
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
});

/**
 * Направление клика → `aimDir` канонического `InputFrame` (TICK-2): угол в
 * единице ядра (FP-7, полный оборот `TURN_UNITS`). Float здесь законен ровно
 * там же, где `fixed.fromFloat` для `move`, — это оболочка, производящая ввод,
 * а не тик; в симуляцию уходит целое, и разворачивает его обратно в вектор
 * JSON-система сцены оператором `cos`/`sin`. Маска — чтобы по проводу не
 * ездили старшие биты: заворачивание угла ядро делает само.
 */
function aimAngle(dx: number, dy: number): number {
  return Math.round((Math.atan2(dy, dx) / (2 * Math.PI)) * TURN_UNITS) & (TURN_UNITS - 1);
}

window.addEventListener('mousedown', (e) => {
  if (e.button === 1) {
    // MMB — drag-панорама (CAM-3); default — autoscroll браузера.
    e.preventDefault();
    midDrag = true;
    return;
  }
  if (e.button === 2) {
    rightDrag = true;
    return;
  }
  if (e.button !== 0) return;
  const point = groundPoint(e.clientX, e.clientY);
  if (point === null || heroId === null) return;
  const view = remote?.view?.entities.get(heroId);
  if (view === undefined) return;
  const dx = point.x - view.currX;
  const dy = point.y - view.currY;
  if (Math.hypot(dx, dy) < 1e-3) return; // клик в себя — направления нет
  pendingCast = aimAngle(dx, dy);
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 1) midDrag = false;
  if (e.button === 2) rightDrag = false;
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
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
  const margin = rig?.config.edgeMarginPx ?? 0;
  const edge = edgePanAxes(pointerX, pointerY, rect, margin);
  camInput.edgeX = edge.x;
  camInput.edgeY = edge.y;
  camInput.centerHeld = keys.has('Space');
  const fly = rig?.capturesMovement() ?? false;
  camInput.moveX = fly ? (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) : 0;
  camInput.moveY = fly ? (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) : 0;
  camInput.moveZ = fly ? (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0) : 0;
}

/**
 * Сырой ввод в воркер (SHELL-6): состояние клавиш сэмплится каждый кадр,
 * фронты кнопок латчатся воркером до ближайшего тика — нажатие между тиками
 * не теряется. `tick`/`seq` канонического InputFrame ставит воркер.
 * Движение героя — WASD без стрелок; в fly-режиме камера владеет
 * клавиатурой и герой стоит (CAM-1, CAM-2).
 */
function pushInput(): void {
  if (remote === null) return;
  const move = heroMoveFromKeys(keys, rig?.capturesMovement() ?? false);

  let buttons = 0;
  let aimDir = 0;
  if (pendingCast !== null) {
    buttons |= CAST_BUTTON;
    aimDir = pendingCast;
    pendingCast = null;
  }
  if (pendingKill) {
    buttons |= KILL_BUTTON;
    pendingKill = false;
  }

  remote.sendInput({ x: fixed.fromFloat(move.x), y: fixed.fromFloat(move.y) }, aimDir, buttons);
}

// ------------------------------------------------------------- HUD и цикл

function updateHud(): void {
  if (hudStatus === null) return;
  const view = remote?.view ?? null;
  const alive = heroId !== null && view !== null && view.entities.has(heroId);
  const controller = heroId === null ? null : (models?.instanceFor(heroId)?.controller ?? null);
  const status = controller?.isDead === true ? 'мёртв (перезапуск — F5)' : alive ? 'жив' : '—';
  const modeName = { follow: 'follow', free: 'free', fly: 'fly' }[rig?.mode ?? 'follow'];
  hudStatus.textContent =
    `тик ${view?.tick ?? 0} | сущностей ${view?.entities.size ?? 0} | ` +
    `скин ${currentSkin} | герой: ${status} | камера: ${modeName} ` +
    `(стрелки/край/MMB — панорама, колесо — зум, Space — к герою, Y — follow, F — полёт)`;
}

let hudCountdown = 0;
let lastFrameAt: number | null = null;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = lastFrameAt === null ? 0 : Math.min(now - lastFrameAt, 250);
  lastFrameAt = now;

  // Тиков здесь нет (SHELL-1): симуляция идёт в воркере своим тикером,
  // кадр только шлёт ввод и интерполирует доставленное (REND-2).
  sampleCameraInput();
  pushInput();
  remote?.frame(now);

  // Конвейер камеры (CAM-1): follow-цель — интерполированная горизонталь
  // инстанса (x/y; высоту rig берёт с поверхности, CAM-2), поза → эффекты →
  // применение к THREE-камере.
  if (rig !== null) {
    const instance = heroId === null ? null : (models?.instanceFor(heroId) ?? null);
    const heroView = heroId === null ? undefined : remote?.view?.entities.get(heroId);
    const target =
      instance === null
        ? null
        : {
            x: instance.holder.position.x,
            y: instance.holder.position.y,
            snap: (heroView?.snap ?? false) || (remote?.view?.snapAll ?? false),
          };
    const dtSec = dt / 1000;
    const logical = rig.update(camInput, dtSec, target);
    resetCameraInput(camInput);
    applyCameraPose(camera, director === null ? logical : director.stack.apply(logical, dtSec));
  }

  renderer3.render(scene3, camera);

  hudCountdown -= dt;
  if (hudCountdown <= 0) {
    hudCountdown = 250;
    updateHud();
  }
}

// -------------------------------------------------------------------- запуск

async function main(): Promise<void> {
  if (hudStatus !== null) hudStatus.textContent = 'загрузка манифеста визуалов…';
  const manifest = await loadManifest();

  if (hudStatus !== null) hudStatus.textContent = 'запуск воркера симуляции…';
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

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
      // Порядок подсистем нормативен (REND-8): сначала террейн, затем модели.
      remote!.register(new TerrainSubsystem(grid, { surface }));
      models = new ModelsSubsystem(manifest, { surface });
      remote!.register(models);

      // Камера: поверхность и границы — из той же сетки, что рендер террейна
      // (CAM-2, CAM-3); эффекты — по таблицам манифеста (ASSET-7, CAM-6).
      const ground = terrainGroundApi(grid, HEIGHT_STEP);
      rig = new CameraRig({
        groundHeightAt: ground.groundHeightAt,
        bounds: ground.bounds,
        startX: 11.5,
        startY: 11.5,
      });
      director = new CameraEffectsDirector({ tables: manifest.cameraEffects });
      // Мини-подсистема: события/состояния тика → диспетчер эффектов. syncTick
      // приходит на каждую доставку — события reliable (SHELL-4) не теряются.
      remote!.register({
        name: 'camera-effects',
        init: () => {},
        syncTick: (view) => director?.onTick(view, rig!.focusX, rig!.focusY, heroId),
        updateFrame: () => {},
      });
      requestAnimationFrame(frame);
    },
  }).connect(shellPort(worker));
}

void main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  if (hudStatus !== null) hudStatus.textContent = `ошибка запуска: ${message}`;
  console.error('демо: запуск не удался', e);
});
