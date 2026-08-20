/**
 * Документ поведения (BOT-8, BOT-9): форма, валидация закрытых словарей и
 * скоринг «вход → кривая → вес → полезность».
 *
 * Документы здесь синтетические и живут в тесте: предмет проверки — ФОРМА,
 * которую понимает реализация, а не числа, которые тюнит дизайнер. Референсные
 * документы дерева контента проверяются там же, где профили, — они пара
 * (`profile.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  BOT_BEHAVIOR_SCHEMA,
  BOT_CURVES,
  BOT_EXECUTORS,
  BOT_INPUTS,
  parseBotBehavior,
  type BotBehaviorDocument,
  type BotConsideration,
  type BotCurve,
} from '../src/behavior.js';
import type { PerceivedWorld } from '../src/brains/layers/perception.js';
import {
  actionUtility,
  considerationScore,
  curveValue,
  inputValue,
  scoreDocument,
  type ScoringContext,
} from '../src/brains/evaluated/scoring.js';
import { testBehavior, testProfile } from './fixtures.js';

const RISING: BotCurve = { type: 'linear', slope: 1, intercept: 0 };

/**
 * Документ как СЫРЫЕ данные: находки валидации ловятся на том, что документ
 * приезжает разбору `unknown`'ом, а не типом — иначе половину случаев (чужой
 * вход, чужая кривая, лишнее поле) в тесте нельзя было бы даже записать.
 */
function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(testBehavior() as unknown as Record<string, unknown>), ...overrides };
}

/** Документ с одной осью — стенд для находок валидации. */
function withConsideration(consideration: Record<string, unknown>): Record<string, unknown> {
  return document({ actions: [{ executor: 'pressure', considerations: [consideration] }] });
}

