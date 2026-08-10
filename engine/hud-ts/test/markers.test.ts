/**
 * Таблица маркеров и реестр отрисовщиков (задача 4.2, HUD-6): представление
 * маркера — данные; встроенные формы и специальные отрисовщики — один реестр
 * за единым интерфейсом; политика неизвестного типа объявлена таблицей.
 */
import { describe, expect, it } from 'vitest';
import type { HudJsonValue } from '../src/composition.js';
import {
  builtinMarkerRenderers,
  markerColor,
  markerTableFromParams,
  resolveMarkerTable,
  type MinimapContext2D,
  type MinimapEntityView,
  type MinimapMarkerRenderer,
  type MinimapMarkerSpec,
  type MinimapMarkerTable,
} from '../src/minimap/markers.js';

/** Записывающая заглушка 2D-контекста: тест читает вызовы, браузер не нужен. */
class RecordingContext implements MinimapContext2D {
  fillStyle: unknown = '';
  readonly calls: { op: string; args: readonly number[]; fillStyle: unknown }[] = [];

  ops(op: string): { op: string; args: readonly number[]; fillStyle: unknown }[] {
    return this.calls.filter((call) => call.op === op);
  }

  private push(op: string, args: readonly number[]): void {
    this.calls.push({ op, args, fillStyle: this.fillStyle });
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.push('fillRect', [x, y, width, height]);
  }
  clearRect(x: number, y: number, width: number, height: number): void {
    this.push('clearRect', [x, y, width, height]);
  }
  beginPath(): void {
    this.push('beginPath', []);
  }
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.push('arc', [x, y, radius, startAngle, endAngle]);
  }
  moveTo(x: number, y: number): void {
    this.push('moveTo', [x, y]);
  }
  lineTo(x: number, y: number): void {
    this.push('lineTo', [x, y]);
  }
  closePath(): void {
    this.push('closePath', []);
  }
  fill(): void {
    this.push('fill', []);
  }
}

function entity(id: number, kind: string | null, team?: number): MinimapEntityView {
  return { id, kind, currX: 0, currY: 0, ...(team !== undefined ? { team } : {}) };
}

const dotSpec: MinimapMarkerSpec = {
  renderer: 'dot',
  color: { mode: 'fixed', color: '#8f8' },
  size: 4,
  priority: 1,
};

const table: MinimapMarkerTable = {
  markers: {
    hero: {
      renderer: 'triangle',
      color: { mode: 'team', byTeam: { '0': '#3af', '1': '#f43' }, fallback: '#ccc' },
      size: 6,
      priority: 10,
    },
    creep: dotSpec,
  },
  unknownKind: { policy: 'skip' },
};

describe('таблица маркеров — данные (HUD-6)', () => {
  it('таблица — JSON-значение композиции: присваивается HudJsonValue и переживает round-trip', () => {
    // Типовая совместимость с параметрами композиции (HUD-4) — проверка компилятора.
    const asJson: HudJsonValue = table;
    expect(JSON.parse(JSON.stringify(asJson))).toEqual(table);
  });

  it('markerTableFromParams принимает валидную таблицу как есть', () => {
    const parsed = markerTableFromParams(table);
    expect(parsed).toEqual(table);
  });

  it('отсутствие таблицы, политики или полей записи — громкая ошибка конфигурации', () => {
    expect(() => markerTableFromParams(undefined)).toThrow('параметр "markers" обязателен');
    expect(() => markerTableFromParams({ markers: {} })).toThrow('политику "unknownKind"');
    expect(() =>
      markerTableFromParams({ markers: {}, unknownKind: { policy: 'explode' } }),
    ).toThrow('неизвестная политика unknownKind "explode"');
    expect(() =>
      markerTableFromParams({
        markers: { hero: { renderer: 'dot', size: 4, priority: 1 } },
        unknownKind: { policy: 'skip' },
      }),
    ).toThrow('тип "hero"');
    expect(() =>
      markerTableFromParams({
        markers: {
          hero: { renderer: 'dot', color: { mode: 'plaid' }, size: 4, priority: 1 },
        },
        unknownKind: { policy: 'skip' },
      }),
    ).toThrow('неизвестный режим окраски "plaid"');
  });
});

