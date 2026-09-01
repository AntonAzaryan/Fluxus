/**
 * Компонент инстанса (BUFF-1), предкомпиляция определений баффов (BUFF-2) и
 * подключение платформы баффов загрузчиком (SER-7).
 *
 * Второго набора правил у баффов нет: проверка определения, её класс ошибок и
 * место (загрузка, а не первое срабатывание) нормируются наравне со
 * способностями (ABIL-10), и тесты здесь ровно об этом.
 */
import { describe, expect, it } from 'vitest';
import { componentNames, componentSchema } from '../src/ecs/world.js';
import * as fixed from '../src/math/fixed.js';
import {
  ABILITY_COMPONENTS,
  ABILITY_SLOT_COMPONENT,
  BUFF_COMPONENTS,
  BUFF_INSTANCE_COMPONENT,
  BUFF_INSTANCE_SCHEMA,
  NO_BUFF_CLASS,
} from '../src/systems/abilities/components.js';
import {
  BUFF_NEGATIVE,
  BUFF_POSITIVE,
  STACKING_INDEPENDENT,
  STACKING_REFRESH,
  STACKING_STACK,
  type AbilityDef,
  type BuffDef,
} from '../src/systems/abilities/model.js';
import { compileAbilityCatalog } from '../src/systems/abilities/catalog.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { FIXED_ONE, NO_ENTITY } from '../src/types.js';

const BASE: SceneDef['components'] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Input', fields: { buttons: 'i32', prevButtons: 'i32' } },
  { name: 'Player', fields: { slot: 'i32' } },
];

const SLOW: BuffDef = {
  id: 'slow',
  class: 'negative',
  durationTicks: 120,
  stacking: 'refresh',
  statMods: [{ component: 'TimeScaleModifiers', value: fixed.fromFloat(0.5) }],
};

function scene(extra: Partial<SceneDef> = {}): SceneDef {
  return { components: BASE, timeScale: true, buffs: [SLOW], ...extra };
}

// ------------------------------------------------------------- компонент

describe('Инстанс баффа — обычный компонент (BUFF-1)', () => {
  it('состав полей: цель, источник, определение, класс, остаток, стаки, счётчик и снятие', () => {
    expect(Object.keys(BUFF_INSTANCE_SCHEMA.fields).sort()).toEqual([
      'buffId',
      'class',
      'dispelled',
      'periodicTicks',
      'remaining',
      'source',
      'stacks',
      'target',
    ]);
    for (const type of Object.values(BUFF_INSTANCE_SCHEMA.fields)) {
      expect(['i32', 'fixed', 'entity']).toContain(type);
    }
  });

  it('умолчания: ссылок нет, класса ещё нет', () => {
    expect(BUFF_INSTANCE_SCHEMA.defaults?.target).toBe(NO_ENTITY);
    expect(BUFF_INSTANCE_SCHEMA.defaults?.source).toBe(NO_ENTITY);
    expect(BUFF_INSTANCE_SCHEMA.defaults?.class).toBe(NO_BUFF_CLASS);
    expect(NO_BUFF_CLASS).toBe(0);
  });

  it('коды класса нормативны: положительный — единица, отрицательный — двойка (BUFF-2)', () => {
    expect(BUFF_POSITIVE).toBe(1);
    expect(BUFF_NEGATIVE).toBe(2);
  });
});

// ------------------------------------------------------------ компиляция

