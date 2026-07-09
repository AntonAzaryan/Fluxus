# ts-render

Three.js-based renderer for Game MVP.

## Features

- **Entity rendering**: Player, fireball, shield, wall entities
- **Health bars**: Visual feedback for entity health
- **Isometric-like camera**: 30° angle perspective
- **Fixed-point conversion**: Converts Q32.16 fixed-point to Three.js coordinates

## Installation

```bash
npm install
```

## Development

```bash
npm run dev      # Start dev server on port 3000
npm run build    # Build for production
npm run preview  # Preview production build
npm run typecheck # Type check only
```

## Usage

```typescript
import { createRenderer, GameState } from 'game-mvp-render';

// Create renderer
const container = document.getElementById('game-container');
const renderer = createRenderer(container, {
  width: 1280,
  height: 720,
  cameraZ: 30,
});

// Game state update loop
function gameLoop(gameState: GameState) {
  renderer.updateState(gameState);
}

// Start rendering
renderer.start();

// Cleanup
renderer.dispose();
```

## Architecture

```
src/
├── index.ts        # Public API exports
├── types.ts        # GameState, Entity types
├── renderer.ts     # Core renderer (scene, camera, lights)
├── entities.ts     # Entity mesh factory
└── main.ts         # Demo entry point
```

## Integration with ts-impl

The renderer consumes `GameState` from ts-impl:

```typescript
import { createGameState } from '../ts-impl/src/tick';
import { createRenderer } from './renderer';

const state = createGameState();
const renderer = createRenderer(container);

// Sync state at 60 FPS
setInterval(() => {
  renderer.updateState(state);
}, 1000 / 60);
```

## Entity Types

| Entity    | Color    | Shape        | Size     |
|-----------|----------|--------------|----------|
| Player    | #00ff88  | Circle       | 1.0      |
| Fireball  | #ff4400  | Circle       | 0.5      |
| Shield    | #0088ff  | 30° Arc      | 1.5      |
| Wall      | #888888  | Rectangle    | Variable |

## License

MIT
