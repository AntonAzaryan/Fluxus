/**
 * Инструмент вьюпорта над двумя документами пары (ED-16, ED-17, ED-19).
 *
 * Здесь проверяется ровно то, чего требует единообразие выделения: инструмент
 * один, выделение плоское, подсветка одна, а «удалить выделенное» — одна
 * операция на юнита и декорацию сразу (сценарий ED-16). Кадра в headless-
 * прогоне нет, поэтому попадания раскладывает по точкам экрана сам тест —
 * согласованность попадания с изображением есть свойство рендера (REND-15).
 */
import { getAtPath, type JsonValue } from '@game-mvp/editor-core';
import { describe, expect, it } from 'vitest';
import { SCENE_AREA_ID, type SceneAreaState } from '../src/areas/scene.js';
import { DECORATION_LIST, PLACEMENT_LIST } from '../src/areas/sceneProject.js';
import { buildLoadedFrame, type LoadedFrameFixture } from './support/frame.js';
import {
  FIXTURE_IDS,
  FIXTURE_PRESENTATION_ID,
  entityHit,
  fixtureHost,
  fixtureHostWithLayer,
  surfaceHit,
} from './support/project.js';

const AT_UNIT = { x: 10, y: 10 };
const AT_DECORATION = { x: 30, y: 10 };
/** Сим-объект, у которого записи манифеста нет: `Crate` в фикстуре без вида. */
const AT_UNSEEN = { x: 50, y: 10 };
const AT_EMPTY = { x: 90, y: 90 };

const down = (f: LoadedFrameFixture, at: { x: number; y: number }, additive = false): void =>
  f.pointer({ phase: 'down', ...at, additive });
const up = (f: LoadedFrameFixture, at: { x: number; y: number }): void =>
  f.pointer({ phase: 'up', ...at, additive: false });
const move = (f: LoadedFrameFixture, at: { x: number; y: number }): void =>
  f.pointer({ phase: 'move', ...at, additive: false });

const placementKeys = (f: LoadedFrameFixture): readonly string[] =>
  f.session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);
const decorationKeys = (f: LoadedFrameFixture): readonly string[] =>
  f.session.descriptors(FIXTURE_PRESENTATION_ID, DECORATION_LIST);

const layer = (f: LoadedFrameFixture): readonly JsonValue[] =>
  getAtPath(f.session.documentValue(FIXTURE_PRESENTATION_ID), DECORATION_LIST) as readonly JsonValue[];
const placements = (f: LoadedFrameFixture): readonly JsonValue[] =>
  getAtPath(f.session.documentValue(FIXTURE_IDS.config), PLACEMENT_LIST) as readonly JsonValue[];

const selection = (f: LoadedFrameFixture): readonly string[] =>
  f.frame.selection.get(SCENE_AREA_ID);

const tool = (f: LoadedFrameFixture): SceneAreaState['tool'] => f.state.tool;

/** Проект с парным документом: под первой точкой юнит, под второй — декорация. */
async function withLayer(): Promise<LoadedFrameFixture> {
  const fixture = await buildLoadedFrame('ru', { host: fixtureHostWithLayer() });
  const unit = placementKeys(fixture)[0] ?? '';
  const decoration = decorationKeys(fixture)[0] ?? '';
  fixture.stage.hits.set(`${AT_UNIT.x}:${AT_UNIT.y}`, entityHit(unit));
  fixture.stage.hits.set(`${AT_DECORATION.x}:${AT_DECORATION.y}`, entityHit(decoration, true));
  fixture.stage.hits.set(
    `${AT_UNSEEN.x}:${AT_UNSEEN.y}`,
    entityHit(placementKeys(fixture)[1] ?? ''),
  );
  fixture.stage.hits.set(`${AT_EMPTY.x}:${AT_EMPTY.y}`, surfaceHit(3.5, 3.5, 15));
  fixture.stage.surfaceHits.set(`${AT_UNSEEN.x}:${AT_UNSEEN.y}`, surfaceHit(2.5, 1.5, 5));
  fixture.stage.surfaceHits.set(`${AT_UNIT.x}:${AT_UNIT.y}`, surfaceHit(0.5, 0.5, 0));
  fixture.stage.surfaceHits.set(`${AT_DECORATION.x}:${AT_DECORATION.y}`, surfaceHit(1.5, 1.5, 5));
  fixture.stage.surfaceHits.set(`${AT_EMPTY.x}:${AT_EMPTY.y}`, surfaceHit(3.5, 3.5, 15));
  fixture.frame.view();
  return fixture;
}

