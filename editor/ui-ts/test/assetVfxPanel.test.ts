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
