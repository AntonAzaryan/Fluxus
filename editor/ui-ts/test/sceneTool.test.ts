/**
 * Инструмент вьюпорта: выделение кликом (ED-17) и расстановка (ED-16) на
 * настоящих документах проекта-фикстуры.
 *
 * Кадра в headless-прогоне нет, поэтому попадания раскладывает по точкам экрана
 * сам тест: согласованность попадания с изображением — свойство рендера
 * (REND-15), и подделывать его здесь было бы враньём. Проверяется то, что
 * принадлежит редактору: во что попадание превращается — в выделение, в набор
 * наложений и в правку документа операцией (ED-29).
 */
import { fixed, FIXED_ONE } from '@game-mvp/core';
import { getAtPath, type JsonValue } from '@game-mvp/editor-core';
import { describe, expect, it } from 'vitest';
import { SCENE_AREA_ID } from '../src/areas/scene.js';
import { PLACEMENT_LIST } from '../src/areas/sceneProject.js';
import { systemsArea } from '../src/areas/systems.js';
import { buildLoadedFrame, buttonByKey, press, type LoadedFrameFixture } from './support/frame.js';
import { FIXTURE_IDS, entityHit, surfaceHit } from './support/project.js';

/** Точка экрана, за которой в дубле кадра стоит попадание. */
const AT_FIRST = { x: 10, y: 10 };
const AT_SECOND = { x: 20, y: 10 };
const AT_EMPTY = { x: 90, y: 90 };

const down = (fixture: LoadedFrameFixture, at: { x: number; y: number }, additive = false): void =>
  fixture.pointer({ phase: 'down', ...at, additive });
const move = (fixture: LoadedFrameFixture, at: { x: number; y: number }): void =>
  fixture.pointer({ phase: 'move', ...at, additive: false });
const up = (fixture: LoadedFrameFixture, at: { x: number; y: number }): void =>
  fixture.pointer({ phase: 'up', ...at, additive: false });
const cancel = (fixture: LoadedFrameFixture): void =>
  fixture.pointer({ phase: 'cancel', x: 0, y: 0, additive: false });

/**
 * Перерисовка, которую в живом редакторе делает подписчик `frame/mount.ts` на
 * просьбу инструмента: описание страницы строится заново, и вместе с ним кадр
 * сводится с документами. Тест зовёт её явно — DOM в прогоне нет.
 */
const redraw = (fixture: LoadedFrameFixture): void => {
  fixture.frame.view();
};

const keys = (fixture: LoadedFrameFixture): readonly string[] =>
  fixture.session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);

const records = (fixture: LoadedFrameFixture): readonly JsonValue[] =>
  getAtPath(fixture.session.documentValue(FIXTURE_IDS.config), PLACEMENT_LIST) as readonly JsonValue[];

const positionOf = (fixture: LoadedFrameFixture, index: number, field: string): JsonValue | undefined =>
  getAtPath(fixture.session.documentValue(FIXTURE_IDS.config), [
    ...PLACEMENT_LIST,
    index,
    'overrides',
    'Position',
    field,
  ]);

const selection = (fixture: LoadedFrameFixture): readonly string[] =>
  fixture.frame.selection.get(SCENE_AREA_ID);

/**
 * Фикстура с разложенным по экрану кадром: под первой точкой первый объект, под
 * второй — второй, под третьей — пустая арена. Поверхность отвечает под всеми
 * тремя: объект стоит НА арене, и точка под ним есть всегда (REND-15).
 */
async function withHits(): Promise<LoadedFrameFixture> {
  const fixture = await buildLoadedFrame();
  const [first, second] = keys(fixture);
  fixture.stage.hits.set(`${AT_FIRST.x}:${AT_FIRST.y}`, entityHit(first ?? ''));
  fixture.stage.hits.set(`${AT_SECOND.x}:${AT_SECOND.y}`, entityHit(second ?? ''));
  fixture.stage.hits.set(`${AT_EMPTY.x}:${AT_EMPTY.y}`, surfaceHit(3.5, 3.5, 15));
  fixture.stage.surfaceHits.set(`${AT_FIRST.x}:${AT_FIRST.y}`, surfaceHit(1.5, 1.5, 5));
  fixture.stage.surfaceHits.set(`${AT_SECOND.x}:${AT_SECOND.y}`, surfaceHit(2.5, 1.5, 6));
  fixture.stage.surfaceHits.set(`${AT_EMPTY.x}:${AT_EMPTY.y}`, surfaceHit(3.5, 3.5, 15));
  fixture.frame.view();
  return fixture;
}

