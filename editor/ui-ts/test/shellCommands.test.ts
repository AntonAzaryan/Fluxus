/**
 * Команды оболочки (ED-24, ED-25): «палитра как способ добраться до объекта,
 * системы, ассета и ОПЕРАЦИИ, не проходя дерево навигатора».
 *
 * Пустой реестр команд делал это требование мёртвым: палитра открывалась и
 * показывала одни операции, ни одну из которых нельзя было применить. Здесь
 * пиннится обратное — каждая команда, которую оболочка вносит вкладом, видна в
 * палитре и делает то, что обещает.
 *
 * Проверка идёт по строкам палитры, а не по внутренностям реестра: автор
 * добирается до команды именно так, и «зарегистрирована» без «показана»
 * ничего не значит (ED-26 — недоступное показано недоступным, а не спрятано).
 */
import { createMemoryHost, type MemoryHost } from '@fluxus/editor-core';
import { describe, expect, it } from 'vitest';
import { createEditorApp } from '../app/assembly.js';
import { SHELL_COMMANDS } from '../src/palette/commands.js';
import { PALETTE_BINDING, UNDO_BINDING } from '../src/frame/keys.js';
import { ASSETS_AREA_ID } from '../src/areas/assets.js';
import { SCENE_AREA_ID, type SceneAreaState } from '../src/areas/scene.js';
import type { PaletteEntry } from '../src/palette/palette.js';
import type { WorkspaceFrame } from '../src/frame/frame.js';
import { buildFrame } from './support/frame.js';
import { FIXTURE_CURVATURE, FIXTURE_SCENE, settle } from './support/project.js';
import { ContributionRegistry } from '@fluxus/editor-core';
import type { PaletteCommand } from '../src/palette/palette.js';
import { registerShellCommands } from '../src/palette/commands.js';
import { stubArea } from './support/stubArea.js';
import { uiResources } from '../src/i18n/uiBundles.js';

const CONFIG = 'levels/arena.json';
const VISUALS = 'art/looks.json';
const CURVATURE = 'art/arena.curve.json';

function projectHost(): MemoryHost {
  return createMemoryHost({
    name: 'project',
    root: { label: 'дерево фикстуры' },
    choices: { root: { label: 'дерево фикстуры' } },
    files: {
      [CONFIG]: JSON.stringify(FIXTURE_SCENE),
      [VISUALS]: JSON.stringify({
        entities: { Hero: { model: 'art/hero.mdx' }, Crate: { model: 'art/crate.mdx' } },
        terrain: { curvatureMap: CURVATURE },
      }),
      [CURVATURE]: JSON.stringify(FIXTURE_CURVATURE),
    },
  });
}

async function editor(): Promise<{ frame: WorkspaceFrame; host: MemoryHost; app: Awaited<ReturnType<typeof createEditorApp>> }> {
  const host = projectHost();
  const app = await createEditorApp({ host });
  app.frame.stateOf(SCENE_AREA_ID);
  await settle();
  return { frame: app.frame, host, app };
}

function entry(frame: WorkspaceFrame, id: string): PaletteEntry {
  const found = frame.paletteEntries().find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`команды "${id}" нет в палитре`);
  return found;
}

/** Каждая команда, которую вносит оболочка, и что она делает. */
const CONTRIBUTED: readonly string[] = [
  SHELL_COMMANDS.openProject,
  SHELL_COMMANDS.save,
  `${SHELL_COMMANDS.localePrefix}ru`,
  `${SHELL_COMMANDS.localePrefix}en`,
  SHELL_COMMANDS.undo,
  SHELL_COMMANDS.redo,
  SHELL_COMMANDS.preview,
  `${SHELL_COMMANDS.areaPrefix}${SCENE_AREA_ID}`,
  `${SHELL_COMMANDS.areaPrefix}${ASSETS_AREA_ID}`,
];

