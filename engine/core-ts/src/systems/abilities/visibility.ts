/**
 * Видимость сущностей-спутников платформы (NET-12), `order` 910 (DET-9).
 *
 * Спутник — сущность, всё содержимое которой есть состояние ДРУГОЙ сущности:
 * слот способности (ABIL-1) и инстанс баффа (BUFF-1). `Position` спутники не
 * несут, поэтому `VisibilitySystem` (900) их не трогает вовсе — она обходит
 * `all: [Visibility, Position]` (FOW-5), — а `filter.ts` режет их своим обычным
 * предикатом, ничего не зная о способностях.
 *
 * Компонент `Visibility` вешает ПЛАТФОРМА, а не автор контента. Умолчание
 * NET-12 («сущность без `Visibility` публична») здесь работает против себя:
 * забытый компонент на слоте — это ESP, раздающий противнику остатки
 * кулдаунов, фазу каста и накопленное прицеливание. Обязанность, которую
 * контент забудет молча, платформа берёт на себя, и держится это
 * интеграционным тестом изоляции, а не комментарием.
 *
 * Место в тике — единственная система позже `VisibilitySystem` (DET-9), и
 * позже она ровно потому, что производна от её результата: маска инстанса
 * баффа есть копия маски цели, а маска цели считается на 900. Исполненная
 * раньше, она копировала бы маску прошлого тика, и бафф на ушедшем в туман
 * враге прожил бы в чужом снапшоте лишний тик.
 *
 * Регистрируется загрузчиком только на сцене с туманом (SER-7): без `fog`
 * компонента `Visibility` в мире нет вовсе, фильтр там не режет никого, и
 * вопроса о маске спутника не стоит.
 *
 * TimeScale (TIME-5): игнорирует — маска спутника производна от состояния мира,
 * счётчиков времени у системы нет.
 */
import { teamBit, VISIBILITY_COMPONENT } from '../visibility.js';
import { ABILITY_SLOT_COMPONENT, BUFF_INSTANCE_COMPONENT } from './components.js';
import { NO_ENTITY, type EntityId, type QuerySpec, type System, type SystemContext } from '../../types.js';
import type { AbilityCatalog } from './model.js';

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = 910;

/**
 * Маска, не называющая ни одной стороны, — «спутник не виден никому». Это
 * безопасное направление умолчания и оно противоположно умолчанию NET-12 для
 * сущности БЕЗ компонента: спутник, о владельце или цели которого нельзя
 * сказать ничего определённого, обязан исчезнуть из персональных снапшотов, а
 * не попасть во все сразу.
 */
const NOBODY = 0;

/**
 * `Visibility` спутника: `undefined` означает «утверждения о видимости нет»,
 * то есть сущность публична ровно так же, как публична цель без компонента
 * (NET-12). Числовое значение — сама маска.
 */
type SatelliteMask = number | undefined;

export class AbilityVisibilitySystem implements System {
  readonly name = 'AbilityVisibility';
  readonly order = ANCHOR_ORDER;
  private readonly catalog: AbilityCatalog;
  private readonly slots: QuerySpec = { all: [ABILITY_SLOT_COMPONENT] };
  private readonly instances: QuerySpec = { all: [BUFF_INSTANCE_COMPONENT] };

  constructor(catalog: AbilityCatalog) {
    this.catalog = catalog;
  }

  run(ctx: SystemContext): void {
    // Запрос по компоненту, которого в мире нет, пуст по построению: сцена с
    // одними `buffs` слотов не имеет, сцена с одними `abilities` — инстансов.
    for (const slot of ctx.query(this.slots)) {
      this.write(ctx, slot, this.slotMask(ctx, slot));
    }
    for (const instance of ctx.query(this.instances)) {
      this.write(ctx, instance, this.instanceMask(ctx, instance));
    }
  }

