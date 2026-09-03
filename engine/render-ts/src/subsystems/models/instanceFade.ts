/**
 * Угасание и проявление инстанса (`fog-of-war` FOW-8, design D7): доля
 * проявленности по кадрам и пул прозрачных копий материалов, которыми
 * детальный ярус её рисует.
 *
 * Модуль самодостаточен: он не знает ни о ярусах, ни о манифесте — только о
 * доле `fade` записи и о мешах её держателя. Батчевый ярус эту же долю несёт
 * пер-инстансным атрибутом альфы и копий не требует вовсе (REND-20).
 */
import * as THREE from 'three';
import { own } from '../../footprint.js';
import type { FadeTarget, InstanceRecord } from './instanceRecord.js';

/**
 * Fade-in — доля длительности fade-out (FOW-8, design D7): появление «короткое»
 * по спеке, и отдельного поля конфигурации под него не заводится — половина
 * той же длительности, которой сущность угасает.
 */
const FADE_IN_RATIO = 0.5;

/**
 * Ход доли проявления/угасания записи по кадрам, как снижение при провале
 * (FOW-8, design D7): угасание — полной длительностью конфига, проявление —
 * короткое (`FADE_IN_RATIO`). Модуль часов: направление задаёт состояние, а не
 * знак хода мира — на обратном ходе угасание не «проявляет» обратно. Decoration
 * не угасает никогда (REND-18) — его доля единица.
 */
export function advanceFade(record: InstanceRecord, settle: number, fadeSeconds: number): void {
  if (fadeSeconds <= 0 || record.decoration) {
    record.fade = 1;
    return;
  }
  if (record.fadingOut) {
    record.fade = Math.max(0, record.fade - settle / fadeSeconds);
    return;
  }
  if (record.fade < 1) {
    record.fade = Math.min(1, record.fade + settle / (fadeSeconds * FADE_IN_RATIO));
  }
}

/**
 * Ход растворения трупа (`rendering` REND-4): задержка после фиксации смерти,
 * затем спад целостности до нуля. Модуль часов — по тем же основаниям, что у
 * угасания: направления у растворения нет, и обратный ход мира не собирает труп
 * обратно (собирает его снятая фиксация смерти, а не знак `dt`).
 *
 * Записи без блока `dissolve` (ASSET-6) канал не касается вовсе: целостность у
 * неё единица всегда, и труп лежит, пока его не снимет сцена, — прежнее
 * поведение.
 */
export function advanceDissolve(record: InstanceRecord, settle: number): void {
  if (record.dissolveDuration <= 0 || !record.deathLock) {
    // Сущность не мертва (либо перестала быть): труп собирается обратно
    // МГНОВЕННО, а не обратным ходом растворения — возрождение это возвращение
    // в бой, а не перемотка похорон.
    record.dissolve = 1;
    record.dissolveHeld = record.dissolveDelay;
    return;
  }
  if (record.dissolveHeld > 0) {
    record.dissolveHeld = Math.max(0, record.dissolveHeld - settle);
    return;
  }
  record.dissolve = Math.max(0, record.dissolve - settle / record.dissolveDuration);
}

/**
 * Доля, которой инстанс НАРИСОВАН в этом кадре: проявленность обзора (FOW-8) и
 * целостность трупа (REND-4) — независимые каналы одной прозрачности, и оба
 * действуют разом. Произведение, а не минимум: труп, растворившийся наполовину
 * и одновременно ушедший в туман наполовину, обязан быть бледнее каждого из них
 * по отдельности.
 *
 * Один ответ на оба яруса (REND-20): держатель детального яруса красит этой
 * долей свои fade-копии, батч везёт её пер-инстансным атрибутом альфы.
 */
export function drawnFade(record: InstanceRecord): number {
  return record.fade * record.dissolve;
}

/** Материалы меша списком — у three они бывают и одиночными, и массивом. */
function materialsOf(material: THREE.Material | THREE.Material[]): readonly THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

/**
 * Материал со слотами карт — теми, что `applySkin` заполняет (`assignTexture`) и
 * что входят в ключ программы three занятостью (`mapUv` и соседи). Базовый
 * `Material` их не объявляет: они принадлежат подтипам, а fade-копия работает с
 * любым материалом меша.
 */
type MappedMaterial = THREE.Material & {
  map?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
  emissiveMap?: THREE.Texture | null;
};

