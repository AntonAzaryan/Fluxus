/**
 * Game Demo: Full ts-impl + ts-render integration
 * Input handling + game loop + rendering
 */

import * as THREE from 'three';
import { createRenderer, GameRenderer, GameState as RenderState } from './renderer';
import {
  createGameState,
  tick,
  TickInput,
} from 'game-mvp-impl/tick';
import { toFixed, ZERO, ONE } from 'game-mvp-impl/fixed/fixed';
import {
  MoveCommandInput,
  DashInput,
  CastFireballInput,
  CastShieldInput,
  CastTimeSlowInput,
} from 'game-mvp-impl/resources/resources';
import { createPlayerArchetype } from 'game-mvp-impl/archetypes/player';
import { loadMdxModel } from './mdxModel';

type InputCommand = MoveCommandInput | DashInput | CastFireballInput | CastShieldInput | CastTimeSlowInput;

// ============================================================================
// Input Handler
// ============================================================================

class InputHandler {
  private keys = new Set<string>();
  private mouseClient = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  private playerId: bigint | null = null;
  private currentTick = 0n;

  constructor(
    private emitCommand: (cmd: InputCommand) => void,
    private renderer: GameRenderer
  ) {
    this.setupListeners();
  }

  private setupListeners(): void {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);

      if (e.code === 'KeyQ' && this.playerId) this.castFireball();
      if (e.code === 'KeyE' && this.playerId) this.castShield();
      if (e.code === 'Space' && this.playerId) this.startDash();
      if (e.code === 'KeyR' && this.playerId) this.castTimeSlow();
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    window.addEventListener('mousemove', (e) => {
      this.mouseClient.x = e.clientX;
      this.mouseClient.y = e.clientY;
    });
  }

  private castFireball(): void {
    const target = this.aimPoint();
    this.emitCommand({
      type: 'CastFireballInput',
      player_id: this.playerId!,
      target_x: toFixed(target.x),
      target_y: toFixed(target.y),
      target_z: ZERO,
    });
  }

  private castShield(): void {
    const target = this.aimPoint();
    this.emitCommand({
      type: 'CastShieldInput',
      player_id: this.playerId!,
      target_x: toFixed(target.x),
      target_y: toFixed(target.y),
      target_z: ZERO,
    });
  }

  private startDash(): void {
    this.emitCommand({
      type: 'DashInput',
      player_id: this.playerId!,
    });
  }

  private castTimeSlow(): void {
    this.emitCommand({
      type: 'CastTimeSlowInput',
      player_id: this.playerId!,
    });
  }

  // Точка на земле под курсором — цель для фаербола/щита.
  private aimPoint(): { x: number; y: number } {
    return this.renderer.clientToGround(this.mouseClient.x, this.mouseClient.y) ?? { x: 0, y: 0 };
  }

  setPlayerId(id: bigint): void {
    this.playerId = id;
  }

  getMovementIntent(): { vec: THREE.Vector2; pressed: boolean } {
    let dx = 0, dy = 0;

    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) dy += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) dy -= 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) dx += 1;

    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      dx /= len;
      dy /= len;
    }

    return {
      pressed: len > 0,
      vec: new THREE.Vector2(dx, dy),
    };
  }

  getKeys(): Set<string> {
    return this.keys;
  }

  updateTick(tick: bigint): void {
    this.currentTick = tick;
  }
}

// ============================================================================
// Main Game
// ============================================================================

const container = document.createElement('div');
container.style.width = '100%';
container.style.height = '100%';
document.body.appendChild(container);

const renderer = createRenderer(container, {
  width: 1280,
  height: 720,
  cameraZ: 320,
});

const gameState = createGameState();
const { world, bus, resources } = gameState;
(window as any).__world = world;
(window as any).__renderer = renderer;