describe('ED-17: клик по вьюпорту выделяет то, что автор видит', () => {
  it('попадание в объект становится выделением его записи расстановки', async () => {
    const fixture = await withHits();
    const [first, second] = keys(fixture);

    down(fixture, AT_SECOND);
    up(fixture, AT_SECOND);
    // Ключ попадания — дескриптор записи: перевод «сущность → документ» делает
    // набор инстансов (REND-11), а инструмент адресуется тем же ключом, что и
    // навигатор.
    expect(selection(fixture)).toEqual([second]);
    expect(selection(fixture)).not.toEqual([first]);
  });

  it('клик по пустому месту снимает выделение', async () => {
    const fixture = await withHits();
    down(fixture, AT_FIRST);
    up(fixture, AT_FIRST);
    expect(selection(fixture)).toHaveLength(1);

    down(fixture, AT_EMPTY);
    up(fixture, AT_EMPTY);
    expect(selection(fixture)).toEqual([]);
  });

  it('мультивыделение набирается модификатором и им же снимается', async () => {
    const fixture = await withHits();
    const [first, second] = keys(fixture);

    down(fixture, AT_FIRST);
    up(fixture, AT_FIRST);
    down(fixture, AT_SECOND, true);
    up(fixture, AT_SECOND);
    expect(selection(fixture)).toEqual([first, second]);

    // Промах с модификатором выделения не снимает: набирающий его промахивается.
    down(fixture, AT_EMPTY, true);
    up(fixture, AT_EMPTY);
    expect(selection(fixture)).toEqual([first, second]);
  });
});

describe('ED-17, REND-16: выделенное подсвечено набором наложений', () => {
  it('подсветка уходит вьюпорту набором, а не вызовом «обведи вот это»', async () => {
    const fixture = await withHits();
    const [first, second] = keys(fixture);

    down(fixture, AT_FIRST);
    up(fixture, AT_FIRST);
    down(fixture, AT_SECOND, true);
    up(fixture, AT_SECOND);
    fixture.frame.view();

    expect(fixture.stage.overlays).toEqual([
      { kind: 'highlight', key: `selection:${first ?? ''}`, placement: first },
      { kind: 'highlight', key: `selection:${second ?? ''}`, placement: second },
    ]);

    down(fixture, AT_EMPTY);
    up(fixture, AT_EMPTY);
    fixture.frame.view();
    // Пустое выделение — пустой набор: гасить нарисованное отдельным вызовом
    // не нужно, картинка есть функция состояния инструмента (REND-16).
    expect(fixture.stage.overlays).toEqual([]);
  });
});

