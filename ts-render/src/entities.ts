/**
 * Entity mesh factory: creates Three.js objects for game entities
 */

import * as THREE from 'three';
import { Entity } from './types';

/**
 * Entity mesh collection
 */
export interface EntityMeshes {
  mesh: THREE.Mesh;
  healthBar?: THREE.Mesh;
  trail?: THREE.Line;
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
 */
const geometries = {
  circle: new THREE.CircleGeometry(1, 32),
  rectangle: new THREE.PlaneGeometry(1, 1),
  shieldArc: createShieldArcGeometry(),
};

/**
 * Create shield arc geometry (30 degree arc)
 */
function createShieldArcGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const radius = 1;
  const arcAngle = Math.PI / 6; // 30 degrees

  shape.moveTo(0, 0);
  shape.absarc(0, 0, radius, -arcAngle / 2, arcAngle / 2, false);
  shape.lineTo(0, 0);

  return new THREE.ShapeGeometry(shape);
}

/**
 * Entity mesh factory
 */
export class EntityMeshFactory {
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Create meshes for an entity based on its components
   */
  create(entity: Entity): EntityMeshes | null {
    let mesh: THREE.Mesh;

    // Determine entity type by components
    if (entity.Projectile) {
      mesh = this.createFireball();
    } else if (entity.Dash) {
      mesh = this.createPlayer(); // Dashing player
    } else if (entity.Collider?.shape === 'aabb') {
      mesh = this.createWall(entity);
    } else if (entity.Collider?.shape === 'circle') {
      // Check if it's a shield (has specific properties)
      const radius = entity.Collider ? Number(entity.Collider.radius) / 65536 : 1;
      if (radius > 1.5) {
        mesh = this.createShield();
      } else {
        mesh = this.createPlayer();
      }
    } else {
      mesh = this.createPlayer();
    }

    // Add health bar if entity has health
    let healthBar: THREE.Mesh | undefined;
    if (entity.Health) {
      healthBar = this.createHealthBar();
      healthBar.position.z = 0.1; // Slightly above entity
      this.scene.add(healthBar);
    }

    this.scene.add(mesh);

    return { mesh, healthBar };
  }

  private createPlayer(): THREE.Mesh {
    const mesh = new THREE.Mesh(geometries.circle, materials.player);
    mesh.scale.set(1, 1, 1);
    return mesh;
  }

  private createFireball(): THREE.Mesh {
    const mesh = new THREE.Mesh(geometries.circle, materials.fireball);
    mesh.scale.set(0.5, 0.5, 0.5);
    return mesh;
  }

  private createShield(): THREE.Mesh {
    const mesh = new THREE.Mesh(geometries.shieldArc, materials.shield);
    mesh.scale.set(1.5, 1.5, 1);
    return mesh;
  }

  private createWall(entity: Entity): THREE.Mesh {
    const mesh = new THREE.Mesh(geometries.rectangle, materials.wall);
    
    if (entity.Collider) {
      const width = Number(entity.Collider.half_width * 2n) / 65536;
      const height = Number(entity.Collider.half_height * 2n) / 65536;
      mesh.scale.set(width, height, 1);
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
      meshes.healthBar.geometry.dispose();
    }
    this.scene.remove(meshes.mesh);
    meshes.mesh.geometry.dispose();
  }
}

/**
 * Create entity mesh factory
 */
export function createEntityMeshes(scene: THREE.Scene): EntityMeshFactory {
  return new EntityMeshFactory(scene);
}
