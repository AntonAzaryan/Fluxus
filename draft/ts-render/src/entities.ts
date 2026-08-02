/**
 * Entity mesh factory: creates Three.js objects for game entities
 */

import * as THREE from 'three';
import { Entity } from './types';
import type { MdxInstance } from './mdxModel';
import { buildMdxInstance } from './mdxModel';
import type { model } from 'war3-model';

/**
 * Entity mesh collection
 */
export interface EntityMeshes {
  mesh: THREE.Object3D;
  healthBar?: THREE.Mesh;
  trail?: THREE.Line;
  mixer?: THREE.AnimationMixer;
  mdx?: MdxInstance;      // инстанс WC3-модели (для смены анимаций)
  currentAnim?: string;   // текущая локомоция (Stand/Walk), чтобы не рестартить каждый кадр
  targetRotZ?: number;    // целевой угол разворота по Z; докручиваем плавно в render-loop
  attackTimer?: number;   // сек до конца одноразовой анимации атаки (>0 — атака блокирует локомоцию)
  attackAlt?: boolean;    // чередование Attack - 1 / Attack - 2 между выстрелами
  torso?: THREE.Bone;     // кость груди — доворачивается к курсору поверх анимации
  torsoYaw?: number;      // текущий доворот груди относительно facing модели, рад
}

/**
 * Materials (reused for performance)
 */
const materials = {
  player: new THREE.MeshStandardMaterial({ color: 0x00ff88 }),
  fireball: new THREE.MeshStandardMaterial({ 
    color: 0xff4400,
    emissive: 0xff2200,
    emissiveIntensity: 0.5,
  }),
  shield: new THREE.MeshStandardMaterial({ 
    color: 0x0088ff,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
  }),
  wall: new THREE.MeshStandardMaterial({ color: 0x888888 }),
  healthBarBg: new THREE.MeshBasicMaterial({ color: 0x330000 }),
  healthBarFg: new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
};

/**
 * Geometries (reused for performance)
 * Юнит-геометрии с основанием на z=0 (растут вверх по Z — высоте игры), масштабируются per-entity.
 */
const geometries = {
  cylinder: createCylinderGeometry(),
  box: createBoxGeometry(),
  shieldArc: createShieldArcGeometry(),
};

function createCylinderGeometry(): THREE.BufferGeometry {
  // CylinderGeometry по умолчанию вытянут вдоль Y — поворачиваем вдоль Z (высота в игровых координатах)
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 32);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, 0.5); // основание на z=0, а не по центру
  return geometry;
}

function createBoxGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0, 0.5); // основание на z=0, а не по центру
  return geometry;
}

/**
 * Create shield arc geometry (30 degree arc), extruded по Z для объёма
 */
function createShieldArcGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const radius = 1;
  const arcAngle = Math.PI / 6; // 30 degrees

  shape.moveTo(0, 0);
  shape.absarc(0, 0, radius, -arcAngle / 2, arcAngle / 2, false);
  shape.lineTo(0, 0);

  return new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
}

/**
 * Entity mesh factory
 */
export class EntityMeshFactory {
  private scene: THREE.Scene;
  private playerModel: model.Model | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setPlayerModel(m: model.Model): void {
    this.playerModel = m;
  }

  /**
   * Create meshes for an entity based on its components
   */
  create(entity: Entity): EntityMeshes | null {
    let mesh: THREE.Object3D;
    let mixer: THREE.AnimationMixer | undefined;
    let mdx: MdxInstance | undefined;

    // Determine entity type by components
    if (entity.Projectile) {
      mesh = this.createFireball(entity);
    } else if (entity.Dash) {
      const result = this.createPlayer(entity);
      mesh = result.mesh;
      mixer = result.mixer;
      mdx = result.mdx;
    } else if (entity.Collider?.shape === 'aabb') {
      mesh = this.createWall(entity);
    } else if (entity.AttachedTo) {
      // Щит — единственная круглая сущность с AttachedTo
      mesh = this.createShield(entity);
    } else {
      const result = this.createPlayer(entity);
      mesh = result.mesh;
      mixer = result.mixer;
      mdx = result.mdx;
    }

    // Add health bar if entity has health
    let healthBar: THREE.Mesh | undefined;
    if (entity.Health) {
      healthBar = this.createHealthBar();
      healthBar.position.z = 0.1; // Slightly above entity
      this.scene.add(healthBar);
    }

    this.scene.add(mesh);

    return {
      mesh,
      healthBar,
      mixer,
      mdx,
      currentAnim: mdx ? 'Stand' : undefined,
      torso: mdx?.bones.get('Bone_Chest'),
    };
  }

