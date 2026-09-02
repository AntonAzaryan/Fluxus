/**
 * Guard-проверка полноты учёта ресурсов GPU (`cli-testing` CLI-8,
 * `performance-budget` PERF-9): каждое создание геометрии, материала, текстуры
 * и цели отрисовки в `src/` обязано проходить через `own(...)` — и `new`, и
 * `clone()`. Копия материала — такое же создание ресурса, как конструктор: у
 * неё свои буферы и своя программа, и отдаёт её тот же владелец (REND-31).
 *
 * Инвариант «после сноса живых ноль» (`lifetime.test.ts`) держится ровно на
 * этом: он проверяет то, что УЧТЕНО, и ресурс, заведённый мимо учёта, прошёл бы
 * его молча. Поэтому полноту стережёт механическая проверка исходника, а не
 * память автора теста — тем же способом, каким CLI-8 держит честными списки
 * guard-проверок ядра.
 *
 * Сканер общий — `engine/tests/guard/scanner.ts`; здесь конфигурация пакета
 * (что сканируется и какие исключения приняты) и тесты самого правила.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatViolations,
  scanResourceOwnership,
  scanResourceOwnershipInSource,
  type GuardException,
} from '../../tests/guard/scanner.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Точечные исключения правила: файл целиком освобождается от него, причина
 * обязательна. Сегодня их нет ни одного, и это не «список забыли завести»:
 * временные ресурсы, живущие ровно вызов, проходят учёт наравне с остальными и
 * отдаются тут же (`overlays.ts`, куб-источник рёбер рамки), а ресурсы, которые
 * строит чужой код, через `new` не создаются вовсе и учитываются в точке
 * владения (`particleEffects.ts`, граф эффекта из `QuarksLoader`).
 *
 * Приёмники `clone()`, чья копия ресурсом не является (граф объектов эффекта,
 * генератор значений библиотеки), объявлены СВОИМ списком в самом правиле —
 * точечно, по приёмнику, а не целым файлом: файл частиц заводит и ресурсы тоже.
 */
const EXCEPTIONS: readonly GuardException[] = [];

describe('guard: полнота учёта ресурсов GPU (PERF-9, CLI-8)', () => {
  it('в src/ нет создания ресурса мимо own(...)', () => {
    expect(formatViolations(scanResourceOwnership({ rootDir: SRC, exceptions: EXCEPTIONS }))).toBe(
      '',
    );
  });

  it('исключения правила точечные и с причиной', () => {
    for (const exception of EXCEPTIONS) {
      expect(exception.rule, exception.file).toBe('gpu-resource-ownership');
      expect(exception.reason.length, exception.file).toBeGreaterThan(10);
    }
  });
});

describe('guard: сканер ловит создание ресурса мимо учёта (CLI-8)', () => {
  it('голое создание краснит с файлом, строкой и видом ресурса', () => {
    const source = '\nconst g = new THREE.BufferGeometry();\n';
    const [violation] = scanResourceOwnershipInSource('subsystems/foo.ts', source);
    expect(violation?.file).toBe('subsystems/foo.ts');
    expect(violation?.line).toBe(2);
    expect(violation?.rule).toBe('gpu-resource-ownership');
    expect(violation?.message).toContain('geometry');
    expect(violation?.message).toContain('engine/tests/guard/scanner.ts');
  });

  it('обёрнутое в own(...) не краснит — ни первым аргументом, ни третьим', () => {
    const wrapped = "const g = own('geometry', 'terrain', new THREE.BufferGeometry());";
    expect(scanResourceOwnershipInSource('x.ts', wrapped)).toHaveLength(0);
    // Вложенное создание внутри уже обёрнутого выражения — своё создание, и
    // учтено оно тоже обязано быть своим `own`: иначе куб-источник рёбер прошёл
    // бы мимо счёта, а живое число после сноса сошлось бы с нулём ошибочно.
    const nested = "own('geometry', 'x', new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)));";
    expect(scanResourceOwnershipInSource('x.ts', nested)).toHaveLength(1);
    const both =
      "own('geometry', 'x', new THREE.EdgesGeometry(own('geometry', 'x', new THREE.BoxGeometry(1, 1, 1))));";
    expect(scanResourceOwnershipInSource('x.ts', both)).toHaveLength(0);
  });

  it('каждый вид ресурса ловится своим именем', () => {
    const cases: readonly [string, string][] = [
      ['new THREE.PlaneGeometry(1, 1)', 'geometry'],
      ['new THREE.MeshStandardMaterial({})', 'material'],
      ['new THREE.DataTexture(data, 1, 1)', 'texture'],
      ['new THREE.WebGLRenderTarget(1, 1)', 'renderTarget'],
    ];
    for (const [expression, kind] of cases) {
      const violations = scanResourceOwnershipInSource('x.ts', `const r = ${expression};`);
      expect(violations, expression).toHaveLength(1);
      expect(violations[0]!.message, expression).toContain(`"${kind}"`);
    }
  });

  it('ресурс без пространства имён ловится так же — правило про класс, а не про импорт', () => {
    expect(scanResourceOwnershipInSource('x.ts', 'const m = new ShaderMaterial({});')).toHaveLength(
      1,
    );
  });

  it('не-ресурсы не краснят: правило про то, у чего есть dispose', () => {
    const source = [
      'const v = new THREE.Vector3();',
      'const m = new THREE.Mesh(geometry, material);',
      'const s = new THREE.Scene();',
      'const g = new THREE.Group();',
    ].join('\n');
    expect(scanResourceOwnershipInSource('x.ts', source)).toHaveLength(0);
  });

  it('строки и комментарии не сканируются — это AST, а не grep', () => {
    const source = "// new THREE.BufferGeometry() в комментарии\nconst s = 'new THREE.Texture()';\n";
    expect(scanResourceOwnershipInSource('x.ts', source)).toHaveLength(0);
  });

  it('чужая функция с тем же именем аргумента не считается учётом', () => {
    // Учёт — вызов ИМЕННО `own`: `keep(new THREE.Texture())` ресурс не считает.
    expect(scanResourceOwnershipInSource('x.ts', 'keep(new THREE.Texture());')).toHaveLength(1);
  });

  it('копия ресурса ловится наравне с конструктором: голый clone() краснит', () => {
    // Копия материала — своя программа и свои буферы (REND-6, FOW-8), и мимо
    // учёта она проходила бы невидимой для инварианта «после сноса живых ноль».
    const [violation] = scanResourceOwnershipInSource('x.ts', 'const m = original.clone();');
    expect(violation?.rule).toBe('gpu-resource-ownership');
    expect(violation?.message).toContain('original.clone()');
    expect(scanResourceOwnershipInSource('x.ts', "own('material', 'models', original.clone());")).toHaveLength(0);
  });

  it('приёмник из списка не-ресурсов не краснит — и только он, а не имя вообще', () => {
    // Граф объектов эффекта делит материал и геометрию с образцом (REND-24).
    expect(scanResourceOwnershipInSource('x.ts', 'const o = template.clone();')).toHaveLength(0);
    // Генератор значений библиотеки ресурсом не является вовсе.
    expect(scanResourceOwnershipInSource('x.ts', 'return this.source.clone();')).toHaveLength(0);
    // А `source.clone()` БЕЗ `this` — другой приёмник и другой случай: в
    // `vatMaterial.ts` он копирует материал батча, и прощать его списку нельзя.
    expect(scanResourceOwnershipInSource('x.ts', 'const m = source.clone();')).toHaveLength(1);
  });
});
