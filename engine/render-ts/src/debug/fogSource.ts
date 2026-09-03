/**
 * Отладочный источник маски видимости (`fog.mask`, `render-debug` RDBG-1) —
 * объявляет его подсистема тумана в точке своей регистрации (REND-27).
 *
 * ## Что он показывает
 *
 * Маску в ДЕЙСТВУЮЩЕМ разрешении — то есть с уже применённым потолком пресета
 * (FOW-10, QUAL-1). Отсюда и польза для разбора: видно, что сцена просит 8, а
 * картинка строится по 4, и это пресет, а не потерянное поле документа. Авторское
 * значение и потолок стоят в пробе рядом с действующим.
 *
 * Наложение — растровая плашка НАД ареной (RDBG-3), а не подкраска кадра: так
 * держится «отладка не красит кадр» (RDBG-5), и заодно честнее — видно, КУДА
 * ложится тексель. В дамп растр не едет вовсе (RDBG-7): там разрешение,
 * прямоугольник, число наблюдателей и доля вскрытого — агрегаты, а не десятки
 * тысяч чисел.
 *
 * Тело секции ВОСПРОИЗВОДИМО по доставленному состоянию: доля вскрытого
 * считается по опубликованному целевому растру, а величины, которые ведут
 * КАДРЫ, — счётчик перестроек и признак идущего рассеивания — уезжают в секцию
 * `clock` (RDBG-7). Иначе два дампа одного и того же доставленного состояния
 * различались бы, и дифф разбора превращался бы в шум.
 *
 * Раскрывать невидимое источник не может по построению (RDBG-6): маска строится
 * из наблюдателей ДОСТАВЛЕННОГО состояния, то есть из того, что клиенту уже
 * прислано, и своей логики видимости у источника нет.
 */
import type { VisibilityMask } from '../fog/mask.js';
import {
  type DebugColor,
  type DebugDraw,
  type DebugProbe,
  type DebugRaster,
  type DebugSource,
} from './contract.js';

/** Тон плашки маски: свет виден яркостью текселя, тон — принадлежностью слою. */
const MASK_COLOR: DebugColor = 0xffe0a0;
/** Подъём плашки над самой высокой площадкой арены, мировые единицы. */
const MASK_PLANE_LIFT = 0.5;

export interface DebugFogProbe extends DebugProbe {
  /** Действующее разрешение маски, текселей на мировую единицу (FOW-10). */
  readonly resolutionTexelsPerUnit: number;
  /** Авторское значение секции `fog` документа сцены (PRES-2). */
  readonly authoredResolutionTexelsPerUnit: number;
  /** Потолок пресета качества (QUAL-1); null — потолка нет. */
  readonly ceilingResolutionTexelsPerUnit: number | null;
  readonly widthTexels: number;
  readonly heightTexels: number;
  /** Прямоугольник маски в мировых единицах. */
  readonly worldX: number;
  readonly worldY: number;
  readonly worldWidth: number;
  readonly worldHeight: number;
  /** Наблюдателей своей команды в последней перестройке (FOW-7). */
  readonly observerCount: number;
  /**
   * Доля вскрытых текселей ОПУБЛИКОВАННОГО ЦЕЛЕВОГО растра [0..1] — того, к
   * которому маска сходится, а не того, что сейчас на экране.
   *
   * Целевого потому, что проба обязана быть воспроизводимой (RDBG-7): показанный
   * растр ползёт кадрами рассеивания (FOW-7), и два дампа ОДНОГО доставленного
   * состояния разошлись бы числом, которое ни от доставки, ни от состояния мира
   * не зависит. Показанный растр наблюдаем наложением — он и есть картинка.
   */
  readonly revealedFraction: number;
  /**
   * Часовые величины (RDBG-7): перестроек маски с создания подсистемы
   * (`rebuildCount`) и идёт ли рассеивание (`dissolving`, 1/0). Обе — про КАДРЫ,
   * а не про доставленное состояние: перестройка идёт порциями кадров под
   * бюджетом, рассеивание — тоже. В теле секции они делали бы всякий дифф
   * дампов шумом.
   */
  readonly clock: Readonly<Record<string, number>>;
}

/** Что источнику нужно от подсистемы тумана — и ничего сверх этого. */
export interface FogDebugAccess {
  /** Целевая маска: разрешение, прямоугольник и размеры растра. */
  mask(): VisibilityMask;
  /** ПОКАЗАННАЯ маска — то, что сейчас на экране (FOW-7). */
  shown(): Uint8Array;
  observers(): number;
  authoredResolution(): number;
  ceilingResolution(): number;
  rebuilds(): number;
  dissolving(): boolean;
  /** Уровни клеток арены (TERR-1) — по ним считается высота плашки. */
  levels(): Uint8Array;
  /** Высота одного уровня террейна в мировых единицах (REND-7). */
  heightStep(): number;
  /** Маска построена хотя бы раз; нет — показывать нечего (RDBG-6). */
  built(): boolean;
}

