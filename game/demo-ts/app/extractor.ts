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
  // обзора. Радиус берётся из ОПУБЛИКОВАННОГО состояния `VisionState` (FOW-3),
  // а не из авторского `Vision.radius`: эффективный радиус — произведение на
  // свёртку `VisionModifier`, и считает его симуляция. Повторить свёртку здесь
  // значило бы завести второе определение (FOW-5), а разойдясь с ней вниз —
  // светить маской ШИРЕ круга симуляции, что FOW-9 запрещает прямо
  // (консервативный коэффициент визуала запас на приближение растра, а не на
  // неверную величину). Поле `fixed`, на границе уедет float'ом мировых единиц
  // (REND-1, `statSources.ts`).
  { name: STATS.team, component: 'Team', field: 'id' },
  { name: STATS.visionRadius, component: 'VisionState', field: 'radius' },
  // Радиус коллайдера — вход отладочного источника кругов коллизий
  // (`render-debug` RDBG-6): величина сущности едет к отладке ТОЛЬКО объявленным
  // статом, как радиус обзора едет к туману. Убрать эту строку — и источник
  // скажет «нет данных», а не нарисует выдуманный радиус.
  { name: STATS.colliderRadius, component: 'Collider', field: 'radius' },
  // Держимая точка пути агента (NPC-6) — вход отладочного источника нитей пути
  // (RDBG-6): та же дорога, что у радиуса коллайдера. Записи молча нет у
  // сущности без `NpcAgent` (герои, снаряды), и источник считает её «без пути».
  { name: STATS.navPathX, component: 'NpcAgent', field: 'pathX' },
  { name: STATS.navPathY, component: 'NpcAgent', field: 'pathY' },
  { name: STATS.navPathValid, component: 'NpcAgent', field: 'pathValid' },
  { name: STATS.navTarget, component: 'NpcAgent', field: 'target' },
  // Входы шара заряда — записи `effects.byState.Charging` манифеста (REND-23):
  // величина заряда и направление прицела ЗАРЯЖАЮЩЕГО. Оба читаются с самого
  // героя, а не с его сущности-слота: слот виден только своей стороне
  // (NET-12), а шар заряда противника обязан быть виден (HUD-1).
  // `Charging` есть только у того, кто заряжает, — у остальных записи молча
  // нет, и это ровно тот сценарий, который описывает HUD-8.
  { name: STATS.charge, component: 'Charging', field: 'ticks' },
  { name: STATS.aim, component: 'Input', field: 'aimDir' },
  // Свёртки стелса и детекции (FOW-3) — входы подачи стелса (`stealthTint.ts`,
  // FOW-13). Производные компоненты пишет пересчёт видимости; у сущности без
  // них записи молча нет — ровно сценарий HUD-8.
  { name: STATS.stealthMask, component: 'StealthState', field: 'mask' },
  { name: STATS.detectionMask, component: 'DetectionState', field: 'mask' },
  // Затухание невидимости (FOW-13): тик начала и длительность фазы едут
  // статами, а долю перехода клиент считает от доставленного тика. Компонент
  // `Cloaking` вешает определение `cloak`/`bossCloak` сцены и снимает бафф
  // затухания; у остальных записи молча нет — ровно сценарий HUD-8.
  { name: STATS.cloakStart, component: 'Cloaking', field: 'startTick' },
  { name: STATS.cloakTicks, component: 'Cloaking', field: 'ticks' },
  // Жертва жгута вытягивания — второй конец луча (REND-23): запись
  // `effects.byKind.Boss` манифеста называет этот стат полем `targetFromStat`.
  // Компонент есть только у кастующего босса, у остальных записи молча нет —
  // ровно сценарий HUD-8.
  { name: STATS.tetherTarget, component: 'Tether', field: 'target' },
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
    // `BossWave`, `BossFire` и `BossField` — спутники способностей босса: волна
    // удара, полоса огня от разгона и поле замедления. Модели у них нет, как у
    // купола: всех троих рисует запись `effects.byKind` манифеста, а пятну огня
    // сверх неё положен эмиттер `particles.byKind` — само пламя (ASSET-6,
    // ASSET-14). Обе записи у пятна обязательны, и оболочка не украшение:
    // секцию `particles` подсистема моделей не читает вовсе, и вид без оболочки
    // достался бы ЗАГЛУШКЕ (ASSET-4). `BossMinion`, наоборот, вид С МОДЕЛЬЮ
    // (`entities` манифеста): без ключа скелет босса приехал бы в кадр
    // безымянным и не нарисовался бы вовсе.
    kindOf: kindByTags([
      'Hero',
      'Boss',
      'BossMinion',
      'BossWave',
      'BossFire',
      'BossField',
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
