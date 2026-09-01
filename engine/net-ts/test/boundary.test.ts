/**
 * Граница модуля (NTR-1). Проверяется сборкой, а не ревью: ядро о сети не знает
 * (DI-3), и обратный импорт обязан быть невозможен физически.
 *
 * Второе проверяемое здесь — что появление сетевого слоя не расширило
 * мутирующую поверхность ядра. Хелпер, добавленный в ядро «для сети», и есть
 * тот side-channel, который TICK-3 объявляет несуществующим (NTR-1).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Путь берётся `fileURLToPath`, а не `URL.pathname`: у `file:`-адреса на
 * Windows `pathname` — это `/D:/Fluxus/...`, и `join` с него начинает второй
 * абсолютный путь (`D:\D:\Fluxus\...`). Проверка границы падала бы на ENOENT,
 * ни разу не заглянув в исходники.
 */
const CORE_ROOT = fileURLToPath(new URL('../../core-ts/', import.meta.url));

function coreSources(): string[] {
  return readdirSync(join(CORE_ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => join(CORE_ROOT, 'src', entry));
}

describe('зависимость односторонняя', () => {
  it('у ядра нет рантайм-зависимостей вообще', () => {
    const manifest = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('ни один исходник ядра не ссылается на сетевой модуль', () => {
    const offenders = coreSources().filter((file) => readFileSync(file, 'utf8').includes('@fluxus/net'));
    expect(offenders).toEqual([]);
  });
});

/**
 * Модули ECS, чьи ЗНАЧЕНИЯ мутируют мир: хранилище и командный буфер. Типы из
 * них публиковать можно — тип не мутирует; значение — нет.
 */
const MUTATING_MODULES = /\/ecs\/(commands|world)\.js$/;

/**
 * Имена, публикация которых расширила бы мутирующую поверхность ядра. Перечень
 * тот же, что `index.ts` объявляет внутренним у себя в шапке (TICK-3), и
 * состоит он из трёх частей: операции над миром (`spawn`…`addTag`), служебные
 * операции жизненного цикла хранилища (`createWorld`, `fromPlain`,
 * `copyWorldInto`, `clearDirty`, `componentMasks` — последняя отдаёт живой
 * `Uint32Array` состава компонентов, то есть запись в него мимо команд) и
 * фабрика, отдающая мутаторы все разом (`createCommandBuffer` плюс `flush()`,
 * применяющий накопленное к миру немедленно).
 */
const MUTATOR_MEMBERS = new Set([
  'spawn',
  'destroy',
  'setField',
  'addComponent',
  'removeComponent',
  'addTag',
  'createWorld',
  'fromPlain',
  'copyWorldInto',
  'clearDirty',
  'componentMasks',
  'createCommandBuffer',
]);

/**
 * Единственный мутатор ECS-уровня, который ЭКСПОРТИРУЕТСЯ: расстановка
 * `worldInit` до первого тика (исключение 1 TICK-3), названная по своей области.
 *
 * Экспортируемых исключений у TICK-3 два, но второе — применение снапшота
 * (исключения 2 и 4) — живёт в `sim/tick.ts`, работает состоянием целиком и ни
 * одной операции из `MUTATOR_MEMBERS` наружу не выносит, поэтому этой проверке
 * границы оно не предмет.
 */
const SANCTIONED_EXPORT = 'worldInitSpawn';

/** Публичная поверхность ядра как AST: разбор точный, а не «похоже на строку». */
function coreIndex(): ts.SourceFile {
  const path = join(CORE_ROOT, 'src/index.ts');
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** Локальные имена значений, ввезённых из модулей ECS-мутации. */
function mutatingBindings(sf: ts.SourceFile): {
  namespaces: Set<string>;
  named: Map<string, string>;
} {
  const namespaces = new Set<string>();
  const named = new Map<string, string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!MUTATING_MODULES.test(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    // `import type * as … from` рантайм-имени не заводит. Признак берётся
    // `phaseModifier`, а не устаревшим `isTypeOnly` (TS 5.9): у отложенного
    // импорта (`import defer`) тот же слот, и различает их именно ключевое слово.
    if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        // Ключ — местное имя, значение — имя В МОДУЛЕ: переименование при ввозе
        // (`createCommandBuffer as mk`) не должно уводить проверку от предмета.
        named.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    }
  }
  return { namespaces, named };
}

/** Ре-экспорт значения из модуля ECS-мутации: `export {…} from`, `export * from`. */
function valueReexports(sf: ts.SourceFile): string[] {
  const offenders: string[] = [];
  for (const statement of sf.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!MUTATING_MODULES.test(statement.moduleSpecifier.text)) continue;
    if (statement.isTypeOnly) continue;
    const clause = statement.exportClause;
    // `export { type A, type B } from …` — тоже только типы, хотя сам оператор
    // типовым не объявлен.
    if (clause !== undefined && ts.isNamedExports(clause) && clause.elements.every((e) => e.isTypeOnly)) {
      continue;
    }
    offenders.push(statement.getText(sf).replace(/\s+/g, ' '));
  }
  return offenders;
}

/**
 * Публикация мутатора ПРИСВАИВАНИЕМ: `export const commandBuffer =
 * createCommandBuffer` либо `export const spawnAny = worldModule.spawn`. Именно
 * этой формой уходит наружу единственное исключение требования, поэтому она
 * разрешена ровно одному имени.
 */
function assignedMutators(sf: ts.SourceFile): string[] {
  const { namespaces, named } = mutatingBindings(sf);
  const offenders: string[] = [];

  const scan = (exported: string, node: ts.Node): void => {
    const visit = (child: ts.Node): void => {
      if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression)) {
        if (namespaces.has(child.expression.text) && MUTATOR_MEMBERS.has(child.name.text)) {
          offenders.push(`${exported} = ${child.getText(sf)}`);
        }
      }
      if (ts.isIdentifier(child)) {
        const inModule = named.get(child.text);
        if (inModule !== undefined && MUTATOR_MEMBERS.has(inModule)) {
          offenders.push(`${exported} = ${child.text}`);
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  };

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(sf);
        if (name === SANCTIONED_EXPORT || declaration.initializer === undefined) continue;
        scan(name, declaration.initializer);
      }
    }
    if (ts.isFunctionDeclaration(statement) && isExported(statement) && statement.body !== undefined) {
      scan(statement.name?.text ?? '(анонимная функция)', statement.body);
    }
  }
  return offenders;
}

