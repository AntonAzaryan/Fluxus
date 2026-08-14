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
import type { EntityId } from '@game-mvp/core';
import {
  AssetService,
  createManifestLoader,
  curvatureLoader,
  gltfLoader,
  mdxLoader,
  particleEffectLoader,
  pngTextureLoader,
  type AssetSource,
  type AssetState,
  type VisualManifest,
} from '@game-mvp/assets';
import {
  CAMERA_CONFIG_DESCRIPTION,
  CAMERA_EFFECTS_DESCRIPTION,
  CameraEffectsDirector,
  CameraRig,
  EffectsSubsystem,
  ModelsSubsystem,
  ParticlesSubsystem,
  TerrainSubsystem,
  VisualSurfaceSource,
  applyCameraPose,
  cameraConfigFromManifest,
  createCameraInput,
  edgePanAxes,
  resetCameraInput,
  terrainGroundApi,
  type CameraBounds,
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
  validateBindings,
} from '@game-mvp/client';
import { ACTION_BITS, STATE_COMPONENTS } from './sim.js';
import { createDemoHud, demoHudComposition } from './hud.js';
import { DEMO_SERVER_URL, demoMode, localModeUrl, serverModeUrl, type DemoMode } from './mode.js';
import { isDemoNotice, isDemoServerReady, type DemoClientInit, type DemoServerInit } from './wiring.js';
import bindingsJson from './bindings.json';

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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- baseline
    if (settled) unsubscribe();
  });
}

// ---------------------------------------------------------------------- ввод

/** Клавиши камеры (CAM-1..3); ввод героя живёт в источниках сэмплера ниже. */
const keys = new Set<string>();
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
  if (e.code === 'KeyF') camInput.flyToggle = true;
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
 * Прицел клика: точка на полу через raycast (design Decision 6) минус позиция
 * героя — угол в единице ядра (FP-7); JSON-система сцены разворачивает его
 * обратно в вектор оператором `cos`/`sin`. Null — направления нет, каст
 * не возникает.
 */
function aimAtPointer(clientX: number, clientY: number): number | null {
  const point = groundPoint(clientX, clientY);
  if (point === null || heroId === null) return null;
  const view = remote?.view?.entities.get(heroId);
  if (view === undefined) return null;
  const dx = point.x - view.currX;
  const dy = point.y - view.currY;
  return Math.hypot(dx, dy) < 1e-3 ? null : aimAngle(dx, dy); // клик в себя — направления нет
}

