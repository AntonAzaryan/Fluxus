/**
 * Накопление угрозы (`npc-behavior` NPC-5): СОБЫТИЙНОЕ — по событиям шины
 * текущего тика (урон, лечение, провокация; EVT-2), а не сканом сущностей.
 *
 * Обход идёт по СОБЫТИЯМ, а не по агентам: индекс «тип события → источники,
 * его объявившие» строится один раз на загрузке, и стоимость начисления растёт
 * числом событий, а не произведением «агенты × события». Скан по агентам
 * остаётся только у забывания — оно и есть работа на агента (NPC-5).
 *
 * Место в тике — после всех, кто эти события публикует: шину система видит
 * только от систем с меньшим `order` (EVT-2), а урон в этой игре публикуют
 * системы сцены и платформа способностей. Отсюда и однотиковая задержка между
 * попаданием и пересмотром цели: решения принимаются в начале следующего тика
 * (`behavior.ts`), и это тот же порядок, в каком работает прерывание каста
 * (ABIL-6).
 *
 * Правила накопления — ПОЛИТИКА документа (веса источников, порог смены цели,
 * забывание); таблица фиксированной ёмкости и вытеснение минимума — МЕХАНИЗМ.
 */
import { mul } from '../../math/fixed.js';
import { NPC_AGENT_COMPONENT, NPC_THREAT_COMPONENT } from './components.js';
import { threatAdd, threatDecay, threatOf } from './runtime.js';
import type { CompiledThreatSource, NpcCatalog } from './model.js';
import {
  FIXED_ONE,
  NO_ENTITY,
  type EntityId,
  type Fixed,
  type QuerySpec,
  type System,
  type SystemContext,
} from '../../types.js';

/**
 * Потолок величины одного начисления — тот же, что у накопления в таблице
 * (`runtime.ts`): дальше него сложение перестало бы помещаться в i32.
 */
const THREAT_MAX = 0x1fffffff;

/** Место в шкале `order` и его основание — таблица DET-9; параметром сборки не является. */
const ANCHOR_ORDER = 840;

/** Источник угрозы вместе с документом, который его объявил. */
interface DeclaredSource {
  readonly behavior: number;
  readonly source: CompiledThreatSource;
  readonly switchMargin: number;
}

export class NpcThreatSystem implements System {
  readonly name = 'NpcThreat';
  readonly order = ANCHOR_ORDER;
  private readonly catalog: NpcCatalog;
  private readonly spec: QuerySpec = { all: [NPC_AGENT_COMPONENT, NPC_THREAT_COMPONENT] };
  /** Тип события → объявившие его источники. Строится один раз, на загрузке. */
  private readonly byType = new Map<string, DeclaredSource[]>();

  constructor(catalog: NpcCatalog) {
    this.catalog = catalog;
    for (const [behavior, compiled] of catalog.behaviors.entries()) {
      for (const source of compiled.threatSources) {
        const list = this.byType.get(source.eventType);
        const entry: DeclaredSource = { behavior, source, switchMargin: compiled.switchMargin };
        if (list === undefined) this.byType.set(source.eventType, [entry]);
        else list.push(entry);
      }
    }
  }

  run(ctx: SystemContext): void {
    const agents = ctx.query(this.spec);
    if (agents.length === 0) return;
    for (const entity of agents) {
      const behavior = this.catalog.behaviors[ctx.get(entity, NPC_AGENT_COMPONENT, 'behavior')];
      if (behavior === undefined || behavior.decayPerTick === FIXED_ONE) continue;
      threatDecay(ctx, entity, behavior.decayPerTick);
    }
    if (this.byType.size === 0) return;
    for (let index = 0; index < ctx.events.length; index++) {
      this.credit(ctx, index);
    }
  }

  /** Начисление по одному событию тика: адресат, источник и величина — поля документа. */
  private credit(ctx: SystemContext, index: number): void {
    const event = ctx.events.at(index);
    const declared = this.byType.get(event.type);
    if (declared === undefined) return;
    for (const entry of declared) {
      const victim = event.data[entry.source.victimField];
      if (victim === undefined || !ctx.isAlive(victim)) continue;
      // Оба компонента, а не один: чтение поля тотально (ECS-7), и сущность с
      // одной лишь threat-таблицей прочла бы нулевой `behavior` и копила бы
      // угрозу по правилам ЧУЖОГО документа.
      if (!ctx.has(victim, NPC_THREAT_COMPONENT) || !ctx.has(victim, NPC_AGENT_COMPONENT)) continue;
      // Источник засчитывается только тому, чей ДОКУМЕНТ его объявил: два
      // документа вправе называть разные события угрозой, и чужое правило
      // применяться к агенту не должно.
      if (ctx.get(victim, NPC_AGENT_COMPONENT, 'behavior') !== entry.behavior) continue;
      const from = event.data[entry.source.sourceField];
      if (from === undefined) continue;
      threatAdd(ctx, victim, from, NpcThreatSystem.amount(entry.source, event.data));
      this.provoke(ctx, victim, from, entry.switchMargin);
    }
  }

  /**
   * Величина одного начисления: вес документа, помноженный на СЧЁТЧИК события.
   *
   * Поле события — целый счётчик сцены (единицы урона, лечения), а не доля
   * Q16.16: правило это объявляет формат документа (`amountField`), и держит
   * его здесь насыщение, а не вера в данные.
   *
   * Произведение считается ДО перевода в i32-домен Q16.16 и насыщается там же.
   * `mul` для этого не годится: он считает в i32 и переполнение заворачивает
   * молча (FP-2), а вес источника угрозы — коэффициент, а не доля, и документ
   * вправе объявить его больше единицы. Умножение веса (Q16.16) на ЦЕЛЫЙ
   * счётчик и есть Q16.16-произведение, поэтому промежуточного масштабирования
   * не нужно вовсе.
   *
   * DET-2, условие 5: счётчик сперва зажат потолком, поэтому в неотсечённой
   * ветке произведение меньше потолка, то есть много меньше 2^53 и точно; в
   * отсечённой точность не нужна — там значима только сама отсечка.
   */
  private static amount(
    source: CompiledThreatSource,
    data: Readonly<Record<string, number>>,
  ): Fixed {
    if (source.amountField === '') return source.weight;
    const counter = data[source.amountField] ?? 0;
    if (counter <= 0 || source.weight <= 0) return 0;
    const capped = counter > THREAT_MAX ? THREAT_MAX : counter;
    const product = source.weight * capped;
    return product >= THREAT_MAX ? THREAT_MAX : product;
  }

  /**
   * Форс-пересмотр решения (NPC-5, D4): угроза от НЕ-цели, перевалившая порог
   * документа, помечает решение просроченным, и агент пересматривает его в
   * начале следующего тика вне своего окна каденса. Метка — поле `decidedTick`
   * со значением «решения нет»: второго флага для одного и того же смысла
   * платформа не заводит.
   */
  private provoke(
    ctx: SystemContext,
    entity: EntityId,
    from: EntityId,
    switchMargin: number,
  ): void {
    const target = ctx.get(entity, NPC_AGENT_COMPONENT, 'target');
    if (from === target || from === NO_ENTITY) return;
    const held = target === NO_ENTITY ? 0 : threatOf(ctx, entity, target);
    if (threatOf(ctx, entity, from) <= held + mul(held, switchMargin)) return;
    ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'decidedTick', -1);
  }
}