/** Высота плашки: над самой высокой площадкой арены (RDBG-3, REND-7). */
function planeZ(access: FogDebugAccess): number {
  let top = 0;
  for (const level of access.levels()) top = Math.max(top, level);
  return (top + 1) * access.heightStep() + MASK_PLANE_LIFT;
}

export function fogMaskDebugSource(access: FogDebugAccess): DebugSource<DebugFogProbe> {
  // Копия растра, а не ссылка на буфер подсистемы (RDBG-2): буфер
  // перезаписывается доставкой, и удержанная ссылка показала бы кадр, которого
  // не было. Буфер заводится один раз и переживает кадры; пересоздаётся он
  // только вместе со сменой разрешения маски.
  let texels = new Uint8Array(0);
  const raster: {
    raster: true;
    widthTexels: number;
    heightTexels: number;
    worldX: number;
    worldY: number;
    worldWidth: number;
    worldHeight: number;
    worldZ: number;
    texels: Uint8Array;
  } = {
    raster: true,
    widthTexels: 0,
    heightTexels: 0,
    worldX: 0,
    worldY: 0,
    worldWidth: 0,
    worldHeight: 0,
    worldZ: 0,
    texels,
  };
  // Часовая секция — стабильный объект, как и сама проба (RDBG-2): свежий
  // словарь на кадр был бы мусором включённого источника.
  const clock = { rebuildCount: 0, dissolving: 0 };
  const probe = {
    resolutionTexelsPerUnit: 0,
    authoredResolutionTexelsPerUnit: 0,
    ceilingResolutionTexelsPerUnit: null as number | null,
    widthTexels: 0,
    heightTexels: 0,
    worldX: 0,
    worldY: 0,
    worldWidth: 0,
    worldHeight: 0,
    observerCount: 0,
    revealedFraction: 0,
    clock,
    mask: raster,
    noData: undefined as string | undefined,
  };

  return {
    id: 'fog.mask',
    title: 'маска видимости (туман войны)',
    probe(): DebugFogProbe {
      if (!access.built()) {
        probe.noData = 'маска ещё не построена: наблюдателей своей команды в доставке нет (FOW-7)';
        return probe;
      }
      probe.noData = undefined;
      const mask = access.mask();
      const shown = access.shown();
      if (texels.length !== shown.length) {
        texels = new Uint8Array(shown.length);
        raster.texels = texels;
      }
      texels.set(shown);
      // Доля вскрытого считается по ЦЕЛЕВОМУ растру (см. `revealedFraction`);
      // в наложение при этом едет показанный — оно и есть картинка кадра.
      const target = mask.data;
      let lit = 0;
      for (const value of target) {
        if (value > 0) lit += 1;
      }
      probe.resolutionTexelsPerUnit = mask.texelsPerUnit;
      probe.authoredResolutionTexelsPerUnit = access.authoredResolution();
      const ceiling = access.ceilingResolution();
      probe.ceilingResolutionTexelsPerUnit = Number.isFinite(ceiling) ? ceiling : null;
      probe.widthTexels = mask.width;
      probe.heightTexels = mask.height;
      probe.worldX = mask.rect.x;
      probe.worldY = mask.rect.y;
      probe.worldWidth = mask.rect.width;
      probe.worldHeight = mask.rect.height;
      probe.observerCount = access.observers();
      probe.revealedFraction = target.length === 0 ? 0 : lit / target.length;
      clock.rebuildCount = access.rebuilds();
      clock.dissolving = access.dissolving() ? 1 : 0;
      raster.widthTexels = mask.width;
      raster.heightTexels = mask.height;
      raster.worldX = mask.rect.x;
      raster.worldY = mask.rect.y;
      raster.worldWidth = mask.rect.width;
      raster.worldHeight = mask.rect.height;
      raster.worldZ = planeZ(access);
      return probe;
    },
    draw(value: DebugFogProbe, out: DebugDraw): void {
      const mask = value.mask as DebugRaster;
      out.raster(mask, MASK_COLOR);
      // Кромка прямоугольника маски: по ней видно, что плашка накрывает арену
      // целиком, а не съехала на полтекселя.
      const z = mask.worldZ;
      const x0 = value.worldX;
      const y0 = value.worldY;
      const x1 = x0 + value.worldWidth;
      const y1 = y0 + value.worldHeight;
      out.polyline([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z], MASK_COLOR, true);
    },
  };
}
