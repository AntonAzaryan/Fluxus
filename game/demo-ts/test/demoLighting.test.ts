/**
 * Свет демо-арены: секция `lighting` её парного документа (`rendering` REND-29)
 * и круг суток поверх неё (REND-32).
 *
 * Механизм проверен в `render-ts` — разрешение фаз, кроссфейд, кэш теней; здесь
 * проверяется ПОЛИТИКА игры, которой у движка нет и быть не может: что документ
 * демо действительно несёт цикл, что подсистема проходит его круг за заявленные
 * сценарием восемь минут и возвращается к первой фазе, и что кода демо в этом
 * нет вовсе — ни драйвера цикла, ни чисел света, ни переключателя.
 *
 * Документ читается прямо из дерева контента: демо — игра, и `content/` ему
 * принадлежит (CONT-4).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { AssetService, PresentationLighting } from '@game-mvp/assets';
import {
  LightingSubsystem,
  resolveLightingCycle,
  type DebugFrameState,
  type DebugLightingProbe,
  type RenderContext,
} from '@game-mvp/render';
import presentationJson from '../../../content/scenes/duel.presentation.json';

const LIGHTING = (presentationJson as { lighting: PresentationLighting }).lighting;

/** Кадр без доставки: цикл читает только кадровые часы (PRES-4). */
const IDLE_FRAME: DebugFrameState = { view: null, alpha: 0, dtSeconds: 0, realDtSeconds: 0 };

function standaloneLighting(): LightingSubsystem {
  const lighting = new LightingSubsystem({ config: LIGHTING });
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: {} as unknown as AssetService,
    config: { heightStep: 0.6 },
  };
  lighting.init(ctx);
  return lighting;
}

/** Имя текущей фазы — глазами отладочного источника подсистемы (RDBG-2). */
function phaseName(lighting: LightingSubsystem): string {
  const source = lighting.debugSources()[0]!;
  return (source.probe(IDLE_FRAME) as DebugLightingProbe).cyclePhaseName;
}

describe('REND-32: демо-арена живёт по кругу суток', () => {
  it('парный документ несёт цикл из четырёх названных фаз, круг — восемь минут', () => {
    const cycle = resolveLightingCycle(LIGHTING);
    expect(cycle).toBeDefined();
    if (cycle === undefined) return;
    expect(cycle.phases.map((phase) => phase.name)).toEqual(['утро', 'день', 'закат', 'ночь']);
    // Круг — сумма длительностей фаз: переход живёт в хвосте слота фазы, а не
    // сверх него (REND-32, сценарий «четыре фазы за восемь минут»).
    const circle = cycle.phases.reduce((sum, phase) => sum + phase.seconds, 0);
    expect(circle).toBe(8 * 60);
    expect(cycle.transitionSeconds).toBe(15);
  });

  it('подсистема проходит круг по кадровым часам и возвращается к утру', () => {
    const lighting = standaloneLighting();
    const { ambient, sun } = lighting.lights;
    const morning = [ambient.color.getHexString(), ambient.intensity, sun.intensity] as const;
    expect(phaseName(lighting)).toBe('утро');

    // Восемь минут presentation-времени по полсекунды на кадр: фазы проходят в
    // авторском порядке, и каждая успевает побыть установившейся.
    const seen: string[] = [];
    for (let frame = 0; frame < 8 * 60 * 2; frame++) {
      lighting.updateFrame(1 / 60, 0, 0.5);
      const name = phaseName(lighting);
      if (seen[seen.length - 1] !== name) seen.push(name);
    }
    expect(seen).toEqual(['утро', 'день', 'закат', 'ночь', 'утро']);
    // Возврат к первой фазе — без скачка: значения ровно те же, что в начале.
    expect([ambient.color.getHexString(), ambient.intensity, sun.intensity]).toEqual([...morning]);
  });

  it('свет по кругу действительно меняется — и тоном, и стороной света', () => {
    const lighting = standaloneLighting();
    const { ambient, sun } = lighting.lights;
    const tones = new Set<string>();
    const sides = new Set<string>();
    for (let frame = 0; frame < 8 * 60; frame++) {
      lighting.updateFrame(1 / 60, 0, 1);
      tones.add(`${ambient.color.getHexString()}:${sun.color.getHexString()}`);
      sides.add(sun.position.toArray().map((v) => v.toFixed(2)).join(','));
    }
    // Четыре стабильных облика плюс кадры кроссфейдов между ними.
    expect(tones.size).toBeGreaterThan(4);
    expect(sides.size).toBeGreaterThan(4);
  });

  it('кода цикла в демо нет: свет приходит документом, переключателя нет', () => {
    const main = readFileSync(new URL('../app/main.ts', import.meta.url), 'utf8');
    // Сборка отдаёт подсистеме секцию документа целиком и о фазах не знает
    // ничего: ни имён, ни длительностей, ни собственного драйвера круга.
    expect(main).toContain('presentation?.lighting');
    expect(main).not.toContain('cycle');
    expect(main).not.toContain('утро');
  });
});
