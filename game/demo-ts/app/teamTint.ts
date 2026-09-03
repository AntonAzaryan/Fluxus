/**
 * Цвет команды на инстансах (`rendering` REND-40) — политика ЭТОГО приложения.
 *
 * Рендер знает только «этой сущности — этот цвет с этой силой» (`setTint`): что
 * такое команда, сколько их и какого они цвета, механизму неизвестно и знать
 * ему это незачем (`docs/architecture.md` §3, механизм против политики). Здесь
 * — вторая половина: доставленный стат `team` (`sim.ts`) через ДОКУМЕНТ ПАЛИТРЫ
 * (`presets/teams.json`) превращается в цвет, и он же уходит в порт.
 *
 * Палитра — документ приложения рядом с пресетами качества, а не секция парного
 * presentation-документа сцены: цвет команды — свойство МАТЧА, а не арены, на
 * которой он идёт. Одна и та же дуэльная сцена играется и «синие против
 * красных», и «восемь одиночек»; положи палитру в документ сцены — и правка
 * состава матча стала бы правкой арены. По той же причине дальтонизм лечится
 * подменой этого файла (аудит §4.3.5), а не правкой рендера.
 *
 * Цвета переводятся в рабочее пространство ОДИН раз на палитру: на кадре
 * остаётся сравнение доставленного стата с уже поданным (`applied`), и
 * аллокаций у подачи нет вовсе.
 */
import * as THREE from 'three';
import type { EntityId } from '@fluxus/core';
import type { EntityView, InstanceTintInput } from '@fluxus/render';
import teamsJson from './presets/teams.json';
import { STATS } from './sim.js';

/** Документ палитры команд: сила тинта и цвет на номер команды. */
interface TeamPaletteDoc {
  readonly strength: number;
  readonly colors: Readonly<Record<string, string>>;
}

/** Кому подача ставит тинт и чем она читает доставку. */
export interface TeamTintOptions {
  /** Доставленные сущности кадра; undefined — доставки ещё нет. */
  readonly entities: () => ReadonlyMap<EntityId, EntityView> | undefined;
  /** Порт «цвет на сущность» (REND-40); false — инстанса нет. */
  readonly setTint: (entity: EntityId, tint: InstanceTintInput | null) => boolean;
}

export interface TeamTint {
  /** Кадровое обновление — после подсистем, по инстансам ЭТОГО кадра. */
  update(): void;
}

/**
 * Разобранная палитра: цвет команды уже в рабочем пространстве рендера.
 * Экспортируется ради теста — он обязан читать те же числа, что и подача, а не
 * второй разбор того же файла.
 */
export function teamPalette(): ReadonlyMap<number, InstanceTintInput> {
  const doc = teamsJson as TeamPaletteDoc;
  const palette = new Map<number, InstanceTintInput>();
  const color = new THREE.Color();
  for (const [team, hex] of Object.entries(doc.colors)) {
    const index = Number(team);
    if (!Number.isFinite(index)) continue;
    color.set(hex);
    palette.set(index, { r: color.r, g: color.g, b: color.b, strength: doc.strength });
  }
  return palette;
}

export function createTeamTint(options: TeamTintOptions): TeamTint {
  const palette = teamPalette();
  /** Кому какой номер команды уже подан: повторная подача — не работа кадра. */
  const applied = new Map<EntityId, number>();

  return {
    update(): void {
      const views = options.entities();
      if (views === undefined) {
        applied.clear();
        return;
      }
      for (const entity of [...applied.keys()]) {
        // Сущность ушла из доставки: её инстанс снимет подсистема моделей сама,
        // а помнить за него поданный цвет незачем — вернувшаяся приедет заново.
        if (!views.has(entity)) applied.delete(entity);
      }
      for (const [entity, view] of views) {
        const team = view.stats?.get(STATS.team);
        // Команды у сущности нет (реквизит, снаряд): тинта ей не полагается, а
        // снимать его не с чего — она его и не получала.
        if (team === undefined) continue;
        if (applied.get(entity) === team) continue;
        const tint = palette.get(team) ?? null;
        // Инстанса ещё нет (модель едет, ASSET-4) — подача повторится следующим
        // кадром: запоминается только то, что дошло.
        if (options.setTint(entity, tint)) applied.set(entity, team);
      }
    },
  };
}