describe('реестр именованных отрисовщиков (HUD-6)', () => {
  it('встроенные формы — обычные записи реестра, специальный отрисовщик встаёт рядом', () => {
    const registry = builtinMarkerRenderers();
    // Встроенное зарегистрировано тем же механизмом — имена резолвятся.
    for (const name of ['dot', 'square', 'triangle']) {
      expect(typeof registry.renderer(name)).toBe('function');
    }
    // Специальный отрисовщик (иконка героя, пинг) — тот же register, тот же интерфейс.
    const heroIcon: MinimapMarkerRenderer = (ctx, x, y, _entity, draw) => {
      ctx.fillStyle = draw.color;
      ctx.fillRect(x, y, draw.size, draw.size);
    };
    registry.register('heroIcon', heroIcon);
    expect(registry.renderer('heroIcon')).toBe(heroIcon);
  });

  it('дубликат и неизвестное имя — ошибки с именем', () => {
    const registry = builtinMarkerRenderers();
    expect(() => {
      registry.register('dot', () => undefined);
    }).toThrow('"dot" уже зарегистрирован');
    expect(() => registry.renderer('ping')).toThrow('"ping" не зарегистрирован');
  });

  it('таблица ссылается на специальный отрисовщик по имени — он получает вызов', () => {
    const registry = builtinMarkerRenderers();
    const seen: number[] = [];
    registry.register('heroIcon', (_ctx, x) => {
      seen.push(x);
    });
    const resolved = resolveMarkerTable(
      {
        markers: { hero: { ...dotSpec, renderer: 'heroIcon' } },
        unknownKind: { policy: 'skip' },
      },
      registry,
    );
    const marker = resolved.markerFor('hero');
    expect(marker).not.toBeNull();
    marker?.render(new RecordingContext(), 7, 0, entity(1, 'hero'), {
      color: '#fff',
      size: 4,
      spec: marker.spec,
    });
    expect(seen).toEqual([7]);
  });
});

describe('резолв таблицы против реестра (HUD-6)', () => {
  it('неизвестное имя отрисовщика — ошибка при резолве с именем записи, до отрисовки', () => {
    const registry = builtinMarkerRenderers();
    expect(() =>
      resolveMarkerTable(
        { markers: { hero: { ...dotSpec, renderer: 'hologram' } }, unknownKind: { policy: 'skip' } },
        registry,
      ),
    ).toThrow('тип "hero": неизвестный отрисовщик "hologram"');
    expect(() =>
      resolveMarkerTable(
        {
          markers: {},
          unknownKind: { policy: 'default', marker: { ...dotSpec, renderer: 'hologram' } },
        },
        registry,
      ),
    ).toThrow('default-маркер политики unknownKind');
  });

  it('политика skip: тип без записи — null (пропуск), не ошибка', () => {
    const resolved = resolveMarkerTable(table, builtinMarkerRenderers());
    expect(resolved.markerFor('creep')?.spec).toEqual(dotSpec);
    expect(resolved.markerFor('mystery')).toBeNull();
  });

  it('политика default: тип без записи получает default-маркер', () => {
    const resolved = resolveMarkerTable(
      { markers: {}, unknownKind: { policy: 'default', marker: dotSpec } },
      builtinMarkerRenderers(),
    );
    expect(resolved.markerFor('mystery')?.spec).toEqual(dotSpec);
  });
});

describe('окраска маркера', () => {
  it('фиксированный цвет не смотрит на команду', () => {
    expect(markerColor({ mode: 'fixed', color: '#8f8' }, entity(1, 'creep', 1))).toBe('#8f8');
  });

  it('командная окраска: словарь, отсутствие команды и команда вне словаря — fallback', () => {
    const spec = { mode: 'team', byTeam: { '0': '#3af', '1': '#f43' }, fallback: '#ccc' } as const;
    expect(markerColor(spec, entity(1, 'hero', 0))).toBe('#3af');
    expect(markerColor(spec, entity(2, 'hero', 1))).toBe('#f43');
    // Поля team в доставленной плоской форме пока нет (SHELL-2) — fallback, не ошибка.
    expect(markerColor(spec, entity(3, 'hero'))).toBe('#ccc');
    expect(markerColor(spec, entity(4, 'hero', 9))).toBe('#ccc');
  });
});
