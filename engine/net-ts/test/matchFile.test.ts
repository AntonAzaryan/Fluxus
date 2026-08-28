/**
 * Раскладка документа матча в `MatchConfig` (`bin/matchFile.mjs`) — слой, на
 * котором сходятся ВСЕ запускалки: `serve.mjs`, `host.mjs` и стенд демо
 * (`game/demo-ts/bin/demo-serve.mjs`) поднимают матч ровно ею.
 *
 * Тестов у него не было ни одного, и это стоило демо ульты отката: раскладка
 * перечисляла секции документа поимённо и потеряла `rewind`. Матч на стенде
 * поднимался без истории, `$rewind/request` отбрасывался сервером, и снаружи
 * это выглядело как ульта, которая жжёт cooldown и ничего не делает. Ни один из
 * 79 тестов перемотки этого не видел: все они конструируют `MatchConfig`
 * напрямую, минуя раскладку.
 *
 * Предмет здесь поэтому двойной: что секции доезжают до конфига И что
 * СЛЕДУЮЩАЯ потерянная секция окажется громкой — отказом запуска с названным
 * ключом либо красным `typecheck`, а не тихо выключенным механизмом.
 *
 * Дерево контента отсюда не читается: `engine/` его не читает (CONT-4), а
 * документ настоящего матча предъявлен тестом ИГРЫ, которому это законно, —
 * `game/demo-ts/test/demoStandRewind.test.ts`. Здесь — форма документа.
 */
import { describe, expect, it } from 'vitest';
import {
  LAUNCHER_FIELDS,
  MATCH_DOCUMENT_FIELDS,
  matchConfigOf,
  matchDataOf,
  type MatchDocument,
} from '../bin/matchFile.mjs';
import type { SceneDef } from '@fluxus/core';
import { contentPack } from '../src/content/pack.js';
import { MatchServer, type MatchConfig } from '../src/server/matchServer.js';
import { duelScene } from './fixtures.js';

/**
 * Документ формы `content/matches/duel.match.json`: те же секции и те же
 * величины, но со сценой фикстуры — предмет здесь раскладка, а не сцена.
 *
 * Секция `rewind` списана с настоящего документа дословно (SNAP-4: интервал и
 * глубина — параметры провайдера, REW-9: cooldown ульты вне отката).
 */
/**
 * Сцена фикстуры плюс компонент cooldown'а ульты: `exempt` требует, чтобы поля
 * пережившего откат компонента были объявлены миром (REW-9), — иначе история не
 * собирается вовсе. В настоящей сцене дуэли это `AbilityCooldown` слотов.
 */
function scene(): SceneDef {
  const base = duelScene();
  return {
    ...base,
    components: [
      ...base.components,
      { name: 'AbilityCooldown', fields: { remaining: 'i32', total: 'i32' } },
    ],
  };
}

const REWIND = {
  interval: 30,
  capacity: 15,
  exempt: [{ component: 'AbilityCooldown' }],
  holdButton: 7,
  step: 4,
  holdTimeoutTicks: 15,
} as const;

/**
 * Секция паузы (NTR-20) — тоже дословно с настоящего документа: правила паузы
 * приходят данными матча, и потеряйся секция в раскладке, игроки лишились бы
 * паузы молча, ровно как лишились когда-то ульты отката.
 */
const PAUSE = {
  budgetPerPlayer: 3,
  opponentUnpauseAfterMs: 30_000,
  resumeCountdownMs: 3000,
  maxPauseMs: 300_000,
  onOwnerDetach: 'ignore',
} as const;

function document(overrides: Partial<MatchDocument> = {}): MatchDocument {
  return {
    name: 'duel',
    buildId: 'dev-0001',
    seed: 99,
    players: ['p1', 'p2'],
    sceneRef: 'duel',
    contentPack: { duel: '../scenes/duel.scene.json' },
    physics: {},
    locomotion: { dodgeButton: 2, jumpButton: 3, lockComponent: 'ActionLock' },
    visibility: {},
    initial: [{ prefab: 'Hero' }, { prefab: 'Hero', overrides: { Player: { slot: 1 } } }],
    teams: [0, 1],
    tickRate: 60,
    snapshotRate: 30,
    inputDelay: 2,
    inputWindow: 15,
    eventRepeat: 2,
    silenceSeconds: 30,
    rewind: REWIND,
    pause: PAUSE,
    scenes: { duel: scene() },
    ...overrides,
  };
}

function packOf(match: MatchDocument) {
  return contentPack(match.scenes ?? { duel: scene() });
}

function configOf(overrides: Partial<MatchDocument> = {}): MatchConfig {
  return configOfDocument(document(overrides));
}

function configOfDocument(match: MatchDocument): MatchConfig {
  return matchConfigOf(match, packOf(match));
}

/**
 * Тот же документ, НЕ назвавший перечисленные секции. Именно удаление ключа, а
 * не запись `undefined` в него: документ матча — разобранный JSON, ключа со
 * значением `undefined` в нём не бывает, и «документ вправе секцию не
 * называть» — это ровно про отсутствие ключа. Раскладка везёт остаток
 * документа целиком (`...carried`), поэтому разница между «нет ключа» и «ключ
 * пустой» доезжает до конфига матча как есть.
 */
