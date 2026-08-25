/**
 * Схема профиля (DSK-5): что контейнер соглашается запустить, а что отвергает
 * на разборе манифеста.
 *
 * Отказ на разборе — не педантизм. Профиль объявляет выданные возможности, и
 * «поле не понял, взял по умолчанию» означало бы возможность, которой никто не
 * объявлял, — то самое расширение профиля, которое DSK-5 запрещает.
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeAppProfile,
  profileGrants,
  profileRoot,
  profileService,
} from '../src/bridge/profile.js';

const EDITOR = {
  id: 'editor',
  title: 'Fluxus Editor',
  bundle: '../../editor/ui-ts/app/dist',
  roots: [{ id: 'content', label: 'content', directory: '../../content', writable: true, serve: true }],
  capabilities: ['read', 'write', 'watch', 'dialog', 'window'],
};

describe('разбор манифеста профиля', () => {
  it('полный профиль редактора разбирается со всеми полями', () => {
    const profile = normalizeAppProfile(EDITOR, 'editor.app.json');
    expect(profile.id).toBe('editor');
    expect(profile.entry).toBe('index.html');
    expect(profile.window).toEqual({ width: 1440, height: 900 });
    expect(profileGrants(profile, 'write')).toBe(true);
    expect(profileRoot(profile, 'content')?.serve).toBe(true);
    expect(profileRoot(profile, 'нет')).toBeUndefined();
  });

  it('профиль игры: чтение раздачей, мост пуст', () => {
    const profile = normalizeAppProfile(
      {
        id: 'game',
        title: 'Fluxus',
        bundle: 'dist',
        roots: [{ id: 'content', directory: 'content', serve: true }],
        capabilities: [],
      },
      'game.app.json',
    );
    expect(profile.capabilities).toEqual([]);
    expect(profileRoot(profile, 'content')?.writable).toBe(false);
    // Метки нет — показывается имя корня: второго имени у одного корня не бывает.
    expect(profileRoot(profile, 'content')?.label).toBe('content');
  });

  it('возможность вне контракта отвергается по имени', () => {
    expect(() =>
      normalizeAppProfile({ ...EDITOR, capabilities: ['read', 'exec'] }, 'editor.app.json'),
    ).toThrow('exec');
  });

  it('корень на запись без возможности "write" — расхождение, а не мелочь', () => {
    expect(() => normalizeAppProfile({ ...EDITOR, capabilities: ['read'] }, 'editor.app.json')).toThrow(
      'write',
    );
  });

  it('возможность "write" без единого корня на запись — тоже отказ', () => {
    expect(() =>
      normalizeAppProfile(
        { ...EDITOR, roots: [{ id: 'content', directory: 'c', writable: false }] },
        'editor.app.json',
      ),
    ).toThrow('ни один корень');
  });

  it('два корня с одним именем не разбираются', () => {
    expect(() =>
      normalizeAppProfile(
        {
          ...EDITOR,
          capabilities: ['read'],
          roots: [
            { id: 'content', directory: 'a' },
            { id: 'content', directory: 'b' },
          ],
        },
        'editor.app.json',
      ),
    ).toThrow('дважды');
  });

  it('отказ называет манифест и требование', () => {
    expect(() => normalizeAppProfile({ ...EDITOR, id: '' }, 'editor.app.json')).toThrow(
      /editor\.app\.json.*DSK-5/s,
    );
  });

  it('поля не строкой и не объектом отвергаются', () => {
    expect(() => normalizeAppProfile('профиль', 'x.json')).toThrow('не объект');
    expect(() => normalizeAppProfile({ ...EDITOR, bundle: 42 }, 'x.json')).toThrow('bundle');
    expect(() => normalizeAppProfile({ ...EDITOR, roots: {} }, 'x.json')).toThrow('roots');
    expect(() => normalizeAppProfile({ ...EDITOR, window: { width: 0 } }, 'x.json')).toThrow(
      'window.width',
    );
  });

  it('повтор возможности не удваивает whitelist', () => {
    const profile = normalizeAppProfile(
      { ...EDITOR, capabilities: ['read', 'read', 'write'] },
      'x.json',
    );
    expect(profile.capabilities).toEqual(['read', 'write']);
  });
});

/** Профиль игры с объявленным сервисом (DSK-7). */
const GAME = {
  id: 'game',
  title: 'Fluxus',
  bundle: 'dist',
  roots: [{ id: 'content', directory: 'content', serve: true }],
  capabilities: ['service'],
  services: [
    { id: 'match-stand', script: 'stand.mjs', args: ['--port', '{port}'], address: 'ws://127.0.0.1:8080' },
  ],
};

describe('объявленные профилем сервисы (DSK-7)', () => {
  it('сервис разбирается со скриптом, аргументами и адресом', () => {
    const profile = normalizeAppProfile(GAME, 'game.app.json');
    expect(profileService(profile, 'match-stand')).toEqual({
      id: 'match-stand',
      script: 'stand.mjs',
      args: ['--port', '{port}'],
      address: 'ws://127.0.0.1:8080',
      // Отвязываемость — свойство ОБЪЯВЛЕНИЯ (DSK-7), и умолчание у него
      // прежнее правило: сервис умирает с сессией.
      detached: false,
    });
    expect(
      profileService(
        normalizeAppProfile(
          { ...GAME, services: [{ ...GAME.services[0], detached: true }] },
          'game.app.json',
        ),
        'match-stand',
      )?.detached,
    ).toBe(true);
    expect(profileService(profile, 'нет')).toBeUndefined();
  });

  it('профиль без сервисов их не выдумывает', () => {
    const profile = normalizeAppProfile(EDITOR, 'editor.app.json');
    expect(profile.services).toEqual([]);
    expect(profileGrants(profile, 'service')).toBe(false);
  });

  it('сервис без возможности "service" — расхождение, а не мелочь', () => {
    expect(() => normalizeAppProfile({ ...GAME, capabilities: [] }, 'game.app.json')).toThrow(
      'service',
    );
  });

  it('возможность "service" без единого сервиса — тоже отказ', () => {
    expect(() => normalizeAppProfile({ ...GAME, services: [] }, 'game.app.json')).toThrow(
      'ни одного сервиса',
    );
  });

  it('два сервиса с одним именем не разбираются', () => {
    expect(() =>
      normalizeAppProfile({ ...GAME, services: [GAME.services[0], GAME.services[0]] }, 'game.app.json'),
    ).toThrow('дважды');
  });

  it('кривые поля сервиса отвергаются с именем поля', () => {
    expect(() =>
      normalizeAppProfile({ ...GAME, services: [{ ...GAME.services[0], script: 42 }] }, 'x.json'),
    ).toThrow('script');
    expect(() =>
      normalizeAppProfile({ ...GAME, services: [{ ...GAME.services[0], address: '' }] }, 'x.json'),
    ).toThrow('address');
    expect(() =>
      normalizeAppProfile({ ...GAME, services: [{ ...GAME.services[0], args: '--port' }] }, 'x.json'),
    ).toThrow('args');
    expect(() => normalizeAppProfile({ ...GAME, services: {} }, 'x.json')).toThrow('services');
  });
});