describe('ED-24: команды оболочки приходят в палитру вкладами', () => {
  it('каждая внесённая команда есть в палитре и подписана ресурсом', async () => {
    const { frame } = await editor();
    for (const id of CONTRIBUTED) {
      const row = entry(frame, id);
      expect(row.kind).toBe('command');
      // Подпись — из ресурсов (ED-27), а не литерал в коде команды.
      expect(row.label.origin).toBe('resource');
      expect(row.label.value.length).toBeGreaterThan(0);
    }
  });

  it('подпись и описание каждой команды разрешаются в ОБЕИХ локалях (ED-27)', () => {
    // Локали равноправны, и команда, чья подпись объявлена только в одной из
    // них, показала бы автору голый ключ ресурса. Спрашиваются оба ключа:
    // подпись видит автор, описание — он же в палитре и машинный потребитель
    // каталога (ED-30).
    const registry = new ContributionRegistry<PaletteCommand>({
      kind: 'command',
      claimName: 'сочетание клавиш',
      claimOf: (command) => command.keybinding,
    });
    registerShellCommands(registry, {
      resources: uiResources('ru'),
      areas: { all: () => [stubArea] },
      open: () => undefined,
      save: () => undefined,
    });
    expect(registry.all().length).toBeGreaterThan(5);
    for (const locale of ['ru', 'en']) {
      const resources = uiResources(locale);
      for (const command of registry.all()) {
        expect(resources.lookup(command.labelKey), `${command.id} @ ${locale}`).toBeDefined();
        expect(resources.lookup(command.descriptionKey), `${command.id} @ ${locale}`).toBeDefined();
      }
    }
  });

  it('команда перехода заводится на КАЖДУЮ область — и на ту, которой ещё нет', () => {
    // Новая область в палитре появляется регистрацией вклада, а не правкой
    // списка команд (ED-25).
    const extra = { ...stubArea, id: 'area.extra', hotkey: 'F9' };
    const registry = new ContributionRegistry<PaletteCommand>({
      kind: 'command',
      claimName: 'сочетание клавиш',
      claimOf: (command) => command.keybinding,
    });
    registerShellCommands(registry, {
      resources: uiResources('ru'),
      areas: { all: () => [stubArea, extra] },
    });
    expect(registry.has(`${SHELL_COMMANDS.areaPrefix}area.extra`)).toBe(true);
  });
});