  /**
   * Маска слота — РОВНО сторона владельца, названная биндингом сцены (ABIL-8),
   * и она MUST NOT выводиться из маски видимости самого владельца (NET-12).
   * Различие существенно: противник, видящий кастера, обязан видеть его самого
   * и всё, что каст создал В МИРЕ, но не сущность-слот — остаток кулдауна, фазу
   * и накопленные шаги: по ним читается решение, которое ещё не принято.
   * Единица вырезания — сущность целиком, поэтому «фаза видна, кулдаун нет»
   * этим механизмом невыразимо, и заряд противника показывает контент —
   * заспавненная сущность и компонент на самом кастере (ABIL-4).
   *
   * Владелец, о стороне которого сказать нечего, — «никому»: слот, оставшийся
   * без владельца (`CastPhaseSystem` убирает такие сироты, design Decision 14) и
   * слот сущности без компонента стороны публичными быть не вправе.
   */
  private slotMask(ctx: SystemContext, slot: EntityId): number {
    const { teamComponent, teamFieldName } = this.catalog.bindings;
    // Пара «`fog` вместе с `abilities` без `teamField`» отвергается загрузчиком
    // (ABIL-8), поэтому сюда попадает только сцена, где слотов не бывает.
    if (teamComponent === undefined || teamFieldName === undefined) return NOBODY;
    const owner = ctx.get(slot, ABILITY_SLOT_COMPONENT, 'owner');
    if (owner === NO_ENTITY || !ctx.isAlive(owner)) return NOBODY;
    // Чтение поля тотально (ECS-7), и нулевая сторона отсутствующего компонента
    // означала бы «виден команде 0» — то есть чужому клиенту.
    if (!ctx.has(owner, teamComponent)) return NOBODY;
    return teamBit(ctx.get(owner, teamComponent, teamFieldName));
  }

  /**
   * Маска инстанса баффа СОВПАДАЕТ с маской его цели (NET-12): бафф есть
   * наблюдаемое свойство сущности, и правило «видна цель — видны её баффы» не
   * добавляет клиенту ничего сверх того, что он и так знает о цели.
   *
   * Совпадение полное, включая отсутствие маски: цель без `Visibility`
   * публична, значит публичен и инстанс на ней. Цель, которой уже нет, — не то
   * же самое: такой инстанс `BuffSystem` (820) убирает в этом же тике, а
   * заспавненный позже неё живёт до следующего, и «никому» на этот тик
   * безопаснее «всем».
   */
  private instanceMask(ctx: SystemContext, instance: EntityId): SatelliteMask {
    const target = ctx.get(instance, BUFF_INSTANCE_COMPONENT, 'target');
    if (target === NO_ENTITY || !ctx.isAlive(target)) return NOBODY;
    if (!ctx.has(target, VISIBILITY_COMPONENT)) return undefined;
    return ctx.get(target, VISIBILITY_COMPONENT, 'visibleTo');
  }

  /**
   * Запись маски. Компонент добавляется при первом же наблюдении спутника
   * вместе со значением, а дальше правится только при фактическом изменении
   * битов — тем же правилом, по которому `VisibilitySystem` не эмитит команду
   * на неизменной маске (FOW-6): иначе `Visibility` спутника был бы dirty
   * каждый тик и сетевая дельта потеряла бы смысл.
   */
  private write(ctx: SystemContext, entity: EntityId, mask: SatelliteMask): void {
    const carries = ctx.has(entity, VISIBILITY_COMPONENT);
    if (mask === undefined) {
      if (carries) ctx.commands.removeComponent(entity, VISIBILITY_COMPONENT);
      return;
    }
    if (!carries) {
      ctx.commands.addComponent(entity, VISIBILITY_COMPONENT, { visibleTo: mask });
      return;
    }
    if (ctx.get(entity, VISIBILITY_COMPONENT, 'visibleTo') === mask) return;
    ctx.commands.setField(entity, VISIBILITY_COMPONENT, 'visibleTo', mask);
  }
}
