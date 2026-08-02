/**
 * Генератор LUT для sin/cos/atan2
 * conventions.md §10: 4096 точек на квадрант + линейная интерполяция
 * 
 * Запуск: npm run gen-trig-lut
 * Результат коммитится как src/fixed/trigLut.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 4096 точек на квадрант (0..π/2)
const TABLE_SIZE = 4096;
const SCALE = 65536n;

function toFixed(value: number): bigint {
  return BigInt(Math.round(value * Number(SCALE)));
}

// Генерация таблицы sin для первого квадранта (0..π/2)
function generateSinLut(): bigint[] {
  const lut: bigint[] = [];
  for (let i = 0; i < TABLE_SIZE; i++) {
    const angle = (Math.PI / 2) * (i / TABLE_SIZE);
    const sinValue = Math.sin(angle);
    lut.push(toFixed(sinValue));
  }
  // Добавляем последнюю точку (sin(π/2) = 1.0)
  lut.push(toFixed(1.0));
  return lut;
}

// Генерация таблицы atan для первого квадранта
// atan(ratio) для ratio от 0 до 1
// lut[i] = atan(i / TABLE_SIZE) в fixed-point радианах
function generateAtanLut(): bigint[] {
  const lut: bigint[] = [];
  for (let i = 0; i <= TABLE_SIZE; i++) {
    const ratio = i / TABLE_SIZE;
    const atanValue = Math.atan(ratio);
    lut.push(toFixed(atanValue));
  }
  return lut;
}

// Генерация таблицы cos (просто sin с фазовым сдвигом, но для точности генерируем отдельно)
function generateCosLut(): bigint[] {
  const lut: bigint[] = [];
  for (let i = 0; i < TABLE_SIZE; i++) {
    const angle = (Math.PI / 2) * (i / TABLE_SIZE);
    const cosValue = Math.cos(angle);
    lut.push(toFixed(cosValue));
  }
  lut.push(toFixed(0.0)); // cos(π/2) = 0
  return lut;
}

const sinLut = generateSinLut();
const cosLut = generateCosLut();
const atanLut = generateAtanLut();

// Сериализация BigInt в строку
function serializeBigIntArray(arr: bigint[]): string {
  return '[' + arr.map(x => x.toString() + 'n').join(', ') + ']';
}

// Формирование выходного файла
const output = `/**
 * Lookup tables для sin/cos/atan2
 * Сгенерировано автоматически scripts/gen-trig-lut.ts
 * Не редактировать вручную!
 * 
 * conventions.md §10: 4096 точек на квадрант + линейная интерполяция
 */

export const TABLE_SIZE = ${TABLE_SIZE};

/**
 * Таблица sin для первого квадранта (0..π/2)
 * sinLut[i] = sin(i * π/2 / TABLE_SIZE) в fixed-point
 */
export const SIN_LUT: bigint[] = ${serializeBigIntArray(sinLut)};

/**
 * Таблица cos для первого квадранта (0..π/2)
 * cosLut[i] = cos(i * π/2 / TABLE_SIZE) в fixed-point
 */
export const COS_LUT: bigint[] = ${serializeBigIntArray(cosLut)};

/**
 * Таблица atan для первого квадранта (0..π/2)
 * atanLut[i] = atan(i / TABLE_SIZE * π/2) в fixed-point
 * Используется для atan2 через симметрию
 */
export const ATAN_LUT: bigint[] = ${serializeBigIntArray(atanLut)};
`;

const outputPath = path.join(__dirname, '..', 'src', 'fixed', 'trigLut.ts');
fs.writeFileSync(outputPath, output);

console.log(`LUT сгенерированы: ${outputPath}`);
console.log(`TABLE_SIZE = ${TABLE_SIZE}`);
console.log(`sin(0) = ${sinLut[0]}, sin(π/2) = ${sinLut[sinLut.length - 1]}`);
console.log(`cos(0) = ${cosLut[0]}, cos(π/2) = ${cosLut[cosLut.length - 1]}`);
console.log(`atan(0) = ${atanLut[0]}, atan(∞) = ${atanLut[atanLut.length - 1]}`);
