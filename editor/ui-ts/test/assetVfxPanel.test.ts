/**
 * Панель секций VFX манифеста визуалов в просмотрщике (ED-14): изображения
 * транзиентных эффектов (`rendering` REND-23) и эмиттеры частиц (ASSET-14).
 *
 * Проверяется наблюдаемое автором: секции стоят в инспекторе, их записи правятся
 * контролами (и правка идёт зарегистрированной операцией, ED-29), новый источник
 * заводится черновиком, ненужное снимается — и ни для чего из этого не нужно
 * открывать `manifest.json` в текстовом редакторе, чего ED-14 и требует.
 *
 * Находки валидации показываются НА МЕСТЕ (ED-8): сломанная запись помечена у
 * своей строки, а не только причиной отказа внизу области.
 */
import { describe, expect, it } from 'vitest';
import { collectTexts, findAll, type UiNode } from '../src/dom/node.js';
import { EFFECT_FIELDS } from '@fluxus/assets';
import { buildAssetFrame, ASSET_IDS } from './support/assets.js';
import { buttonByKey, press } from './support/frame.js';

type Fixture = Awaited<ReturnType<typeof buildAssetFrame>>;

/** Значение манифеста как объект с обеими секциями VFX. */
function manifest(fixture: Fixture): {
  effects?: Record<string, Record<string, unknown>>;
  particles?: Record<string, Record<string, unknown>>;
} {
  return fixture.session.documentValue(ASSET_IDS.visuals) as {
    effects?: Record<string, Record<string, unknown>>;
    particles?: Record<string, Record<string, unknown>>;
  };
}

/** Записать значение прямо в документ — так его туда кладёт правка вне панели. */
function seed(fixture: Fixture, path: readonly (string | number)[], value: unknown): void {
  fixture.session.applyOperation('document.setValue', {
    document: ASSET_IDS.visuals,
    path: [...path],
    value: value as never,
  });
}

/** Контрол по его подписи для доступности: так его находит и автор с клавиатуры. */
function labelled(fixture: Fixture, tag: string, label: string): UiNode | undefined {
  return findAll(fixture.frame.view(), (node) => node.tag === tag).find(
    (node) => node.labels?.ariaLabel?.value === label || node.labels?.ariaLabel?.key === label,
  );
}

/** Ввод в поле: тот же обработчик, каким его правит автор. */
function commit(node: UiNode | undefined, value: string): void {
  const handler = node?.on?.change;
  if (handler === undefined) throw new Error('у контрола нет обработчика ввода');
  handler({ target: { value } } as unknown as Event);
}

/** Кнопка по ключу её подписи — тем же поиском, каким её жмёт оснастка кадра. */
function pressByKey(fixture: Fixture, key: string): void {
  press(buttonByKey(fixture.frame.view(), key));
}

const BALL = { primitive: 'sphere', color: '#ff8a3c', radius: 0.25 };

