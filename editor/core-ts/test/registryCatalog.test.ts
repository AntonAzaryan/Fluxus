/**
 * ED-30 «Само-описание и структурная валидация» в части каталога: операции с
 * параметрами, набор рабочих областей и набор типов редактируемого — из тех же
 * реестров (ED-25), из которых строится интерфейс, и без второго описания,
 * поддерживаемого вручную.
 *
 * Доменные имена в фикстурах — намеренно (см. шапку `registry.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { buildEditorCatalog } from '../src/registry/catalog.js';
import { createEditorContributions } from '../src/registry/contributions.js';
import type { DescriptionResolver } from '../src/registry/descriptions.js';
import {
  createOperationRegistry,
  describeOperations,
  type OperationDescription,
} from '../src/operations/registry.js';
import { BUILTIN_OPERATIONS, registerBuiltinOperations } from '../src/operations/builtin.js';
import { EDITOR_BUNDLES, StringResources, catalogDescriptions } from '../src/i18n/index.js';

/**
 * Заглушка бандла `en` (ED-28, слой локалей): цепочка разрешения кончается самим
 * ключом, поэтому неизвестный ключ возвращается как есть.
 */
function resolver(bundle: Record<string, string> = {}): DescriptionResolver {
  return { describe: (key) => bundle[key] ?? key };
}

function noOperations(): readonly OperationDescription[] {
  return [];
}

function sources(overrides?: {
  operations?: () => readonly OperationDescription[];
  descriptions?: DescriptionResolver;
}) {
  const contributions = createEditorContributions();
  contributions.areas.register({
    id: 'scene',
    descriptionKey: 'ui.area.scene',
    hotkey: 'F1',
    editableTypes: [{ id: 'scene', descriptionKey: 'schema.scene', schemaId: 'scene' }],
  });
  contributions.areas.register({
    id: 'objects',
    descriptionKey: 'ui.area.objects',
    hotkey: 'F2',
    editableTypes: [{ id: 'prefab', descriptionKey: 'prefab.document', schemaId: 'prefab' }],
  });
  contributions.viewportTools.register({
    id: 'terrain.raise',
    descriptionKey: 'ui.tool.terrain.raise',
    areas: ['scene'],
  });
  contributions.validationRules.register({
    id: 'height.range',
    descriptionKey: 'ui.rule.heightRange',
    appliesTo: ['scene'],
  });
  return {
    contributions,
    operations: overrides?.operations ?? noOperations,
    descriptions: overrides?.descriptions ?? resolver(),
  };
}