describe('поверхность ядра не расширялась', () => {
  it('мутирующий хелпер остался ровно один — worldInitSpawn', () => {
    const index = readFileSync(join(CORE_ROOT, 'src/index.ts'), 'utf8');
    const exportedMutators = ['spawn', 'destroy', 'setField', 'addComponent', 'removeComponent', 'addTag']
      .filter((name) => new RegExp(`^\\s*export (const|function) ${name}\\b`, 'm').test(index));
    expect(exportedMutators).toEqual([]);
    expect(index).toContain('export const worldInitSpawn');
  });

  /**
   * Тот же запрет, но по имени экспорта не поймать: фабрика
   * `createCommandBuffer` называется иначе, а отдаёт ровно те пять операций
   * сразу — и `flush()`, применяющий их к миру немедленно. Поэтому правило
   * шире перечня имён и покрывает обе формы публикации: ре-экспорт из модулей
   * ECS-мутации (наружу уходят только ТИПЫ) и присваивание ввезённого мутатора
   * в `export const` — идиому, которой пользуется само `index.ts` для
   * единственного исключения TICK-3 (`worldInitSpawn`), и потому разрешённую
   * ровно этому имени.
   *
   * Полностью механическим сторожем это не делает: фабрика, написанная в
   * `index.ts` своим телом и не ввезённая из этих модулей, мимо разбора
   * пройдёт. Последний рубеж на такой случай — эталон публичной поверхности
   * (`engine/core-ts/test/api-surface.golden.json`, CLI-8): новое имя в
   * рантайм-экспортах краснит его и принимается только явной регенерацией на
   * ревью.
   */
  it('мутатор не публикуется ни ре-экспортом, ни присваиванием (TICK-3)', () => {
    const sf = coreIndex();
    expect(valueReexports(sf)).toEqual([]);
    expect(assignedMutators(sf)).toEqual([]);
  });

  /**
   * Сам сторож проверяется на подделках: правило, которое ничего не ловит,
   * зелено по той же причине, что и правило, которому нечего ловить.
   */
  it('сторож ловит обе формы и не краснит на действующем index.ts (CLI-8)', () => {
    const fake = (source: string): ts.SourceFile =>
      ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);

    const reexport = fake("export { createCommandBuffer } from './ecs/commands.js';\n");
    expect(valueReexports(reexport)).toHaveLength(1);
    expect(valueReexports(fake("export * from './ecs/world.js';\n"))).toHaveLength(1);
    expect(valueReexports(fake("export type { CommandBufferHandle } from './ecs/commands.js';\n"))).toEqual([]);

    const assigned = fake(
      "import { createCommandBuffer } from './ecs/commands.js';\n" +
        'export const commandBuffer = createCommandBuffer;\n',
    );
    expect(assignedMutators(assigned)).toHaveLength(1);

    const aliased = fake(
      "import { createCommandBuffer as mk } from './ecs/commands.js';\n" +
        'export const buffer = (world) => mk(world);\n',
    );
    expect(assignedMutators(aliased)).toHaveLength(1);

    const viaNamespace = fake(
      "import * as worldModule from './ecs/world.js';\n" +
        'export const spawnAny = worldModule.spawn;\n',
    );
    expect(assignedMutators(viaNamespace)).toHaveLength(1);

    // Служебные операции хранилища — тот же запрет и тот же довод (TICK-3):
    // перечень сторожа обязан покрывать весь список, объявленный внутренним в
    // шапке `index.ts`, а не только пять операций над сущностями.
    const lifecycle = fake(
      "import * as worldModule from './ecs/world.js';\n" +
        'export const rebuild = worldModule.copyWorldInto;\n' +
        'export const masks = worldModule.componentMasks;\n',
    );
    expect(assignedMutators(lifecycle)).toHaveLength(2);

    // Исключение TICK-3 под своим именем — законно; чтение мира — тоже.
    const sanctioned = fake(
      "import * as worldModule from './ecs/world.js';\n" +
        'export const worldInitSpawn = worldModule.spawn;\n' +
        'export const world = { getField: worldModule.getField } as const;\n',
    );
    expect(assignedMutators(sanctioned)).toEqual([]);
  });

  it('сетевой слой обходится опубликованной поверхностью', () => {
    // Импорт из глубины ядра (`@fluxus/core/src/...`) означал бы, что граница
    // держится на честном слове, а не на экспортах.
    const netRoot = fileURLToPath(new URL('../src/', import.meta.url));
    const offenders = readdirSync(netRoot, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts'))
      .filter((entry) => readFileSync(join(netRoot, entry), 'utf8').includes('@fluxus/core/'));
    expect(offenders).toEqual([]);
  });
});
