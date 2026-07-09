/**
 * Game MVP Renderer
 * Three.js-based renderer for game entities
 */

import * as THREE from 'three';

// Re-export types for consumers
export type { GameState, Entity } from './types';
export { createRenderer } from './renderer';
export { createEntityMeshes, EntityMeshFactory, EntityMeshes } from './entities';

