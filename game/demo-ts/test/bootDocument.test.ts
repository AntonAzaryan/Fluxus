/**
 * Документ старта демо (`game-boot` BOOT-3, BOOT-1) — политика игры: состав и
 * строгость прогрева описываются документом, а не кодом сборки.
 *
 * Проверяется здесь то же, что у пресетов качества (QUAL-1) и по тому же
 * прецеденту: отказ АДРЕСНЫЙ (называет запись, а не «документ не подошёл»),
 * отвергнутый документ старт не останавливает, а объявленная, но не названная
 * стадия видна диагностике, а не теряется молча.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STAGE_TIMEOUT_MS,
  DEFAULT_WARM_FRAMES,
  defaultBootDocument,
  notWarmedStages,
  resolveBootDocument,
  resolveSplash,
  validateBootDocument,
  type BootRegistry,
} from '../app/boot/bootDocument.js';

/** Сцена демо глазами реестра: четыре подсистемы с точкой прогрева и одно назначение. */
function registry(overrides: Partial<BootRegistry> = {}): BootRegistry {
  return {
    declared: new Set(['models', 'particles', 'effects', 'fog']),
    declarable: ['fog'],
    destinations: new Set(['scene']),
    ...overrides,
  };
}

/** Минимальный годный документ: одна стадия и умолчания всего остального. */
function doc(stages: unknown[], rest: Record<string, unknown> = {}): unknown {
  return { stages, ...rest };
}