/** Альфа кадра на fade-копии: доля проявленности от базовой непрозрачности (FOW-8). */
function applyFadeOpacity(clone: THREE.Material, fade: number): void {
  clone.opacity = (clone.userData.fadeBaseOpacity as number) * fade;
}

/**
 * Пулы fade-копий по исходному материалу (FOW-8) — по одному на подсистему:
 * копии переживают эпизод угасания и выдаются следующему, потому что у
 * прозрачной копии ДРУГАЯ программа шейдера, и пересборка копии означала бы
 * компиляцию прямо в кадре открытия обзора.
 */
export class FadeClonePool {
/**
 * Пулы fade-копий по ИСХОДНОМУ материалу (FOW-8). Копия отличается от
 * оригинала одним полем — `transparent`, — но в three r0.185 это бит 17 ключа
 * программы (`opaque` = `!transparent && NormalBlending && !alphaToCoverage`,
 * `WebGLPrograms.getProgramCacheKeyBooleans`): у копии ДРУГАЯ программа, и
 * первый её draw компилирует и линкует шейдер прямо в кадре — десятки
 * миллисекунд на материал. Освобождать копию по концу эпизода значило бы
 * ронять `usedTimes` её программы до нуля, а с ним и саму программу
 * (`releaseProgram`), и платить компиляцию на КАЖДОМ открытии обзора; поэтому
 * копии не освобождаются, а возвращаются в пул своего оригинала и выдаются
 * следующему эпизоду.
 *
 * Пул — свободный список, а не одна копия на материал: угасают одновременно
 * несколько инстансов, а `opacity` — свойство материала, и одна копия на всех
 * означала бы, что доля одного видна на другом. Копия выдаётся на меш-слот и
 * возвращается концом его эпизода; длина списка ограничена числом
 * одновременно угасающих, а число ключей — материалами контента плюс своими
 * материалами живых инстансов (REND-6).
 *
 * Копия живёт ровно столько, сколько её оригинал (`disposeFadeClones`):
 * пережить его она не вправе — ключа, по которому её нашли бы снова, больше
 * нет, и она осталась бы висеть со своей программой навсегда.
 */
  private readonly clones = new Map<THREE.Material, THREE.Material[]>();

  /**
   * Fade держателя (FOW-8) — прозрачностью: материалы мешей разделяются с
   * ассетом (REND-3) и copy-on-write скинов (REND-6), поэтому на время fade
   * инстанс получает СВОИ копии с `transparent`, а по концу возвращает
   * разделяемые. Копии берутся из пула своего оригинала (`fadeClones`) и туда
   * же уходят: программа шейдера у прозрачной копии ДРУГАЯ, и пересоздавать
   * копию на каждый эпизод значит компилировать шейдер прямо в кадре открытия
   * обзора — тот самый всплеск, ради которого заведён и прогрев (`prewarm`).
   */
  applyToHolder(record: InstanceRecord): void {
    const fade = drawnFade(record);
    if (fade >= 1) {
      this.clear(record);
      return;
    }
    const holder = record.holder;
    if (holder === null) return;
    record.fadedTargets ??= this.lend(holder);
    for (const target of record.fadedTargets) {
      // Проход БЕЗ аллокации (REND-26): `materialsOf` заводил бы здесь массив
      // на каждый меш и каждый кадр угасания.
      const material = target.mesh.material;
      if (Array.isArray(material)) {
        for (const clone of material) applyFadeOpacity(clone, fade);
      } else {
        applyFadeOpacity(material, fade);
      }
    }
  }

  /**
   * Подменяет материалы мешей поддерева fade-копиями из пулов их оригиналов и
   * отдаёт записи для возврата (FOW-8).
   */
  private lend(root: THREE.Object3D): FadeTarget[] {
    const targets: FadeTarget[] = [];
    root.traverse((node) => {
      // Узкий типизированный проход: `instanceof THREE.Mesh` дал бы Mesh<any>.
      const mesh = node as Partial<THREE.Mesh> & THREE.Object3D;
      if (mesh.isMesh !== true || mesh.material === undefined) return;
      const original = mesh.material;
      mesh.material = Array.isArray(original)
        ? original.map((material) => this.borrow(material))
        : this.borrow(original);
      targets.push({ mesh: mesh as FadeTarget['mesh'], original });
    });
    return targets;
  }

