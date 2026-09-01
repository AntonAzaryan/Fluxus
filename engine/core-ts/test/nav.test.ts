/**
 * Реализация поиска пути (`pathfinding` NAV-1..NAV-10) на сетке террейна:
 * запекание карт, A* по 4-связности, тотальность краёв, зазор под радиус агента
 * и целочисленное сглаживание.
 *
 * Карты здесь синтетические и живут в тесте: предмет проверки — МЕХАНИЗМ, а не
 * числа, которые тюнит дизайнер (тестовые фикстуры движка контентом не
 * являются, CONT-4).
 */
import { describe, expect, it } from 'vitest';
import { bakeNavGrid } from '../src/systems/nav/bake.js';
import { buildNavigation } from '../src/systems/nav/navigation.js';
import { carveFloor, createTerrainGrid, type TerrainDef } from '../src/systems/terrain.js';
import { buildSimulation } from '../src/sim/build.js';
import { restoreSnapshot, takeSnapshot, tick } from '../src/sim/tick.js';
import { withDiagnostics } from '../src/debug.js';
import {
  FIXED_ONE,
  type DiagnosticRecord,
  type DiagnosticsSink,
  type NavigationApi,
  type PathResult,
  type TerrainGrid,
  type Vec2,
} from '../src/types.js';

const ONE = FIXED_ONE;
const HALF = ONE >> 1;

/** Бюджет раскрытий, заведомо больший любой карты этого файла (NAV-5). */
const WIDE_BUDGET = 4096;

/** Сетка из текстовых карт; ряд флагов по умолчанию — обычные клетки (TERR-3). */
function grid(levels: readonly string[], flags?: readonly string[]): TerrainGrid {
  const def: TerrainDef = {
    width: levels[0]!.length,
    height: levels.length,
    tileSize: ONE,
    levels,
    flags: flags ?? levels.map((row) => '.'.repeat(row.length)),
  };
  return createTerrainGrid(def);
}

/** Ровная сетка нулевого уровня по одной карте флагов. */
function plain(flags: readonly string[]): TerrainGrid {
  return grid(
    flags.map((row) => '0'.repeat(row.length)),
    flags,
  );
}

function navigation(terrain: TerrainGrid, budget = WIDE_BUDGET, maxAgentRadius = 0): NavigationApi {
  return buildNavigation(terrain, { budget, maxAgentRadius });
}

/** Центр клетки в мировых координатах — та же точка, что кладёт в путь NAV-10. */
function at(x: number, y: number): Vec2 {
  return { x: x * ONE + HALF, y: y * ONE + HALF };
}

/** Путь в читаемом виде: список пар «клетка», чтобы дифф теста называл клетки. */
function cells(result: PathResult): [number, number][] {
  return result.waypoints.map((point) => [Math.floor(point.x / ONE), Math.floor(point.y / ONE)]);
}

describe('NAV-9: карта зазора печётся из карты проходимости', () => {
  it('зазоры у стены, в коридоре и на открытом поле совпадают с посчитанными вручную', () => {
    // Пять на пять, непроходимая клетка в центре. Край сетки — тоже
    // непроходимость: клетка у края получает зазор один.
    const nav = bakeNavGrid(
      plain([
        '.....',
        '.....',
        '.._..',
        '.....',
        '.....',
      ]),
    );
    const clearance = (x: number, y: number): number => nav.clearance[y * 5 + x]!;

    expect(clearance(2, 2)).toBe(0); // сама непроходимая клетка
    expect(clearance(2, 1)).toBe(1); // вплотную к ней
    expect(clearance(0, 0)).toBe(1); // у края сетки
    expect(clearance(2, 0)).toBe(1); // тоже у края
    // По диагонали от дыры: до неё два шага по сторонам, до края — тоже два.
    expect(clearance(1, 1)).toBe(2);
    // Открытого поля шире двух клеток на этой карте нет: центр занят дырой.
    expect(nav.passable[2 * 5 + 2]).toBe(0);
    expect(nav.passable[0]).toBe(1);
  });

  it('в широком поле зазор растёт вглубь, в узком коридоре остаётся единицей', () => {
    const open = bakeNavGrid(
      plain([
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
      ]),
    );
    expect(open.clearance[2 * 7 + 3]).toBe(3); // середина: три клетки до края
    expect(open.clearance[1 * 7 + 3]).toBe(2);

    const corridor = bakeNavGrid(
      plain([
        '_______',
        '.......',
        '_______',
      ]),
    );
    // Коридор шириной в клетку: зазор единица по всей длине.
    for (let x = 0; x < 7; x++) expect(corridor.clearance[7 + x], `x=${x}`).toBe(1);
  });
});