describe('словарь стадий и адресный отказ (BOOT-3)', () => {
  it('незнакомая стадия отвергается С ИМЕНЕМ, а не пропускается молча', () => {
    const result = validateBootDocument(doc([{ stage: 'prewarm.shadows' }]), registry());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Опечатка в имени стоила бы ровно того прогрева, ради которого стадия и
    // написана: отказ обязан назвать запись.
    expect(result.errors.join('\n')).toContain('prewarm.shadows');
    expect(result.errors.join('\n')).toContain('shadows');
  });

  it('встроенные стадии принимаются, а имя без префикса подсистемы — нет', () => {
    const ok = validateBootDocument(
      doc([{ stage: 'handshake' }, { stage: 'scene' }, { stage: 'firstDelivery' }, { stage: 'warmFrames' }]),
      registry(),
    );
    expect(ok.ok).toBe(true);
    const bad = validateBootDocument(doc([{ stage: 'models' }]), registry());
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.join('\n')).toContain('prewarm.<подсистема>');
  });

  it('туман объявляемый, но не построенный: документ принят — исход стадии решит раннер', () => {
    // Сцена без тумана — не повод отвергнуть документ, написанный про СБОРКУ
    // (QUAL-1): стадия принимается и получает `skipped` там, где подсистемы нет.
    const result = validateBootDocument(
      doc([{ stage: 'prewarm.fog' }]),
      registry({ declared: new Set(['models']) }),
    );
    expect(result.ok).toBe(true);
  });

  it('таймаут у стадии без таймаута отвергается адресно (BOOT-4)', () => {
    for (const stage of ['handshake', 'firstDelivery']) {
      const result = validateBootDocument(doc([{ stage, timeoutMs: 5000 }]), registry());
      expect(result.ok, stage).toBe(false);
      if (result.ok) continue;
      // Документ, обещающий им потолок, описывает не ту машину: единственное,
      // чего раскрытие ждёт без потолка, — приход соперника.
      expect(result.errors.join('\n')).toContain(stage);
      expect(result.errors.join('\n')).toContain('BOOT-4');
    }
  });

  it('умолчания полей документированы: строгость, таймаут, тёплые кадры', () => {
    const result = validateBootDocument(
      doc([{ stage: 'prewarm.models' }, { stage: 'warmFrames' }]),
      registry(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.stages[0]).toEqual({
      name: 'prewarm.models',
      required: true,
      timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
    });
    expect(result.document.warmFrames).toBe(DEFAULT_WARM_FRAMES);
    expect(result.document.after).toBe('scene');
    // У стадии-события таймаута нет по построению — не «бесконечность числом».
    const event = validateBootDocument(doc([{ stage: 'handshake' }]), registry());
    expect(event.ok && event.document.stages[0]!.timeoutMs).toBeNull();
  });

  it('обещанные тёплые кадры без своей стадии отвергаются: ждать их нечем остановить', () => {
    // Потолок у ожидания кадров один — таймаут стадии `warmFrames`, а кадрового
    // цикла может не быть вовсе (вкладка в фоне). Бессрочное ожидание у
    // раскрытия ровно одно — первая доставка (BOOT-4).
    const result = validateBootDocument(doc([{ stage: 'handshake' }], { warmFrames: 3 }), registry());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('warmFrames');
    expect(result.errors.join('\n')).toContain('без потолка');
  });

  it('промолчавший о кадрах документ их и не ждёт: умолчание без стадии — ноль', () => {
    // Обещания автор не давал: умолчание в два кадра действует там, где стадия
    // названа, а без неё ждать нечего.
    const result = validateBootDocument(doc([{ stage: 'handshake' }]), registry());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.warmFrames).toBe(0);
    // Явный ноль — та же законная форма, и отказом она не является.
    const zero = validateBootDocument(doc([{ stage: 'handshake' }], { warmFrames: 0 }), registry());
    expect(zero.ok).toBe(true);
  });

  it('стадия, названная дважды, отвергается: исход у стадии один', () => {
    const result = validateBootDocument(
      doc([{ stage: 'prewarm.models' }, { stage: 'prewarm.models' }]),
      registry(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('дважды');
  });

  it('объявленная, но не названная стадия — в диагностику, а не в тишину', () => {
    const plan = resolveBootDocument(
      doc([{ stage: 'prewarm.models' }, { stage: 'handshake' }]),
      registry(),
    );
    expect(plan.rejected).toEqual([]);
    // Прогрев частиц не исполняется, и об этом сказано вслух (BOOT-3, BOOT-5).
    expect([...plan.notWarmed].sort()).toEqual(['prewarm.effects', 'prewarm.fog', 'prewarm.particles']);
    expect(notWarmedStages(plan.document, ['models'])).toEqual([]);
  });

  it('отвергнутый документ старт не останавливает: действует умолчание сборки', () => {
    const plan = resolveBootDocument({ stages: 'все' }, registry());
    expect(plan.rejected.length).toBeGreaterThan(0);
    // Умолчание несёт стадии ВСЕХ объявленных подсистем: опечатка в одном поле
    // не должна стоить игроку всех монтажей в первом кадре.
    const names = plan.document.stages.map((stage) => stage.name);
    expect(names).toContain('prewarm.models');
    expect(names).toContain('handshake');
    expect(names).toContain('firstDelivery');
    expect(plan.notWarmed).toEqual([]);
    expect(plan.document.after).toBe('scene');
  });

  it('не разобранный документ даёт то же умолчание, что и отвергнутый', () => {
    for (const broken of [null, 42, 'документ', undefined]) {
      const plan = resolveBootDocument(broken, registry());
      expect(plan.rejected.length, String(broken)).toBeGreaterThan(0);
      expect(plan.document.stages.length).toBe(defaultBootDocument(registry().declared).stages.length);
    }
  });
});

describe('назначение после раскрытия (BOOT-1)', () => {
  it('`menu` без регистрации отвергается словом «зарезервировано» и уводит на `scene`', () => {
    const plan = resolveBootDocument(doc([{ stage: 'handshake' }], { after: 'menu' }), registry());
    expect(plan.rejected.join('\n')).toContain('menu');
    // Это не опечатка автора, а обещание будущего экрана — и отказ обязан
    // отличать одно от другого.
    expect(plan.rejected.join('\n')).toContain('зарезервировано');
    expect(plan.document.after).toBe('scene');
  });

  it('незнакомое назначение отвергается адресно и тоже уводит на `scene`', () => {
    const plan = resolveBootDocument(doc([{ stage: 'handshake' }], { after: 'титры' }), registry());
    expect(plan.rejected.join('\n')).toContain('титры');
    expect(plan.rejected.join('\n')).not.toContain('зарезервировано');
    expect(plan.document.after).toBe('scene');
  });

  it('зарегистрированное назначение принимается как есть', () => {
    const plan = resolveBootDocument(
      doc([{ stage: 'handshake' }], { after: 'menu' }),
      registry({ destinations: new Set(['scene', 'menu']) }),
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.document.after).toBe('menu');
  });
});

describe('сплеш документа (BOOT-2)', () => {
  it('медиа без пути отвергается: показывать нечего, а документ обещает картинку', () => {
    const result = validateBootDocument(
      doc([{ stage: 'handshake' }], { splash: { kind: 'image' } }),
      registry(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('splash.src');
  });

  it('секция сплеша читается ОТДЕЛЬНО от реестра: её спрашивают до сборки сцены', () => {
    const splash = resolveSplash({ splash: { kind: 'video', src: 'visuals/intro.mp4', minMs: 1500 } });
    expect(splash).toEqual({
      kind: 'video',
      src: 'visuals/intro.mp4',
      title: '',
      minMs: 1500,
      fadeMs: 400,
    });
  });

  it('отвергнутый документ сплеша не отменяет: заголовок и тайминги остаются авторскими', () => {
    // Опечатка в имени стадии не повод сменить титры студии на глазах игрока —
    // страница показывает их с первой отрисовки (BOOT-2).
    const plan = resolveBootDocument(
      doc([{ stage: 'prewarm.shadows' }], { splash: { kind: 'none', title: 'Арена', minMs: 900 } }),
      registry(),
    );
    expect(plan.rejected.length).toBeGreaterThan(0);
    expect(plan.document.splash.title).toBe('Арена');
    expect(plan.document.splash.minMs).toBe(900);
  });
});
