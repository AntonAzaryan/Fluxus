/**
 * Extractor демо — один на обе сборки (SHELL-8): и на одиночную симуляцию
 * (`worker.ts`), и на тонкого клиента матча (`netClient.ts`).
 *
 * Общий он по той же причине, по какой общий конфиг матча: presentation-состояние
 * обязано выглядеть одинаково независимо от того, кто произвёл тик, — иначе
 * подсистема рендера различала бы режимы, чего REND-8 не допускает.
 */
import { ABILITY_STEPS, type TerrainGrid } from '@fluxus/core';
import { Extractor, kindByTags, type StatSource } from '@fluxus/render';
import {
  ABILITY_SLOTS,
  COOLDOWN_SOURCES,
  FIREBALL_LIFETIME_TICKS,
  PREVIEW_SLOTS,
  STATE_COMPONENTS,
  STATS,
} from './sim.js';

/**
 * Конфигурация доставляемых статов демо (HUD-8): «имя доставки → компонент и
 * поле мира». Это ДАННЫЕ сборки, а не код кодека: новый стат — запись в этом
 * списке плюс биндинг в композиции HUD, и ни экстрактор, ни кодек, ни виджет
 * при этом не правятся.
 *
 * Компонента счёта сцена демо пока не содержит. Запись без компонента-источника
 * молча не едет (`hasComponent` мира отвечает «нет»), и виджет показывает
 * пустое состояние — ровно тот сценарий, который HUD-8 и описывает.
 */
export const DEMO_STATS: readonly StatSource[] = Object.freeze([
  { name: STATS.slot, component: 'Player', field: 'slot' },
  { name: STATS.hp, component: 'Health', field: 'hp' },
  { name: STATS.hpMax, component: 'Health', field: 'hpMax' },
  { name: STATS.deaths, component: 'Score', field: 'deaths' },
  // Входы маски тумана войны (FOW-7, design D4): команда наблюдателя и радиус
  // обзора. `Vision.radius` — fixed, на границе он уедет float'ом мировых
  // единиц (REND-1, `statSources.ts`); свёртка `VisionModifier` здесь не
  // повторяется — консервативный коэффициент визуала покрывает дрейф (FOW-9).
  { name: STATS.team, component: 'Team', field: 'id' },
  { name: STATS.visionRadius, component: 'Vision', field: 'radius' },
  // Радиус коллайдера — вход отладочного источника кругов коллизий
  // (`render-debug` RDBG-6): величина сущности едет к отладке ТОЛЬКО объявленным
  // статом, как радиус обзора едет к туману. Убрать эту строку — и источник
  // скажет «нет данных», а не нарисует выдуманный радиус.
  { name: STATS.colliderRadius, component: 'Collider', field: 'radius' },
  // Входы шара заряда главного потока (`chargeBalls.ts`): величина заряда и
  // направление прицела ЗАРЯЖАЮЩЕГО. Оба читаются с самого героя, а не с его
  // сущности-слота: слот виден только своей стороне (NET-12), а шар заряда
  // противника обязан быть виден (HUD-1). `Charging` есть только у того, кто
  // заряжает, — у остальных записи молча нет, и это ровно тот сценарий, который
  // описывает HUD-8.
  { name: STATS.charge, component: 'Charging', field: 'ticks' },
  { name: STATS.aim, component: 'Input', field: 'aimDir' },
  // Кулдаун лежит на сущности-слоте владельца (ABIL-1, ABIL-7), а едет на нём
  // самом: слот `Position` не несёт и в поток тиков не попадает (NET-12).
  // Слотовая форма источника — `slotIndex` записи (`statSources.ts`).
  ...Object.entries(COOLDOWN_SOURCES).flatMap(([ability, slotIndex]) => [
    { name: STATS.cooldown(ability), component: 'AbilityCooldown', field: 'remaining', slotIndex },
    { name: STATS.cooldownMax(ability), component: 'AbilityCooldown', field: 'total', slotIndex },
  ]),
  // Состояние слотов с цепочкой прицеливания — вход превью каста (REND-28).
  ...PREVIEW_SLOTS.flatMap((ability) => {
    const slotIndex = ABILITY_SLOTS[ability as keyof typeof ABILITY_SLOTS];
    const steps = Array.from({ length: ABILITY_STEPS }, (_unused, step) => [
      { name: STATS.slotStepX(ability, step), component: 'AbilitySlot', field: `step${step}x`, slotIndex },
      { name: STATS.slotStepY(ability, step), component: 'AbilitySlot', field: `step${step}y`, slotIndex },
      { name: STATS.slotStepEntity(ability, step), component: 'AbilitySlot', field: `step${step}e`, slotIndex },
    ]).flat();
    return [
      { name: STATS.slotAbility(ability), component: 'AbilitySlot', field: 'abilityId', slotIndex },
      { name: STATS.slotPhase(ability), component: 'AbilitySlot', field: 'phase', slotIndex },
      { name: STATS.slotStaged(ability), component: 'AbilitySlot', field: 'staged', slotIndex },
      ...steps,
    ];
  }),
]);

