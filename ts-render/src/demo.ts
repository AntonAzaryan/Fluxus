/**
 * Game Demo: Simple visualization with mock game state
 * Full ts-impl integration requires monorepo setup
 */

import * as THREE from 'three';
import { createRenderer, GameState } from './renderer';

// ============================================================================
// Mock Game State (для демонстрации рендера)
// В реальной игре это будет приходить из ts-impl
// ============================================================================

const container = document.createElement('div');
container.style.width = '100%';
container.style.height = '100%';
document.body.appendChild(container);

const gameRenderer = createRenderer(container, {
  width: 1280,
  height: 720,
});

// Mock entities
const mockEntities = [
  {
    id: 1n,
    Position: { x: 0n, y: 0n, z: 0n },
    Health: { current: 100n * 65536n, max: 100n * 65536n },
    Collider: { shape: 'circle' as const, radius: 65536n, half_width: 0n, half_height: 0n, height: 655360n },
  },
  {
    id: 2n,
    Position: { x: 10n * 65536n, y: 5n * 65536n, z: 0n },
    Health: { current: 80n * 65536n, max: 100n * 65536n },
    Collider: { shape: 'circle' as const, radius: 65536n, half_width: 0n, half_height: 0n, height: 655360n },
  },
  {
    id: 3n,
    Position: { x: -5n * 65536n, y: -8n * 65536n, z: 0n },
    Collider: { shape: 'aabb' as const, radius: 0n, half_width: 2n * 65536n, half_height: 5n * 65536n, height: 655360n },
  },
];

// Animation state
let time = 0;

// UI
const infoDiv = document.getElementById('info');
if (infoDiv) {
  infoDiv.innerHTML = `
    <div>Game MVP Render Demo</div>
    <div style="margin-top: 8px; color: #aaa;">
      Mock entities - ts-impl integration requires monorepo
    </div>
  `;
}

// Game loop
function gameLoop() {
  time += 0.016;

  // Animate entities
  mockEntities[0].Position.x = BigInt(Math.sin(time) * 5 * 65536);
  mockEntities[0].Position.y = BigInt(Math.cos(time) * 3 * 65536);

  mockEntities[1].Position.x = BigInt(10 * 65536 + Math.sin(time * 0.5) * 3 * 65536);

  const renderState: GameState = {
    tick: BigInt(time * 60),
    entities: mockEntities,
  };

  gameRenderer.updateState(renderState);
  requestAnimationFrame(gameLoop);
}

gameRenderer.start();
gameLoop();

console.log('Game MVP Render Demo started!');
