/**
 * Режиссёр волн (`npc-behavior` NPC-8): спавн, состав и темп — отдельный слой
 * ПОВЕРХ поведения отдельного крипа. Отделён он затем, чтобы состав волн
 * тюнился независимо: правка таблицы волн не трогает ни код режиссёра, ни
 * документы поведения.
 *
 * Спавн идёт через Command Buffer на общих основаниях (CMD-1, CMD-6): префаб
 * называет таблица, поля агента приезжают переопределениями. Предел
 * одновременно активных NPC — ДАННЫЕ СЦЕНЫ, и превышать его режиссёр не вправе:
 * очередной боец ждёт освобождения места, а не пополняет тик неограниченным
 * числом агентов.
 *
 * Состояние режиссёра (какая волна, сколько до следующего бойца, сколько уже
 * выпущено) живёт компонентом обычной сущности расстановки: оно обязано
 * попадать в снапшот и откатываться вместе с миром (SNAP-1), как радиус арены.
 */
import {
  NPC_AGENT_COMPONENT,
  NPC_DIRECTOR_COMPONENT,
  NPC_ROUTE_COMPONENT,
  NPC_WAVE_DONE,
  NPC_WAVE_UNARMED,
} from './components.js';
import { NpcRoutes } from './routes.js';
import { livingAgents, posX, posY } from './runtime.js';
import type { NpcCatalog, NpcWaveDef, NpcWavesDef } from './model.js';
import {
  NO_ENTITY,
  type EntityId,
  type FieldOverrides,
  type QuerySpec,
  type System,
  type SystemContext,
} from '../../types.js';

/** Место в шкале `order` и его основание — таблица DET-9; параметром сборки не является. */
const ANCHOR_ORDER = -960;

export class NpcDirectorSystem implements System {
  readonly name = 'NpcDirector';
  readonly order = ANCHOR_ORDER;
  private readonly catalog: NpcCatalog;
  private readonly routes = new NpcRoutes();
  private readonly spec: QuerySpec = { all: [NPC_DIRECTOR_COMPONENT] };
  private readonly agentSpec: QuerySpec;

  constructor(catalog: NpcCatalog) {
    this.catalog = catalog;
    // Предел считает ЖИВЫХ агентов (NPC-8): сцена вправе оставлять тела на
    // арене, и предел, забитый трупами, откладывал бы спавн навсегда — то есть
    // означал бы не «до освобождения мест», а «никогда». Выборка та же, что у
    // поведения и движения: «живой» обязано значить у них одно и то же.
    this.agentSpec = livingAgents(catalog);
  }

  run(ctx: SystemContext): void {
    const waves = this.catalog.waves;
    if (waves === undefined) return;
    const directors = ctx.query(this.spec);
    if (directors.length === 0) return;
    this.routes.rebuild(ctx, this.catalog.bindings.position);
    // Живые агенты считаются ОДИН раз на тик: предел общий, и пересчитывать его
    // на каждого режиссёра значило бы платить за один и тот же ответ дважды.
    // Мёртвых выборка не содержит по построению спецификации запроса.
    let active = ctx.query(this.agentSpec).length;

    for (const director of directors) {
      const index = ctx.get(director, NPC_DIRECTOR_COMPONENT, 'wave');
      if (index === NPC_WAVE_DONE || index < 0 || index >= waves.entries.length) continue;
      const wave = waves.entries[index]!;
      const released = ctx.get(director, NPC_DIRECTOR_COMPONENT, 'released');
      if (released === NPC_WAVE_UNARMED) {
        // Пауза перед первым бойцом волны — её собственное число таблицы.
        ctx.commands.setField(director, NPC_DIRECTOR_COMPONENT, 'released', 0);
        ctx.commands.setField(director, NPC_DIRECTOR_COMPONENT, 'timer', wave.delayTicks);
        continue;
      }
      const timer = ctx.get(director, NPC_DIRECTOR_COMPONENT, 'timer');
      if (timer > 0) {
        ctx.commands.setField(director, NPC_DIRECTOR_COMPONENT, 'timer', timer - 1);
        continue;
      }
      if (released >= wave.count) {
        // Волна пуста либо выпущена целиком: проверка ДО выпуска, а не после
        // него. Иначе `count: 0` значило бы «один боец» — состав волны есть
        // данные (NPC-8), и ноль в них обязан значить ноль.
        this.advance(ctx, director, index, waves);
        continue;
      }
      if (active >= waves.cap) {
        // Предел сцены достигнут: выпуск ОТКЛАДЫВАЕТСЯ, а не пропускается —
        // волна не должна худеть от того, что предыдущая ещё жива (NPC-8).
        continue;
      }
      this.release(ctx, wave);
      active++;
      ctx.commands.setField(director, NPC_DIRECTOR_COMPONENT, 'released', released + 1);
      ctx.commands.setField(director, NPC_DIRECTOR_COMPONENT, 'timer', wave.spacingTicks);
    }
  }

  /** Выпуск одного бойца волны: префаб таблицы плюс поля агента и маршрута (CMD-6). */
  private release(ctx: SystemContext, wave: NpcWaveDef): void {
    const bindings = this.catalog.bindings;
    let x = wave.x ?? 0;
    let y = wave.y ?? 0;
    if (wave.route !== undefined) {
      const start = this.routes.at(wave.route, 0);
      if (start !== NO_ENTITY) {
        x = posX(ctx, bindings, start);
        y = posY(ctx, bindings, start);
      }
    }
    const overrides: FieldOverrides = {
      [NPC_AGENT_COMPONENT]: { behavior: wave.behavior },
      [bindings.position]: { x, y },
      ...(wave.route === undefined ? {} : { [NPC_ROUTE_COMPONENT]: { route: wave.route, index: 0 } }),
    };
    ctx.commands.spawn(wave.prefab, overrides);
  }

  /** Переход к следующей волне: волна отработана либо пуста (NPC-8). */
  private advance(
    ctx: SystemContext,
    director: EntityId,
    index: number,
    waves: NpcWavesDef,
  ): void {
    const next = index + 1;
    ctx.commands.setField(director, NPC_DIRECTOR_COMPONENT, 'released', NPC_WAVE_UNARMED);
    ctx.commands.setField(director, NPC_DIRECTOR_COMPONENT, 'timer', 0);
    ctx.commands.setField(
      director,
      NPC_DIRECTOR_COMPONENT,
      'wave',
      next >= waves.entries.length ? NPC_WAVE_DONE : next,
    );
  }
}
