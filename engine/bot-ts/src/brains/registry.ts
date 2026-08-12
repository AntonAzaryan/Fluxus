/**
 * Реестр мозгов по имени (BOT-2): единственное место, где сборка выбирает
 * реализацию за контрактом.
 *
 * Нужен он ровно потому, что фабрика — функция, а через границу воркера ездят
 * данные: init-сообщение называет мозг именем, воркер разворачивает имя в
 * фабрику. Появление обученного мозга — новая запись здесь и новое имя в
 * профиле сборки; хостинг, клиент и протокол не меняются (BOT-2).
 */
import type { BotBrainFactory } from '../brain.js';
import { classicBrain } from './classic/classicBrain.js';
import { walkToCenter } from './scripted.js';

export const BRAIN_KINDS = ['classic', 'scripted'] as const;

export type BrainKind = (typeof BRAIN_KINDS)[number];

const FACTORIES: Readonly<Record<BrainKind, BotBrainFactory>> = {
  classic: classicBrain(),
  scripted: walkToCenter,
};

export function brainFactoryByKind(kind: BrainKind): BotBrainFactory {
  const factory = FACTORIES[kind];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- имя приезжает данными init-сообщения, а не из типа
  if (factory === undefined) throw new Error(`brainFactoryByKind: неизвестный мозг "${kind}"`);
  return factory;
}