describe('TERR-7: клетка не мельче диаметра крупнейшего агента', () => {
  const flat = plain(['...', '...', '...']);

  it('сборка с радиусом больше половины клетки отвергается находкой с обоими значениями', () => {
    expect(() => navigation(flat, WIDE_BUDGET, HALF + 1)).toThrow(/TERR-7/);
    expect(() => navigation(flat, WIDE_BUDGET, HALF + 1)).toThrow(
      new RegExp(`${String(ONE)}.*${String(HALF + 1)}`),
    );
  });

  it('радиус ровно в половину клетки принимается', () => {
    expect(() => navigation(flat, WIDE_BUDGET, HALF)).not.toThrow();
  });

  it('бюджет — целое ≥ 1 (NAV-5)', () => {
    expect(() => navigation(flat, 0)).toThrow(/NAV-5/);
    expect(() => navigation(flat, 1.5)).toThrow(/NAV-5/);
  });

  it('запрос с радиусом больше заявленного предела не падает, а отвечает по зазору (NAV-9)', () => {
    // Заявленный предел — половина клетки, а спрашивают вчетверо больше:
    // запрос остаётся тотальным (NAV-5) и честно упирается в зазор.
    const api = navigation(plain(['.....', '.....', '.....']), WIDE_BUDGET, HALF);
    const wide = api.findPath(at(0, 1), at(4, 1), { agentRadius: 2 * ONE });
    expect(wide.status).toBe('unreachable');
    expect(wide.waypoints).toEqual([]);
  });
});

describe('NAV-7: поиск по сетке террейна с 4-связностью', () => {
  it('путь через рампу: перепад проходим только по ней', () => {
    const levels = ['0011', '0011', '0011', '0011'];
    const withRamp = grid(levels, ['....', '.^..', '.^..', '....']);
    const found = navigation(withRamp).findPath(at(0, 0), at(3, 0));
    expect(found.status).toBe('found');

    // Тот же перепад без рампы — обрыв, и цель недостижима (TERR-5).
    const cliff = grid(levels, ['....', '....', '....', '....']);
    expect(navigation(cliff).findPath(at(0, 0), at(3, 0)).status).toBe('unreachable');
  });

  it('диагональный угол не срезается: соседства без общей стороны нет', () => {
    const api = navigation(plain(['._', '_.']));
    expect(api.findPath(at(0, 0), at(1, 1)).status).toBe('unreachable');
  });

  it('цель за непроходимой границей — unreachable с пустым списком (NAV-1)', () => {
    const api = navigation(plain(['._.', '._.', '._.']));
    const result = api.findPath(at(0, 1), at(2, 1));
    expect(result.status).toBe('unreachable');
    expect(result.waypoints).toEqual([]);
  });
});

describe('NAV-8: целочисленная стоимость и нормативный tie-break', () => {
  it('два маршрута равной стоимости: возвращается предписанный порядком соседей', () => {
    // Стена в центре ряда: обойти её можно сверху и снизу за одну и ту же
    // целую стоимость. Сосед СВЕРХУ рассматривается раньше соседа снизу
    // (возрастание линейного индекса), и путь идёт верхом.
    const api = navigation(plain(['.....', '.._..', '.....']));
    const result = api.findPath(at(0, 1), at(4, 1));
    expect(result.status).toBe('found');
    expect(cells(result)).toEqual([
      [2, 0],
      [4, 1],
    ]);
  });

  it('исчерпание бюджета отличимо от недостижимости (NAV-5)', () => {
    const flat = plain(['.........', '.........', '.........']);
    const tight = navigation(flat, 4);
    const result = tight.findPath(at(0, 0), at(8, 2));
    expect(result.status).toBe('budgetExhausted');
    expect(result.waypoints).toEqual([]);
    // Та же карта и тот же запрос с достаточным бюджетом — обычный путь.
    expect(navigation(flat).findPath(at(0, 0), at(8, 2)).status).toBe('found');
  });
});

