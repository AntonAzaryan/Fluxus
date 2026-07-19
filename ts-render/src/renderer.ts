/**
 * Core renderer: scene, camera, lights, render loop
 */

import * as THREE from 'three';
import { GameState, Entity } from './types';
import { EntityMeshFactory, EntityMeshes } from './entities';
import type { model } from 'war3-model';

// Re-export GameState for consumers
export type { GameState };

/**
 * Renderer configuration
 */
export interface RendererConfig {
  width: number;
  height: number;
  cameraZ: number;
  cameraAngle: number; // radians from vertical
}

const defaultConfig: RendererConfig = {
  width: 1280,
  height: 720,
  cameraZ: 30,
  cameraAngle: Math.PI / 6, // 30 degrees
};

// Разворот MDX-модели: угол считаем как atan2(dy, dx). У этой модели локальный
// «перёд» направлен вдоль +X, поэтому смещение не нужно (rotation.z = angle).
const MDX_FACING_OFFSET = 0;
// Порог скорости, ниже которого считаем сущность стоящей (idle).
const MOVE_EPS = 0.02;
// Скорость доворота модели к целевому направлению (1/сек, экспоненц. сглаживание).
// Чем больше — тем резче разворот; ~12 даёт заметный, но плавный поворот.
const TURN_RATE = 12;

/**
 * Main renderer class
 */
export class GameRenderer {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private entityMeshes: Map<bigint, EntityMeshes>;
  private entityFactory: EntityMeshFactory;
  private animationId: number | null = null;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private clock = new THREE.Clock();
  // Смещение камеры относительно цели слежения (чтобы игрок не улетал за кадр)
  private cameraOffset = new THREE.Vector3();
  private followTargetId: bigint | null = null;

