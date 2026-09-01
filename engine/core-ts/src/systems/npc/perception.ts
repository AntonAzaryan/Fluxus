/**
 * Восприятие NPC (`npc-behavior` NPC-1, NPC-5): прямое чтение мира плюс
 * выборка соседей сеткой (NPC-6). Персонального снапшота и фильтра видимости
 * здесь нет: NPC — часть авторитетной симуляции, а не её участник.
 *
 * Кандидаты снимаются ОДИН раз на прогон системы и переиспользуются всеми
 * агентами: запрос на каждого агента был бы работой, растущей произведением
 * «агенты × сущности», а выборка соседей — тем, ради чего сетка и заведена.
 */
import { distSqCompare, distSqLe } from '../../math/fixed.js';
import { NpcGrid } from './grid.js';
import { hiddenFrom, isDead, posX, posY, teamOf } from './runtime.js';
import type { NpcHandles } from './handles.js';
import type { CompiledNpcBindings } from './model.js';
import { NO_ENTITY, type EntityId, type Fixed, type QuerySpec, type SystemContext } from '../../types.js';

const NO_CANDIDATES = new Float64Array(0);

/**
 * Предел соседей на один запрос. Не «сколько поместится», а осознанный потолок
 * работы: агент выбирает, кого бить, а не ведёт перепись арены, и стоимость
 * его решения обязана быть ограничена числом, а не плотностью толпы (NPC-4).
 *
 * Потолок наблюдаем: в толпе плотнее его агент выбирает ближайшего из
 * ОСМОТРЕННЫХ, а не из всех. Это цена, которую платформа платит осознанно —
 * альтернатива «осмотреть всех» есть перебор, растущий квадратом числа агентов,
 * то есть ровно то, что NPC-6 запрещает. Размер клетки сетки подобран так, чтобы
 * при штатной плотности арены потолок не срабатывал вовсе.
 */
const NEIGHBOR_LIMIT = 48;

/**
 * Предел ОСМОТРА одного запроса (NPC-6). Величина отдельная от предела
 * собранных: осмотром считаются и звенья цепочек клеток, и сами пробы клеток, —
 * а клеток в развёртке радиуса квадратично много, и предел, считающий одних
 * собранных, пределом работы не был бы.
 *
 * Тысяча с четвертью — это развёртка кольцами радиусом в пятнадцать клеток, то
 * есть тридцать мировых единиц: больше, чем диаметр арены демо. При штатной
 * плотности предел поэтому не срабатывает вовсе, а срабатывает он тем, что
 * запрос теряет самые дальние кольца — вырождается в поиск в меньшем радиусе, а
 * не в поиск не там.
 */
const EXAMINE_LIMIT = 1024;

export class NpcPerception {
  private readonly grid: NpcGrid;
  private readonly scratch = new Int32Array(NEIGHBOR_LIMIT);
  private candidates: Float64Array = NO_CANDIDATES;
  private spec: QuerySpec | undefined;

  constructor(cellSize: Fixed) {
    this.grid = new NpcGrid(cellSize);
  }

  /**
   * Снимает кандидатов тика и наполняет ими сетку. Кандидат — живая сущность
   * со стороной и позицией: сторона нужна, чтобы отличить врага от союзника, а
   * сцена без объявленной стороны целей не выбирает вовсе (NPC-1).
   */
  rebuild(ctx: SystemContext, bindings: CompiledNpcBindings, handles: NpcHandles): void {
    if (!bindings.hasTeam) {
      this.candidates = NO_CANDIDATES;
      this.grid.begin(0);
      return;
    }
    // Спецификация запроса адресуется ИМЕНАМИ (QuerySpec не тронут), чтение
    // позиций — handle'ами (SYS-10): имена нужны один раз, чтение — на каждого.
    this.spec ??= { all: [bindings.teamComponent, bindings.position] };
    this.candidates = ctx.query(this.spec);
    this.grid.begin(this.candidates.length);
    for (let slot = 0; slot < this.candidates.length; slot++) {
      const entity = this.candidates[slot]!;
      this.grid.add(slot, posX(ctx, handles, entity), posY(ctx, handles, entity));
    }
  }

  /**
   * Ближайший живой враг в радиусе; `NO_ENTITY` — никого. Ближе сравнивается
   * тем же точным сравнением квадратов, что фильтр `withinRadius` (QUERY-1):
   * «ближе» в выборе цели и в выборке значит буквально одно и то же.
   */
  nearestEnemy(
    ctx: SystemContext,
    handles: NpcHandles,
    self: EntityId,
    x: Fixed,
    y: Fixed,
    team: number,
    radius: Fixed,
  ): EntityId {
    const found = this.grid.neighbors(-1, x, y, radius, this.scratch, EXAMINE_LIMIT);
    let best = NO_ENTITY;
    let bestX = 0;
    let bestY = 0;
    for (let i = 0; i < found; i++) {
      const slot = this.scratch[i]!;
      const entity = this.candidates[slot]!;
      if (entity === self) continue;
      if (teamOf(ctx, handles, entity) === team) continue;
      if (isDead(ctx, handles, entity)) continue;
      // NPC-10: скрытая от агента цель не выбирается и во входы не попадает.
      if (hiddenFrom(ctx, handles, self, entity)) continue;
      const dx = this.grid.xAt(slot) - x;
      const dy = this.grid.yAt(slot) - y;
      if (best !== NO_ENTITY && distSqCompare(dx, dy, bestX, bestY) >= 0) continue;
      best = entity;
      bestX = dx;
      bestY = dy;
    }
    return best;
  }

  /** Сколько живых союзников в радиусе — вход `crowding` (NPC-3). */
  allies(
    ctx: SystemContext,
    handles: NpcHandles,
    self: EntityId,
    x: Fixed,
    y: Fixed,
    team: number,
    radius: Fixed,
  ): number {
    const found = this.grid.neighbors(-1, x, y, radius, this.scratch, EXAMINE_LIMIT);
    let count = 0;
    for (let i = 0; i < found; i++) {
      const slot = this.scratch[i]!;
      const entity = this.candidates[slot]!;
      if (entity === self) continue;
      if (teamOf(ctx, handles, entity) !== team) continue;
      if (isDead(ctx, handles, entity)) continue;
      count++;
    }
    return count;
  }

  /** Живая ли цель и в пределах ли она радиуса чувства — без выборки соседей. */
  static reaches(
    ctx: SystemContext,
    handles: NpcHandles,
    self: EntityId,
    target: EntityId,
    radius: Fixed,
  ): boolean {
    if (target === NO_ENTITY || !ctx.isAlive(target)) return false;
    if (isDead(ctx, handles, target)) return false;
    // NPC-10: цель, ушедшая в невскрытый стелс, для чувств агента недостижима —
    // условия документа (`targetOutOfReach`) переключают его штатно.
    if (hiddenFrom(ctx, handles, self, target)) return false;
    const dx = posX(ctx, handles, target) - posX(ctx, handles, self);
    const dy = posY(ctx, handles, target) - posY(ctx, handles, self);
    return distSqLe(dx, dy, radius);
  }
}
