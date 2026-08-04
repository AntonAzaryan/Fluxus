/**
 * Демо рендера (задача 5.1 add-render-assets-mvp): мини-симуляция ядра
 * (`demo/sim.ts`: `loadScene` + системы + физика) плюс `RenderHost` с
 * подсистемами террейна и моделей. Ядро о рендере не знает: хост подключён
 * обычным наблюдателем через `dispatch` (REND-1), объединяет их этот файл.
 *
 * Цикл: fixed timestep 60 тиков/с с аккумулятором; кадр отвязан от тика —
 * `RenderHost.frame(now)` интерполирует между двумя последними тиками (REND-2).
 * Обвязка камеры/света/ввода перенесена из `draft/ts-render` (demo.ts,
 * renderer.ts) — идеи UI, но симуляция целиком на `@game-mvp/core`.
 */
import * as THREE from 'three';
import { dispatch, fixed, tick, type InputFrame, type SceneDef } from '@game-mvp/core';
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
  RenderHost,
  TerrainSubsystem,
  kindByTags,
  type RenderContext,
} from '../src/index.js';
import {
  CAST_BUTTON,
  KILL_BUTTON,
  PLAYER_ID,
  TICK_SECONDS,
  createDemoSimulation,
  packAimDir,
} from './sim.js';
import sceneJson from './scene.json';

const TICK_MS = TICK_SECONDS * 1000;

/** Высота уровня террейна в мировых единицах — параметр рендера (REND-7). */
const HEIGHT_STEP = 0.6;

const CAMERA_DISTANCE = 16;
/** Наклон камеры от вертикали: ~40° — изометрия из референса draft/renderer.ts. */
const CAMERA_TILT = (40 * Math.PI) / 180;

// ------------------------------------------------------------------ симуляция

const { sim, state, playerId, grid } = createDemoSimulation(sceneJson as unknown as SceneDef);

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

// Свет: ambient + «солнце» (референс draft/renderer.ts). Позиция направленного
// света статична — арена 24×24 целиком в его охвате.
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

/** Источник байтов демо: дерево контента отдаёт vite из `demo/public/assets`. */
const assetSource: AssetSource = {
  async read(id: string): Promise<ArrayBuffer> {
    const response = await fetch(`/assets/${id}`);
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
    const handle = assets.request<VisualManifest>('manifest', 'manifest.json');
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

// ------------------------------------------------------------ рендер-хост

const context: RenderContext = { scene: scene3, assets, config: { heightStep: HEIGHT_STEP } };
const host = new RenderHost(context, {
  tickSeconds: TICK_SECONDS,
  // Ключи манифеста визуалов = теги prefab'ов сцены (ASSET-6). У Fireball
  // записи в манифесте нет НАМЕРЕННО: частицы отложены, снаряд — заглушка.
  kindOf: kindByTags(['Hero', 'Fireball']),
  terrainGrid: grid,
  aimEvents: ['CastFireball'],
});

/** Подсистема моделей: появляется после загрузки манифеста (см. main). */
let models: ModelsSubsystem | null = null;

// ---------------------------------------------------------------------- ввод

const keys = new Set<string>();
/** Отложенный на ближайший тик каст: упакованный aimDir (см. packAimDir). */
let pendingCast: number | null = null;
let pendingKill = false;
let inputSeq = 0;
let currentSkin: 'steel' | 'ember' = 'steel';

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

/**
 * Точка клика на плоскости пола под игроком: луч через камеру (референс
 * clientToGround из draft/renderer.ts). NDC — относительно rect канваса.
 */
function groundPoint(clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = renderer3.domElement.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  // Плоскость на высоте уровня игрока: клик по плато целится по плато.
  const level = host.view.entities.get(playerId)?.currLevel ?? 0;
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
  if (e.code === 'KeyS') {
    // S — смена скина (REND-6), поэтому «юг» в движении только на ArrowDown.
    currentSkin = currentSkin === 'steel' ? 'ember' : 'steel';
    models?.setSkin(playerId, currentSkin);
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

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const point = groundPoint(e.clientX, e.clientY);
  if (point === null) return;
  const view = host.view.entities.get(playerId);
  if (view === undefined) return;
  const dx = point.x - view.currX;
  const dy = point.y - view.currY;
  const length = Math.hypot(dx, dy);
  if (length < 1e-3) return;
  pendingCast = packAimDir(dx / length, dy / length);
});

/** Канонический ввод тика (TICK-2): состояние клавиш сэмплится каждый тик. */
function inputFrameFor(tickNumber: number): InputFrame {
  let moveX = 0;
  let moveY = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) moveY += 1;
  if (keys.has('ArrowDown')) moveY -= 1;
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

  inputSeq += 1;
  return {
    tick: tickNumber,
    playerId: PLAYER_ID,
    seq: inputSeq,
    move: { x: fixed.fromFloat(nx), y: fixed.fromFloat(ny) },
    aimDir,
    buttons,
  };
}

// ------------------------------------------------------------- HUD и цикл

function updateHud(): void {
  if (hudStatus === null) return;
  const alive = host.view.entities.has(playerId);
  const controller = models?.instanceFor(playerId)?.controller ?? null;
  const status = controller?.isDead === true ? 'мёртв (перезапуск — F5)' : alive ? 'жив' : '—';
  hudStatus.textContent =
    `тик ${state.tick} | сущностей ${host.view.entities.size} | ` +
    `скин ${currentSkin} | герой: ${status}`;
}

let accumulator = 0;
let lastFrameAt: number | null = null;
let hudCountdown = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = lastFrameAt === null ? 0 : Math.min(now - lastFrameAt, 250);
  lastFrameAt = now;

  // Fixed timestep 60 тиков/с: аккумулятор наверстывает целыми тиками, кадр
  // рисуется интерполяцией между двумя последними (REND-2).
  accumulator += dt;
  while (accumulator >= TICK_MS) {
    accumulator -= TICK_MS;
    const result = tick(sim, state, [inputFrameFor(state.tick + 1)]);
    dispatch(result, [host]);
  }

  host.frame(now);

  // Камера следит за игроком: цель — интерполированная позиция инстанса,
  // сглаживание экспоненциальное, не зависит от FPS (референс draft).
  const instance = models?.instanceFor(playerId) ?? null;
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

  // Порядок подсистем нормативен (REND-8): сначала террейн, затем модели.
  host.register(new TerrainSubsystem(grid));
  models = new ModelsSubsystem(manifest);
  host.register(models);

  requestAnimationFrame(frame);
}

void main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  if (hudStatus !== null) hudStatus.textContent = `ошибка запуска: ${message}`;
  console.error('демо: запуск не удался', e);
});
