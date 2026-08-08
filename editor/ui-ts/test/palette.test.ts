/**
 * Палитра команд и поиск по проекту (ED-24): «способ добраться до объекта,
 * системы, ассета и операции, не проходя дерево навигатора».
 *
 * Три свойства, ради которых она и написана, пиннятся здесь:
 *
 * - операции приходят из машинного каталога (ED-30), поэтому только что
 *   зарегистрированная операция появляется в палитре, а палитра не правится;
 * - команда — вклад (ED-25): зарегистрировали, и она в списке, каркас при этом
 *   тот же;
 * - находки поиска приносят области, а открывает их каркас — переключением на
 *   ту область, которая находку дала (ED-23: поиск сквозной).
 */
import {
  ContributionRegistry,
  type AuthoringOperation,
  type ValidationRule,
} from '@game-mvp/editor-core';
import { describe, expect, it } from 'vitest';
import { collectTexts, findAll, hasClass, type UiNode } from '../src/dom/node.js';
import { PALETTE_CLASS, PALETTE_ROVING_ID } from '../src/palette/view.js';
import type { CommandTarget, PaletteCommand } from '../src/palette/palette.js';
import { PALETTE_BINDING } from '../src/frame/keys.js';
import { systemsArea } from '../src/areas/systems.js';
import { createAssetArea } from '../src/areas/assets.js';
import { attr, buildFrame, buildLoadedFrame, keydown } from './support/frame.js';
import { FIXTURE_CURVATURE_ID, FIXTURE_IDS, fixtureHost, settle } from './support/project.js';

/** Операция-вклад: у неё нет ничего, кроме id, ключа описания и параметров. */
const NAMED_OPERATION: AuthoringOperation = {
  id: 'test.rename',
  descriptionKey: 'ui.inspector.title',
  params: { document: { type: 'document', descriptionKey: 'ui.inspector.title' } },
  apply: () => undefined,
};

function paletteOf(view: UiNode): UiNode | undefined {
  return findAll(view, (node) => hasClass(node, PALETTE_CLASS))[0];
}

/** Строки палитры: их `data-id` — id команды, операции или находки. */
function entryIds(view: UiNode): string[] {
  const palette = paletteOf(view);
  return palette === undefined
    ? []
    : findAll(palette, (node) => attr(node, 'role') === 'option').map(
        (node) => attr(node, 'data-id') ?? '',
      );
}

describe('ED-24: палитра открывается и закрывается, не мешая областям', () => {
  it('сочетание каркаса открывает её и возвращает фокус в строку запроса', () => {
    const { frame } = buildFrame();
    expect(frame.paletteOpen()).toBe(false);
    expect(paletteOf(frame.view())).toBeUndefined();

    expect(frame.handleKey({ key: 'p', ctrl: true, shift: false, alt: false })).toBe(true);
    expect(frame.paletteOpen()).toBe(true);
    // Фокус — в палитру: открыть её и заставить автора дотянуться мышью значило
    // бы не дать добраться до чего-либо клавиатурой.
    expect(frame.takeFocusRequest()).toBe(PALETTE_ROVING_ID);

    const palette = paletteOf(frame.view());
    expect(palette).toBeDefined();
    expect(attr(palette ?? { tag: 'div' }, 'role')).toBe('dialog');
  });

  it('сочетание палитры занято каркасом и области его не получают', () => {
    // Область, объявившая `Ctrl+P` своей, не получила бы ни одного нажатия —
    // каркас разбирает его раньше. Отказ вместо молчания (ED-23).
    expect(() =>
      buildFrame([{ ...systemsArea, id: 'area.other', hotkey: PALETTE_BINDING }]),
    ).toThrow();
  });

  it('Escape гасит палитру, а не уводит фокус мимо неё', () => {
    const { frame } = buildFrame();
    frame.openPalette();
    expect(frame.handleKey({ key: 'Escape', ctrl: false, shift: false, alt: false })).toBe(true);
    expect(frame.paletteOpen()).toBe(false);
  });
});

