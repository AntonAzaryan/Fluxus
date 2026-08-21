/**
 * Реестр мозгов по имени (BOT-2): единственное место, где сборка выбирает
 * реализацию за контрактом.
 *
 * Нужен он ровно потому, что фабрика — функция, а через границу воркера ездят
 * данные: init-сообщение называет мозг именем, воркер разворачивает имя в
 * фабрику. Появление обученного мозга — новая запись здесь и новое имя в
 * профиле сборки; хостинг, клиент и протокол не меняются (BOT-2).
 *
 * Реализаций две, и нужны они разному. `evaluated` — мозг по умолчанию (BOT-8):
 * универсальный evaluator, чья политика приезжает документом контента.
 * `scripted` — «иди в центр»: вторая реализация контракта (тест заменимости) и
 * детерминированный бот интеграционных прогонов.
 *
 * Данные сцены реестр требует, а не досочиняет: центр арены живёт в ассете
 * сцены (`arena` ARENA-1), а не в компоненте, и умолчание «начало координат»
 * на арене со смещённым центром означало бы бота, бегущего за край. Тем же
 * путём и по тем же основаниям приезжают рельеф (`terrainView.ts`) и документ
 * поведения (BOT-8): дерево контента читает игра, а не движок (CONT-4). Темпа
 * матча здесь нет — он приезжает мозгу в `BotSelf.tickRate` из `Welcome` его
 * собственного клиента (NTR-7).
 */
import type { BotBehaviorDocument } from '../behavior.js';
import type { BotBrainFactory } from '../brain.js';
import type { BotTerrain } from '../terrainView.js';
import type { WorldViewNames } from '../worldView.js';
import { evaluatedBrain } from './evaluated/evaluatedBrain.js';
import type { ArenaCenter } from './layers/plan.js';
import { scriptedBrain } from './scripted.js';

export const BRAIN_KINDS = ['evaluated', 'scripted'] as const;

export type BrainKind = (typeof BRAIN_KINDS)[number];

/** Что сборка обязана сообщить мозгу о сцене, на которой он играет. */
export interface BrainAssembly {
  /** Центр арены сцены (ARENA-1): цель отступления и «иди в центр». */
  readonly center: ArenaCenter;
  /**
   * Документ поведения (BOT-8): политика выбора действий. Обязателен для
   * `evaluated` и бессмыслен для `scripted` — тот ничего не выбирает.
   */
  readonly behavior?: BotBehaviorDocument;
  /**
   * Рельеф сцены (TERR-1, TERR-3): по нему мозг решает, брать ли уступ прыжком.
   * Необязателен — сцена без террейна законна (DI-3), и обрывов в ней нет.
   */
  readonly terrain?: BotTerrain;
  /** Имена компонентов сцены (TICK-4); умолчания — как у клиента. */
  readonly names?: WorldViewNames;
}

const BUILDERS: Readonly<Record<BrainKind, (assembly: BrainAssembly) => BotBrainFactory>> = {
  evaluated: (assembly) => {
    // Мозг без документа не конструируется вовсе (BOT-8): молчаливое умолчание
    // означало бы политику, зашитую кодом, — ровно то, что документ отменяет.
    if (assembly.behavior === undefined) {
      throw new Error('brainFactoryByKind: мозгу "evaluated" не передан документ поведения (BOT-8)');
    }
    return evaluatedBrain({
      behavior: assembly.behavior,
      center: assembly.center,
      ...(assembly.terrain !== undefined ? { terrain: assembly.terrain } : {}),
      ...(assembly.names !== undefined ? { names: assembly.names } : {}),
    });
  },
  scripted: (assembly) =>
    scriptedBrain({
      target: assembly.center,
      ...(assembly.names !== undefined ? { names: assembly.names } : {}),
    }),
};

export function brainFactoryByKind(kind: BrainKind, assembly: BrainAssembly): BotBrainFactory {
  const build = BUILDERS[kind];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- имя приезжает данными init-сообщения, а не из типа
  if (build === undefined) throw new Error(`brainFactoryByKind: неизвестный мозг "${kind}"`);
  return build(assembly);
}