describe('ED-16, ED-18: перетаскивание — одна операция от нажатия до отпускания', () => {
  it('мультивыделение едет целиком и отменяется одним шагом', async () => {
    const fixture = await withHits();
    const [first, second] = keys(fixture);
    const before = fixture.state.draft?.placements.map((item) => item.x) ?? [];

    down(fixture, AT_FIRST);
    down(fixture, AT_SECOND, true);
    // Второе нажатие армирует перетаскивание уже по обоим выделенным.
    move(fixture, AT_EMPTY);
    move(fixture, AT_EMPTY);
    up(fixture, AT_EMPTY);

    // Сдвиг курсора по поверхности: с (2.5, 1.5) на (3.5, 3.5).
    expect(positionOf(fixture, 0, 'x')).toBe(fixed.fromFloat((before[0] ?? 0) + 1));
    expect(positionOf(fixture, 1, 'x')).toBe(fixed.fromFloat((before[1] ?? 0) + 1));
    expect(fixture.session.history().undo).toHaveLength(1);
    expect(fixture.session.history().undo[0]?.operationId).toBe('scene.placement.move');

    fixture.session.undo();
    const after = fixture.state.draft?.placements.map((item) => item.x) ?? [];
    expect(after).toEqual(before);
    expect(selection(fixture)).toEqual([first, second]);
  });

  it('клик без сдвига записи в историю не оставляет', async () => {
    const fixture = await withHits();
    down(fixture, AT_FIRST);
    move(fixture, AT_FIRST);
    up(fixture, AT_FIRST);
    // Иначе undo после выделения не делал бы ничего, и автор нажал бы второй раз.
    expect(fixture.session.history().undo).toEqual([]);
  });

  it('объект едет во вьюпорте по ходу перетаскивания, а не в момент отпускания', async () => {
    // ED-15: «вьюпорт показывает результат не позже следующего кадра». Правка
    // внутри ещё не закрытого взаимодействия события сессии не даёт — событие
    // даёт только `commit`, — поэтому кадр сводится с документами явно. Без
    // этого объект стоял бы на месте, пока автор держит кнопку.
    const fixture = await withHits();
    const submitted = fixture.stage.submitted.length;

    down(fixture, AT_FIRST);
    move(fixture, AT_EMPTY);
    redraw(fixture);

    expect(fixture.stage.submitted.length).toBeGreaterThan(submitted);
    // Кнопка ещё не отпущена, а набор инстансов уже в новой точке.
    expect(fixture.stage.last?.placements[0]?.x).toBeCloseTo(3.5, 6);
    expect(fixture.session.history().undo).toEqual([]);
  });

  it('брошенное перетаскивание возвращает документы и не оставляет записи', async () => {
    // Отпускание, до вьюпорта не дошедшее (окно потеряло фокус, область снесена):
    // без закрытия взаимодействие осталось бы открытым, а пока оно открыто,
    // сессия не даёт ни следующей операции, ни undo (ED-18).
    const fixture = await withHits();
    const before = positionOf(fixture, 0, 'x');

    down(fixture, AT_FIRST);
    move(fixture, AT_EMPTY);
    expect(fixture.session.pending).toBe(true);

    cancel(fixture);
    expect(fixture.session.pending).toBe(false);
    expect(fixture.state.tool.dragging).toBe(false);
    expect(positionOf(fixture, 0, 'x')).toBe(before);
    expect(fixture.session.history().undo).toEqual([]);
  });

  it('точка вне представимого Q16.16 бросает перетаскивание целиком, а не наполовину', async () => {
    // Половина мультивыделения, доехавшая до новой позиции, — состояние,
    // которого не производит ни одна операция целиком; `commit` записал бы его
    // в историю как достижимое (ED-18, FP-1).
    const fixture = await withHits();
    const before = positionOf(fixture, 0, 'x');

    down(fixture, AT_FIRST);
    down(fixture, AT_SECOND, true);
    fixture.stage.surfaceHits.set(`${AT_EMPTY.x}:${AT_EMPTY.y}`, surfaceHit(1e9, 1e9, 15));
    // Отказ ядра не поднимается исключением в обработчик указателя.
    expect(() => {
      move(fixture, AT_EMPTY);
    }).not.toThrow();

    expect(fixture.session.pending).toBe(false);
    expect(positionOf(fixture, 0, 'x')).toBe(before);
    expect(fixture.session.history().undo).toEqual([]);
  });

  it('перетаскивание не переставляет записи расстановки', async () => {
    const fixture = await withHits();
    const names = records(fixture).map((entry) => getAtPath(entry, ['prefab']));

    down(fixture, AT_FIRST);
    move(fixture, AT_EMPTY);
    up(fixture, AT_EMPTY);

    // Порядок нормативен: он задаёт выданные ID (SER-8, ED-16).
    expect(records(fixture).map((entry) => getAtPath(entry, ['prefab']))).toEqual(names);
    expect(keys(fixture)).toHaveLength(2);
  });
});