/**
 * Сцена, парного документа у которой в дереве НЕТ: слой декораций живёт
 * документом сессии, пока его не запишет сохранение (PRES-1, ED-16).
 */
async function withoutLayer(): Promise<LoadedFrameFixture> {
  const fixture = await buildLoadedFrame('ru', { host: fixtureHost() });
  fixture.stage.hits.set(`${AT_UNIT.x}:${AT_UNIT.y}`, entityHit(placementKeys(fixture)[0] ?? ''));
  fixture.stage.surfaceHits.set(`${AT_UNIT.x}:${AT_UNIT.y}`, surfaceHit(0.5, 0.5, 0));
  fixture.stage.hits.set(`${AT_EMPTY.x}:${AT_EMPTY.y}`, surfaceHit(3.5, 3.5, 15));
  fixture.stage.surfaceHits.set(`${AT_EMPTY.x}:${AT_EMPTY.y}`, surfaceHit(3.5, 3.5, 15));
  fixture.frame.view();
  return fixture;
}

/** Лежит ли парный документ в дереве: слой в сессии — ещё не файл на диске. */
const inTree = async (f: LoadedFrameFixture): Promise<boolean> =>
  (await f.host.content.stat(FIXTURE_PRESENTATION_ID))?.kind === 'file';

describe('PRES-1: открытие сцены находит парный документ по имени', () => {
  it('документ открыт, его записи попали в кадр и адресуются дескрипторами', async () => {
    const fixture = await withLayer();
    expect(fixture.session.isOpen(FIXTURE_PRESENTATION_ID)).toBe(true);
    expect(decorationKeys(fixture)).toHaveLength(2);
    // Набор уехал вьюпорту третьим набором, а не вместе с сим-объектами.
    const draft = fixture.stage.last!;
    expect(draft.decorations).toHaveLength(2);
    expect(draft.placements).toHaveLength(2);
    expect(draft.decorations![0]!.key).toBe(decorationKeys(fixture)[0]);
  });

  it('сцена без файла пары поднимается пустым слоем, и слой доступен', async () => {
    const fixture = await withoutLayer();
    // Документ открыт, хотя файла в дереве нет: пустой слой — законное
    // состояние сцены, а не отсутствие места (PRES-1, PRES-2).
    expect(fixture.session.isOpen(FIXTURE_PRESENTATION_ID)).toBe(true);
    expect(fixture.session.documentValue(FIXTURE_PRESENTATION_ID)).toEqual({});
    expect(await inTree(fixture)).toBe(false);
    expect(fixture.stage.last!.decorations ?? []).toEqual([]);
    expect(fixture.stage.failure).toBeNull();
    // Расстановка декораций от существования файла не зависит (ED-16, PRES-5).
    expect(tool(fixture).canDecorate).toBe(true);
  });
});

/**
 * ED-16, PRES-5, PRES-1: парный документ рождается ПРАВКОЙ, а не заранее.
 *
 * SHALL расстановки декораций и перевода prop → decoration не оговорены
 * существованием файла, и слой, доступный только на сцене, где `*.presentation.json`
 * кто-то уже создал руками, их не исполняет. Документ поэтому открыт пустым, а
 * файла до сохранения не появляется: «документ ради пустого слоя» PRES-1
 * запрещает, документ ради правки — нет.
 */
