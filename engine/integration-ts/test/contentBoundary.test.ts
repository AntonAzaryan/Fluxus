/**
 * Граница контента (CONT-1): в пакетах движка не лежит игровой контент.
 *
 * Проверка живёт в кросс-слойной сюите, потому что правило репозиторное, а не
 * про один пакет: `integration-ts` — единственное место, которому видны все
 * пакеты сразу. Сканер общий — engine/tests/guard/contentLocation.ts; здесь
 * конфигурация движка и тесты самого сканера.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENGINE_FIXTURE_EXCLUSIONS,
  formatContentViolations,
  scanContentLocation,
} from '../../tests/guard/contentLocation.js';

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('guard: игровой контент вне пакетов движка (CONT-1)', () => {
  it('в engine/ нет документов контента, кроме освобождённых фикстур', () => {
    const violations = scanContentLocation({
      rootDir: ENGINE_ROOT,
      exclude: ENGINE_FIXTURE_EXCLUSIONS,
    });
    expect(formatContentViolations(violations)).toBe('');
  });
});

describe('guard: сканер границы контента ловит каждый вид документа', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'content-guard-'));
    mkdirSync(join(root, 'pkg-ts/src'), { recursive: true });
    mkdirSync(join(root, 'pkg-ts/src/bots/behaviors'), { recursive: true });
    mkdirSync(join(root, 'pkg-ts/src/visuals'), { recursive: true });
    mkdirSync(join(root, 'pkg-ts/node_modules/dep'), { recursive: true });
    mkdirSync(join(root, 'tests/golden'), { recursive: true });
    // Профиль бота (bot-player BOT-6) опознаётся директорией: имя файла —
    // уровень сложности, по суффиксу от любого JSON его не отличить. Документ
    // поведения (BOT-8) лежит уровнем глубже — в `bots/behaviors/`, — поэтому
    // имя контентной директории ищется на любом уровне пути, а не у родителя.
    writeFileSync(join(root, 'pkg-ts/src/bots/easy.json'), '{}');
    writeFileSync(join(root, 'pkg-ts/src/bots/behaviors/classic.json'), '{}');
    // Карта кривизны (assets ASSET-7) названа назначением, а не видом: ловится
    // по имени, поэтому её копия ВНЕ дерева визуалов границу тоже не проезжает.
    writeFileSync(join(root, 'pkg-ts/src/arena-curvature.json'), '{}');
    // А документ дерева визуалов с произвольным именем опознаёт место.
    writeFileSync(join(root, 'pkg-ts/src/visuals/skins.json'), '{}');
    // Эмиттерный ассет (ASSET-14) и иконка интерфейса (match-hud HUD-4) —
    // presentation-документы дерева контента наравне с моделью и текстурой.
    writeFileSync(join(root, 'pkg-ts/src/torch.effect.json'), '{}');
    writeFileSync(join(root, 'pkg-ts/src/cast.svg'), '');
    writeFileSync(join(root, 'pkg-ts/src/duel.scene.json'), '{}');
    writeFileSync(join(root, 'pkg-ts/src/duel.presentation.json'), '{}');
    writeFileSync(join(root, 'pkg-ts/src/duel.bots.json'), '{}');
    writeFileSync(join(root, 'pkg-ts/src/duel.match.json'), '{}');
    writeFileSync(join(root, 'pkg-ts/src/manifest.json'), '{}');
    writeFileSync(join(root, 'pkg-ts/src/hero.mdx'), '');
    // Та же модель в ТЕКУЩЕМ формате контента (ASSET-3, BLND-11) и авторский
    // источник её сцены (CONT-6): знай сканер только `.mdx`, граница CONT-1
    // держалась бы для исторического формата и протекала бы для рабочего.
    writeFileSync(join(root, 'pkg-ts/src/hero.gltf'), '');
    writeFileSync(join(root, 'pkg-ts/src/hero.glb'), '');
    writeFileSync(join(root, 'pkg-ts/src/duel.blend'), '');
    writeFileSync(join(root, 'pkg-ts/src/skin.png'), '');
    // Не контент: исходники, манифест пакета, эталон прогона.
    writeFileSync(join(root, 'pkg-ts/src/index.ts'), '');
    writeFileSync(join(root, 'pkg-ts/package.json'), '{}');
    writeFileSync(join(root, 'tests/golden/movement.scenario.json'), '{}');
    writeFileSync(join(root, 'tests/golden/movement.golden.json'), '{}');
    // Чужой пакет в общем хранилище — не исходник репозитория.
    writeFileSync(join(root, 'pkg-ts/node_modules/dep/thing.scene.json'), '{}');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('сцена, парные слои, матч, манифест, модель, текстура, эффект, иконка и документы ботов краснят', () => {
    const files = scanContentLocation({ rootDir: root }).map((v) => v.file);
    expect(files).toEqual([
      'pkg-ts/src/arena-curvature.json',
      'pkg-ts/src/bots/behaviors/classic.json',
      'pkg-ts/src/bots/easy.json',
      'pkg-ts/src/cast.svg',
      'pkg-ts/src/duel.blend',
      'pkg-ts/src/duel.bots.json',
      'pkg-ts/src/duel.match.json',
      'pkg-ts/src/duel.presentation.json',
      'pkg-ts/src/duel.scene.json',
      'pkg-ts/src/hero.glb',
      'pkg-ts/src/hero.gltf',
      'pkg-ts/src/hero.mdx',
      'pkg-ts/src/manifest.json',
      'pkg-ts/src/skin.png',
      'pkg-ts/src/torch.effect.json',
      'pkg-ts/src/visuals/skins.json',
    ]);
  });

  it('виды, которых словарь прежде не знал, ловятся наравне с прочими (CONT-1)', () => {
    // Дыра, которую закрывает этот набор: в дереве контента лежат иконки
    // интерфейса, документы эффектов, карта кривизны и документы поведения
    // ботов, а словарь проверки знал только сцену, парные слои, матч, манифест,
    // модель, текстуру и профиль бота. Копия любого из четырёх видов внутри
    // пакета движка проезжала границу молча — ровно тот случай, ради которого
    // проверка заведена.
    const kinds = new Map(scanContentLocation({ rootDir: root }).map((v) => [v.file, v.message]));
    expect(kinds.get('pkg-ts/src/cast.svg')).toContain('HUD-4');
    expect(kinds.get('pkg-ts/src/torch.effect.json')).toContain('ASSET-14');
    // Карта кривизны — по имени (ASSET-7), любой другой документ дерева
    // визуалов — по месту (ASSET-2): два признака, а не один.
    expect(kinds.get('pkg-ts/src/arena-curvature.json')).toContain('ASSET-7');
    expect(kinds.get('pkg-ts/src/visuals/skins.json')).toContain('ASSET-2');
    expect(kinds.get('pkg-ts/src/bots/behaviors/classic.json')).toContain('BOT-8');
  });

  it('модель в РАБОЧЕМ формате контента граница ловит наравне с историческим', () => {
    // Отдельным тестом, потому что это и была дыра: `.mdx` — исторический
    // формат реестра (BLND-11), а модели контента приезжают glTF (ASSET-3), и
    // словарь сканера обязан знать оба, иначе CONT-1 держится только для того
    // формата, которым уже не пользуются.
    const kinds = new Map(scanContentLocation({ rootDir: root }).map((v) => [v.file, v.message]));
    for (const file of ['pkg-ts/src/hero.gltf', 'pkg-ts/src/hero.glb', 'pkg-ts/src/duel.blend']) {
      expect(kinds.get(file), file).toContain('CONT-1');
    }
  });

  it('исходники, манифест пакета и эталоны прогона не краснят', () => {
    const files = scanContentLocation({ rootDir: root }).map((v) => v.file);
    expect(files).not.toContain('pkg-ts/src/index.ts');
    expect(files).not.toContain('pkg-ts/package.json');
    expect(files).not.toContain('tests/golden/movement.scenario.json');
    expect(files).not.toContain('tests/golden/movement.golden.json');
  });

  it('node_modules не обходится: чужие пакеты — не исходники репозитория', () => {
    const files = scanContentLocation({ rootDir: root }).map((v) => v.file);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('освобождённая директория отсекается целиком', () => {
    const violations = scanContentLocation({
      rootDir: root,
      exclude: [{ dir: 'pkg-ts/src', reason: 'проверка освобождения' }],
    });
    expect(formatContentViolations(violations)).toBe('');
  });

  it('нарушение называет файл, правило и вид документа', () => {
    const violations = scanContentLocation({ rootDir: root });
    const first = violations.find((v) => v.file === 'pkg-ts/src/duel.match.json');
    expect(first!.rule).toBe('content-in-engine');
    expect(first!.message).toContain('конфиг матча');
    expect(first!.message).toContain('CONT-1');
    expect(first!.message).toContain('engine/tests/guard/contentLocation.ts');
  });
});