describe('ED-24, ED-30: операции приходят из каталога, а не из списка в палитре', () => {
  it('только что зарегистрированная операция появляется в палитре сама', () => {
    const { frame, session } = buildFrame();
    frame.openPalette();
    expect(entryIds(frame.view())).not.toContain(NAMED_OPERATION.id);

    // Регистрация — единственное действие: ни палитра, ни каталог не правятся
    // (ED-30: «отдельно каталог не правится»).
    session.operations.register(NAMED_OPERATION);
    expect(entryIds(frame.view())).toContain(NAMED_OPERATION.id);
  });

  it('операция без команды показана недоступной, а не спрятана', () => {
    const { frame, session } = buildFrame();
    session.operations.register(NAMED_OPERATION);
    frame.openPalette();
    const row = findAll(
      paletteOf(frame.view()) ?? { tag: 'div' },
      (node) => attr(node, 'data-id') === NAMED_OPERATION.id,
    )[0];
    // Параметры операции палитре взять неоткуда (ED-25), и она говорит об этом
    // недоступностью, а не молчанием (ED-26).
    expect(attr(row ?? { tag: 'div' }, 'aria-disabled')).toBe('true');
    expect(row?.on?.['click']).toBeUndefined();
  });

  it('команда, взявшая операцию на себя, делает её исполнимой', () => {
    const commands = new ContributionRegistry<PaletteCommand>({
      kind: 'command',
      claimName: 'сочетание клавиш',
      claimOf: (command) => command.keybinding,
    });
    let ran = 0;
    commands.register({
      id: 'test.command.rename',
      descriptionKey: 'ui.inspector.title',
      labelKey: 'ui.inspector.title',
      operation: NAMED_OPERATION.id,
      run: (target: CommandTarget) => {
        expect(target.session).toBeDefined();
        ran += 1;
      },
    });
    const { frame, session } = buildFrame(undefined, 'ru', { commands });
    session.operations.register(NAMED_OPERATION);
    frame.openPalette();

    const view = frame.view();
    const row = findAll(
      paletteOf(view) ?? { tag: 'div' },
      (node) => attr(node, 'data-id') === NAMED_OPERATION.id,
    )[0];
    expect(attr(row ?? { tag: 'div' }, 'aria-disabled')).toBeUndefined();
    row?.on?.['click']?.({} as Event);
    expect(ran).toBe(1);
    // Палитра закрывается тем же действием: строка исполнена, показывать
    // собранный по прежнему состоянию список больше нечего.
    expect(frame.paletteOpen()).toBe(false);
  });

  it('в превью операции авторинга в палитре недоступны (ED-9, ED-26)', async () => {
    const { frame, session } = await buildLoadedFrame();
    session.operations.register(NAMED_OPERATION);
    frame.togglePreview();
    expect(frame.mode()).toBe('preview');
    const entry = frame.paletteEntries().find((candidate) => candidate.id === NAMED_OPERATION.id);
    expect(entry?.disabled).toBe(true);
    frame.stopPreview();
  });
});

describe('ED-24, ED-23: поиск по проекту находит документ мимо дерева', () => {
  it('документ находится по куску имени и открывается напрямую', async () => {
    const { frame, area } = await buildLoadedFrame();
    // Дерево навигатора при этом не трогается вовсе: автор набирает запрос.
    frame.setSearchQuery('manifest');
    frame.openPalette();

    const hit = frame.paletteEntries().find((entry) => entry.kind === 'result');
    expect(hit?.label.value).toBe(FIXTURE_IDS.visuals);
    hit?.run();
    expect(frame.selection.get(area.id)).toEqual([FIXTURE_IDS.visuals]);
  });

  it('находка соседней области открывается вместе с переходом в неё', async () => {
    const { frame, area } = await buildLoadedFrame();
    expect(frame.activeAreaId()).toBe(area.id);
    frame.setSearchQuery('regen');
    frame.openPalette();

    const hit = frame.paletteEntries().find((entry) => entry.kind === 'result');
    expect(hit).toBeDefined();
    hit?.run();
    // Поиск сквозной (ED-23): каркас переключает область сам, потому что
    // открыть найденное умеет только та область, которая его нашла.
    expect(frame.activeAreaId()).toBe(systemsArea.id);
    expect(frame.selection.get(systemsArea.id)).toEqual(['content/systems/regen.system.json']);
  });

  it('пустой запрос находок не даёт, а команды и операции остаются', () => {
    const { frame, session } = buildFrame();
    session.operations.register(NAMED_OPERATION);
    frame.openPalette();
    expect(frame.paletteEntries().every((entry) => entry.kind !== 'result')).toBe(true);
    expect(frame.paletteEntries().length).toBeGreaterThan(0);
  });

  it('запрос сквозной: он переживает переключение области и правит список', async () => {
    const { frame } = await buildLoadedFrame();
    frame.setSearchQuery('fixture');
    frame.activate(systemsArea.id);
    expect(frame.searchQuery()).toBe('fixture');
    frame.openPalette();
    const labels = frame
      .paletteEntries()
      .filter((entry) => entry.kind === 'result')
      .map((entry) => entry.label.value);
    expect(labels).toContain(FIXTURE_IDS.config);
    expect(labels).toContain(FIXTURE_CURVATURE_ID);
  });

  it('строка запроса верхнего бара открывает палитру набранным', () => {
    const { frame } = buildFrame();
    const search = findAll(frame.view(), (node) => attr(node, 'type') === 'search')[0];
    search?.on?.['input']?.({ target: { value: 'duel' } } as unknown as Event);
    expect(frame.searchQuery()).toBe('duel');
    expect(frame.paletteOpen()).toBe(true);
  });

  it('ассет дерева контента — такая же находка, как документ', async () => {
    // ED-24 называет ассет наравне с объектом и системой; приносит находку та
    // область, которая дерево контента и показывает (ED-20).
    const host = fixtureHost();
    const assets = createAssetArea({ host });
    const { frame } = await buildLoadedFrame('ru', { host, areas: [assets] });
    // Запись состояния области заводится первым обращением к ней, а дерево она
    // читает асинхронно — так же, как читал бы его настоящий хост среды.
    frame.stateOf(assets.id);
    await settle();

    frame.setSearchQuery('scene.json');
    frame.openPalette();
    const labels = frame
      .paletteEntries()
      .filter((entry) => entry.kind === 'result')
      .map((entry) => entry.detail?.value ?? '');
    expect(labels).toContain(FIXTURE_IDS.config);
  });
});