  private createPlayer(
    entity: Entity
  ): { mesh: THREE.Object3D; mixer?: THREE.AnimationMixer; mdx?: MdxInstance } {
    if (this.playerModel) {
      // Видимость «служебных» геосетов (варианты Defend/Death, включая дубликат
      // тела geo3) управляется покадровой GeosetAnim.Alpha внутри
      // buildMdxInstance — в Stand/Walk они гаснут сами, без хардкода индексов.
      const inst = buildMdxInstance(this.playerModel);
      const height = entity.Collider ? Number(entity.Collider.height) / 65536 : 1;
      inst.root.scale.setScalar(height);
      inst.play('Stand');
      return { mesh: inst.root, mixer: inst.mixer, mdx: inst };
    }
    // ---- fallback: старый цилиндр ----
    const mesh = new THREE.Mesh(geometries.cylinder, materials.player);
    const radius = entity.Collider ? Number(entity.Collider.radius) / 65536 : 1;
    const h = entity.Collider ? Number(entity.Collider.height) / 65536 : 1;
    mesh.scale.set(radius, radius, h);
    return { mesh };
  }

  private createFireball(entity: Entity): THREE.Mesh {
    const mesh = new THREE.Mesh(geometries.cylinder, materials.fireball);
    const radius = entity.Collider ? Number(entity.Collider.radius) / 65536 : 1;
    const height = entity.Collider ? Number(entity.Collider.height) / 65536 : 1;
    mesh.scale.set(radius, radius, height);
    return mesh;
  }

  private createShield(entity: Entity): THREE.Mesh {
    const mesh = new THREE.Mesh(geometries.shieldArc, materials.shield);
    const radius = entity.Collider ? Number(entity.Collider.radius) / 65536 : 1;
    const height = entity.Collider ? Number(entity.Collider.height) / 65536 : 1;
    mesh.scale.set(radius, radius, height);

    // Дуга щита (local +X) поворачивается в сторону каста — направление
    // задаётся смещением от владельца, зафиксированным в момент каста.
    if (entity.AttachedTo) {
      const offsetX = Number(entity.AttachedTo.offset_x) / 65536;
      const offsetY = Number(entity.AttachedTo.offset_y) / 65536;
      mesh.rotation.z = Math.atan2(offsetY, offsetX);
    }

    return mesh;
  }

  private createWall(entity: Entity): THREE.Mesh {
    const mesh = new THREE.Mesh(geometries.box, materials.wall);

    if (entity.Collider) {
      const width = Number(entity.Collider.half_width * 2n) / 65536;
      const depth = Number(entity.Collider.half_height * 2n) / 65536;
      const height = Number(entity.Collider.height) / 65536;
      mesh.scale.set(width, depth, height);
    }

    return mesh;
  }

  private createHealthBar(): THREE.Mesh {
    const bar = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.15),
      materials.healthBarFg
    );
    return bar;
  }

  /**
   * Dispose entity meshes
   */
  dispose(meshes: EntityMeshes): void {
    if (meshes.healthBar) {
      this.scene.remove(meshes.healthBar);
      // healthBar создаётся своей PlaneGeometry на каждый инстанс — освобождаем.
      meshes.healthBar.geometry.dispose();
    }
    if (meshes.mixer) {
      meshes.mixer.stopAllAction();
    }
    this.scene.remove(meshes.mesh);
    // ВНИМАНИЕ: mesh.geometry — это общая модульная геометрия
    // (geometries.cylinder/box/shieldArc), разделяемая между сущностями.
    // ЕЁ НЕЛЬЗЯ dispose здесь: иначе при удалении, например, фаербола
    // рушится GPU-буфер общего цилиндра и перестаёт рендериться игрок.
  }
}

/**
 * Create entity mesh factory
 */
export function createEntityMeshes(scene: THREE.Scene): EntityMeshFactory {
  return new EntityMeshFactory(scene);
}