describe('форма документа поведения (BOT-8)', () => {
  it('валидный документ разбирается целиком', () => {
    const parsed = parseBotBehavior(testBehavior());
    expect(parsed.schema).toBe(BOT_BEHAVIOR_SCHEMA);
    expect(parsed.actions.map((action) => action.executor)).toEqual([...BOT_EXECUTORS]);
    expect(parsed.actions[0]!.considerations[0]!.input).toBe('enemyKnown');
  });

  it('переживает round-trip разбора: документ приезжает и через границу воркера', () => {
    const parsed = parseBotBehavior(testBehavior());
    expect(parseBotBehavior(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  /** BOT-8, сценарий «Документ прошлой версии». */
  it('чужая версия формы отвергается находкой, а не тихим умолчанием', () => {
    expect(() => parseBotBehavior(document({ schema: 99 }))).toThrow(/schema: 99/);
  });

  it('версия называется и тогда, когда полей тоже не хватает', () => {
    expect(() => parseBotBehavior({ schema: 99, name: 'future' })).toThrow(/schema: 99/);
  });

  it('не-объект отвергается сразу', () => {
    expect(() => parseBotBehavior(null)).toThrow(/ожидался объект/);
    expect(() => parseBotBehavior('classic')).toThrow(/ожидался объект/);
  });

  it('называет все находки разом, а не первую', () => {
    const broken = document({ name: '' });
    broken.actions = [];
    expect(() => parseBotBehavior(broken)).toThrow(/name/);
    expect(() => parseBotBehavior(broken)).toThrow(/actions/);
  });

  it('документ без действий отвергается: выбирать не из чего', () => {
    expect(() => parseBotBehavior(document({ actions: [] }))).toThrow(/ни одного действия/);
    expect(() => parseBotBehavior({ ...document(), actions: {} })).toThrow(/массив действий/);
  });

  it('исполнитель, объявленный дважды, — находка', () => {
    const twice = document();
    twice.actions = [
      { executor: 'kite', considerations: [{ input: 'enemyKnown', curve: RISING, weight: 1 }] },
      { executor: 'kite', considerations: [{ input: 'enemyKnown', curve: RISING, weight: 1 }] },
    ];
    expect(() => parseBotBehavior(twice)).toThrow(/"kite" объявлен дважды/);
  });
});

/**
 * Словари закрыты (BOT-9): неизвестное имя входа, кривой или исполнителя —
 * находка с самим именем, а не молчаливый ноль. Иначе документ с опечаткой
 * играл бы «почти как задумано», и разбирать это пришлось бы по поведению бота.
 */
describe('закрытые словари документа (BOT-9)', () => {
  it('неизвестный исполнитель отвергается с именем', () => {
    const alien = document();
    alien.actions = [{ executor: 'flank', considerations: [{ input: 'enemyKnown', curve: RISING, weight: 1 }] }];
    expect(() => parseBotBehavior(alien)).toThrow(/executor/);
    expect(() => parseBotBehavior(alien)).toThrow(/"flank"/);
  });

  /** BOT-9, сценарий «Документ называет неизвестный вход». */
  it('неизвестный вход отвергается с именем и путём действия', () => {
    const broken = withConsideration({ input: 'enemyMorale', curve: RISING, weight: 1 });
    expect(() => parseBotBehavior(broken)).toThrow(/actions\[0\]\.considerations\[0\]\.input/);
    expect(() => parseBotBehavior(broken)).toThrow(/"enemyMorale"/);
  });

  it('неизвестная форма кривой отвергается с именем', () => {
    const broken = withConsideration({ input: 'enemyKnown', curve: { type: 'sine' }, weight: 1 });
    expect(() => parseBotBehavior(broken)).toThrow(/curve\.type/);
    expect(() => parseBotBehavior(broken)).toThrow(/"sine"/);
  });

  it('словари называются в находке целиком: дизайнеру видно, из чего выбирать', () => {
    const broken = withConsideration({ input: 'enemyMorale', curve: { type: 'sine' }, weight: 1 });
    for (const input of BOT_INPUTS) expect(() => parseBotBehavior(broken)).toThrow(input);
    for (const curve of BOT_CURVES) expect(() => parseBotBehavior(broken)).toThrow(curve);
  });

  it('пустой список осей — находка: полезность действия не на чем считать', () => {
    const empty = document();
    empty.actions = [{ executor: 'pressure', considerations: [] }];
    expect(() => parseBotBehavior(empty)).toThrow(/пустой список/);
    empty.actions = [{ executor: 'pressure', considerations: {} }];
    expect(() => parseBotBehavior(empty)).toThrow(/массив осей/);
  });

  it('вес вне [0, 1] — находка: произведение обязано остаться в диапазоне', () => {
    expect(() =>
      parseBotBehavior(withConsideration({ input: 'enemyKnown', curve: RISING, weight: 2 })),
    ).toThrow(/weight/);
  });

  it('кулдаун без слота — находка, а слот у чужого входа — тоже', () => {
    expect(() =>
      parseBotBehavior(
        withConsideration({ input: 'abilityCooldownFraction', curve: RISING, weight: 1 }),
      ),
    ).toThrow(/slot/);
    expect(() =>
      parseBotBehavior(
        withConsideration({ input: 'enemyKnown', curve: RISING, weight: 1, slot: 0 }),
      ),
    ).toThrow(/слот осмыслен только у входа/);
  });
});

/** Кривые отклика: значения и обязательный кламп в [0, 1] (BOT-9). */
describe('кривые отклика (BOT-9)', () => {
  it('linear: прямая, зажатая с обеих сторон', () => {
    const curve: BotCurve = { type: 'linear', slope: -2, intercept: 1 };
    expect(curveValue(curve, 0)).toBeCloseTo(1, 12);
    expect(curveValue(curve, 0.25)).toBeCloseTo(0.5, 12);
    // Ниже нуля и выше единицы кривая не отдаёт ничего: диапазон нормативен.
    expect(curveValue(curve, 1)).toBe(0);
    expect(curveValue({ type: 'linear', slope: 5, intercept: 0 }, 1)).toBe(1);
  });

  it('quadratic: сдвиг вершины — поле кривой', () => {
    const curve: BotCurve = { type: 'quadratic', slope: 1, intercept: 0, shift: 1 };
    expect(curveValue(curve, 1)).toBe(0);
    expect(curveValue(curve, 0)).toBeCloseTo(1, 12);
    expect(curveValue(curve, 0.5)).toBeCloseTo(0.25, 12);
  });

  it('logistic: порог с плавными краями, середина — поле кривой', () => {
    const curve: BotCurve = { type: 'logistic', slope: 10, midpoint: 0.5 };
    expect(curveValue(curve, 0.5)).toBeCloseTo(0.5, 12);
    expect(curveValue(curve, 0)).toBeLessThan(0.02);
    expect(curveValue(curve, 1)).toBeGreaterThan(0.98);
  });

  it('constant: вход не читается вовсе', () => {
    expect(curveValue({ type: 'constant', value: 0.25 }, 0)).toBe(0.25);
    expect(curveValue({ type: 'constant', value: 0.25 }, 1)).toBe(0.25);
  });
});

/**
 * Словарь входов (BOT-9): нормировка в [0, 1] — код, и масштаб она берёт из
 * профиля и состояния, а не из документа.
 */
describe('входы considerations (BOT-9)', () => {
  const context: ScoringContext = { profile: testProfile(), center: { x: 0, y: 0 } };

  function world(overrides: Partial<PerceivedWorld> = {}): PerceivedWorld {
    return {
      tick: 100,
      observedTick: 100,
      self: { id: 1, x: 0, y: 0, vx: 0, vy: 0, slot: 1, team: 1 },
      slots: [],
      enemies: [],
      threats: [],
      arenaRadius: 20,
      carrying: false,
      ...overrides,
    };
  }

  function value(input: BotConsideration['input'], scene: PerceivedWorld, slot?: number): number {
    return inputValue(
      { input, curve: RISING, weight: 1, ...(slot === undefined ? {} : { slot }) },
      scene,
      context,
    );
  }

  const enemyAt = (x: number): PerceivedWorld['enemies'][number] => ({
    id: 2, x, y: 0, vx: 0, vy: 0, slot: 0, team: 0, seenTick: 100, visible: true,
  });

  it('enemyDistance нормирован ДВУМЯ дистанциями боя профиля', () => {
    // Дистанция боя тестового профиля — 8: единицу вход отдаёт на шестнадцати.
    expect(value('enemyDistance', world({ enemies: [enemyAt(8)] }))).toBeCloseTo(0.5, 12);
    expect(value('enemyDistance', world({ enemies: [enemyAt(16)] }))).toBe(1);
    expect(value('enemyDistance', world({ enemies: [enemyAt(40)] }))).toBe(1);
    // Врага нет — «дальше некуда»: давить не на кого, и это скажут ворота.
    expect(value('enemyDistance', world())).toBe(1);
  });

  it('enemyKnown не различает видимого и помнимого: знание есть знание (BOT-3)', () => {
    expect(value('enemyKnown', world())).toBe(0);
    expect(value('enemyKnown', world({ enemies: [enemyAt(4)] }))).toBe(1);
    const remembered = { ...enemyAt(4), visible: false };
    expect(value('enemyKnown', world({ enemies: [remembered] }))).toBe(1);
  });

  it('threatDistance считает только СБЛИЖАЮЩИЙСЯ снаряд', () => {
    const closing = { id: 3, x: 4, y: 0, vx: -1, vy: 0, distance: 4, closing: true };
    expect(value('threatDistance', world({ threats: [closing] }))).toBeCloseTo(0.5, 12);
    expect(value('threatClosing', world({ threats: [closing] }))).toBe(1);
    // Улетающий снаряд угрозой не считается ни одним из двух входов.
    const leaving = { ...closing, closing: false };
    expect(value('threatDistance', world({ threats: [leaving] }))).toBe(1);
    expect(value('threatClosing', world({ threats: [leaving] }))).toBe(0);
  });

  it('edgeProximity растёт в запасе до границы арены и достигает единицы на ней', () => {
    const at = (x: number): PerceivedWorld =>
      world({ self: { id: 1, x, y: 0, vx: 0, vy: 0, slot: 1, team: 1 } });
    // Радиус 20, запас профиля 2: до восемнадцати края нет вовсе.
    expect(value('edgeProximity', at(17))).toBe(0);
    expect(value('edgeProximity', at(19))).toBeCloseTo(0.5, 12);
    expect(value('edgeProximity', at(20))).toBe(1);
    // Арены в снапшоте нет — краю неоткуда взяться.
    expect(value('edgeProximity', world({ arenaRadius: undefined }))).toBe(0);
  });

  it('abilityCooldownFraction читает СВОЙ слот из своего снапшота (ABIL-7)', () => {
    const scene = world({ slots: [{ slotIndex: 2, phase: -1, staged: 0, cooldown: 0.75 }] });
    expect(value('abilityCooldownFraction', scene, 2)).toBeCloseTo(0.75, 12);
    // Слота с таким индексом в снапшоте нет — «ничто не мешает».
    expect(value('abilityCooldownFraction', scene, 0)).toBe(0);
  });
});

/**
 * Композиция (BOT-9): полезность действия — произведение оценок, сохраняющее
 * диапазон; ноль на одной оси выключает действие целиком.
 */
describe('полезность действия (BOT-9)', () => {
  const context: ScoringContext = { profile: testProfile(), center: { x: 0, y: 0 } };

  const scene: PerceivedWorld = {
    tick: 10,
    observedTick: 10,
    self: { id: 1, x: 0, y: 0, vx: 0, vy: 0, slot: 1, team: 1 },
    slots: [],
    enemies: [{ id: 2, x: 8, y: 0, vx: 0, vy: 0, slot: 0, team: 0, seenTick: 10, visible: true }],
    threats: [],
    arenaRadius: 20,
    carrying: false,
  };

  it('оценка оси — кривая, взвешенная документом', () => {
    const consideration: BotConsideration = { input: 'enemyDistance', curve: RISING, weight: 0.6 };
    expect(considerationScore(consideration, scene, context)).toBeCloseTo(0.3, 12);
  });

  it('произведение осей: ноль на одной выключает действие', () => {
    const pressure = parseBotBehavior(testBehavior()).actions[0]!;
    expect(actionUtility(pressure, scene, context)).toBeCloseTo(0.3, 12);
    const alone = { ...scene, enemies: [] };
    // Врага нет — ворота `enemyKnown` дают ноль, и всё произведение с ним.
    expect(actionUtility(pressure, alone, context)).toBe(0);
  });

  it('победитель — наибольшая полезность; ничью решает порядок документа', () => {
    const tie: BotBehaviorDocument = parseBotBehavior(
      document({
        actions: [
          { executor: 'kite', considerations: [{ input: 'enemyKnown', curve: RISING, weight: 1 }] },
          { executor: 'dodge', considerations: [{ input: 'enemyKnown', curve: RISING, weight: 1 }] },
        ],
      }),
    );
    expect(scoreDocument(tie, scene, context, 0, false).chosen).toBe('kite');
  });

  /** BOT-9: «когда очков не набрал никто, действует умолчание механизма». */
  it('нулевые очки у всех — умолчание механизма, а не действие документа', () => {
    const nobody = parseBotBehavior(
      document({
        actions: [
          { executor: 'kite', considerations: [{ input: 'threatClosing', curve: RISING, weight: 1 }] },
        ],
      }),
    );
    const decision = scoreDocument(nobody, { ...scene, threats: [] }, context, 0, false);
    expect(decision.utility).toBe(0);
    expect(decision.chosen).toBe('retreat');
  });
});