describe('NAV-5: запрос тотален', () => {
  const api = navigation(plain(['...', '...', '...']));

  it('точка за краем сетки адресует ближайшую клетку, а не бросает', () => {
    const result = api.findPath({ x: -10 * ONE, y: -10 * ONE }, at(2, 2));
    expect(result.status).toBe('found');
    expect(result.waypoints.at(-1)).toEqual(at(2, 2));
  });

  it('совпадение СТАРТА И ЦЕЛИ — found с пустым списком (NAV-1)', () => {
    const here = at(1, 1);
    const result = api.findPath(here, { x: here.x, y: here.y });
    expect(result.status).toBe('found');
    expect(result.waypoints).toEqual([]);
  });

  it('цель в клетке агента, но не в его точке, — путь из самой цели', () => {
    // Клетка одна на двоих, а точки разные: выбросить цель значило бы вернуть
    // `found`, не ведущий никуда (NAV-1 требует последней точкой саму цель).
    const target = { x: ONE + HALF + 1, y: ONE + HALF - 1 };
    const result = api.findPath(at(1, 1), target);
    expect(result.status).toBe('found');
    expect(result.waypoints).toEqual([target]);
  });

  it('старт в непроходимой клетке ищет честно и не бросает', () => {
    const walled = navigation(plain(['._.', '___', '...']));
    // Из дыры, замурованной со всех сторон, выхода нет — это `unreachable`.
    const stuck = walled.findPath(at(1, 0), at(1, 2));
    expect(stuck.status).toBe('unreachable');
    // А из дыры с открытой стороной путь есть: собственная проходимость старта
    // поиску не мешает.
    const open = navigation(plain(['...', '._.', '...']));
    expect(open.findPath(at(1, 1), at(1, 2)).status).toBe('found');
  });

  it('отрицательный радиус читается как отсутствие радиуса', () => {
    const result = api.findPath(at(0, 0), at(2, 2), { agentRadius: -ONE });
    expect(result.status).toBe('found');
  });
});

describe('NAV-10: сглаживание прямой видимости', () => {
  it('прямой коридор даёт единственную точку — цель', () => {
    const api = navigation(plain(['.....']));
    const result = api.findPath(at(0, 0), at(4, 0));
    expect(result.status).toBe('found');
    expect(result.waypoints).toEqual([at(4, 0)]);
  });

  it('Г-образный обход даёт точку у угла и цель, а не цепочку центров клеток', () => {
    // Стена вдоль ряда 1 до последней колонки: путь идёт вправо, огибает её и
    // возвращается влево.
    const api = navigation(plain(['....', '___.', '....']));
    const result = api.findPath(at(0, 0), at(0, 2));
    expect(result.status).toBe('found');
    expect(result.waypoints.length).toBeLessThanOrEqual(3);
    expect(result.waypoints.at(-1)).toEqual(at(0, 2));
    // Ни одна точка не лежит в непроходимой клетке.
    for (const [x, y] of cells(result)) expect([x, y]).not.toEqual([1, 1]);
  });

  it('последняя точка — ТОЧНАЯ цель запроса, а не центр её клетки (NAV-1)', () => {
    const api = navigation(plain(['.....']));
    const corner = { x: 4 * ONE + 1, y: 1 };
    const result = api.findPath(at(0, 0), corner);
    expect(result.waypoints.at(-1)).toEqual(corner);
  });

  it('спорный угол непроходим с обеих сторон', () => {
    // Отрезок из центра (0, 0) в центр (3, 1) проходит РОВНО через точку (2, 1)
    // сетки — общий угол четырёх клеток. Пока все четыре проходимы, он
    // выпрямляется в одну точку; стоит одной из огибающих угол клеток стать
    // дырой — видимость через угол не даётся, и путь сохраняет излом. Ни в ту,
    // ни в другую сторону: правило симметрично.
    const open = navigation(plain(['....', '....']));
    expect(open.findPath(at(0, 0), at(3, 1)).waypoints).toEqual([at(3, 1)]);

    const pinched = navigation(plain(['.._.', '....']));
    const forward = pinched.findPath(at(0, 0), at(3, 1));
    const backward = pinched.findPath(at(3, 1), at(0, 0));
    expect(forward.status).toBe('found');
    expect(backward.status).toBe('found');
    expect(forward.waypoints.length).toBeGreaterThan(1);
    expect(backward.waypoints.length).toBeGreaterThan(1);
  });
});