describe('ED-16, PRES-5: первая правка декораций наполняет пустой парный документ', () => {
  it('декорация ставится на сцене без файла пары и живёт в сессии до сохранения', async () => {
    const fixture = await withoutLayer();
    const active = tool(fixture);
    active.setLayer('decoration');
    active.setMode('place');
    active.setVisual('Statue');
    fixture.frame.view();

    down(fixture, AT_EMPTY);
    up(fixture, AT_EMPTY);

    const records = layer(fixture);
    expect(records).toHaveLength(1);
    expect(getAtPath(records[0] ?? null, ['visual'])).toBe('Statue');
    expect(selection(fixture)).toEqual([decorationKeys(fixture)[0]]);
    // Слой доехал до кадра тем же путём, что и на сцене с файлом (ED-15).
    expect(fixture.stage.last!.decorations).toHaveLength(1);
    // Диска правка не касалась: сохранение — отдельная операция (ED-21).
    expect(fixture.host.writes).toEqual([]);
    expect(await inTree(fixture)).toBe(false);
  });

  it('prop переводится в декорацию туда же, и запись уезжает из конфига (PRES-5)', async () => {
    const fixture = await withoutLayer();
    down(fixture, AT_UNIT);
    up(fixture, AT_UNIT);
    expect(tool(fixture).convertible).toBe('sim');

    tool(fixture).convert(null);

    expect(layer(fixture)).toHaveLength(1);
    expect(getAtPath(layer(fixture)[0] ?? null, ['visual'])).toBe('Hero');
    expect(placements(fixture)).toHaveLength(1);
    expect(await inTree(fixture)).toBe(false);
  });

  it('отменённая единственная правка не оставляет в слое несохранённого', async () => {
    const fixture = await withoutLayer();
    const active = tool(fixture);
    active.setLayer('decoration');
    active.setMode('place');
    active.setVisual('Statue');
    fixture.frame.view();
    down(fixture, AT_EMPTY);
    up(fixture, AT_EMPTY);
    expect(fixture.session.document(FIXTURE_PRESENTATION_ID).dirty).toBe(true);

    expect(fixture.session.undo()).toBe(true);
    // Документ вернулся к тому, чем открылся, — и сохранять в нём нечего:
    // писать пустой документ значило бы завести файл ради пустого слоя (PRES-1).
    expect(fixture.session.documentValue(FIXTURE_PRESENTATION_ID)).toEqual({});
    expect(fixture.session.document(FIXTURE_PRESENTATION_ID).dirty).toBe(false);
    expect(fixture.session.dirtyDocumentIds()).not.toContain(FIXTURE_PRESENTATION_ID);
  });
});

describe('ED-17: выделение сим-объектов и декораций единообразно', () => {
  it('клик по декорации выделяет её запись, клик по юниту — его', async () => {
    const fixture = await withLayer();
    const unit = placementKeys(fixture)[0]!;
    const decoration = decorationKeys(fixture)[0]!;

    down(fixture, AT_DECORATION);
    up(fixture, AT_DECORATION);
    expect(selection(fixture)).toEqual([decoration]);

    down(fixture, AT_UNIT);
    up(fixture, AT_UNIT);
    expect(selection(fixture)).toEqual([unit]);
  });

  it('мультивыделение набирается через слой: юнит и декорация вместе', async () => {
    const fixture = await withLayer();
    const unit = placementKeys(fixture)[0]!;
    const decoration = decorationKeys(fixture)[0]!;

    down(fixture, AT_UNIT);
    up(fixture, AT_UNIT);
    down(fixture, AT_DECORATION, true);
    up(fixture, AT_DECORATION);
    expect(selection(fixture)).toEqual([unit, decoration]);
    expect(tool(fixture).selected()).toEqual([unit, decoration]);
  });

  it('подсветка одна на оба слоя, и слой назван, чтобы ключ искали в своём наборе', async () => {
    const fixture = await withLayer();
    const unit = placementKeys(fixture)[0]!;
    const decoration = decorationKeys(fixture)[0]!;

    down(fixture, AT_UNIT);
    up(fixture, AT_UNIT);
    down(fixture, AT_DECORATION, true);
    up(fixture, AT_DECORATION);
    fixture.frame.view();

    expect(fixture.stage.overlays).toEqual([
      { kind: 'highlight', key: `selection:${unit}`, placement: unit },
      { kind: 'highlight', key: `selection:${decoration}`, placement: decoration, decoration: true },
    ]);
  });
});

describe('ED-16: удаление выделенного одной операцией', () => {
  it('юнит исчезает из расстановки, декорация — из парного документа; undo один', async () => {
    const fixture = await withLayer();
    down(fixture, AT_UNIT);
    up(fixture, AT_UNIT);
    down(fixture, AT_DECORATION, true);
    up(fixture, AT_DECORATION);

    tool(fixture).remove();
    expect(placements(fixture)).toHaveLength(1);
    expect(layer(fixture)).toHaveLength(1);
    expect(selection(fixture)).toEqual([]);

    // Одна запись истории: автор удалял один раз и отменять будет один раз.
    expect(fixture.session.history().undo).toHaveLength(1);
    expect(fixture.session.undo()).toBe(true);
    expect(placements(fixture)).toHaveLength(2);
    expect(layer(fixture)).toHaveLength(2);
    // Redo возвращает оба документа вместе.
    expect(fixture.session.redo()).toBe(true);
    expect(placements(fixture)).toHaveLength(1);
    expect(layer(fixture)).toHaveLength(1);
  });
});