const kbmSource = new KeyboardMouseSource({
  bindings: bindings.keyboardMouse,
  // Fly владеет клавиатурой — герой стоит (CAM-1, CAM-2).
  movementCaptured: () => rig?.capturesMovement() ?? false,
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
  if (e.button === 2) rightDrag = true;
  // ЛКМ (каст) обрабатывает KeyboardMouseSource.bind выше.
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
  const margin = rig?.config.edgeMarginPx ?? 0;
  const edge = pointerOverHud ? { x: 0, y: 0 } : edgePanAxes(pointerX, pointerY, rect, margin);
  camInput.edgeX = edge.x;
  camInput.edgeY = edge.y;
  camInput.centerHeld = keys.has('KeyC');
  const fly = rig?.capturesMovement() ?? false;
  camInput.moveX = fly ? (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) : 0;
  camInput.moveY = fly ? (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) : 0;
  camInput.moveZ = fly ? (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0) : 0;
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
  remote.sendInput(input.move, input.aimDir, input.buttons);
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

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = lastFrameAt === null ? 0 : Math.min(now - lastFrameAt, 250);
  lastFrameAt = now;

  // Тиков здесь нет (SHELL-1): симуляция идёт в воркере своим тикером,
  // кадр только шлёт ввод и интерполирует доставленное (REND-2).
  // Отложенное кадрирование миникарты — когда камера уже не follow (см. panTo).
  if (pendingPan !== null && rig !== null && rig.mode !== 'follow') {
    rig.frameBounds({ rect: panFramingRect(rig.config, pendingPan.x, pendingPan.y), aspect: camera.aspect });
    pendingPan = null;
  }
  sampleCameraInput();
  pushInput();
  if (touchSource !== null) touchOverlay?.(touchSource.overlay());

  // Конвейер камеры (CAM-1): follow-цель — интерполированная горизонталь
  // инстанса (x/y; высоту rig берёт с поверхности, CAM-2), поза → эффекты →
  // применение к THREE-камере.
  //
  // ДО кадра подсистем, а не после: отсечение и выбор уровня детализации идут
  // по матрицам камеры (REND-21, REND-22), и камера, посаженная после кадра,
  // отсекала бы по пирамиде ПРОШЛОГО кадра — быстрым разворотом инстансы
  // вырезались бы у края экрана. Цель слежения при этом на кадр старше, но
  // конвейер камеры её и так сглаживает — тот же порядок у сцены редактора.
  if (rig !== null) {
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
    const dtSec = dt / 1000;
    const logical = rig.update(camInput, dtSec, target);
    resetCameraInput(camInput);
    applyCameraPose(camera, director === null ? logical : director.stack.apply(logical, dtSec));
  }

  remote?.frame(now);
  renderer3.render(scene3, camera);
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

/** Сообщение человеку поверх вьюпорта: матч занят, сервер не отвечает и т. п. */
function showNotice(message: string): void {
  const notice = document.getElementById('notice');
  if (notice === null) return;
  notice.textContent = message;
  notice.style.display = 'block';
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
  // Адрес — константа сборки (D4). Страница едет по http с dev-сервера, поэтому
  // ws:// из неё разрешён; со страницы по https браузер такое соединение
  // заблокирует (mixed content) — стенд для LAN, а не для интернета.
  button.title = `подключиться к стенду ${DEMO_SERVER_URL}`;
  button.href = serverModeUrl(window.location.href);
}

async function main(): Promise<void> {
  // Режим выбирается ОДИН раз, до создания воркеров: переключение режима — это
  // перезагрузка страницы с другим параметром (SHELL-8).
  const mode = demoMode(window.location.search);
  // Кнопка режима — ДО загрузки манифеста: она и есть дорога со сломанной
  // страницы. Упади манифест (нет ассета, нет сети) — переключиться было бы
  // нечем, а это единственный орган управления, которому матч не нужен вовсе.
  wireConnectButton(mode);
  const manifest = await loadManifest();
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
      // Порядок подсистем нормативен (REND-8): сначала террейн, затем модели.
      remote!.register(new TerrainSubsystem(grid, { surface }));
      // Перёд модели больше не параметр сборки: он описан в записи манифеста
      // (ASSET-6 `facingDeg`, REND-13), поэтому модели разных форматов с разным
      // передом уживаются в одной сцене без общего для всех значения.
      // Камера подсистеме — вход отсечения невидимых инстансов (REND-21): та же
      // самая, которой рисуется кадр. Её поза здесь на один кадр старше кадра
      // подсистем (цель слежения берётся из уже посаженной позы инстанса), и
      // запас консервативности границ покрывает это наравне с размахом клипов.
      models = new ModelsSubsystem(manifest, { surface, camera });
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
      remote!.register(
        new ParticlesSubsystem(manifest, {
          surface,
          stateComponents: STATE_COMPONENTS,
          sockets: models,
        }),
      );

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
      });

      // HUD на пакете (задача 5.2, HUD-1..7): реестры и композиция — demo/hud.ts.
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

      // Отладочная ручка ручного прогона (задача 5.3): read-only точка
      // наблюдения камеры — снаружи конвейера её иначе не видно, а проверке
      // «клик миникарты двигает камеру» нужно на что смотреть.
      (window as { demoCameraFocus?: () => { x: number; y: number } }).demoCameraFocus = () => ({
        x: rig?.focusX ?? 0,
        y: rig?.focusY ?? 0,
      });

      requestAnimationFrame(frame);
    },
  }).connect(shellPort(worker));
}

void main().catch((e: unknown) => {
  console.error('демо: запуск не удался', e);
});
