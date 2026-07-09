/**
 * Demo: Simple game visualization
 */

import { createRenderer, GameState } from './index';

// Create container
const container = document.createElement('div');
container.style.width = '100%';
container.style.height = '100%';
document.body.appendChild(container);

// Create renderer
const renderer = createRenderer(container, {
  width: 1280,
  height: 720,
});

// Demo game state
let tick = 0n;
const entities = [
  {
    id: 1n,
    Position: { x: 0n, y: 0n, z: 0n },
    Velocity: { dx: 655360n, dy: 0n, dz: 0n }, // 10.0 in fixed-point
    Collider: { shape: 'circle' as const, radius: 65536n, half_width: 0n, half_height: 0n, height: 655360n },
    Health: { current: 100n * 65536n, max: 100n * 65536n },
  },
  {
    id: 2n,
    Position: { x: 327680n, y: 0n, z: 0n }, // 5.0 in fixed-point
    Velocity: { dx: -655360n, dy: 0n, dz: 0n },
    Collider: { shape: 'circle' as const, radius: 65536n, half_width: 0n, half_height: 0n, height: 655360n },
    Health: { current: 100n * 65536n, max: 100n * 65536n },
  },
  {
    id: 3n,
    Position: { x: 655360n, y: 327680n, z: 0n }, // 10.0, 5.0
    Collider: { shape: 'aabb' as const, radius: 0n, half_width: 327680n, half_height: 131072n, height: 655360n },
  },
];

// Simple animation loop
let posX = 0n;
const speed = 65536n; // 1.0 per second

function update() {
  tick += 1n;
  posX = (posX + speed) % (65536n * 20n); // Wrap around at 20 units

  // Update entity positions
  entities[0].Position.x = posX;
  entities[0].Position.y = BigInt(Math.sin(Number(tick) / 60) * 3 * 65536);

  const state: GameState = {
    tick,
    entities,
  };

  renderer.updateState(state);
}

// Start renderer
renderer.start();

// Update 60 times per second
setInterval(update, 1000 / 60);

// Handle resize
window.addEventListener('resize', () => {
  renderer.resize(window.innerWidth, window.innerHeight);
});

console.log('Game MVP Render demo started');
