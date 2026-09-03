/**
 * Операции над секциями VFX манифеста визуалов (ED-14, ED-29): транзиентные
 * эффекты (`assets` ASSET-6, `rendering` REND-23) и эмиттеры частиц (ASSET-14,
 * REND-24).
 *
 * Проверяется наблюдаемое: правка идёт зарегистрированной операцией и обратима
 * (ED-29, ED-18); источник несёт список изображений, и одиночная запись
 * превращается в него дописыванием второй (REND-23); правила формата
 * спрашиваются у модуля ассетов, а не у копии его правил в редакторе (ED-1);
 * ID эмиттерного ассета — путь от корня дерева контента (ASSET-2, ED-20).
 */
import { describe, expect, it } from 'vitest';
import { runOperationRoundTrip, type EditorSession } from '@fluxus/editor-core';
import { createAssetArea } from '../src/areas/assets.js';
import { VFX_OPERATIONS, effectImages, emitterOf, vfxSourceNames } from '../src/areas/assetVfx.js';
import { buildFrame } from './support/frame.js';
import { ASSET_IDS, ASSET_VISUALS } from './support/assets.js';

/** Сессия с открытым манифестом-фикстурой и тем же реестром, что у приложения. */
function scratch(): EditorSession {
  const { session } = buildFrame([createAssetArea()]);
  session.openDocument({ id: ASSET_IDS.visuals, kind: 'visuals', value: ASSET_VISUALS });
  return session;
}

/** Значение документа манифеста после правок — вход читателей секций. */
function manifest(session: EditorSession): ReturnType<EditorSession['documentValue']> {
  return session.documentValue(ASSET_IDS.visuals);
}

const BALL = { table: 'byKind', name: 'Fireball', primitive: 'sphere', color: '#ff8a3c', radius: 0.25 };

describe('ED-29: правки секций VFX обратимы', () => {
  it.each([
    [VFX_OPERATIONS.addImage, BALL],
    [
      VFX_OPERATIONS.setEmitter,
      { table: 'byKind', name: 'Fireball', asset: 'visuals/vfx/torch.effect.json', socket: 'Socket_Tail' },
    ],
  ])('«применить, отменить, сравнить» проходит для %s', (operationId, params) => {
    const result = runOperationRoundTrip(scratch(), operationId, {
      document: ASSET_IDS.visuals,
      ...params,
    });
    expect(result.findings).toEqual([]);
    expect(result.recorded).toBe(true);
  });

  it('правка поля изображения обратима тем же способом', () => {
    const session = scratch();
    session.applyOperation(VFX_OPERATIONS.addImage, { document: ASSET_IDS.visuals, ...BALL });

    const result = runOperationRoundTrip(session, VFX_OPERATIONS.setField, {
      document: ASSET_IDS.visuals,
      table: 'byKind',
      name: 'Fireball',
      field: 'alpha',
      value: 0.5,
    });

    expect(result.findings).toEqual([]);
    expect(result.recorded).toBe(true);
  });
});

describe('Список изображений одного источника (REND-23)', () => {
  it('вторая запись превращает одиночную в список, номер возвращается вызывающему', () => {
    const session = scratch();
    const first = session.applyOperation(VFX_OPERATIONS.addImage, {
      document: ASSET_IDS.visuals,
      ...BALL,
    });
    const second = session.applyOperation(VFX_OPERATIONS.addImage, {
      document: ASSET_IDS.visuals,
      table: 'byKind',
      name: 'Fireball',
      primitive: 'ribbon',
      color: '#ffb066',
      width: 0.2,
    });

    expect(first.result).toBe(0);
    expect(second.result).toBe(1);
    const images = effectImages(manifest(session), 'byKind', 'Fireball');
    expect(images.map((image) => image.primitive)).toEqual(['sphere', 'ribbon']);
    expect(vfxSourceNames(manifest(session), 'effects', 'byKind')).toEqual(['Fireball']);
  });

  it('поле адресуется номером изображения, когда их несколько', () => {
    const session = scratch();
    session.applyOperation(VFX_OPERATIONS.addImage, { document: ASSET_IDS.visuals, ...BALL });
    session.applyOperation(VFX_OPERATIONS.addImage, {
      document: ASSET_IDS.visuals,
      table: 'byKind',
      name: 'Fireball',
      primitive: 'ribbon',
      color: '#ffb066',
      width: 0.2,
    });

    session.applyOperation(VFX_OPERATIONS.setField, {
      document: ASSET_IDS.visuals,
      table: 'byKind',
      name: 'Fireball',
      index: 1,
      field: 'trailSamples',
      value: 12,
    });

    const images = effectImages(manifest(session), 'byKind', 'Fireball');
    expect(images[0]?.trailSamples).toBeUndefined();
    expect(images[1]?.trailSamples).toBe(12);
  });

  it('null снимает поле: чинить документ руками автор не обязан (ED-14)', () => {
    const session = scratch();
    session.applyOperation(VFX_OPERATIONS.addImage, { document: ASSET_IDS.visuals, ...BALL });
    session.applyOperation(VFX_OPERATIONS.setField, {
      document: ASSET_IDS.visuals,
      table: 'byKind',
      name: 'Fireball',
      field: 'alpha',
      value: 0.5,
    });
    expect(effectImages(manifest(session), 'byKind', 'Fireball')[0]?.alpha).toBe(0.5);

    session.applyOperation(VFX_OPERATIONS.setField, {
      document: ASSET_IDS.visuals,
      table: 'byKind',
      name: 'Fireball',
      field: 'alpha',
      value: null,
    });

    expect(effectImages(manifest(session), 'byKind', 'Fireball')[0]?.alpha).toBeUndefined();
  });
});

