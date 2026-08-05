/**
 * Guard-проверка чистых циклов сетевого слоя (CLI-8): код, который NTR-3 и
 * NTR-10 объявляют свободным от часов и ввода-вывода, сканируется в режиме
 * «чистый цикл» — без wall-clock, таймеров и чужой случайности. Хосты и
 * транспорт легально живут во времени и сокетах и под скан не подпадают.
 * Float здесь не запрещён: миллисекунды приходят параметрами и являются
 * данными, а не геймплейной математикой.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatViolations, scanDir } from '../../tests/guard/scanner.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('guard: чистые циклы сетевого слоя (CLI-8, NTR-3, NTR-10)', () => {
  it('server/match/protocol/client/content без хостов и транспорта — режим «чистый цикл»', () => {
    const violations = scanDir({
      rootDir: SRC,
      mode: 'pure-cycle',
      exclude: [
        'index.ts', // barrel: только реэкспорты
        'transport', // сокеты и loopback — граница с внешним миром
        'server/host.ts', // таймер и часы сервера (NTR-3: всё, чего нет в чистом цикле)
        'client/host.ts', // собственный таймер клиента
      ],
    });
    expect(formatViolations(violations)).toBe('');
  });
});