describe('NAV-9: agentRadius через карту зазора', () => {
  /** Единственный проход — коридор в ОДНУ клетку: его зазор равен единице. */
  const pinch = plain(['.......', '.......', '.......', '___.___', '.......', '.......', '.......']);
  /** Тот же проход шириной в три клетки: зазор его середины — двойка. */
  const wide = plain(['.......', '.......', '.......', '__...__', '.......', '.......', '.......']);
  /** Радиус чуть шире клетки: округление вверх требует двух клеток зазора. */
  const BULKY = ONE + 1;

  it('проход уже агента: с радиусом — unreachable, без него — found', () => {
    const api = navigation(pinch, WIDE_BUDGET, HALF);
    const bulky = api.findPath(at(3, 1), at(3, 5), { agentRadius: BULKY });
    expect(bulky.status).toBe('unreachable');
    expect(bulky.waypoints).toEqual([]);
    // Тот же запрос без радиуса ограничен одной проходимостью клеток.
    expect(api.findPath(at(3, 1), at(3, 5)).status).toBe('found');
  });

  it('тот же агент проходит проход шире: зазор середины допускает его', () => {
    const api = navigation(wide, WIDE_BUDGET, HALF);
    expect(api.findPath(at(3, 1), at(3, 5), { agentRadius: BULKY }).status).toBe('found');
  });

  it('радиус в пределах TERR-7 проходит коридор в одну клетку: клетка не мельче агента', () => {
    const api = navigation(pinch, WIDE_BUDGET, HALF);
    expect(api.findPath(at(3, 1), at(3, 5), { agentRadius: HALF }).status).toBe('found');
  });

  it('агент шире клетки в коридор шириной в клетку не проходит', () => {
    // Зазор `k` означает `(k − ½)` клетки свободного места от центра, поэтому
    // радиус в 0.6 клетки требует уже двух клеток зазора: округление вверх
    // считает полклетки до собственной границы (NAV-9). Простое
    // `ceil(radius / tileSize)` дало бы единицу и пропустило бы агента в проход,
    // в который он не входит.
    const api = navigation(pinch, WIDE_BUDGET, HALF);
    // Радиус — Q16.16, то есть ЦЕЛОЕ (FP-1): дробное значение здесь означало бы
    // величину, которой в симуляции не бывает. 39321 ≈ 0.6 клетки.
    const bulky = 39321;
    expect(api.findPath(at(3, 1), at(3, 5), { agentRadius: bulky }).status).toBe('unreachable');
    expect(navigation(wide, WIDE_BUDGET, HALF).findPath(at(3, 1), at(3, 5), { agentRadius: bulky }).status).toBe(
      'found',
    );
  });
});

describe('NAV-2: запрос чист и детерминирован', () => {
  const map = plain(['.....', '.._..', '.....', '._...', '.....']);

  it('повтор запроса после других запросов даёт побитово тот же путь', () => {
    const api = navigation(map);
    const first = api.findPath(at(0, 0), at(4, 4));
    api.findPath(at(4, 4), at(0, 0));
    api.findPath(at(2, 2), at(0, 4), { agentRadius: HALF });
    const again = api.findPath(at(0, 0), at(4, 4));
    expect(again).toEqual(first);
  });

  it('свежесобранный API отвечает тем же, что и работавший', () => {
    const used = navigation(map);
    for (let i = 0; i < 5; i++) used.findPath(at(i % 5, 0), at(4, 4));
    const fresh = navigation(map);
    expect(used.findPath(at(0, 0), at(4, 4))).toEqual(fresh.findPath(at(0, 0), at(4, 4)));
  });

  it('сборка над той же картой в другом порядке запросов даёт те же байты', () => {
    const a = navigation(map);
    const b = navigation(map);
    const forward = JSON.stringify(a.findPath(at(0, 4), at(4, 0)));
    b.findPath(at(2, 2), at(2, 0));
    expect(JSON.stringify(b.findPath(at(0, 4), at(4, 0)))).toBe(forward);
  });
});