describe('ED-16, ED-18: перетаскивание смешанного выделения — одно взаимодействие', () => {
  it('едут оба документа, а в истории остаётся одна запись', async () => {
    const fixture = await withLayer();
    down(fixture, AT_UNIT);
    up(fixture, AT_UNIT);
    down(fixture, AT_DECORATION, true);
    up(fixture, AT_DECORATION);

    // Нажатие на декорации, движение к пустой точке, отпускание там же.
    down(fixture, AT_DECORATION);
    move(fixture, AT_EMPTY);
    up(fixture, AT_EMPTY);

    // Оба уехали на один и тот же сдвиг (3.5 − 1.5 = 2), но записаны по-разному:
    // декорация — десятичным числом своего документа (PRES-3), юнит — валидным
    // Q16.16 в переопределении компонента (FP-1). Операция при этом одна, и
    // слой у неё параметр.
    expect(getAtPath(layer(fixture)[0] ?? null, ['x'])).toBe(3.5);
    expect(getAtPath(placements(fixture)[0] ?? null, ['overrides', 'Position', 'x'])).toBe(
      Math.trunc(3.5 * 65536),
    );
    expect(fixture.session.history().undo).toHaveLength(1);

    fixture.session.undo();
    expect(getAtPath(layer(fixture)[0] ?? null, ['x'])).toBe(1.5);
  });
});

describe('ED-16: постановка декорации во вьюпорте', () => {
  it('слой выбирается переключателем, запись дописывается в конец и сразу выделена', async () => {
    const fixture = await withLayer();
    const before = decorationKeys(fixture).length;
    const active = tool(fixture);
    expect(active.canDecorate).toBe(true);
    active.setLayer('decoration');
    active.setMode('place');
    // Вид по умолчанию — первый из пространства ключей манифеста (ASSET-9).
    expect(active.visuals).toEqual(['Hero', 'Statue']);
    active.setVisual('Statue');
    fixture.frame.view();

    down(fixture, AT_EMPTY);
    up(fixture, AT_EMPTY);

    const records = layer(fixture);
    expect(records).toHaveLength(before + 1);
    expect(getAtPath(records.at(-1) ?? null, ['visual'])).toBe('Statue');
    expect(getAtPath(records.at(-1) ?? null, ['x'])).toBe(3.5);
    // Конфиг сцены при этом не тронут: слой изолирован (PRES-4).
    expect(placements(fixture)).toHaveLength(2);
    expect(selection(fixture)).toEqual([decorationKeys(fixture).at(-1)]);
  });
});

describe('PRES-5, ED-26: перевод предлагается только там, где он исполним', () => {
  it('однородное выделение переводится, смешанное — нет', async () => {
    const fixture = await withLayer();
    down(fixture, AT_UNIT);
    up(fixture, AT_UNIT);
    expect(tool(fixture).convertible).toBe('sim');

    down(fixture, AT_DECORATION, true);
    up(fixture, AT_DECORATION);
    // Смешанное переводить некуда: половина уже в приёмнике.
    expect(tool(fixture).convertible).toBeNull();
  });

  it('сим-объект без записи манифеста в декорацию не предлагается', async () => {
    // `visual` у декорации — обязательное поле (PRES-2), а у объекта, чей
    // prefab в манифесте не описан, вида нет вовсе: перевод показан
    // недоступным, а не отказывает нажатием (ED-26).
    const fixture = await withLayer();
    down(fixture, AT_UNSEEN);
    up(fixture, AT_UNSEEN);
    expect(selection(fixture)).toEqual([placementKeys(fixture)[1]]);
    expect(tool(fixture).convertible).toBeNull();

    tool(fixture).convert(null);
    // Ни один документ пары не тронут: несделанное осталось несделанным.
    expect(layer(fixture)).toHaveLength(2);
    expect(placements(fixture)).toHaveLength(2);
  });
});

describe('PRES-2: неразрешимая ссылка подсвечивается валидацией', () => {
  it('находка адресует запись и стоит на её `visual`', async () => {
    const fixture = await buildLoadedFrame('ru', {
      host: fixtureHostWithLayer(undefined, {
        decorations: [{ visual: 'Ghost', x: 1, y: 1 }],
      }),
    });
    const { state } = fixture;
    const issue = state.report!.forDocument(FIXTURE_PRESENTATION_ID).find(
      (found) => found.ruleId === 'editor.decorationVisual',
    );
    expect(issue?.path).toEqual(['decorations', 0, 'visual']);
    expect(issue?.severity).toBe('warning');
    // Кадр при этом жив: запись рисуется заглушкой (ASSET-6).
    expect(fixture.stage.last!.decorations).toHaveLength(1);
  });
});