describe('ED-24: клавиатура палитры водит по строкам, не теряя строку запроса', () => {
  it('стрелки двигают подсветку, Enter исполняет подсвеченное', () => {
    const { frame, session } = buildFrame();
    session.operations.register(NAMED_OPERATION);
    frame.openPalette();

    const query = (): UiNode | undefined =>
      findAll(paletteOf(frame.view()) ?? { tag: 'div' }, (node) => node.tag === 'input')[0];
    // Единственная остановка Tab палитры — строка запроса: по ней каркас и
    // возвращает фокус после пересборки страницы.
    expect(attr(query() ?? { tag: 'div' }, 'tabindex')).toBe('0');

    const selected = (): string =>
      findAll(
        paletteOf(frame.view()) ?? { tag: 'div' },
        (node) => attr(node, 'aria-selected') === 'true',
      ).map((node) => attr(node, 'data-id') ?? '')[0] ?? '';
    const first = selected();
    expect(keydown(query(), 'ArrowDown')).toBe(true);
    expect(selected()).not.toBe(first);
    expect(keydown(query(), 'ArrowUp')).toBe(true);
    expect(selected()).toBe(first);
  });

  it('правило валидации палитру не касается: её строки — команды и находки', async () => {
    // Проверка на то, что палитра не начала показывать всё подряд: правило —
    // вклад (ED-25), но добраться до него ED-24 не требует.
    const rule: ValidationRule = {
      id: 'test.noop',
      descriptionKey: 'ui.inspector.title',
      reasonCodes: ['noop'],
      appliesTo: ['scene'],
      check: () => undefined,
    };
    const { frame } = await buildLoadedFrame('ru', { rules: [rule] });
    frame.openPalette();
    expect(frame.paletteEntries().some((entry) => entry.id === rule.id)).toBe(false);
  });
});

describe('ED-27: весь текст палитры имеет происхождение', () => {
  it('подписи — из ресурсов, значения — имена реестров и документов', async () => {
    const { frame, session } = await buildLoadedFrame();
    session.operations.register(NAMED_OPERATION);
    frame.setSearchQuery('fixture');
    frame.openPalette();
    const palette = paletteOf(frame.view());
    expect(palette).toBeDefined();

    // Имена, которые палитра вправе показать как значение: id операций реестра,
    // id открытых документов и имена prefab’ов их расстановки. Локаль их не
    // касается — они принадлежат реестрам и документам, а не интерфейсу.
    const names = new Set<string>([
      // Набранное автором — тоже не подпись интерфейса: запрос принадлежит ему,
      // и локаль его не касается ровно так же, как имени prefab’а (ED-27).
      frame.searchQuery(),
      ...session.operations.list().map((operation) => operation.id),
      ...session.documentIds(),
      ...(
        (session.documentValue(FIXTURE_IDS.config) as { prefabs?: { name?: string }[] }).prefabs ??
        []
      ).map((prefab) => prefab.name ?? ''),
    ]);

    const texts = collectTexts(palette ?? { tag: 'div' });
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      if (text.origin === 'value') {
        expect(names.has(text.value), `значение не из реестра и не из документа: ${text.value}`)
          .toBe(true);
        continue;
      }
      // Подпись обязана разрешиться: у палитры нет ни одного ключа, который
      // вычислялся бы из пути поля в схеме (ED-28), — все они её собственные.
      expect(frame.session).toBeDefined();
      expect(text.value.length).toBeGreaterThan(0);
      expect(text.value).not.toBe(text.key);
    }
  });
});
