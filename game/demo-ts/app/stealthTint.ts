/**
 * Подача стелс-состояний (FOW-13) — presentation главного потока.
 *
 * Симуляция уже решила всё игровое: жёсткий невскрытый стелс вырезан фильтром
 * снапшота (NET-12), таргетинг и восприятие NPC читают маски (FOW-3, NPC-10).
 * Здесь — только картинка: свой юнит под активным стелсом рисуется
 * полупрозрачным, чужой под невскрытым мягким каналом — силуэтом-плейсхолдером
 * (шейдер преломления — отдельная работа рендера), вскрытый детекцией — как
 * обычно. Числа — из секции `stealth` парного presentation-документа (PRES-2);
 * секции нет — документированные умолчания ниже.
 *
 * Вскрытость канала своей командой вычисляется из ДОСТАВЛЕННОГО состояния:
 * детекция союзников едет статом (`DetectionState.mask`), своя команда видна
 * себе всегда (FOW-3). Жёсткость каналов клиенту не нужна вовсе: чужая
 * сущность с невскрытой маской доставлена — значит, канал мягкий по построению
 * (жёсткую фильтр бы вырезал).
 *
 * Непрозрачность ставится на СВОИ материалы инстанса: разделяемые с ассетом
 * материалы сперва переводятся в собственные (`ownTextureTargets`, REND-6) —
 * иначе полупрозрачность одного невидимки красила бы всех соседей по ассету.
 * Батчевый ярус и заглушка подачи не получают: у них нет своих материалов, и
 * это принятый остаток плейсхолдера, а не пробел.
 */
import type { EntityId } from '@fluxus/core';
import type { PresentationStealth } from '@fluxus/assets';
import type { EntityView, ModelInstanceView } from '@fluxus/render';
import { STATS } from './sim.js';

/** Документированные умолчания секции `stealth` (FOW-13, PRES-2). */
export const STEALTH_TINT_DEFAULTS = Object.freeze({
  allyOpacity: 0.55,
  enemyOpacity: 0.18,
});

/** Вход подачи: покадровые доступы к доставке и инстансам — как у шаров заряда. */
export interface StealthTintOptions {
  /** Доставленные сущности кадра; undefined — доставки ещё нет. */
  readonly entities: () => ReadonlyMap<EntityId, EntityView> | undefined;
  /** Инстанс сущности в кадре подсистемы моделей; null — рисовать ещё нечего. */
  readonly instanceFor: (entity: EntityId) => ModelInstanceView | null;
  /** Сущность своего героя (handshake воркера); null — handshake ещё не пришёл. */
  readonly heroId: () => EntityId | null;
  /** Секция `stealth` парного документа; нет секции — умолчания. */
  readonly stealth?: PresentationStealth;
}

export interface StealthTint {
  /** Кадровое обновление — после подсистем, по инстансам ЭТОГО кадра. */
  update(): void;
}

/** Что и на каком инстансе затонировано — чтобы вернуть как было. */
interface TintRecord {
  readonly model: NonNullable<ModelInstanceView['model']>;
  readonly originals: readonly { readonly opacity: number; readonly transparent: boolean }[];
  value: number;
}

export function createStealthTint(options: StealthTintOptions): StealthTint {
  const allyOpacity = options.stealth?.allyOpacity ?? STEALTH_TINT_DEFAULTS.allyOpacity;
  const enemyOpacity = options.stealth?.enemyOpacity ?? STEALTH_TINT_DEFAULTS.enemyOpacity;
  const tinted = new Map<EntityId, TintRecord>();

  /** Вернуть материалам инстанса исходную подачу и забыть запись. */
  function restore(entity: EntityId): void {
    const record = tinted.get(entity);
    if (record === undefined) return;
    tinted.delete(entity);
    // Инстанс мог смениться или уйти вместе с сущностью: чужие материалы не
    // трогаем — их исходные значения уже не наши.
    if (options.instanceFor(entity)?.model !== record.model) return;
    record.model.materials.forEach((material, index) => {
      const original = record.originals[index];
      if (original === undefined) return;
      material.opacity = original.opacity;
      material.transparent = original.transparent;
    });
  }

  function apply(entity: EntityId, value: number): void {
    const model = options.instanceFor(entity)?.model ?? null;
    if (model === null) {
      // Батчевый ярус или заглушка: подачи нет, но и хвоста записи не держим.
      restore(entity);
      return;
    }
    const held = tinted.get(entity);
    if (held !== undefined && held.model !== model) restore(entity);
    const record = tinted.get(entity);
    if (record === undefined) {
      // Copy-on-write материалов (REND-6): непрозрачность одного инстанса не
      // должна красить соседей, разделяющих материалы ассета.
      if (!model.ownsMaterials) model.ownTextureTargets();
      const originals = model.materials.map((material) => ({
        opacity: material.opacity,
        transparent: material.transparent,
      }));
      model.materials.forEach((material, index) => {
        material.transparent = true;
        material.opacity = originals[index]!.opacity * value;
      });
      tinted.set(entity, { model, originals, value });
      return;
    }
    if (record.value === value) return;
    record.model.materials.forEach((material, index) => {
      material.opacity = record.originals[index]!.opacity * value;
    });
    record.value = value;
  }

  return {
    update(): void {
      const views = options.entities();
      if (views === undefined) {
        for (const entity of [...tinted.keys()]) restore(entity);
        return;
      }
      const hero = options.heroId();
      const myTeam = hero === null ? undefined : views.get(hero)?.stats?.get(STATS.team);
      // Детекция команды зрителя — OR доставленных свёрток союзников (FOW-13).
      let teamDetection = 0;
      if (myTeam !== undefined) {
        for (const view of views.values()) {
          if (view.stats?.get(STATS.team) !== myTeam) continue;
          teamDetection |= view.stats.get(STATS.detectionMask) ?? 0;
        }
      }
      for (const entity of [...tinted.keys()]) {
        if (!views.has(entity)) restore(entity);
      }
      for (const [entity, view] of views) {
        const mask = (view.stats?.get(STATS.stealthMask) ?? 0) | 0;
        if (mask === 0) {
          restore(entity);
          continue;
        }
        const ally = myTeam !== undefined && view.stats?.get(STATS.team) === myTeam;
        if (ally) {
          apply(entity, allyOpacity);
        } else if ((mask & ~teamDetection) !== 0) {
          apply(entity, enemyOpacity);
        } else {
          // Вскрыт детекцией команды — обычная подача.
          restore(entity);
        }
      }
    },
  };
}
