/**
 * Контент-пак клиента и сервера: сцены, адресуемые ссылкой (NTR-5).
 *
 * Хеш пака — вычислимая половина версии игры (NET-16, NET-17) и считается
 * функцией ядра `contentPackHash`, а не своей: двух разных способов хешировать
 * данные в движке быть не должно (NET-17).
 *
 * Ограничение MVP осознанное: пак содержит ровно одну сцену. `contentPackHash`
 * — чистая функция ОДНОГО конфига сцены, и склейка хешей нескольких сцен в один
 * потребовала бы нормы (в каком порядке, каким способом), которой в NET-17 нет.
 * Изобрести её здесь значило бы завести второй способ хеширования — ровно то,
 * что требование запрещает. Многосценовый пак — отдельный change со своей нормой.
 */
import { contentPackHash, type SceneDef } from '@game-mvp/core';
import type { ContentPack } from '../client/matchClient.js';

export interface LoadedContentPack extends ContentPack {
  /** Вычислимая половина версии игры (NET-17). */
  readonly hash: string;
  readonly refs: readonly string[];
}

export function contentPack(scenes: Readonly<Record<string, SceneDef>>): LoadedContentPack {
  const refs = Object.keys(scenes);
  if (refs.length !== 1) {
    throw new Error(
      `контент-пак MVP содержит ровно одну сцену, получено ${refs.length}: ` +
        'склейка хешей нескольких сцен не нормирована (NET-17) и вводится отдельным change\'ем',
    );
  }
  const only = scenes[refs[0]!]!;
  return {
    hash: contentPackHash(only),
    refs,
    scene: (sceneRef) => scenes[sceneRef],
  };
}
