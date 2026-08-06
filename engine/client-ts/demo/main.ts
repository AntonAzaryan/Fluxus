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
  manifestLoader,
  mdxLoader,
  pngTextureLoader,
  type AssetSource,
  type AssetState,
  type VisualManifest,
} from '@game-mvp/assets';
import {
  ModelsSubsystem,
  TerrainSubsystem,
  type RenderContext,
} from '@game-mvp/render';
import { RemoteHost, shellPort } from '@game-mvp/client';
import { CAST_BUTTON, KILL_BUTTON, TURN_UNITS } from './sim.js';

/** Высота уровня террейна в мировых единицах — параметр рендера (REND-7). */
const HEIGHT_STEP = 0.6;

const CAMERA_DISTANCE = 16;
/** Наклон камеры от вертикали: ~40° — изометрия из удалённого прототипа ts-render. */
const CAMERA_TILT = (40 * Math.PI) / 180;

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
const cameraOffset = new THREE.Vector3(
  0,
  -CAMERA_DISTANCE * Math.sin(CAMERA_TILT),
  CAMERA_DISTANCE * Math.cos(CAMERA_TILT),
);
/** Точка, за которой следит камера; сглаживается к игроку по кадрам. */
const cameraTarget = new THREE.Vector3(11.5, 11.5, 0);

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
 * Точка клика на плоскости пола под игроком: луч через камеру. NDC —
 * относительно rect канваса; плоскость на высоте уровня героя.
 */
function groundPoint(clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = renderer3.domElement.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const level = heroId === null ? 0 : (remote?.view?.entities.get(heroId)?.currLevel ?? 0);
  groundPlane.constant = -level * HEIGHT_STEP;
  const point = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, point) === null
    ? null
    : { x: point.x, y: point.y };
}

window.addEventListener('keydown', (e) => {
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
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

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

/**
 * Сырой ввод в воркер (SHELL-6): состояние клавиш сэмплится каждый кадр,
 * фронты кнопок латчатся воркером до ближайшего тика — нажатие между тиками
 * не теряется. `tick`/`seq` канонического InputFrame ставит воркер.
 */
function pushInput(): void {
  if (remote === null) return;
  let moveX = 0;
  let moveY = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) moveY += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) moveY -= 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) moveX -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) moveX += 1;
  const length = Math.hypot(moveX, moveY);
  const nx = length > 0 ? moveX / length : 0;
  const ny = length > 0 ? moveY / length : 0;

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

  remote.sendInput({ x: fixed.fromFloat(nx), y: fixed.fromFloat(ny) }, aimDir, buttons);
}

// ------------------------------------------------------------- HUD и цикл

function updateHud(): void {
  if (hudStatus === null) return;
  const view = remote?.view ?? null;
  const alive = heroId !== null && view !== null && view.entities.has(heroId);
  const controller = heroId === null ? null : (models?.instanceFor(heroId)?.controller ?? null);
  const status = controller?.isDead === true ? 'мёртв (перезапуск — F5)' : alive ? 'жив' : '—';
  hudStatus.textContent =
    `тик ${view?.tick ?? 0} | сущностей ${view?.entities.size ?? 0} | ` +
    `скин ${currentSkin} | герой: ${status}`;
}

let hudCountdown = 0;
let lastFrameAt: number | null = null;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = lastFrameAt === null ? 0 : Math.min(now - lastFrameAt, 250);
  lastFrameAt = now;

  // Тиков здесь нет (SHELL-1): симуляция идёт в воркере своим тикером,
  // кадр только шлёт ввод и интерполирует доставленное (REND-2).
  pushInput();
  remote?.frame(now);

  // Камера следит за игроком: цель — интерполированная позиция инстанса.
  const instance = heroId === null ? null : (models?.instanceFor(heroId) ?? null);
  if (instance !== null) {
    cameraTarget.lerp(instance.holder.position, 1 - Math.exp(-6 * (dt / 1000)));
  }
  camera.position.copy(cameraTarget).add(cameraOffset);
  camera.lookAt(cameraTarget);

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
      // Порядок подсистем нормативен (REND-8): сначала террейн, затем модели.
      remote!.register(new TerrainSubsystem(grid));
      models = new ModelsSubsystem(manifest);
      remote!.register(models);
      requestAnimationFrame(frame);
    },
  }).connect(shellPort(worker));
}

void main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  if (hudStatus !== null) hudStatus.textContent = `ошибка запуска: ${message}`;
  console.error('демо: запуск не удался', e);
});
