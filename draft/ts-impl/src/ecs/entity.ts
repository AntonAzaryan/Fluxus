/**
 * Entity: плоская структура сущности для miniplex
 * { id: bigint } & Partial<все компоненты>
 */

import { ComponentTypes } from '../components/types';

/**
 * Базовая сущность с id
 */
export interface BaseEntity {
  id: bigint; // u64
}

/**
 * Полная сущность: id + все возможные компоненты (опционально)
 */
export type Entity = BaseEntity & Partial<ComponentTypes>;

/**
 * Тип для фабрик архетипов
 */
export type ArchetypeFactory<T extends Partial<ComponentTypes> = {}> = (overrides?: Partial<T>) => Partial<ComponentTypes>;
