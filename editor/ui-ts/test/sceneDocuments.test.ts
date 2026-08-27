/**
 * ED-15: «изображение SHALL быть производным от текущего состояния
 * редактируемых документов… Тикающей симуляции в режиме правки MUST NOT быть».
 *
 * Проверяется сама производная — то, что редактор отдаёт рендеру: набор
 * инстансов (REND-11), сетка террейна (REND-14) и карта кривизны (REND-9).
 * Кадра здесь нет и быть не может: WebGL в прогоне пакета нет, а подделывать
 * картинку тестом бессмысленно — она либо совпадает с игровой (ED-1), либо
 * никакой тест этого не докажет.
 *
 * Настоящая сцена репозитория проверяется отдельно: `content/scenes/duel.scene.json`
 * обязана открываться и давать сетку, иначе «вьюпорт работает» означало бы
 * «работает на фикстуре».
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEditorSession, createOperationRegistry, registerBuiltinOperations } from '@fluxus/editor-core';
import {
  curvatureOf,
  placementsOf,
  sceneDraft,
  terrainOf,
  visualsOf,
} from '../src/areas/sceneDocuments.js';
import { FIXTURE_CURVATURE, FIXTURE_SCENE, FIXTURE_VISUALS } from './support/project.js';

const visuals = visualsOf(FIXTURE_VISUALS);

/** Копия фикстуры: тест правит документ, а не общий объект. */
const sceneCopy = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(FIXTURE_SCENE)) as Record<string, unknown>;

