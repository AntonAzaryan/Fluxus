/**
 * Реестр мозгов по имени (BOT-2): единственное место, где сборка выбирает
 * реализацию за контрактом.
 *
 * Нужен он ровно потому, что фабрика — функция, а через границу воркера ездят
 * данные: init-сообщение называет мозг именем, воркер разворачивает имя в
 * фабрику. Появление обученного мозга — новая запись здесь и новое имя в
 * профиле сборки; хостинг, клиент и протокол не меняются (BOT-2).
 *
 * Данные сцены реестр требует, а не досочиняет: центр арены живёт в ассете
 * сцены (`arena` ARENA-1), а не в компоненте, и умолчание «начало координат»
 * на арене со смещённым центром означало бы бота, бегущего за край. Темпа матча
 * здесь нет — он приезжает мозгу в `BotSelf.tickRate` из `Welcome` его
 * собственного клиента (NTR-7).
 */
import type { BotBrainFactory } from '../brain.js';
import type { WorldViewNames } from '../worldView.js';
import { classicBrain } from './classic/classicBrain.js';
import type { ArenaCenter } from './classic/utility.js';
import { scriptedBrain } from './scripted.js';

export const BRAIN_KINDS = ['classic', 'scripted'] as const;

export type BrainKind = (typeof BRAIN_KINDS)[number];

/** Что сборка обязана сообщить мозгу о сцене, на которой он играет. */
export interface BrainAssembly {
  /** Центр арены сцены (ARENA-1): цель отступления и «иди в центр». */
  readonly center: ArenaCenter;
  /** Имена компонентов сцены (TICK-4); умолчания — как у клиента. */
  readonly names?: WorldViewNames;
}

const BUILDERS: Readonly<Record<BrainKind, (assembly: BrainAssembly) => BotBrainFactory>> = {
  classic: (assembly) =>
    classicBrain({
      center: assembly.center,
      ...(assembly.names !== undefined ? { names: assembly.names } : {}),
    }),
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