// Spawn player
const playerArchetype = createPlayerArchetype();
const playerId = world.spawn({
  Position: playerArchetype.Position,
  Velocity: playerArchetype.Velocity,
  Collider: playerArchetype.Collider,
  DynamicBody: playerArchetype.DynamicBody,
  Health: playerArchetype.Health,
  Cooldowns: playerArchetype.Cooldowns,
  MoveIntent: playerArchetype.MoveIntent,
  CollisionLayer: playerArchetype.CollisionLayer,
});

// Spawn walls
world.spawn({
  Position: { x: toFixed(60), y: toFixed(30), z: ZERO },
  Collider: { shape: 'aabb', radius: ZERO, half_width: toFixed(15), half_height: toFixed(40), height: toFixed(10) },
  StaticBody: {},
  CollisionLayer: { layer: 2, mask: 0b1111 },
});

world.spawn({
  Position: { x: toFixed(-60), y: toFixed(-30), z: ZERO },
  Collider: { shape: 'aabb', radius: ZERO, half_width: toFixed(15), half_height: toFixed(40), height: toFixed(10) },
  StaticBody: {},
  CollisionLayer: { layer: 2, mask: 0b1111 },
});

// Commands buffer
const commands: InputCommand[] = [];

const inputHandler = new InputHandler((cmd) => commands.push(cmd), renderer);
inputHandler.setPlayerId(playerId);
renderer.setFollowTarget(playerId);

// UI
const infoDiv = document.getElementById('info');
if (infoDiv) {
  infoDiv.innerHTML = `
    <div style="font-weight: bold;">Game MVP - Full Integration</div>
    <div style="margin-top: 8px;">
      <div>WASD/Arrows: Move</div>
      <div>Q: Fireball (летит к курсору) | E: Shield (к курсору)</div>
      <div>Space: Dash | R: Time Slow</div>
      <div style="opacity:0.7">Наведи мышь — туда полетит фаербол</div>
    </div>
    <div style="margin-top: 8px;" id="stats"></div>
  `;
}

// Game loop
let lastTime = performance.now();
const tickRate = 1000 / 60;

function gameLoop(currentTime: number) {
  const deltaTime = currentTime - lastTime;

  if (deltaTime >= tickRate) {
    // Movement input
    const movement = inputHandler.getMovementIntent();

    if (movement.pressed) {
      const moveCmd = {
        type: 'MoveCommandInput' as const,
        player_id: playerId,
        dx: toFixed(movement.vec.x),
        dy: toFixed(movement.vec.y),
        dz: ZERO,
      };
      commands.push(moveCmd);
    }

    // Tick
    const input: TickInput = { commands };
    tick(gameState, input);
    commands.length = 0;

    inputHandler.updateTick(resources.timeState.current_tick);
    lastTime = currentTime;
  }

  // Render
  const renderState: RenderState = {
    tick: resources.timeState.current_tick,
    entities: world.all().map((e) => ({
      id: e.id,
      Position: e.Position,
      Velocity: e.Velocity,
      Collider: e.Collider,
      Health: e.Health,
      Projectile: e.Projectile,
      Dash: e.Dash,
      StaticBody: e.StaticBody,
      AttachedTo: e.AttachedTo,
    })),
  };

  renderer.updateState(renderState);

  // Stats
  const statsDiv = document.getElementById('stats');
  const player = world.get(playerId);
  if (statsDiv && player?.Health) {
    const healthPct = Number(player.Health.current) / Number(player.Health.max);
    statsDiv.innerHTML = `
      Tick: ${Number(resources.timeState.current_tick)}<br>
      Health: ${(healthPct * 100).toFixed(0)}%<br>
      Entities: ${world.all().length}
    `;
  }

  requestAnimationFrame(gameLoop);
}

// Асинхронная загрузка MDX модели перед стартом
loadMdxModel('/models/SkeletonBarbarian.mdx')
  .then((mdl) => {
    renderer.setPlayerModel(mdl);
    console.log('MDX модель загружена:', mdl.Sequences.map((s) => s.Name));
  })
  .catch((e) => console.error('Не удалось загрузить MDX:', e))
  .finally(() => {
    renderer.start();
    requestAnimationFrame(gameLoop);
  });
