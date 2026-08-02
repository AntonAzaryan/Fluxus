/** Обязательная зависимость ядра (DI-2): реализация MathApi поверх fixed.ts/vector.ts. */
import * as fixed from './fixed.js';
import type { MathApi } from '../types.js';
import * as vector from './vector.js';

export const mathApi: MathApi = {
  fromInt: fixed.fromInt,
  toInt: fixed.toInt,
  fromFloat: fixed.fromFloat,
  toFloat: fixed.toFloat,
  add: fixed.add,
  sub: fixed.sub,
  mul: fixed.mul,
  div: fixed.div,
  abs: fixed.abs,
  min: fixed.min,
  max: fixed.max,
  clamp: fixed.clamp,
  sqrt: fixed.sqrt,
  vec: {
    add: vector.add,
    sub: vector.sub,
    scale: vector.scale,
    dot: vector.dot,
    lengthSq: vector.lengthSq,
    length: vector.length,
    normalize: vector.normalize,
  },
};