describe('ED-30: машинный каталог', () => {
  it('отдаёт операции с параметрами', () => {
    const catalog = buildEditorCatalog(
      sources({
        operations: () => [
          {
            id: 'placement.add',
            descriptionKey: 'ui.operation.placement.add',
            params: [
              {
                name: 'prefab',
                type: 'string',
                optional: false,
                sessionScoped: false,
                descriptionKey: 'ui.operation.placement.add.prefab',
              },
              {
                name: 'target',
                type: 'descriptor',
                optional: true,
                sessionScoped: true,
                descriptionKey: 'ui.operation.placement.add.target',
              },
            ],
          },
        ],
      }),
    );

    expect(catalog.operations).toHaveLength(1);
    const [operation] = catalog.operations;
    expect(operation?.id).toBe('placement.add');
    expect(operation?.params).toEqual([
      {
        name: 'prefab',
        type: 'string',
        optional: false,
        sessionScoped: false,
        descriptionKey: 'ui.operation.placement.add.prefab',
        description: 'ui.operation.placement.add.prefab',
      },
      {
        name: 'target',
        type: 'descriptor',
        optional: true,
        // Сессионность дескриптора объявлена явно: ссылка, сохранённая между
        // сессиями, недействительна, и каталог обязан это сообщать.
        sessionScoped: true,
        descriptionKey: 'ui.operation.placement.add.target',
        description: 'ui.operation.placement.add.target',
      },
    ]);
  });

  it('берёт операции из реестра слоя операций как есть, без переходника', () => {
    // Шов ED-29 ↔ ED-30: описание операций строит слой операций, каталог его
    // только читает. Тест держит две формы совместимыми — расхождение обязано
    // ломаться здесь, а не у внешнего потребителя каталога.
    const registry = createOperationRegistry();
    registry.register({
      id: 'placement.add',
      descriptionKey: 'ui.operation.placement.add',
      params: {
        target: { type: 'descriptor', optional: true, descriptionKey: 'ui.op.target' },
        document: { type: 'document', descriptionKey: 'ui.op.document' },
      },
      apply: () => undefined,
    });

    const catalog = buildEditorCatalog({
      ...sources(),
      operations: () => describeOperations(registry),
    });

    expect(catalog.operations[0]?.id).toBe('placement.add');
    expect(catalog.operations[0]?.params.map((param) => [param.name, param.sessionScoped])).toEqual([
      ['document', false],
      ['target', true],
    ]);
  });

  it('описания встроенных операций приходят из бандла, а не оказываются ключами', () => {
    // Шов трёх слоёв целиком: реестр операций (ED-29) → каталог (ED-30) →
    // строковые ресурсы (ED-28). Ключ, за которым нет строки, виден как сам
    // ключ — это правильное поведение цепочки, но для операций, которые
    // редактор везёт с собой, это значило бы каталог без описаний.
    const resources = new StringResources({ locale: 'ru', editor: EDITOR_BUNDLES });
    const catalog = buildEditorCatalog({
      ...sources(),
      operations: () => describeOperations(registerBuiltinOperations(createOperationRegistry())),
      descriptions: catalogDescriptions(resources),
    });

    expect(catalog.operations).toHaveLength(BUILTIN_OPERATIONS.length);
    for (const operation of catalog.operations) {
      expect(operation.description).not.toBe(operation.descriptionKey);
      for (const param of operation.params) {
        expect(param.description).not.toBe(param.descriptionKey);
      }
    }
    // Локаль пользователя — русская, каталог всё равно английский: описание для
    // машины и описание для человека на `en` — один текст (ED-30).
    expect(resources.locale).toBe('ru');
    expect(catalog.operations[0]?.description).toBe(
      EDITOR_BUNDLES['en']![catalog.operations[0]!.descriptionKey],
    );
  });

  it('отдаёт области и типы редактируемого из реестров', () => {
    const catalog = buildEditorCatalog(sources());

    expect(catalog.areas).toEqual([
      {
        id: 'objects',
        descriptionKey: 'ui.area.objects',
        description: 'ui.area.objects',
        hotkey: 'F2',
        editableTypes: ['prefab'],
        tools: [],
      },
      {
        id: 'scene',
        descriptionKey: 'ui.area.scene',
        description: 'ui.area.scene',
        hotkey: 'F1',
        editableTypes: ['scene'],
        tools: ['terrain.raise'],
      },
    ]);
    expect(catalog.editableTypes.map((type) => type.id)).toEqual(['prefab', 'scene']);
    expect(catalog.editableTypes[1]).toEqual({
      id: 'scene',
      descriptionKey: 'schema.scene',
      description: 'schema.scene',
      schemaId: 'scene',
      areas: ['scene'],
      validationRules: ['height.range'],
    });
  });

  it('берёт описания из строковых ресурсов и не заводит своих', () => {
    const bundle = {
      'ui.area.scene': 'Scene workspace area',
      'ui.operation.placement.add': 'Adds a record to the initial placement',
    };
    const catalog = buildEditorCatalog(
      sources({
        descriptions: resolver(bundle),
        operations: () => [
          { id: 'placement.add', descriptionKey: 'ui.operation.placement.add', params: [] },
        ],
      }),
    );

    expect(catalog.operations[0]?.description).toBe(bundle['ui.operation.placement.add']);
    expect(catalog.areas.find((area) => area.id === 'scene')?.description).toBe(
      bundle['ui.area.scene'],
    );
    // Ресурса нет — виден сам ключ, а не пустая строка и не выдуманный текст.
    expect(catalog.areas.find((area) => area.id === 'objects')?.description).toBe('ui.area.objects');
  });

  it('строится в момент запроса: новая регистрация видна без правки каталога', () => {
    const built = sources();
    const before = buildEditorCatalog(built);
    expect(before.areas.map((area) => area.id)).toEqual(['objects', 'scene']);

    built.contributions.areas.register({
      id: 'systems',
      descriptionKey: 'ui.area.systems',
      hotkey: 'F3',
      editableTypes: [{ id: 'system', descriptionKey: 'system.document', schemaId: 'system' }],
    });
    built.contributions.validationRules.register({
      id: 'component.exists',
      descriptionKey: 'ui.rule.componentExists',
      appliesTo: ['system'],
    });

    const after = buildEditorCatalog(built);
    expect(after.areas.map((area) => area.id)).toEqual(['objects', 'scene', 'systems']);
    expect(after.editableTypes.find((type) => type.id === 'system')?.validationRules).toEqual([
      'component.exists',
    ]);
    // Прежние записи — те же: расширение не правит уже описанное (ED-25).
    expect(after.areas.slice(0, 2)).toEqual(before.areas);
  });

  it('сливает тип, заявленный двумя областями, и падает на расхождении', () => {
    const type = { id: 'prefab', descriptionKey: 'prefab.document', schemaId: 'prefab' };
    const shared = createEditorContributions();
    shared.areas.register({ id: 'scene', descriptionKey: 'ui.area.scene', editableTypes: [type] });
    shared.areas.register({
      id: 'objects',
      descriptionKey: 'ui.area.objects',
      editableTypes: [type],
    });
    const merged = buildEditorCatalog({
      contributions: shared,
      operations: noOperations,
      descriptions: resolver(),
    });
    expect(merged.editableTypes).toHaveLength(1);
    expect(merged.editableTypes[0]?.areas).toEqual(['objects', 'scene']);

    const diverged = createEditorContributions();
    diverged.areas.register({ id: 'scene', descriptionKey: 'ui.area.scene', editableTypes: [type] });
    diverged.areas.register({
      id: 'objects',
      descriptionKey: 'ui.area.objects',
      editableTypes: [{ ...type, schemaId: 'other' }],
    });
    expect(() =>
      buildEditorCatalog({
        contributions: diverged,
        operations: noOperations,
        descriptions: resolver(),
      }),
    ).toThrow(/тип редактируемого "prefab"/);
  });
});
