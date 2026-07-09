/**
 * Game Demo: Full ts-impl + ts-render integration
 * Input handling + game loop + rendering
 */

import * as THREE from 'three';
import { createRenderer, GameState as RenderState } from './renderer';
import {
  createGameState,
  tick,
  TickInput,
} from 'game-mvp-impl/tick';
import { toFixed, ZERO, ONE } from 'game-mvp-impl/fixed/fixed';
import { MoveCommand, DashCommand, CastFireball, CastShield, CastTimeSlow } from 'game-mvp-impl/ecs/events';
import { createPlayerArchetype } from 'game-mvp-impl/archetypes/player';

// ============================================================================
// Input Handler
// ============================================================================

class InputHandler {
  private keys = new Set<string>();
  private mouse = new THREE.Vector2();
  private playerId: bigint | null = null;
  private currentTick = 0n;

  constructor(
    private canvas: HTMLElement,
    private emitCommand: (cmd: MoveCommand | DashCommand | CastFireball | CastShield | CastTimeSlow) => void
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

    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    });
  }

  private castFireball(): void {
    const target = this.screenToWorld(this.mouse);
    this.emitCommand({
      tick: this.currentTick,
      player_id: this.playerId!,
      caster_id: this.playerId!,
      target_x: toFixed(target.x),
      target_y: toFixed(target.y),
      target_z: ZERO,
    } as CastFireball);
  }

  private castShield(): void {
    const target = this.screenToWorld(this.mouse);
    this.emitCommand({
      tick: this.currentTick,
      player_id: this.playerId!,
      caster_id: this.playerId!,
      target_x: toFixed(target.x),
      target_y: toFixed(target.y),
      target_z: ZERO,
    } as CastShield);
  }

  private startDash(): void {
    this.emitCommand({
      tick: this.currentTick,
      player_id: this.playerId!,
    } as DashCommand);
  }

  private castTimeSlow(): void {
    this.emitCommand({
      tick: this.currentTick,
      player_id: this.playerId!,
      caster_id: this.playerId!,
    } as CastTimeSlow);
  }

  private screenToWorld(screen: THREE.Vector2): { x: number; y: number } {
    const viewWidth = 40;
    const viewHeight = viewWidth * (window.innerHeight / window.innerWidth);
    return {
      x: screen.x * (viewWidth / 2),
      y: screen.y * (viewHeight / 2),
    };
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
  cameraZ: 30,
});

const gameState = createGameState();
const { world, bus, resources } = gameState;

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
  Position: { x: toFixed(10), y: toFixed(5), z: ZERO },
  Collider: { shape: 'aabb', radius: ZERO, half_width: toFixed(2), half_height: toFixed(5), height: toFixed(10) },
  StaticBody: {},
  CollisionLayer: { layer: 2, mask: 0b1111 },
});

world.spawn({
  Position: { x: toFixed(-10), y: toFixed(-5), z: ZERO },
  Collider: { shape: 'aabb', radius: ZERO, half_width: toFixed(2), half_height: toFixed(5), height: toFixed(10) },
  StaticBody: {},
  CollisionLayer: { layer: 2, mask: 0b1111 },
});

// Commands buffer
const commands: Array<MoveCommand | DashCommand | CastFireball | CastShield | CastTimeSlow> = [];

const inputHandler = new InputHandler(container, (cmd) => commands.push(cmd));
inputHandler.setPlayerId(playerId);

// UI
const infoDiv = document.getElementById('info');
if (infoDiv) {
  infoDiv.innerHTML = `
    <div style="font-weight: bold;">Game MVP - Full Integration</div>
    <div style="margin-top: 8px;">
      <div>WASD/Arrows: Move</div>
      <div>Q: Fireball | E: Shield</div>
      <div>Space: Dash | R: Time Slow</div>
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
    // Movement intent
    const movement = inputHandler.getMovementIntent();
    const player = world.get(playerId);
    
    if (player?.MoveIntent && movement.pressed) {
      player.MoveIntent.dx = toFixed(movement.vec.x);
      player.MoveIntent.dy = toFixed(movement.vec.y);
      player.MoveIntent.dz = ZERO;
    }

    // Tick
    const input: TickInput = { commands: commands as any };
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

renderer.start();
requestAnimationFrame(gameLoop);

console.log('🎮 Game MVP started - ts-impl + ts-render fully integrated!');