describe('ED-16: расстановка дописывает в конец и адресуется выделению', () => {
  it('постановка кликом дописывает запись в конец и выделяет её', async () => {
    const fixture = await withHits();
    const before = keys(fixture);
    fixture.state.tool.setMode('place');
    fixture.state.tool.setPrefab('Hero');

    down(fixture, AT_EMPTY);
    up(fixture, AT_EMPTY);

    const list = records(fixture);
    expect(list).toHaveLength(3);
    expect(getAtPath(list[2] ?? null, ['prefab'])).toBe('Hero');
    expect(keys(fixture).slice(0, 2)).toEqual(before);
    expect(selection(fixture)).toEqual([keys(fixture)[2]]);
    // Позиция — переопределение поля компонента, названного настройкой проекта
    // (ED-16, SER-8): именованного поля позиции в записи нет.
    expect(Object.keys(list[2] as object)).toEqual(['prefab', 'overrides']);
    expect(positionOf(fixture, 2, 'x')).toBe(fixed.fromFloat(3.5));
  });

  it('привязка к сетке — инструмент ввода: в документ уходит позиция, а не клетка', async () => {
    const fixture = await withHits();
    fixture.state.tool.setMode('place');
    fixture.state.tool.setPrefab('Hero');
    fixture.state.tool.setSnapping(true);
    // Клетка фикстуры — мировая единица, поэтому 3.5 прилипает к узлу 4.
    fixture.stage.surfaceHits.set(`${AT_EMPTY.x}:${AT_EMPTY.y}`, surfaceHit(3.6, 2.4, 15));
    fixture.frame.view();

    down(fixture, AT_EMPTY);
    up(fixture, AT_EMPTY);

    expect(positionOf(fixture, 2, 'x')).toBe(4 * FIXED_ONE);
    expect(positionOf(fixture, 2, 'y')).toBe(2 * FIXED_ONE);
    // Индекса клетки в записи нет и появиться неоткуда.
    expect(JSON.stringify(records(fixture)[2])).not.toContain('cell');
  });

  it('удаление адресовано выделению и убирает обоих одной записью истории', async () => {
    const fixture = await withHits();
    down(fixture, AT_FIRST);
    up(fixture, AT_FIRST);
    down(fixture, AT_SECOND, true);
    up(fixture, AT_SECOND);
    fixture.frame.view();

    press(buttonByKey(fixture.frame.view(), 'ui.action.remove'));
    expect(records(fixture)).toHaveLength(0);
    expect(selection(fixture)).toEqual([]);
    expect(fixture.session.history().undo).toHaveLength(1);

    fixture.session.undo();
    expect(records(fixture)).toHaveLength(2);
  });

  it('поворот адресован выделению и пишет поле, названное настройкой проекта', async () => {
    const fixture = await withHits();
    down(fixture, AT_FIRST);
    up(fixture, AT_FIRST);
    fixture.frame.view();

    press(buttonByKey(fixture.frame.view(), 'ui.area.scene.rotateRight'));
    expect(positionOf(fixture, 0, 'turns')).toBe(fixed.fromFloat(1 / 8));
    expect(positionOf(fixture, 1, 'turns')).toBeUndefined();
  });

  it('поворот считается от доли оборота документа, а не от радиан кадра (FP-1)', async () => {
    // `raw/65536 · 2π / 2π` для примерно седьмой части значений Q16.16 даёт
    // величину чуть ниже исходной, и усечение к нулю возвращает на квант
    // меньше. Прежний поворот, взятый через радианы рендера, терял бы этот квант
    // на каждом нажатии — молча и накопительно.
    const fixture = await withHits();
    down(fixture, AT_FIRST);
    up(fixture, AT_FIRST);
    redraw(fixture);

    // Значение, которое обратный ход через радианы не воспроизводит бит-в-бит.
    const hostile = -65533;
    fixture.state.tool.rotate(hostile / FIXED_ONE);
    redraw(fixture);
    expect(positionOf(fixture, 0, 'turns')).toBe(hostile);

    fixture.state.tool.rotate(1 / 8);
    expect(positionOf(fixture, 0, 'turns')).toBe(hostile + FIXED_ONE / 8);
  });
});

describe('ED-26: недоступное показано недоступным', () => {
  it('удаление и поворот без выделения видимо недоступны', async () => {
    const fixture = await withHits();
    const view = fixture.frame.view();
    for (const key of ['ui.action.remove', 'ui.area.scene.rotateRight']) {
      expect(buttonByKey(view, key)?.attrs?.['aria-disabled'], key).toBe('true');
    }
  });
});

describe('ED-23: выделение переживает переключение области', () => {
  it('уход в соседнюю область и возврат оставляют выделенное на месте', async () => {
    const fixture = await withHits();
    const [, second] = keys(fixture);
    down(fixture, AT_SECOND);
    up(fixture, AT_SECOND);

    fixture.frame.activate(systemsArea.id);
    fixture.frame.view();
    fixture.frame.activate(SCENE_AREA_ID);
    fixture.frame.view();

    expect(selection(fixture)).toEqual([second]);
    // И подсветка вернулась вместе с ним: набор наложений — функция выделения.
    expect(fixture.stage.overlays).toEqual([
      { kind: 'highlight', key: `selection:${second ?? ''}`, placement: second },
    ]);
  });
});
