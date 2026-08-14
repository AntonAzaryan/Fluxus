/**
 * Эмиттерный ассет (ASSET-14): форма корня документа эффекта, адресные отказы
 * на не-документе и загрузка через реестр загрузчиков (ASSET-3). Всё headless,
 * в Node: библиотеки частиц, браузера и рендера здесь нет и быть не должно
 * (ASSET-5).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AssetService,
  manifestLoader,
  particleEffectLoader,
  validateParticleEffect,
  type ParticleEffectDocument,
} from '../src/index.js';
import { FIXTURES_DIR, FsAssetSource, MemoryAssetSource, bytesOf, settled } from './helpers.js';

/** Фикстура — документ, записанный самой библиотекой частиц (эмиттер в группе). */
const TORCH_ID = 'torch.effect.json';

/** Минимальный документ: корневой узел и есть эмиттер. */
const minimalDoc = {
  metadata: { version: 4.7, type: 'Object', generator: 'Object3D.toJSON' },
  object: { uuid: 'e0e1', type: 'ParticleEmitter', ps: { version: '3.0' } },
};

function expectErrors(doc: unknown, ...patterns: RegExp[]): string[] {
  const result = validateParticleEffect(doc);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('ожидался провал валидации');
  for (const pattern of patterns) {
    expect(
      result.errors.some((e) => pattern.test(e)),
      `нет ошибки под ${pattern}; есть:\n${result.errors.join('\n')}`,
    ).toBe(true);
  }
  return result.errors;
}

describe('ASSET-14: форма документа эффекта', () => {
  it('документ библиотеки частиц проходит валидацию и доходит до потребителя как есть', async () => {
    const raw: unknown = JSON.parse(await readFile(join(FIXTURES_DIR, TORCH_ID), 'utf8'));
    const result = validateParticleEffect(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Иммутабельные разделяемые данные (ASSET-5): документ не пересобирается —
    // разворачивает его в объекты библиотеки рендер (REND-24), и любая правка
    // здесь была бы правкой чужого формата.
    expect(result.effect).toBe(raw);
    expect(result.effect.object.type).toBe('Group');
    expect(result.effect.object.children?.[0]?.type).toBe('ParticleEmitter');
  });

  it('минимальный документ — эмиттер корневым узлом', () => {
    const result = validateParticleEffect(minimalDoc);
    expect(result.ok).toBe(true);
  });

  it('документ богаче кода остаётся легальным', () => {
    // Валидируется форма корня, а не схема целиком: набор генераторов и
    // поведений внутри эффекта принадлежит библиотеке, и документ более новой
    // версии редактора обязан грузиться (то же основание, что у REND-23).
    const result = validateParticleEffect({
      ...minimalDoc,
      geometries: [{ uuid: 'g', type: 'PlaneGeometry' }],
      materials: [{ uuid: 'm', type: 'MeshBasicMaterial' }],
      textures: [],
      images: [],
      animations: [],
      somethingNew: { fromFutureVersion: true },
      object: {
        ...minimalDoc.object,
        ps: { version: '9.0', behaviors: [{ type: 'ЕщёНеИзобретено', params: [1, 2, 3] }] },
        children: [
          { uuid: 'e2', type: 'ParticleEmitter', ps: {} },
          { uuid: 'x', type: 'Mesh', geometry: 'g', material: 'm' },
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  it('не-документ отвергается адресно', () => {
    expectErrors(null, /эмиттерный ассет: ожидался объект-документ эффекта.*null/);
    expectErrors([], /эмиттерный ассет: ожидался объект-документ эффекта.*массив/);
    expectErrors({}, /object: обязательное поле — корневой узел/);
    expectErrors({ object: 'Torch' }, /object: ожидался узел графа объектов.*string/);
    expectErrors({ object: { uuid: 'x' } }, /object\.type: обязательное поле — тип узла/);
  });

  it('документ без единого эмиттера документом эффекта не является', () => {
    // Сцена three.js без частиц — валидный граф объектов и невалидный эффект:
    // ссылаться на неё записью манифеста нечем.
    expectErrors(
      {
        object: {
          uuid: 'r',
          type: 'Group',
          children: [{ uuid: 'm', type: 'Mesh' }],
        },
      },
      /object: в документе нет ни одного эмиттера/,
    );
  });

  it('чужой диалект назван по своей же метке', () => {
    expectErrors(
      { metadata: { version: 4.7, type: 'BufferGeometry' }, object: minimalDoc.object },
      /metadata\.type: документ эффекта — граф объектов/,
    );
    expectErrors({ metadata: 7, object: minimalDoc.object }, /metadata: ожидался объект метаданных/);
  });

  it('битый узел адресуется путём внутри графа, ошибки собираются все разом', () => {
    const errors = expectErrors(
      {
        object: {
          uuid: 'r',
          type: 'Group',
          children: [{ uuid: 'a', type: 'ParticleEmitter' }, 42, { uuid: 'c' }],
        },
      },
      /object\.children\[1\]: ожидался узел графа объектов.*number/,
      /object\.children\[2\]\.type: обязательное поле/,
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expectErrors(
      { object: { uuid: 'r', type: 'ParticleEmitter', children: {} } },
      /object\.children: ожидался список узлов графа/,
    );
  });
});

describe('ASSET-14: загрузчик в реестре (ASSET-3)', () => {
  it('валидный документ приходит handle\'ом ready, битый — failed с причиной', async () => {
    const service = new AssetService(new FsAssetSource(FIXTURES_DIR));
    service.registerLoader(particleEffectLoader);
    const handle = service.request<ParticleEffectDocument>('particle-effect', TORCH_ID);
    const state = await settled(service, handle);
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.data.object.children?.[0]?.type).toBe('ParticleEmitter');

    const memory = new AssetService(
      new MemoryAssetSource(
        new Map([
          ['effects/broken.effect.json', bytesOf('{ "object": { "uuid": "x" } }')],
          ['effects/garbage.effect.json', bytesOf('это не JSON')],
        ]),
      ),
    );
    memory.registerLoader(particleEffectLoader);
    const broken = memory.request('particle-effect', 'effects/broken.effect.json');
    const garbage = memory.request('particle-effect', 'effects/garbage.effect.json');
    const brokenState = await settled(memory, broken);
    const garbageState = await settled(memory, garbage);
    expect(brokenState.status).toBe('failed');
    if (brokenState.status !== 'failed') return;
    expect(brokenState.reason).toMatch(/effects\/broken\.effect\.json.*не прошёл валидацию/s);
    expect(brokenState.reason).toMatch(/object\.type/);
    expect(garbageState.status).toBe('failed');
    if (garbageState.status !== 'failed') return;
    expect(garbageState.reason).toMatch(/некорректный JSON/);
  });

  it('.json делится с другими видами ассета: ключ реестра — пара «вид + формат»', async () => {
    // ASSET-3: манифест, presentation-документ и эффект живут в одном
    // расширении, и вытеснять друг друга загрузчики не должны.
    const service = new AssetService(
      new MemoryAssetSource(
        new Map([
          ['visuals/manifest.json', bytesOf(JSON.stringify({ entities: {} }))],
          ['visuals/effects/torch.effect.json', bytesOf(JSON.stringify(minimalDoc))],
        ]),
      ),
    );
    service.registerLoader(manifestLoader);
    service.registerLoader(particleEffectLoader);
    const manifest = service.request('manifest', 'visuals/manifest.json');
    const effect = service.request('particle-effect', 'visuals/effects/torch.effect.json');
    expect((await settled(service, manifest)).status).toBe('ready');
    expect((await settled(service, effect)).status).toBe('ready');
  });
});