/**
 * События, по которым доворачивается торс (REND-5). Список ДАННЫЕ сборки, а не
 * константа кодека: новый доворот — строка здесь, и ни экстрактор, ни рендер
 * при этом не правятся.
 *
 * Условие у записи одно и жёсткое: событие обязано нести направление
 * (`dirX`/`dirY`) — иначе доворачивать не на что, и запись молча не работала бы.
 * Держит это условие тест сцены (`demoBoss.test.ts`), а не комментарий.
 */
export const DEMO_AIM_EVENTS: readonly string[] = Object.freeze([
  'CastFireball',
  'BossStrikeWindup',
  'BossStrikeLanded',
  'BossChargeAim',
  'BossChargeStarted',
  'BossRepelLanded',
  'BossFacing',
]);

export function createDemoExtractor(grid: TerrainGrid | undefined): Extractor {
  return new Extractor({
    // Ключи манифеста визуалов = теги prefab'ов сцены (ASSET-6). Снаряд и купол
    // замедления рисуются записью эффекта, а не моделью, — ключ им нужен тот же.
    // `HeavyFireball` — ПЕРЕД `Fireball`: заряженный снаряд несёт оба тега
    // (системы сцены ищут его по `Fireball`), а тип берётся первым совпавшим —
    // так у него своя, более крупная запись эффекта.
    // `BossWave` и `BossFire` — спутники способностей босса: волна удара и
    // полоса огня от разгона. Модели у них нет, как у купола, — их рисует
    // запись `effects.byKind` манифеста, и ключ ей нужен тот же (ASSET-6).
    kindOf: kindByTags([
      'Hero',
      'Boss',
      'BossWave',
      'BossFire',
      'HeavyFireball',
      'Fireball',
      'SlowDome',
    ]),
    ...(grid !== undefined ? { terrainGrid: grid } : {}),
    // Доворот торса (REND-5) — по направлению каста: одно каноническое событие
    // сцены несёт и факт каста, и `dirX`/`dirY`. Событие заряда рядом с ним
    // больше не нужно: направление выстрела до подтверждения шага не решено
    // вовсе (ABIL-5), и доворачивать торс на непринятое решение значило бы
    // показывать противнику то, чего кастер ещё не выбрал.
    // Босс — второй адрес доворота, и адрес несущий: курс инстанса производен
    // от скорости (REND-13), а босс на замахе, рёве и прицеливании СТОИТ
    // (система `BossCastHold` сцены гасит ему скорость), и доворот корпуса с
    // головой (REND-5) — единственный способ показать, на кого он смотрит, не
    // двигая сущность. Каждое из перечисленных событий несёт `dirX`/`dirY`:
    // замах и приземление удара, прицеливание и старт разгона, отталкивание в
    // упор и периодическое удержание прицела (`BossFacing`, раз в 16 тиков
    // каста) — им босс и «удерживает поворот в сторону цели», пока копит разгон.
    aimEvents: DEMO_AIM_EVENTS,
    // Компоненты-состояния, зеркалируемые в `EntityView.states` (CAM-6): список
    // общий с главным потоком (`sim.ts`) — порядок задаёт биты.
    stateComponents: STATE_COMPONENTS,
    // Фаза полёта снаряда (REND-12): `AbilityProjectile.ticksLeft` доставки
    // считает оставшиеся тики вниз (ABIL-9), полное число — константа сборки.
    // Рендер фазу не вычисляет — он получает её плоской формой и по ней рисует
    // низкую дугу (SHELL-2).
    flight: { component: 'AbilityProjectile', field: 'ticksLeft', total: FIREBALL_LIFETIME_TICKS },
    // Геймплейные статы доставки (HUD-8): имена уезжают один раз в handshake,
    // значения — разреженными парами в кадре.
    stats: DEMO_STATS,
  });
}