function documentWithout(...omit: readonly (keyof MatchDocument)[]): MatchDocument {
  const match: { -readonly [K in keyof MatchDocument]?: MatchDocument[K] } = document();
  for (const field of omit) delete match[field];
  return match;
}

function configWithout(...omit: readonly (keyof MatchDocument)[]): MatchConfig {
  return configOfDocument(documentWithout(...omit));
}

describe('раскладка документа матча в конфиг (NTR-6, NTR-14)', () => {
  it('секция rewind доезжает до конфига дословно — иначе перематывать нечем (NET-11)', () => {
    expect(configOf().rewind).toEqual(REWIND);
  });

  it('сервер, поднятый этой раскладкой, механизм перемотки СОБРАЛ', () => {
    const server = new MatchServer(configOf());

    // `pause()` требует контроллера и без него бросает: проверка на то, что
    // история собрана, а не на то, что поле конфига непусто.
    expect(() => { server.pause(); }).not.toThrow();
    expect(server.mode).toBe('Paused');
    server.beginRewind();
    expect(server.mode).toBe('Rewinding');
    server.pause();
    server.resume();
    expect(server.mode).toBe('Running');
  });

  it('матч без секции rewind поднимается по-прежнему — перемотки в нём просто нет', () => {
    const config = configWithout('rewind');
    expect(config.rewind).toBeUndefined();
    const server = new MatchServer(config);
    expect(() => { server.pause(); }).toThrow(/без истории/);
  });

  it('до конфига доезжает КАЖДАЯ секция, объявленная документом', () => {
    const match = document();
    // Список раскладки и документ теста обязаны сойтись: секция, добавленная в
    // один и забытая в другом, краснеет здесь, а не пропадает из матча.
    expect(Object.keys(match)).toEqual(expect.arrayContaining([...MATCH_DOCUMENT_FIELDS]));

    const config: Record<string, unknown> = { ...matchConfigOf(match, packOf(match)) };
    for (const field of MATCH_DOCUMENT_FIELDS) {
      expect(config[field]).toEqual((match as Record<string, unknown>)[field]);
    }
  });

  it('выводимые поля считаются раскладкой, а не берутся из документа', () => {
    const match = document();
    const pack = packOf(match);
    const config = matchConfigOf(match, pack);

    expect(config.version).toEqual({ buildId: 'dev-0001', contentPackHash: pack.hash });
    expect(config.scene).toBe(pack.scene('duel'));
    // Порог молчания документ считает в секундах, конфиг — в тиках.
    expect(config.silenceTicks).toBe(30 * 60);
  });

  it('умолчания темпа те же, что были: документ вправе их не называть', () => {
    const config = configWithout(
      'tickRate',
      'snapshotRate',
      'inputDelay',
      'silenceSeconds',
      'initial',
    );

    expect(config.tickRate).toBe(60);
    expect(config.snapshotRate).toBe(30);
    expect(config.inputDelay).toBe(2);
    expect(config.silenceTicks).toBe(10 * 60);
    expect(config.initial).toEqual([]);
  });

  it('данные матча для лобби теряют версию и ростер, но не секции матча (SES-4)', () => {
    const match = document();
    const data: Record<string, unknown> = { ...matchDataOf(match, packOf(match)) };

    expect(data.version).toBeUndefined();
    expect(data.players).toBeUndefined();
    expect(data.rewind).toEqual(REWIND);
    expect(data.locomotion).toEqual(match.locomotion);
  });
});

describe('следующая потерянная секция — громкая, а не молчаливая', () => {
  it('неизвестный ключ документа роняет запуск и называет себя', () => {
    const match = { ...document(), rewnd: REWIND } as MatchDocument;
    expect(() => matchConfigOf(match, packOf(match))).toThrow(/"rewnd"/);
  });

  it('поле сборки запуска в документе отвергается своей причиной', () => {
    const match = { ...document(), allowObserver: true } as MatchDocument;
    expect(() => matchConfigOf(match, packOf(match))).toThrow(/поле сборки запуска/);
  });

  /**
   * Полнота списков проверяется ТИПОМ: поле `MatchConfig`, не названное ни в
   * `MATCH_DOCUMENT_FIELDS`, ни в `LAUNCHER_FIELDS`, делает `Unlisted`
   * непустым, и тогда `true` не присваивается — `npm run typecheck` краснеет
   * ещё до прогона тестов. Ровно этой проверки не хватало, когда конфиг матча
   * оброс секцией `rewind`.
   */
  it('списки раскладки покрывают конфиг матча целиком', () => {
    type Unlisted = Exclude<
      keyof MatchConfig,
      (typeof MATCH_DOCUMENT_FIELDS)[number] | (typeof LAUNCHER_FIELDS)[number]
    >;
    const complete: [Unlisted] extends [never] ? true : false = true;

    expect(complete).toBe(true);
    // Пересекаться списки не вправе: поле либо приезжает документом, либо его
    // назначает сборка, и «и то и другое» означало бы два источника у одного
    // значения.
    const both = MATCH_DOCUMENT_FIELDS.filter((field) =>
      (LAUNCHER_FIELDS as readonly string[]).includes(field),
    );
    expect(both).toEqual([]);
  });
});