describe('NAV-3: данные производны от ассета и матчем не трогаются', () => {
  /** Ряд из пяти клеток: без пола в середине пути слева направо не было бы. */
  const scene = {
    components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }] as const,
    terrain: { width: 5, height: 1, tileSize: ONE, levels: ['00000'], flags: ['.....'] },
  };

  function built(): ReturnType<typeof buildSimulation> {
    return buildSimulation(
      { scene, seed: 7, navigation: { budget: 256, maxAgentRadius: HALF } },
      { where: 'тест навигации' },
    );
  }

  it('снятый в бою пол невидим для findPath, а перемотка ответов не меняет', () => {
    const { sim, state } = built();
    const api = sim.navigation!;
    const before = api.findPath(at(0, 0), at(4, 0));
    expect(before.status).toBe('found');

    // Пол середины ряда снимается геймплеем (TERR-8): живая карта пола —
    // компонент мира, и навигация его не читает (NAV-7).
    sim.systems.register({
      name: 'SceneCarve',
      order: 10,
      run: (ctx) => {
        if (ctx.tick === 1) carveFloor(ctx, at(2, 0));
      },
    });
    tick(sim, state);
    expect(sim.terrain!.hasFloorAt(at(2, 0))).toBe(false);
    expect(api.findPath(at(0, 0), at(4, 0))).toEqual(before);

    // Перемотка возвращает мир, но навигационных данных не касается вовсе:
    // в снапшоте их нет (NAV-3).
    const snapshot = takeSnapshot(state);
    tick(sim, state);
    restoreSnapshot(state, snapshot);
    expect(api.findPath(at(0, 0), at(4, 0))).toEqual(before);
  });

  it('SER-5: поля "cost" у блока навигации документа прогона не существует', () => {
    // Учёт работы в счётчиках стоимости (PERF-3) выбирает сборка, а не автор
    // документа: опубликованная схема блок закрывает и `cost` не называет, а
    // тихо поддержанное сверх схемы поле сделало бы опубликованный контракт
    // ложным. Отказ адресный — молчаливого игнорирования опечатки не бывает.
    expect(() =>
      buildSimulation(
        {
          scene,
          seed: 7,
          navigation: { budget: 256, maxAgentRadius: HALF, cost: false } as never,
        },
        { where: 'тест навигации' },
      ),
    ).toThrow(/SER-5[\s\S]*cost/);
  });
});

describe('PERF-3: работа навигации видна счётчику navNodes', () => {
  function costOf(body: () => void): number {
    let nodes = 0;
    const sink: DiagnosticsSink = {
      trace: 'systems',
      record: (entry: DiagnosticRecord) => {
        if (entry.code === 'TICK_COST') nodes += Number(entry.data?.navNodes ?? 0);
      },
    };
    withDiagnostics(sink, 1, body);
    return nodes;
  }

  it('счётчик равен раскрытиям плюс пробам и повторяется побитово', () => {
    const api = navigation(plain(['.....', '.._..', '.....']));
    const first = costOf(() => {
      api.findPath(at(0, 1), at(4, 1));
    });
    const second = costOf(() => {
      api.findPath(at(0, 1), at(4, 1));
    });
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
    // Два запроса стоят ровно вдвое: работа запроса — функция карты и
    // аргументов, а не числа предыдущих вызовов (NAV-2).
    const twice = costOf(() => {
      api.findPath(at(0, 1), at(4, 1));
      api.findPath(at(0, 1), at(4, 1));
    });
    expect(twice).toBe(2 * first);
  });

  it('сборка с выключенным учётом счётчик не двигает (RDBG-8)', () => {
    // Отладочный слой строит навигацию ВНЕ оплачиваемого пути: его собственная
    // работа в счётчики стоимости попадать MUST NOT, и держится это устройством
    // сборки, а не тем, в какой момент зовут пробу.
    const map = plain(['.....', '.._..', '.....']);
    const metered = buildNavigation(map, { budget: WIDE_BUDGET, maxAgentRadius: 0 });
    const free = buildNavigation(map, { budget: WIDE_BUDGET, maxAgentRadius: 0, cost: false });
    const paid = costOf(() => {
      metered.findPath(at(0, 1), at(4, 1));
    });
    const unpaid = costOf(() => {
      free.findPath(at(0, 1), at(4, 1));
    });
    expect(paid).toBeGreaterThan(0);
    expect(unpaid).toBe(0);
    // Ответ при этом тот же: учёт инертен (DI-5).
    expect(free.findPath(at(0, 1), at(4, 1))).toEqual(metered.findPath(at(0, 1), at(4, 1)));
  });

  it('без подключённого стока учёт не исполняется вовсе', () => {
    const api = navigation(plain(['...', '...', '...']));
    // Вне контекста диагностики запрос отвечает тем же, ничего не считая.
    const outside = api.findPath(at(0, 0), at(2, 2));
    const inside = costOf(() => {
      expect(api.findPath(at(0, 0), at(2, 2))).toEqual(outside);
    });
    expect(inside).toBeGreaterThan(0);
  });
});