  /**
   * Прозрачная копия оригинала — из его пула либо новая (FOW-8).
   *
   * Копия из пула — снимок оригинала на момент ПРОШЛОЙ выдачи, а оригинал
   * меняется и после неё: текстуры слотов приезжают асинхронно (ASSET-4), и
   * `ensureBaseSkin`/`applyInstanceSkin` пишут карты в него задним числом — как
   * и смена скина (REND-6). Поэтому при каждой выдаче копия пересобирается по
   * оригиналу ЦЕЛИКОМ: иначе первая же копия, взятая в окне загрузки, рисовала
   * бы модель без текстуры до конца сессии, и рисовала бы её своей программой —
   * занятость слота карты входит в ключ (`mapUv`), и прогрев такой не грел.
   */
  private borrow(original: THREE.Material): THREE.Material {
    const pooled = this.clones.get(original)?.pop();
    if (pooled === undefined) {
      // Копия живёт в пуле подсистемы и отдаётся её сносом (`disposeFadeClones`),
      // поэтому она такой же учтённый ресурс, как созданный через `new` (PERF-8).
      const fresh = own('material', 'models', original.clone());
      fresh.transparent = true;
      // База берётся у ОРИГИНАЛА на каждой выдаче: копия живёт дольше эпизода,
      // и запомни она свою же (уже умноженную) непрозрачность — следующий
      // эпизод угасал бы от угасшего.
      fresh.userData.fadeBaseOpacity = original.opacity;
      return fresh;
    }
    const maps = pooled as MappedMaterial;
    const wasMap = maps.map ?? null;
    const wasNormal = maps.normalMap ?? null;
    const wasEmissive = maps.emissiveMap ?? null;
    pooled.copy(original);
    pooled.transparent = true;
    // `Material.copy` переносит и `userData` оригинала, поэтому база ставится
    // ПОСЛЕ него, а не до.
    pooled.userData.fadeBaseOpacity = original.opacity;
    // Пересборка материала объявляется three, только если карты действительно
    // сменились: на обычном пути (оригинал с прошлой выдачи не менялся) версия
    // не растёт, и копия рисуется прогретой программой без пере-поиска.
    if ((maps.map ?? null) !== wasMap
      || (maps.normalMap ?? null) !== wasNormal
      || (maps.emissiveMap ?? null) !== wasEmissive) {
      pooled.needsUpdate = true;
    }
    return pooled;
  }

  /**
   * Конец эпизода угасания: разделяемые материалы — обратно мешам, fade-копии —
   * в пулы своих оригиналов (FOW-8). Копии не освобождаются: они и есть кэш
   * скомпилированных программ, ради которого пулы заведены.
   */
  clear(record: InstanceRecord): void {
    const targets = record.fadedTargets;
    if (targets === null) return;
    record.fadedTargets = null;
    this.giveBack(targets);
  }

  /** Возврат отложенных материалов мешам, а выданных копий — в пулы (FOW-8). */
  private giveBack(targets: readonly FadeTarget[]): void {
    for (const target of targets) {
      const originals = materialsOf(target.original);
      const clones = materialsOf(target.mesh.material);
      target.mesh.material = target.original;
      for (let i = 0; i < clones.length; i++) {
        const original = originals[i];
        const clone = clones[i];
        if (original === undefined || clone === undefined) continue;
        const pool = this.clones.get(original);
        if (pool === undefined) this.clones.set(original, [clone]);
        else pool.push(clone);
      }
    }
  }

  /**
   * Освобождает fade-копии перечисленных оригиналов (FOW-8, REND-31): копия
   * живёт ровно столько, сколько её оригинал — материалы ассета отдаются
   * `releaseShared`, свои материалы инстанса (REND-6) — вместе с инстансом.
   */
  disposeClonesOf(originals: Iterable<THREE.Material>): void {
    for (const original of originals) {
      const pool = this.clones.get(original);
      if (pool === undefined) continue;
      for (const clone of pool) clone.dispose();
      this.clones.delete(original);
    }
  }

  /**
   * Снос подсистемы (REND-31): копии, чей ОРИГИНАЛ подсистеме не принадлежит
   * (материал заглушки — процессный синглтон), освобождением ассета не
   * закрываются, а держать ими программу дальше сноса нельзя.
   */
  dispose(): void {
    for (const pool of this.clones.values()) {
      for (const clone of pool) clone.dispose();
    }
    this.clones.clear();
  }
}