/** Файл дерева контента репозитория: путь от его корня — он же ID ассета. */
const contentFile = (path: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../content/${path}`, import.meta.url)), 'utf8'),
  );

describe('ED-15, REND-14: сетка террейна — производная конфига сцены', () => {
  it('сетку считает ядро: уровни, рампы и cliff-геометрия приезжают уже выведенными', () => {
    const grid = terrainOf(FIXTURE_SCENE);
    expect(grid?.width).toBe(4);
    expect(grid?.height).toBe(4);
    // Плато уровня 1 в углу — значит между ним и низиной есть обрывы (TERR-5).
    expect(grid?.cliffs.length).toBeGreaterThan(0);
    // Клетка без пола осталась клеткой без пола (TERR-6).
    expect([...(grid?.floor ?? [])].filter((bit) => bit === 0)).toHaveLength(1);
  });

  it('правка уровня клетки даёт другую сетку — её и отдают подсистеме целиком', () => {
    const before = terrainOf(FIXTURE_SCENE);
    const edited = sceneCopy();
    (edited.terrain as { levels: string[] }).levels = ['1111', '0000', '0011', '0011'];
    const after = terrainOf(edited);
    expect(after).not.toBe(before);
    expect(after?.levels[0]).toBe(1);
    expect(before?.levels[0]).toBe(0);
    expect(after?.cliffs.length).not.toBe(before?.cliffs.length);
  });

  it('сцена без террейна — не ошибка: сетки просто нет', () => {
    const edited = sceneCopy();
    delete edited.terrain;
    expect(terrainOf(edited)).toBeNull();
  });
});

describe('ED-15, REND-11: набор инстансов — производная расстановки', () => {
  it('запись расстановки становится инстансом с позицией, посчитанной ядром', () => {
    const placements = placementsOf({ config: FIXTURE_SCENE, visuals, keys: ['a', 'b'] });
    expect(placements.map((item) => item.prefab)).toEqual(['Hero', 'Crate']);
    expect(placements.map((item) => item.key)).toEqual(['a', 'b']);
    // 98304 в Q16.16 — это 1.5 мировых единицы: значение поля prefab'а, а не
    // число, которое редактор посчитал сам.
    expect(placements[0]?.x).toBeCloseTo(1.5, 6);
    expect(placements[1]?.x).toBeCloseTo(2.5, 6);
  });

  it('визуальный тип — ключ манифеста; записи без записи манифеста не рисуются', () => {
    const placements = placementsOf({ config: FIXTURE_SCENE, visuals, keys: ['a', 'b'] });
    expect(placements[0]?.kind).toBe('Hero');
    // `Crate` в манифесте не назван — рендеру он приедет как «не рисуется»
    // (REND-11), а не пропадёт из набора: в навигаторе он есть.
    expect(placements[1]?.kind).toBeNull();
  });

  it('уровень под объектом — ответ ядра, а не пересчёт в редакторе (TERR-4)', () => {
    const edited = sceneCopy();
    (edited.prefabs as { name: string; components: { Position: { x: number; y: number } } }[])[0]!
      .components.Position = { x: 229376, y: 229376 };
    const placements = placementsOf({ config: edited, visuals });
    // (3.5, 3.5) лежит на плато уровня 1.
    expect(placements[0]?.level).toBe(1);
  });

  it('правка позиции даёт новый набор с теми же ключами — инстанс обновится, а не пересоздастся', () => {
    const keys = ['a', 'b'];
    const before = placementsOf({ config: FIXTURE_SCENE, visuals, keys });
    const edited = sceneCopy();
    (edited.initial as { prefab: string; overrides?: unknown }[])[0] = {
      prefab: 'Hero',
      overrides: { Position: { x: 262144 } },
    };
    const after = placementsOf({ config: edited, visuals, keys });
    expect(after.map((item) => item.key)).toEqual(before.map((item) => item.key));
    expect(after[0]?.x).toBeCloseTo(4, 6);
    expect(after[0]?.x).not.toBe(before[0]?.x);
  });

  it('удаление записи убирает её ключ из набора — источник уберёт инстанс сам', () => {
    const edited = sceneCopy();
    (edited.initial as unknown[]).splice(0, 1);
    const placements = placementsOf({ config: edited, visuals, keys: ['b'] });
    expect(placements.map((item) => item.key)).toEqual(['b']);
    expect(placements[0]?.prefab).toBe('Crate');
  });

  it('носители сцены не путаются с расстановкой ни при каком наборе ассетов (SER-7)', () => {
    // Соответствие «запись #i ↔ живая сущность #(носители + i)» держится на
    // нормативном порядке спавна: сперва носители порождённых компонентов,
    // затем расстановка. Носителей у сцены столько, сколько ассетов их
    // порождает, поэтому проверяются все сочетания: появление `arena` в сцене
    // не имеет права переназначить объекты друг другу молча.
    const arena = { center: { x: 131072, y: 131072 }, radius: 196608 };
    const base = placementsOf({ config: FIXTURE_SCENE, visuals, keys: ['a', 'b'] });
    const variants: Record<string, unknown>[] = [
      { arena },
      { fog: true },
      { timeScale: true },
      { tweens: [] },
      { arena, fog: true, timeScale: true, tweens: [] },
    ];
    for (const extra of variants) {
      const edited = { ...sceneCopy(), ...extra };
      const placements = placementsOf({ config: edited, visuals, keys: ['a', 'b'] });
      expect(placements.map((item) => item.prefab), JSON.stringify(extra)).toEqual([
        'Hero',
        'Crate',
      ]);
      expect(placements.map((item) => item.x), JSON.stringify(extra)).toEqual(
        base.map((item) => item.x),
      );
    }
  });

  it('сцена без террейна тоже сходится: носителей нет, записи идут первыми', () => {
    const edited = sceneCopy();
    delete edited.terrain;
    const placements = placementsOf({ config: edited, visuals, keys: ['a', 'b'] });
    expect(placements.map((item) => item.prefab)).toEqual(['Hero', 'Crate']);
    // Уровня под объектом без террейна нет — и выдумывать его редактор не станет.
    expect(placements[0]?.level).toBe(0);
  });

  it('пустая расстановка — пустой набор, и ядро для этого не поднимается', () => {
    const edited = sceneCopy();
    delete edited.initial;
    expect(placementsOf({ config: edited, visuals })).toEqual([]);
  });
});

describe('ED-16: где у объекта позиция — настройка проекта, а не имя в редакторе', () => {
  /** Тот же контент, но позицию несёт другой компонент с другими полями. */
  const otherwiseNamed = (): Record<string, unknown> => {
    const edited = sceneCopy();
    edited.components = [{ name: 'Placement', fields: { east: 'fixed', north: 'fixed' } }];
    edited.prefabs = [
      { name: 'Hero', tags: ['Hero'], components: { Placement: { east: 98304, north: 98304 } } },
      { name: 'Crate', tags: ['Crate'], components: { Placement: { east: 163840, north: 98304 } } },
    ];
    return edited;
  };

  it('привязка проекта читается вместо конвенции ядра', () => {
    const placements = placementsOf({
      config: otherwiseNamed(),
      visuals,
      position: { component: 'Placement', x: 'east', y: 'north' },
    });
    expect(placements[0]?.x).toBeCloseTo(1.5, 6);
    expect(placements[1]?.x).toBeCloseTo(2.5, 6);
  });

  it('без привязки редактор берёт конвенцию ядра и позиции не выдумывает', () => {
    // Компонента конвенции в этой сцене нет — и объект честно оказывается в
    // начале координат, а не там, где редактор угадал бы по имени поля.
    expect(placementsOf({ config: otherwiseNamed(), visuals })[0]?.x).toBe(0);
    expect(placementsOf({ config: FIXTURE_SCENE, visuals })[0]?.x).toBeCloseTo(1.5, 6);
  });
});

describe('ED-11, REND-9: карта кривизны приходит документом, а не ассетом', () => {
  it('значение документа разбирается модулем ассетов', () => {
    const map = curvatureOf(FIXTURE_CURVATURE);
    expect(map?.width).toBe(4);
    expect(map?.height).toBe(4);
  });

  it('несовпадение алфавита — названная причина, а не молчаливый ноль', () => {
    expect(() => curvatureOf({ width: 4, height: 4, rows: ['zzzz', '....', '....', '....'] })).toThrow();
  });

  it('карты нет — плоские ступени, не ошибка', () => {
    expect(curvatureOf(null)).toBeNull();
    expect(curvatureOf(undefined)).toBeNull();
  });
});

describe('ED-8, ED-15: сломанный документ оставляет кадр, а не роняет вьюпорт', () => {
  it('битая карта уровней гасит сетку и называет причину, расстановку не трогая', () => {
    const edited = sceneCopy();
    (edited.terrain as { levels: string[] }).levels = ['00', '00'];
    const draft = sceneDraft({ config: edited, visuals });
    expect(draft.grid).toBeNull();
    expect(draft.failure).toContain('levels');
  });

  it('битая расстановка гасит набор, но сетка остаётся нарисованной', () => {
    const edited = sceneCopy();
    (edited.initial as { prefab: string }[])[0] = { prefab: 'ЧегоНет' };
    const draft = sceneDraft({ config: edited, visuals });
    expect(draft.grid).not.toBeNull();
    expect(draft.placements).toEqual([]);
    expect(draft.failure).not.toBeNull();
  });

  it('целые документы причин не дают', () => {
    const draft = sceneDraft({ config: FIXTURE_SCENE, visuals, curvature: FIXTURE_CURVATURE });
    expect(draft.failure).toBeNull();
    expect(draft.grid).not.toBeNull();
    expect(draft.curvature).not.toBeNull();
    expect(draft.placements).toHaveLength(2);
  });
});

describe('ED-15: настоящая сцена дерева контента, а не только фикстура', () => {
  const config = contentFile('scenes/duel.scene.json') as { terrain: { width: number } };
  const manifest = visualsOf(contentFile('visuals/manifest.json'));
  const curvature = contentFile(manifest.terrain?.curvatureMap ?? '');

  it('конфиг сцены репозитория открывается и даёт сетку с обрывами', () => {
    const draft = sceneDraft({
      config,
      visuals: manifest,
      curvature,
    });
    expect(draft.failure).toBeNull();
    expect(draft.grid?.width).toBe(config.terrain.width);
    expect(draft.grid?.cliffs.length).toBeGreaterThan(0);
  });

  it('карта кривизны манифеста совпадает с сеткой арены — холм будет виден', () => {
    const draft = sceneDraft({
      config,
      visuals: manifest,
      curvature,
    });
    expect(draft.curvature?.width).toBe(draft.grid?.width);
    expect(draft.curvature?.height).toBe(draft.grid?.height);
  });

  it('расстановка конфига сцены доезжает до вьюпорта как есть', () => {
    // Не «вьюпорт ничего не рисует»: террейн и кривизна те же, что у игрока.
    // Сегодня в `duel.scene.json` стоит ровно один житель арены — босс
    // (`npc-behavior` NPC-7), — и вьюпорт обязан показать его на том же месте,
    // где его увидит игрок: в центре арены и со своим визуалом манифеста.
    const draft = sceneDraft({ config, visuals: manifest });
    expect(draft.placements.map((entry) => entry.prefab)).toEqual(['Boss']);
    const boss = draft.placements[0]!;
    expect(boss.kind).toBe('Boss');
    expect([boss.x, boss.y]).toEqual([24, 24]);
  });
});

describe('ED-22, REND-34: секции парного документа доезжают до вьюпорта', () => {
  const config = contentFile('scenes/duel.scene.json');
  const presentation = contentFile('scenes/duel.presentation.json');

  it('секции lighting и postprocess настоящей сцены — в кадре вьюпорта как есть', () => {
    const draft = sceneDraft({ config, visuals, presentation });

    // Своей копии чисел у редактора нет: он отдаёт подсистемам ту же секцию,
    // которую читает игровой клиент, — отсюда тождество кадров (ED-22).
    expect(draft.postprocess).toEqual(
      (presentation as { postprocess: unknown }).postprocess,
    );
    expect(draft.lighting).toEqual((presentation as { lighting: unknown }).lighting);
  });

  it('сцена без парного документа — кадр умолчаний, а не отказ', () => {
    const draft = sceneDraft({ config, visuals });

    expect(draft.failure).toBeNull();
    expect(draft.postprocess).toBeUndefined();
  });

  it('сломанная секция гасит только себя: причину назвал разбор декораций (ED-8)', () => {
    const draft = sceneDraft({
      config,
      visuals,
      presentation: { decorations: [], postprocess: { toneMapping: { operator: 'filmic' } } },
    });

    expect(draft.postprocess).toBeUndefined();
    expect(draft.failure).toContain('postprocess.toneMapping.operator');
  });
});

describe('ED-29: производная считается без интерфейса', () => {
  it('ключи набора — дескрипторы сессии, а не индексы списка', () => {
    const session = createEditorSession({
      operations: registerBuiltinOperations(createOperationRegistry()),
    });
    session.openDocument({
      id: 'scenes/fixture.scene.json',
      kind: 'scene',
      value: FIXTURE_SCENE,
      lists: [['initial']],
    });
    const keys = session.descriptors('scenes/fixture.scene.json', ['initial']);
    expect(keys).toHaveLength(2);
    const placements = placementsOf({ config: FIXTURE_SCENE, visuals, keys });
    expect(placements.map((item) => item.key)).toEqual([...keys]);
  });
});