describe('ED-14: секции VFX правятся из редактора, а не в JSON', () => {
  it('обе секции и черновик стоят в инспекторе', async () => {
    const fixture = await buildAssetFrame();
    const keys = collectTexts(fixture.frame.view()).map((text) => text.key ?? '');
    for (const key of [
      'ui.area.assets.vfxEffects',
      'ui.area.assets.vfxParticles',
      'ui.area.assets.vfxNew',
    ]) {
      expect(keys, key).toContain(key);
    }
  });

  it('изображение источника выбирается, и его числа правятся полем', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Fireball'], BALL);
    fixture.frame.view();

    // Выбор источника — тот же список, которым автор выбирает изображение.
    commit(labelled(fixture, 'select', 'Fireball'), '0');
    const radius = labelled(fixture, 'input', 'radius');
    expect(radius?.labels?.value?.value).toBe('0.25');

    commit(radius, '0.5');

    const record = manifest(fixture).effects?.byKind?.Fireball as Record<string, unknown>;
    expect(record.radius).toBe(0.5);
  });

  it('пустое значение поля снимает его: чинить документ руками автор не обязан', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Fireball'], { ...BALL, alpha: 0.5 });
    fixture.frame.view();
    commit(labelled(fixture, 'select', 'Fireball'), '0');

    commit(labelled(fixture, 'input', 'alpha'), '');

    const record = manifest(fixture).effects?.byKind?.Fireball as Record<string, unknown>;
    expect(record.alpha).toBeUndefined();
    expect(record.radius).toBe(0.25);
  });

  it('черновик заводит источник: примитив, цвет и радиус — одной операцией', async () => {
    const fixture = await buildAssetFrame();
    commit(labelled(fixture, 'input', 'ui.area.assets.vfxSource'), 'SlowDome');
    commit(labelled(fixture, 'input', 'ui.area.assets.vfxPrimitive'), 'ring');
    commit(labelled(fixture, 'input', 'ui.area.assets.vfxColor'), '#6fd3ff');
    commit(labelled(fixture, 'input', 'ui.area.assets.vfxRadius'), '3');

    pressByKey(fixture, 'ui.area.assets.vfxAddImage');

    expect(manifest(fixture).effects?.byKind?.SlowDome).toEqual({
      primitive: 'ring',
      color: '#6fd3ff',
      radius: 3,
    });
  });

  it('второе изображение источника делает его списком (REND-23)', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Fireball'], BALL);
    fixture.frame.view();
    commit(labelled(fixture, 'input', 'ui.area.assets.vfxSource'), 'Fireball');
    commit(labelled(fixture, 'input', 'ui.area.assets.vfxPrimitive'), 'ribbon');
    commit(labelled(fixture, 'input', 'ui.area.assets.vfxColor'), '#ffb066');
    commit(labelled(fixture, 'input', 'ui.area.assets.vfxWidth'), '0.2');

    pressByKey(fixture, 'ui.area.assets.vfxAddImage');

    const images = manifest(fixture).effects?.byKind?.Fireball;
    expect(Array.isArray(images)).toBe(true);
    expect((images as readonly { primitive: string }[]).map((image) => image.primitive)).toEqual([
      'sphere',
      'ribbon',
    ]);
  });

  it('снятие последнего изображения снимает источник целиком', async () => {
    // Пустой список формат отвергает (REND-23), и оставлять автора с заведомо
    // невалидным документом ради буквальности действия незачем.
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Fireball'], BALL);
    fixture.frame.view();
    commit(labelled(fixture, 'select', 'Fireball'), '0');

    pressByKey(fixture, 'ui.area.assets.vfxRemoveImage');

    expect(manifest(fixture).effects?.byKind?.Fireball).toBeUndefined();
  });

  it('находка валидации показана у строки источника (ED-8)', async () => {
    const fixture = await buildAssetFrame();
    // Запись без радиуса и без ширины: формат её отвергает (ASSET-6).
    seed(fixture, ['effects', 'byKind', 'Zone'], { primitive: 'disc', color: '#fff' });

    // Причина видна ТЕКСТОМ рядом со строкой, а не только цветом (ED-22).
    const shown = collectTexts(fixture.frame.view()).map((text) => text.value);
    expect(shown.some((text) => text.includes('effects.byKind.Zone'))).toBe(true);
  });
});

describe('ED-14: эмиттеры частиц (ASSET-14)', () => {
  it('привязка эмиттера заводится черновиком и правится полями', async () => {
    const fixture = await buildAssetFrame();
    commit(labelled(fixture, 'input', 'ui.area.assets.vfxSource'), 'Fireball');
    commit(labelled(fixture, 'input', 'ui.area.assets.vfxEffectAsset'), 'visuals/vfx/torch.effect.json');
    pressByKey(fixture, 'ui.area.assets.vfxBindEmitter');
    expect(manifest(fixture).particles?.byKind?.Fireball).toEqual({
      effect: 'visuals/vfx/torch.effect.json',
    });

    // Сокет и масштаб дописываются в ТУ ЖЕ запись: она пишется целиком.
    commit(labelled(fixture, 'input', 'ui.area.assets.vfxSocket'), 'Socket_Tail');
    commit(labelled(fixture, 'input', 'ui.area.assets.vfxScale'), '2');

    expect(manifest(fixture).particles?.byKind?.Fireball).toEqual({
      effect: 'visuals/vfx/torch.effect.json',
      socket: 'Socket_Tail',
      scale: 2,
    });
  });

  it('привязка снимается кнопкой строки, а не правкой JSON', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['particles', 'byKind', 'Fireball'], { effect: 'visuals/vfx/torch.effect.json' });
    fixture.frame.view();

    pressByKey(fixture, 'ui.area.assets.vfxRemoveEmitter');

    expect(manifest(fixture).particles?.byKind?.Fireball).toBeUndefined();
  });

  it('негодный ID ассета отвергает операция, а причина видна автору (ASSET-2, ED-30)', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['particles', 'byKind', 'Fireball'], { effect: 'visuals/vfx/torch.effect.json' });
    fixture.frame.view();

    commit(labelled(fixture, 'input', 'Fireball'), 'https://example.test/torch.effect.json');

    expect(fixture.state.failure).toMatch(/ASSET-2/);
    // Полуправок отказ не оставляет: прежняя ссылка на месте (ED-29).
    expect(manifest(fixture).particles?.byKind?.Fireball).toEqual({
      effect: 'visuals/vfx/torch.effect.json',
    });
  });
});