describe('Предкомпиляция определений баффов (BUFF-2)', () => {
  it('плоское представление: срезы общих массивов и коды видов', () => {
    const dot: BuffDef = {
      id: 'poison',
      class: 'negative',
      durationTicks: 90,
      stacking: 'stack',
      maxStacks: 5,
      periodic: { everyTicks: 30, do: [{ emitEvent: { type: 'Tick' } }] },
      triggers: [{ type: 'Collision', as: 'hit', do: [{ emitEvent: { type: 'Proc' } }] }],
      onExpire: [{ emitEvent: { type: 'Gone' } }],
    };
    const catalog = loadScene(scene({ buffs: [SLOW, dot] })).abilities!;

    expect(catalog.buffs).toHaveLength(2);
    expect(catalog.buffIndex.get('slow')).toBe(0);
    expect(catalog.buffIndex.get('poison')).toBe(1);

    const slow = catalog.buffs[0]!;
    expect(slow.klass).toBe(BUFF_NEGATIVE);
    expect(slow.stacking).toBe(STACKING_REFRESH);
    expect(slow.statStart).toBe(0);
    expect(slow.statCount).toBe(1);
    expect(catalog.statMods[0]!.component).toBe('TimeScaleModifiers');

    // Второе определение встаёт срезом за первым — дерева на бафф нет.
    const poison = catalog.buffs[1]!;
    expect(poison.stacking).toBe(STACKING_STACK);
    expect(poison.statStart).toBe(1);
    expect(poison.statCount).toBe(0);
    expect(poison.triggerStart).toBe(0);
    expect(poison.triggerCount).toBe(1);
    expect(catalog.buffTriggers[0]!.as).toBe('hit');
    expect(poison.periodic).toHaveLength(1);
    expect(poison.onExpire).toHaveLength(1);
  });

  it('умолчания у политики нет: молчание документа — ошибка загрузки (BUFF-3)', () => {
    // Политику называет определение: умолчание, выбранное платформой, было бы
    // решением ядра о геймплее — «два наложения дают два инстанса» и «второе
    // продлевает первый» суть разные способности.
    const plain = { id: 'plain', class: 'positive' } as unknown as BuffDef;
    expect(() => loadScene(scene({ buffs: [plain] }))).toThrow(
      /бафф "plain"\.stacking: определение обязано называть политику стакинга/,
    );
  });

  it('имя события реакции по умолчанию — `event` (BUFF-5)', () => {
    const plain: BuffDef = {
      id: 'plain',
      class: 'positive',
      stacking: 'independent',
      triggers: [{ type: 'Hit', do: [] }],
    };
    const catalog = loadScene(scene({ buffs: [plain] })).abilities!;
    expect(catalog.buffs[0]!.stacking).toBe(STACKING_INDEPENDENT);
    expect(catalog.buffTriggers[0]!.as).toBe('event');
  });

  it('вида баффа платформа не хранит: поля-перечисления вида в представлении нет (BUFF-7)', () => {
    const catalog = loadScene(scene()).abilities!;
    expect(Object.keys(catalog.buffs[0]!)).not.toContain('kind');
    expect(Object.keys(catalog.buffs[0]!)).not.toContain('aura');
  });

  it('отсутствие длительности — постоянный бафф, а не нулевая (BUFF-2)', () => {
    const passive: BuffDef = { id: 'passive', class: 'positive', stacking: 'independent' };
    const catalog = loadScene(scene({ buffs: [passive] })).abilities!;
    expect(catalog.buffs[0]!.durationTicks).toBeUndefined();
  });
});

// -------------------------------------------------- проверки загрузки