describe('ED-24: каждая команда оболочки делает то, что обещает', () => {
  it('переход в область переключает область, а на текущей показан недоступным', async () => {
    const { frame } = await editor();
    expect(frame.activeAreaId()).toBe(SCENE_AREA_ID);
    // Переход туда, где уже стоишь, — ровно тот элемент, который нельзя
    // применить, и он показан недоступным (ED-26).
    expect(entry(frame, `${SHELL_COMMANDS.areaPrefix}${SCENE_AREA_ID}`).disabled).toBe(true);

    entry(frame, `${SHELL_COMMANDS.areaPrefix}${ASSETS_AREA_ID}`).run();
    expect(frame.activeAreaId()).toBe(ASSETS_AREA_ID);
  });

  it('смена языка меняет локаль ресурсов и не трогает документы (ED-27)', async () => {
    const { frame, app, host } = await editor();
    const before = host.text(CONFIG);
    entry(frame, `${SHELL_COMMANDS.localePrefix}en`).run();
    expect(app.resources.locale).toBe('en');
    entry(frame, `${SHELL_COMMANDS.localePrefix}ru`).run();
    expect(app.resources.locale).toBe('ru');
    // Ни байта на диске: локаль — настройка автора, а не свойство проекта.
    expect(host.text(CONFIG)).toBe(before);
    expect(host.writes).toEqual([]);
  });

  it('отмена и повтор идут историей сессии и показаны недоступными без неё', async () => {
    const { frame } = await editor();
    expect(entry(frame, SHELL_COMMANDS.undo).disabled).toBe(true);
    expect(entry(frame, SHELL_COMMANDS.redo).disabled).toBe(true);

    frame.session.applyOperation('document.setValue', {
      document: CONFIG,
      path: ['capacity'],
      value: 32,
    });
    expect(entry(frame, SHELL_COMMANDS.undo).disabled).toBe(false);
    entry(frame, SHELL_COMMANDS.undo).run();
    expect((frame.session.documentValue(CONFIG) as { capacity: number }).capacity).toBe(
      FIXTURE_SCENE.capacity,
    );
    expect(entry(frame, SHELL_COMMANDS.redo).disabled).toBe(false);
    entry(frame, SHELL_COMMANDS.redo).run();
    expect((frame.session.documentValue(CONFIG) as { capacity: number }).capacity).toBe(32);
  });

  it('сохранение показано недоступным, пока сохранять нечего (ED-26)', async () => {
    const { frame, host } = await editor();
    expect(entry(frame, SHELL_COMMANDS.save).disabled).toBe(true);

    frame.session.applyOperation('document.setValue', {
      document: CONFIG,
      path: ['capacity'],
      value: 32,
    });
    expect(entry(frame, SHELL_COMMANDS.save).disabled).toBe(false);
    entry(frame, SHELL_COMMANDS.save).run();
    await settle();
    expect(host.writes).toEqual([CONFIG]);
  });

  it('открытие проекта идёт тем же путём, что первое открытие', async () => {
    const { frame, host } = await editor();
    const asked = host.choiceRequests.filter((request) => request.kind === 'root').length;
    entry(frame, SHELL_COMMANDS.openProject).run();
    await settle();
    // Корень спрашивается заново — иначе повторное открытие не увидело бы
    // ни другого дерева, ни файла, появившегося в нём извне (ED-12).
    expect(host.choiceRequests.filter((request) => request.kind === 'root').length).toBe(asked + 1);
    // Тот же проект остаётся открытым, и вьюпорт не пересобран: «открыть то же
    // самое» состоянием области не является (ED-23).
    expect((frame.stateOf(SCENE_AREA_ID) as SceneAreaState).project?.configId).toBe(CONFIG);
  });

  it('прогон показан недоступным там, где рисовать нечем, а не молчит (ED-26)', async () => {
    const { frame } = await editor();
    // Без WebGL кадра нет, прогонять некуда — и строка палитры это показывает.
    expect(entry(frame, SHELL_COMMANDS.preview).disabled).toBe(!frame.canPreview());
  });
});

describe('ED-24, ED-25: сочетание команды — такое же занятое место, как у области', () => {
  it('сохранение доходит своим сочетанием', async () => {
    const { frame, host } = await editor();
    frame.session.applyOperation('document.setValue', {
      document: CONFIG,
      path: ['capacity'],
      value: 32,
    });
    expect(frame.handleKey({ key: 's', ctrl: true, shift: false, alt: false })).toBe(true);
    await settle();
    expect(host.writes).toEqual([CONFIG]);
  });

  it('команда на сочетании каркаса отвергается сборкой, а не молчит', () => {
    const registry = new ContributionRegistry<PaletteCommand>({ kind: 'command' });
    registry.register({
      id: 'test.command.stealsUndo',
      descriptionKey: 'ui.inspector.title',
      labelKey: 'ui.inspector.title',
      keybinding: UNDO_BINDING,
      run: () => undefined,
    });
    // Такая команда не получила бы ни одного нажатия: каркас разбирает отмену
    // раньше вкладов (ED-18, ED-23). Молчание здесь обнаруживалось бы
    // ненажимающейся клавишей, а не отказом.
    expect(() => buildFrame(undefined, 'ru', { commands: registry })).toThrow();
  });

  it('команда на сочетании области отвергается так же', () => {
    const registry = new ContributionRegistry<PaletteCommand>({ kind: 'command' });
    registry.register({
      id: 'test.command.stealsArea',
      descriptionKey: 'ui.inspector.title',
      labelKey: 'ui.inspector.title',
      keybinding: stubArea.hotkey ?? PALETTE_BINDING,
      run: () => undefined,
    });
    expect(() => buildFrame([stubArea], 'ru', { commands: registry })).toThrow();
  });
});