/**
 * Составные поля записи (REND-23): окно доставленного стата, порог цвета,
 * мигание. До этой правки они были видны, но не правились — автор открывал
 * `manifest.json` руками, чего ED-14 не допускает. Проверяется наблюдаемое:
 * подполя стоят строками, правка идёт операцией (ED-29), заводимое поле уходит
 * в документ одной записью, а находка владельца видна у своей строки (ED-8).
 */
describe('ED-14: составные поля записи правятся подполями', () => {
  /** Запись выбранного источника таблицы `byKind`. */
  function record(fixture: Fixture, name: string): Record<string, unknown> {
    return manifest(fixture).effects?.byKind?.[name] as Record<string, unknown>;
  }

  /** Подписи пунктов выпадающего списка — то, из чего выбирает автор. */
  function options(fixture: Fixture, label: string): readonly string[] {
    const node = labelled(fixture, 'select', label);
    return (node?.children ?? []).map((child) => child.text?.value ?? '');
  }

  /** Выбрать источник (он же выбор его единственного изображения). */
  function selectSource(fixture: Fixture, name: string): void {
    commit(labelled(fixture, 'select', name), '0');
  }

  it('список «дописать поле» — само описание формата (ASSET-6), а не список панели', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Fireball'], BALL);
    fixture.frame.view();
    selectSource(fixture, 'Fireball');

    // Первый пункт списка — «нет»; дальше поля описания в его смысловом порядке.
    const shown = options(fixture, 'ui.area.assets.vfxField');
    expect(shown.slice(1)).toEqual(
      EFFECT_FIELDS.filter((spec) => !(spec.name in BALL)).map((spec) => spec.name),
    );
    // Составные поля и вертикальное смещение — в списке: прежний ручной список
    // панели о них не знал, и дописать их из редактора было нечем.
    for (const field of ['verticalOffset', 'radiusFromStat', 'colorAt', 'blink']) {
      expect(shown, field).toContain(field);
    }
  });

  it('окно стата правится подполем, а запись уходит операцией целиком', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Charge'], {
      ...BALL,
      radiusFromStat: { stat: 'charge', max: 60, to: 2 },
    });
    fixture.frame.view();
    selectSource(fixture, 'Charge');

    commit(labelled(fixture, 'input', 'radiusFromStat.max'), '80');

    const window = record(fixture, 'Charge').radiusFromStat as Record<string, unknown>;
    expect(window).toEqual({ stat: 'charge', max: 80, to: 2 });
    // Порядок ключей правка одного числа не перекладывает (ED-21).
    expect(Object.keys(window)).toEqual(['stat', 'max', 'to']);
  });

  it('пустое подполе снимается, а необязательное дописывается', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Charge'], {
      ...BALL,
      radiusFromStat: { stat: 'charge', min: 1, max: 60, to: 2 },
    });
    fixture.frame.view();
    selectSource(fixture, 'Charge');

    commit(labelled(fixture, 'input', 'radiusFromStat.min'), '');
    expect(record(fixture, 'Charge').radiusFromStat).toEqual({ stat: 'charge', max: 60, to: 2 });

    commit(labelled(fixture, 'input', 'radiusFromStat.from'), '1.5');
    expect(record(fixture, 'Charge').radiusFromStat).toEqual({
      stat: 'charge',
      max: 60,
      to: 2,
      from: 1.5,
    });
  });

  it('мигание заводится черновиком подполей и уходит в документ одной записью', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Link'], {
      primitive: 'beam',
      color: '#6fd3ff',
      width: 0.4,
    });
    fixture.frame.view();
    selectSource(fixture, 'Link');

    commit(labelled(fixture, 'select', 'ui.area.assets.vfxField'), 'blink');
    // До нажатия набранное живёт в черновике: документ не трогается подполем.
    commit(labelled(fixture, 'input', 'blink.periodMs'), '180');
    expect(record(fixture, 'Link').blink).toBeUndefined();
    commit(labelled(fixture, 'input', 'blink.alpha'), '0.4');

    pressByKey(fixture, 'ui.area.assets.vfxSetField');

    expect(record(fixture, 'Link').blink).toEqual({ periodMs: 180, alpha: 0.4 });
    // Поле в документе — черновик закрыт, и у строки теперь снятие поля.
    expect(buttonByKey(fixture.frame.view(), 'ui.area.assets.vfxSetField')).toBeUndefined();
    expect(buttonByKey(fixture.frame.view(), 'ui.area.assets.vfxRemoveField')).toBeDefined();
  });

  it('пустой черновик записывать нечего: действие показано недоступным (ED-26)', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Link'], {
      primitive: 'beam',
      color: '#6fd3ff',
      width: 0.4,
    });
    fixture.frame.view();
    selectSource(fixture, 'Link');
    commit(labelled(fixture, 'select', 'ui.area.assets.vfxField'), 'blink');

    const write = (): UiNode | undefined =>
      buttonByKey(fixture.frame.view(), 'ui.area.assets.vfxSetField');
    expect(write()?.attrs?.['aria-disabled']).toBe('true');

    commit(labelled(fixture, 'input', 'blink.periodMs'), '180');

    expect(write()?.attrs?.['aria-disabled']).toBe('false');
  });

  it('порог цвета заводится тем же черновиком: строка и число в одном поле', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Charge'], {
      ...BALL,
      radiusFromStat: { stat: 'charge', max: 60, to: 2 },
    });
    fixture.frame.view();
    selectSource(fixture, 'Charge');

    commit(labelled(fixture, 'select', 'ui.area.assets.vfxField'), 'colorAt');
    commit(labelled(fixture, 'input', 'colorAt.phase'), '0.5');
    commit(labelled(fixture, 'input', 'colorAt.color'), '#ff7020');
    pressByKey(fixture, 'ui.area.assets.vfxSetField');

    expect(record(fixture, 'Charge').colorAt).toEqual({ phase: 0.5, color: '#ff7020' });
  });

  it('составное поле снимается кнопкой своей строки', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Charge'], {
      ...BALL,
      radiusFromStat: { stat: 'charge', max: 60, to: 2 },
    });
    fixture.frame.view();
    selectSource(fixture, 'Charge');

    pressByKey(fixture, 'ui.area.assets.vfxRemoveField');

    expect(record(fixture, 'Charge')).toEqual(BALL);
  });

  it('находка владельца видна у строки подполя, а не одной кучей (ED-8)', async () => {
    const fixture = await buildAssetFrame();
    // Конец окна не дальше его начала — пустое окно, и владелец адресует находку
    // подполю `max` (ASSET-6).
    seed(fixture, ['effects', 'byKind', 'Charge'], {
      ...BALL,
      radiusFromStat: { stat: 'charge', min: 5, max: 5, to: 2 },
      alpha: 2,
    });
    fixture.frame.view();
    selectSource(fixture, 'Charge');

    // Знак находки живёт в оболочке контрола — рядом с полем, а не внизу области.
    const reason = (label: string): string => {
      const shell = findAll(fixture.frame.view(), (node) =>
        (node.children ?? []).some((child) => child.labels?.ariaLabel?.value === label),
      )[0];
      return shell === undefined
        ? ''
        : collectTexts(shell)
            .map((text) => text.value)
            .join(' ');
    };
    expect(reason('radiusFromStat.max')).toMatch(/конец окна/);
    // Скалярное поле показывает свою находку тем же способом.
    expect(reason('alpha')).toMatch(/\[0\.\.1\]/);
  });

  it('порог цвета без окна помечен у своей строки, а не молча принят', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Zone'], {
      ...BALL,
      colorAt: { phase: 0.5, color: '#ff7020' },
    });
    fixture.frame.view();
    selectSource(fixture, 'Zone');

    const shown = collectTexts(fixture.frame.view()).map((text) => text.value);
    expect(shown.some((text) => text.includes('поле ведётся фазой окна'))).toBe(true);
  });

  it('негодное подполе отвергает владелец, и полуправки не остаётся (ED-29, ED-30)', async () => {
    const fixture = await buildAssetFrame();
    seed(fixture, ['effects', 'byKind', 'Link'], {
      primitive: 'beam',
      color: '#6fd3ff',
      width: 0.4,
      blink: { periodMs: 180, alpha: 0.4 },
    });
    fixture.frame.view();
    selectSource(fixture, 'Link');

    commit(labelled(fixture, 'input', 'blink.alpha'), '5');

    expect(fixture.state.failure).toMatch(/blink\.alpha/);
    expect(record(fixture, 'Link').blink).toEqual({ periodMs: 180, alpha: 0.4 });
  });
});
