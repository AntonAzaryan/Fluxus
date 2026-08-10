/**
 * Guard-проверки инвариантов ядра (CLI-8): весь `src/` в строгом режиме
 * детерминизма, импорты только относительные, манифест без runtime-зависимостей.
 * Сканер общий — engine/tests/guard/scanner.ts; здесь только конфигурация
 * ядра и тесты самого сканера (сценарии CLI-8: нарушение краснит, точная
 * целочисленная операция — нет).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatViolations,
  scanDir,
  scanImports,
  scanImportsInSource,
  scanSourceText,
} from '../../tests/guard/scanner.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG_ROOT, 'src');

describe('guard: детерминизм ядра (CLI-8)', () => {
  it('src/ в строгом режиме: без запрещённых API, float-литералов и async', () => {
    const violations = scanDir({
      rootDir: SRC,
      mode: 'strict',
      exceptions: [
        // process.env.NODE_ENV читается один раз при загрузке модуля и лишь
        // включает debug-ассерты; входом в тик не является (DET-5 не про это).
        { file: 'debug.ts', rule: 'forbidden-global', reason: 'DEBUG-флаг из NODE_ENV на загрузке модуля' },
      ],
    });
    expect(formatViolations(violations)).toBe('');
  });

  it('импорты src/ только относительные: чужие пакеты досягаемы через общий node_modules, но запрещены', () => {
    expect(formatViolations(scanImports({ rootDir: SRC }))).toBe('');
  });

  it('манифест ядра не объявляет runtime-зависимостей (CORE-1)', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg.dependencies).toBeUndefined();
  });
});

describe('guard: сканер ловит каждый вид нарушения (CLI-8)', () => {
  it('wall-clock и таймеры краснят', () => {
    expect(scanSourceText('x.ts', 'const t = Date.now();', 'strict')).toHaveLength(1);
    expect(scanSourceText('x.ts', 'const t = performance.now();', 'pure-cycle')).toHaveLength(1);
    expect(scanSourceText('x.ts', 'setTimeout(() => {}, 0);', 'pure-cycle')).toHaveLength(1);
  });

  it('чужая случайность и трансцендентные краснят в обоих режимах', () => {
    expect(scanSourceText('x.ts', 'const r = Math.random();', 'pure-cycle')).toHaveLength(1);
    expect(scanSourceText('x.ts', 'const s = Math.sqrt(2);', 'strict')).toHaveLength(1);
    expect(scanSourceText('x.ts', 'const c = crypto.getRandomValues(buf);', 'strict')).toHaveLength(1);
  });

  /**
   * DET-2 называет запрещённое поимённо: «Функции libm хост-языка — `sqrt`,
   * `sin`, `cos`, `pow`, `exp`, `log` и прочие — MUST NOT вызываться в симуляции
   * ни при каких условиях». Проверка механическая (CLI-8), а не «глазами»: без
   * неё правка `MATH_ALLOWED` тихо открыла бы любую из них.
   */
  it('весь названный DET-2 список libm краснит в ОБОИХ режимах', () => {
    for (const name of ['sqrt', 'sin', 'cos', 'pow', 'exp', 'log', 'random']) {
      for (const mode of ['strict', 'pure-cycle'] as const) {
        const violations = scanSourceText('x.ts', `const v = Math.${name}(1);`, mode);
        expect(violations, `${name} в режиме ${mode}`).toHaveLength(1);
        expect(violations[0]!.rule).toBe('math-api');
      }
    }
  });

  it('float-литерал краснит только в строгом режиме, hex с e-цифрой — нигде', () => {
    expect(scanSourceText('x.ts', 'const a = 0.5;', 'strict')).toHaveLength(1);
    expect(scanSourceText('x.ts', 'const a = 1e3;', 'strict')).toHaveLength(1);
    expect(scanSourceText('x.ts', 'const a = 0.5;', 'pure-cycle')).toHaveLength(0);
    expect(scanSourceText('x.ts', 'const z = 0x9e3779b9;', 'strict')).toHaveLength(0);
  });

  it('точные целочисленные операции не дают ложного срабатывания', () => {
    const src = 'const a = Math.min(1, 2) + Math.max(3, 4) + Math.abs(-5) + Math.floor(6) + Math.imul(7, 8);';
    expect(scanSourceText('x.ts', src, 'strict')).toHaveLength(0);
  });

  it('async/await/Promise краснят в строгом режиме', () => {
    expect(scanSourceText('x.ts', 'async function f() {}', 'strict')).toHaveLength(1);
    expect(scanSourceText('x.ts', 'const p = Promise.resolve(1);', 'strict')).toHaveLength(1);
    // Тип Promise<void> — не значение: ловим исполнение, а не сигнатуры.
    expect(scanSourceText('x.ts', 'declare function f(): Promise<void>;', 'strict')).toHaveLength(0);
  });

  it('строки и комментарии не сканируются — это AST, а не grep', () => {
    const src = `const s = 'Q16.16 и Date.now()'; // Math.random() в комментарии\n`;
    expect(scanSourceText('x.ts', src, 'strict')).toHaveLength(0);
  });

  it('нерелятивный импорт краснит, относительный — нет', () => {
    expect(scanImportsInSource('x.ts', "import ws from 'ws';")).toHaveLength(1);
    expect(scanImportsInSource('x.ts', "import { tick } from './sim/tick.js';")).toHaveLength(0);
    expect(scanImportsInSource('x.ts', "import { readFileSync } from 'node:fs';")).toHaveLength(1);
  });

  it('нарушение указывает файл, строку и путь к конфигу', () => {
    const [v] = scanSourceText('systems/foo.ts', '\nconst t = Date.now();', 'strict');
    expect(v!.file).toBe('systems/foo.ts');
    expect(v!.line).toBe(2);
    expect(v!.message).toContain('engine/tests/guard/scanner.ts');
  });
});