describe('ED-1: правила формата спрашиваются у модуля ассетов', () => {
  it('запись без радиуса и ширины отвергает валидатор манифеста, а не копия его правила', () => {
    const session = scratch();

    // Причина — словами владельца правила (ASSET-6): своей копии этой проверки
    // у операции нет, и разойтись с ней ей нечем (CORE-3).
    expect(() =>
      session.applyOperation(VFX_OPERATIONS.addImage, {
        document: ASSET_IDS.visuals,
        table: 'byKind',
        name: 'Zone',
        primitive: 'disc',
        color: '#6fd3ff',
      }),
    ).toThrow(/radius: обязательное поле/);
    // Полуправок отказ не оставляет: записанное упавшей операцией откатывает
    // слой операций (ED-29).
    expect(vfxSourceNames(manifest(session), 'effects', 'byKind')).toEqual([]);
  });

  it('неизвестное поле называет владелец формата, а не перечень редактора', () => {
    const session = scratch();
    session.applyOperation(VFX_OPERATIONS.addImage, { document: ASSET_IDS.visuals, ...BALL });

    expect(() =>
      session.applyOperation(VFX_OPERATIONS.setField, {
        document: ASSET_IDS.visuals,
        table: 'byKind',
        name: 'Fireball',
        field: 'radus',
        value: 2,
      }),
    ).toThrow(/radus: неизвестное поле/);
    // Поле, которого формат не знает, в документе не осталось.
    expect(effectImages(manifest(session), 'byKind', 'Fireball')[0]?.radus).toBeUndefined();
  });

  it('таблица не из трёх — отказ с перечнем допустимых', () => {
    expect(() =>
      scratch().applyOperation(VFX_OPERATIONS.addImage, {
        document: ASSET_IDS.visuals,
        ...BALL,
        table: 'byWhatever',
      }),
    ).toThrow(/byKind, byState, byEvent/);
  });
});

describe('Привязка эмиттера частиц (ASSET-14, ED-20)', () => {
  it('запись пишется целиком: ссылка, сокет и масштаб', () => {
    const session = scratch();

    session.applyOperation(VFX_OPERATIONS.setEmitter, {
      document: ASSET_IDS.visuals,
      table: 'byState',
      name: 'Poisoned',
      asset: 'visuals/vfx/poison.effect.json',
      scale: 2,
    });

    expect(emitterOf(manifest(session), 'byState', 'Poisoned')).toEqual({
      effect: 'visuals/vfx/poison.effect.json',
      scale: 2,
    });
  });

  it('переписанная привязка не тащит за собой прежний сокет', () => {
    const session = scratch();
    session.applyOperation(VFX_OPERATIONS.setEmitter, {
      document: ASSET_IDS.visuals,
      table: 'byKind',
      name: 'Fireball',
      asset: 'visuals/vfx/torch.effect.json',
      socket: 'Socket_Tail',
    });

    session.applyOperation(VFX_OPERATIONS.setEmitter, {
      document: ASSET_IDS.visuals,
      table: 'byKind',
      name: 'Fireball',
      asset: 'visuals/vfx/burst.effect.json',
    });

    expect(emitterOf(manifest(session), 'byKind', 'Fireball')).toEqual({
      effect: 'visuals/vfx/burst.effect.json',
    });
  });

  it('ID ассета — путь от корня дерева контента, а не URL (ASSET-2)', () => {
    for (const asset of ['', '/visuals/vfx/torch.effect.json', '../torch.effect.json']) {
      expect(() =>
        scratch().applyOperation(VFX_OPERATIONS.setEmitter, {
          document: ASSET_IDS.visuals,
          table: 'byKind',
          name: 'Fireball',
          asset,
        }),
        asset,
      ).toThrow();
    }
  });
});