  constructor(container: HTMLElement, config: Partial<RendererConfig> = {}) {
    const cfg = { ...defaultConfig, ...config };

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    // Camera (isometric-like perspective)
    this.camera = new THREE.PerspectiveCamera(
      45,
      cfg.width / cfg.height,
      0.1,
      1000
    );
    this.cameraOffset.set(
      0,
      -cfg.cameraZ * Math.sin(cfg.cameraAngle),
      cfg.cameraZ * Math.cos(cfg.cameraAngle)
    );
    this.camera.position.copy(this.cameraOffset);
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(cfg.width, cfg.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    // Lights
    this.setupLights();

    // Grid helper — по умолчанию GridHelper лежит в плоскости XZ (Y-up),
    // но игровая плоскость земли — XY (Z — высота, conventions.md §10),
    // поэтому поворачиваем сетку в плоскость XY.
    const gridHelper = new THREE.GridHelper(2000, 200, 0x444444, 0x222222);
    gridHelper.rotation.x = Math.PI / 2;
    this.scene.add(gridHelper);

    // Entity meshes factory
    this.entityFactory = new EntityMeshFactory(this.scene);
    this.entityMeshes = new Map();
  }

  private setupLights(): void {
    // Ambient light
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(ambient);

    // Directional light (sun-like)
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(10, 10, 10);
    this.scene.add(directional);

    // Point light for atmosphere
    const point = new THREE.PointLight(0x4444ff, 0.5, 50);
    point.position.set(0, 0, 5);
    this.scene.add(point);
  }

  /**
   * Set player MDX model prototype
   */
  setPlayerModel(m: model.Model): void {
    this.entityFactory.setPlayerModel(m);
  }

  /**
   * Update game state - sync entities with scene
   */
  updateState(state: GameState): void {
    const currentIds = new Set<bigint>();

    // Update or create entity meshes
    for (const entity of state.entities) {
      currentIds.add(entity.id);

      if (!this.entityMeshes.has(entity.id)) {
        // Create new entity mesh
        const meshes = this.entityFactory.create(entity);
        if (meshes) {
          this.entityMeshes.set(entity.id, meshes);
        }
      }

      // Update position
      const meshes = this.entityMeshes.get(entity.id);
      if (meshes && entity.Position) {
        const x = Number(entity.Position.x) / 65536;
        const y = Number(entity.Position.y) / 65536;
        const z = Number(entity.Position.z) / 65536;
        meshes.mesh.position.set(x, y, z);

        // Update health bar if exists
        if (entity.Health && meshes.healthBar) {
          meshes.healthBar.position.set(x, y, z + 0.1);
          const healthPct = Number(entity.Health.current) / Number(entity.Health.max);
          meshes.healthBar.scale.x = healthPct;
        }
      }

      // MDX-модель: поворот «лицом» по вектору движения + смена idle/walk
      if (meshes?.mdx) {
        this.updateMdxAnimation(entity, meshes);
      }
    }

    // Remove dead entities
    for (const [id, meshes] of this.entityMeshes.entries()) {
      if (!currentIds.has(id)) {
        this.entityFactory.dispose(meshes);
        this.entityMeshes.delete(id);
      }
    }

    // Камера следует за целью (игроком). Без этого при скорости движения,
    // большой относительно видимой зоны, игрок мгновенно уезжает за кадр и
    // кажется, что «улетает бесконечно».
    if (this.followTargetId !== null) {
      const target = state.entities.find((e) => e.id === this.followTargetId);
      if (target?.Position) {
        const tx = Number(target.Position.x) / 65536;
        const ty = Number(target.Position.y) / 65536;
        const tz = Number(target.Position.z) / 65536;
        this.camera.position.set(
          tx + this.cameraOffset.x,
          ty + this.cameraOffset.y,
          tz + this.cameraOffset.z
        );
        this.camera.lookAt(tx, ty, tz);
      }
    }
  }

  /**
   * Обновить анимацию и разворот MDX-модели по состоянию сущности.
   * Направление берём из рывка (чистое dir_*), иначе из скорости; поворачиваем
   * модель вокруг вертикальной оси Z. Клип меняем только при смене состояния,
   * чтобы не рестартить его каждый кадр.
   */
  private updateMdxAnimation(entity: Entity, meshes: EntityMeshes): void {
    let dx = 0;
    let dy = 0;
    if (entity.Dash) {
      dx = Number(entity.Dash.dir_x) / 65536;
      dy = Number(entity.Dash.dir_y) / 65536;
    } else if (entity.Velocity) {
      dx = Number(entity.Velocity.dx) / 65536;
      dy = Number(entity.Velocity.dy) / 65536;
    }
    const speed = Math.hypot(dx, dy);

    if (speed > MOVE_EPS) {
      // Задаём только ЦЕЛЬ разворота; фактический угол доворачивается плавно
      // в render-loop по dt (иначе поворот скачком при смене направления).
      meshes.targetRotZ = Math.atan2(dy, dx) + MDX_FACING_OFFSET;
    }

    const desired = entity.Dash || speed > MOVE_EPS ? 'Walk' : 'Stand';
    if (meshes.currentAnim !== desired && meshes.mdx) {
      meshes.mdx.play(desired);
      meshes.currentAnim = desired;
    }
  }

  /**
   * Плавно доворачивает модель к целевому направлению (targetRotZ) за кадр.
   * Экспоненциальное сглаживание по кратчайшей дуге — не зависит от FPS и не
   * «перескакивает» через ±π.
   */
  private smoothFacing(meshes: EntityMeshes, dt: number): void {
    if (meshes.targetRotZ == null) return;
    const cur = meshes.mesh.rotation.z;
    // разница, приведённая к диапазону (-π, π] — поворачиваем по кратчайшей дуге
    let diff = meshes.targetRotZ - cur;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const t = 1 - Math.exp(-TURN_RATE * dt);
    meshes.mesh.rotation.z = cur + diff * t;
  }

  /**
   * Назначить сущность, за которой следует камера (обычно игрок).
   */
  setFollowTarget(id: bigint | null): void {
    this.followTargetId = id;
  }

  /**
   * Start render loop
   */
  start(): void {
    if (this.animationId !== null) return;

    const animate = () => {
      this.animationId = requestAnimationFrame(animate);
      const dt = this.clock.getDelta();
      for (const meshes of this.entityMeshes.values()) {
        if (meshes.mixer) meshes.mixer.update(dt);
        this.smoothFacing(meshes, dt);
      }
      this.renderer.render(this.scene, this.camera);
    };

    animate();
  }

  /**
   * Stop render loop
   */
  stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * Cleanup
   */
  dispose(): void {
    this.stop();
    for (const meshes of this.entityMeshes.values()) {
      this.entityFactory.dispose(meshes);
    }
    this.entityMeshes.clear();
    this.renderer.dispose();
  }

  /**
   * Преобразовать экранные координаты (NDC, -1..1) в мировые координаты на плоскости земли (z=0),
   * бросая луч через реальную (перспективную, наклонённую) камеру — вместо линейного приближения.
   */
  screenToGround(ndc: THREE.Vector2): { x: number; y: number } | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const point = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, point);
    if (!hit) return null;
    return { x: point.x, y: point.y };
  }

  /**
   * Мировая точка на земле под курсором мыши. NDC вычисляются относительно
   * bounding rect самого канваса, а НЕ window: канвас может не совпадать с
   * окном (фиксированный размер / отступы), иначе прицел «мажет».
   */
  clientToGround(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    return this.screenToGround(ndc);
  }

  /**
   * Resize renderer
   */
  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
}

/**
 * Create renderer instance
 */
export function createRenderer(
  container: HTMLElement,
  config?: Partial<RendererConfig>
): GameRenderer {
  return new GameRenderer(container, config);
}
