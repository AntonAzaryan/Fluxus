/**
 * Core renderer: scene, camera, lights, render loop
 */

import * as THREE from 'three';
import { GameState, Entity } from './types';
import { EntityMeshFactory, EntityMeshes } from './entities';

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
    this.camera.position.set(
      0,
      -cfg.cameraZ * Math.sin(cfg.cameraAngle),
      cfg.cameraZ * Math.cos(cfg.cameraAngle)
    );
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
    const gridHelper = new THREE.GridHelper(100, 50, 0x444444, 0x222222);
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
    }

    // Remove dead entities
    for (const [id, meshes] of this.entityMeshes.entries()) {
      if (!currentIds.has(id)) {
        this.entityFactory.dispose(meshes);
        this.entityMeshes.delete(id);
      }
    }
  }

  /**
   * Start render loop
   */
  start(): void {
    if (this.animationId !== null) return;

    const animate = () => {
      this.animationId = requestAnimationFrame(animate);
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