describe('Проверки загрузки определений баффов (BUFF-2, ABIL-10)', () => {
  const failing = (buff: Partial<BuffDef>, extra: Partial<SceneDef> = {}): (() => void) => {
    const def: BuffDef = { ...SLOW, ...buff };
    return () => loadScene(scene({ buffs: [def], ...extra }));
  };

  it('неизвестное имя действия — ошибка загрузки, называющая бафф и место', () => {
    expect(failing({ onExpire: [{ emitEvnet: { type: 'Gone' } }] as never })).toThrow(
      /бафф "slow"\.onExpire\[0\]: неизвестное действие "emitEvnet"/,
    );
  });

  it('неизвестный оператор выражения — ошибка загрузки', () => {
    expect(failing({ durationTicks: { nope: [1] } })).toThrow(
      /бафф "slow"\.durationTicks: неизвестный оператор "nope"/,
    );
  });

  it('ссылка на незарегистрированный компонент — ошибка загрузки', () => {
    expect(
      failing({ onExpire: [{ removeComponent: { entity: { var: 'target' }, component: 'Ghost' } }] }),
    ).toThrow(/компонент "Ghost" не зарегистрирован/);
  });

  it('класс вне закрытого набора — ошибка загрузки, перечисляющая словарь', () => {
    expect(failing({ class: 'neutral' as never })).toThrow(
      /бафф "slow"\.class: неизвестное значение "neutral"; допустимы: negative, positive/,
    );
  });

  it('политика вне закрытого набора — ошибка загрузки', () => {
    expect(failing({ stacking: 'queue' as never })).toThrow(/допустимы: independent, refresh, stack/);
  });

  it('политика `stack` без потолка — ошибка загрузки (BUFF-3)', () => {
    // Потолка нет как ключа: `SLOW` его не объявляет, и перекрывается только
    // политика. Ключ со значением `undefined` документом невыразим вовсе.
    expect(failing({ stacking: 'stack' })).toThrow(
      /политика "stack" требует потолка стаков в поле "maxStacks"/,
    );
  });

  it('периодика без периода — ошибка загрузки (BUFF-5)', () => {
    expect(failing({ periodic: { do: [] } as never })).toThrow(
      /блок периодики требует периода в тиках/,
    );
  });

  it('«список источников не подключён конфигом сцены» — ошибка загрузки (BUFF-4)', () => {
    // Та же сцена без `timeScale`: компонент списка в мир не дописан, и правка
    // осталась бы правкой без эффекта.
    expect(() =>
      loadScene({ components: BASE, buffs: [SLOW] }),
    ).toThrow(/список источников "TimeScaleModifiers" сцена не подключает \(TIME-7, SER-7\)/);
  });

  it('статовая правка без значения — ошибка загрузки', () => {
    expect(failing({ statMods: [{ component: 'TimeScaleModifiers' } as never] })).toThrow(
      /статовая правка требует значения-выражения/,
    );
  });

  it('неизвестная переменная в периодике — ошибка загрузки, а не молчаливый undefined', () => {
    expect(
      failing({ periodic: { everyTicks: 10, do: [{ emitEvent: { type: 'T', data: { v: { var: 'owner' } } } }] } }),
    ).toThrow(/переменная "owner" не связана/);
  });

  it('имя события связано только в реакции, его объявившей', () => {
    expect(
      failing({ onExpire: [{ emitEvent: { type: 'T', data: { v: { eventField: [{ var: 'hit' }, 'x'] } } } }] }),
    ).toThrow(/переменная "hit" не связана/);
    expect(
      failing({
        triggers: [
          {
            type: 'Collision',
            as: 'hit',
            do: [{ emitEvent: { type: 'T', data: { v: { eventField: [{ var: 'hit' }, 'nx'] } } } }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('дубль идентификатора определения — ошибка загрузки', () => {
    expect(() => loadScene(scene({ buffs: [SLOW, SLOW] }))).toThrow(
      /определение "slow" объявлено дважды/,
    );
  });

  it('опечатка в ветке, до которой прогон мог бы и не дойти, ловится на загрузке', () => {
    expect(
      failing({ onExpire: [{ if: { cond: false, then: [{ destroyEntitty: { entity: { var: 'self' } } }] } }] as never }),
    ).toThrow(/неизвестное действие "destroyEntitty"/);
  });
});

// ------------------------------------------------------ подключение сценой

describe('Загрузчик подключает платформу баффов составом сцены (SER-7)', () => {
  it('компонент инстанса дописывается ПОСЛЕ компонентов платформы способностей', () => {
    const ability: AbilityDef = { id: 'bolt', trigger: { input: { bit: 0 } }, effects: [] };
    const { world } = loadScene(scene({ abilities: [ability] }));
    const names = componentNames(world);
    expect(names.at(-1)).toBe(BUFF_INSTANCE_COMPONENT);
    expect(names.indexOf(ABILITY_SLOT_COMPONENT)).toBeLessThan(names.indexOf(BUFF_INSTANCE_COMPONENT));
    expect(names.slice(-1 - ABILITY_COMPONENTS.length)).toEqual([
      ...ABILITY_COMPONENTS.map((s) => s.name),
      ...BUFF_COMPONENTS.map((s) => s.name),
    ]);
  });

  it('система баффов стоит на нормативном месте шкалы (DET-9)', () => {
    const { systems } = loadScene(scene());
    const places = new Map(systems.ordered().map((system) => [system.name, system.order]));
    expect(places.get('Buff')).toBe(820);
  });

  it('сцена с `buffs` без `abilities` законна: систем способностей в ней нет (SER-7)', () => {
    const { systems, world } = loadScene(scene());
    expect(systems.ordered().map((system) => system.name)).toEqual(['TimeScale', 'Buff']);
    expect(componentSchema(world, ABILITY_SLOT_COMPONENT)).toBeUndefined();
    expect(componentSchema(world, BUFF_INSTANCE_COMPONENT)).toBeDefined();
  });

  it('сцена без `buffs` не меняется ни компонентом, ни системой', () => {
    const bare = loadScene({ components: BASE });
    expect(componentSchema(bare.world, BUFF_INSTANCE_COMPONENT)).toBeUndefined();
    expect(bare.systems.ordered()).toHaveLength(0);
    expect(bare.abilities).toBeUndefined();
  });

  it('нейтральное значение свободного слота списка — единица Q16.16 (TIME-7)', () => {
    const { world } = loadScene(scene());
    expect(componentSchema(world, 'TimeScaleModifiers')!.defaults?.value0).toBe(FIXED_ONE);
  });

  it('компиляция вне загрузчика — та же чистая функция над тем же миром', () => {
    const loaded = loadScene(scene());
    const catalog = compileAbilityCatalog({ buffs: [SLOW] }, loaded.world);
    expect(catalog.buffs).toHaveLength(1);
    expect(catalog.abilities).toHaveLength(0);
  });
});
