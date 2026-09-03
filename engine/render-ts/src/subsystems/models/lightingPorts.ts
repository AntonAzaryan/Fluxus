/**
 * Порты подсистемы моделей к подсистеме освещения (REND-8): теневой ярус
 * нарисованного (REND-30, design D3), носитель локального света записи вида
 * (REND-33, ASSET-16) и контактное пятно динамического кастера (REND-30).
 *
 * Почему они здесь, а не в подсистеме освещения: происхождение инстанса
 * (доставка против набора декораций) и запись его вида знает ВЛАДЕЛЕЦ
 * инстансов, а что делать с ярусом, светом и пятном — решает свет. Модуль
 * держит одну ссылку на приёмник и ничего о его внутренностях не знает; сцена
 * без света порта не передаёт вовсе, и ни одна ветка здесь не работает.
 */
import type * as THREE from 'three';
import { resolveVisualLight, type VisualManifest } from '@fluxus/assets';
import type { BlobCaster, BlobCasterPose, LightCarrier, LightCarrierPose, LightingSink } from '../../types.js';
import { boundsOf, casterTierOf, type InstanceRecord } from './instanceRecord.js';

/**
 * Ключ носителя локального света (REND-33, design D3) — тай-брейк отбора
 * активных источников: ключ записи манифеста плюс порядковый номер инстанса в
 * его наборе. Наборы разделены буквой: нумерация у них своя, и одно число
 * значит в них разные инстансы.
 *
 * Что этот ключ обещает, а что нет. Он не зависит ни от кадра, ни от порядка
 * обхода реестра носителей, поэтому повтор ТОГО ЖЕ кадра отбирает те же
 * источники, и перестановка носителей в реестре отбора не двигает. Но
 * «порядковый номер» у двух наборов разного происхождения: у сущности мира это
 * её sim-идентификатор, производный от данных, а у размещения (REND-11,
 * REND-18) — номер, выданный набором инстансов по порядку сведения
 * (`keyedInstanceSet.ts`). Смена вида размещения инстанс ПЕРЕСОЗДАЁТ, то есть
 * за сессию правки номер того же размещения может смениться, и тай-брейк между
 * двумя носителями с в точности равными оценками — перевернуться. Ключа
 * документа у подсистемы для этого нет: сведённый набор приносит ей позы и вид,
 * а не адреса записей (REND-18).
 */
function lightCarrierKey(record: InstanceRecord): string {
  return `${record.kind ?? ''}#${record.decoration ? 'd' : 'e'}${record.entity}`;
}

/**
 * Поза носителя в переиспользуемую запись (REND-33): ТА САМАЯ, которой инстанс
 * нарисован в этом кадре (REND-3), а не второй её расчёт. `false` — позы кадра
 * инстанс ещё не получил: в кадре его нет, и светить неоткуда.
 */
function poseOfCarrier(record: InstanceRecord, out: LightCarrierPose): boolean {
  if (!record.posed) return false;
  out.x = record.pos.x;
  out.y = record.pos.y;
  out.z = record.pos.z;
  out.qx = record.quat.x;
  out.qy = record.quat.y;
  out.qz = record.quat.z;
  out.qw = record.quat.w;
  return true;
}

/**
 * Позиция контактного пятна инстанса (REND-30): ТА САМАЯ поза, которой инстанс
 * нарисован в этом кадре (REND-3), а не второй её расчёт. `false` — пятна в
 * кадре нет, и оснований для этого три:
 *
 * - позы кадра инстанс ещё не получил;
 * - он отсечён пирамидой видимости (REND-21) — в кадре его нет вовсе;
 * - он НЕ ПРОЯВЛЕН ПОЛНОСТЬЮ (`fade < 1`, FOW-8). Последнее — не мелочь:
 *   поддерево инстанса растворяется прозрачностью, а пятно непрозрачности не
 *   имеет вовсе и осталось бы чёрным кругом под пустотой. Условие взято долей
 *   проявленности, а не флагом `fadingOut`, потому что дефект СИММЕТРИЧЕН:
 *   угасание «ушла в туман» и проявление вернувшегося из тумана (FOW-8) — одна
 *   и та же рампа, пройденная в разные стороны, и на обеих модели в кадре
 *   почти нет. REND-30 требует, чтобы пятно было ЧАСТЬЮ ПРЕДСТАВЛЕНИЯ инстанса,
 *   а представление на рампе — это доля `fade`.
 *
 * Доля пересчитывается в `poseAll` того же кадра, то есть ДО `blobCastersPosed`
 * (см. `updateFrame`), и вне рампы она равна единице по построению: у декораций
 * и при выключенном fade запись держит 1 всегда, так что ни один другой путь
 * пятна не теряет.
 */
function poseOfBlob(record: InstanceRecord, out: BlobCasterPose): boolean {
  if (!record.posed || !record.visible || record.fade < 1) return false;
  out.x = record.pos.x;
  out.y = record.pos.y;
  out.z = record.pos.z;
  return true;
}

/**
 * Радиус контактного пятна инстанса, мировые единицы (REND-30): половина
 * БОЛЬШЕГО горизонтального габарита нарисованного — габаритов BIND-ПОЗЫ
 * (`boundsOf`), тех же, которыми инстанс виден наружу (REND-3, REND-15).
 *
 * Не консервативные границы отсечения (ASSET-12, REND-21): те — объединение
 * ВСЕХ кадров всех клипов, то есть выпад атаки и распластанная смерть разом, и
 * пятно по ним раздуто всю жизнь юнита, а не в момент выпада. Отсечению
 * консервативность нужна (исчезнуть раньше юнита нельзя), пятну — нет: оно
 * повторяет след стоящего инстанса, и «те же данные, что у отсечения» спутали
 * бы безопасную границу с габаритом.
 *
 * Горизонтального, а не диагонального: пятно лежит на полу и повторяет след
 * инстанса, а высота модели к следу отношения не имеет — иначе башня отбрасывала
 * бы пятно во всю свою высоту. Габаритов ещё нет (модель не загружена, ASSET-4)
 * — радиус нулевой: пятно появится вместе с моделью, а не константой кода.
 */
function blobRadiusOf(record: InstanceRecord): number {
  const bounds = boundsOf(record);
  if (bounds === null) return 0;
  const width = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  return (width / 2) * Math.abs(record.scale);
}

/**
 * Живые порты одной подсистемы моделей. `undefined` вместо приёмника — сцена
 * без света: методы становятся пустыми, а инстансы не получают ни флагов теней,
 * ни источников (REND-8).
 */
export class LightingPorts {
  private readonly sink: LightingSink | undefined;

  constructor(sink: LightingSink | undefined) {
    this.sink = sink;
  }

  /** Корень ушёл из кадра: снятый инстанс, опустевший батч (REND-8). */
  dropCaster(root: THREE.Object3D): void {
    this.sink?.dropCaster(root);
  }

  /** Кэшированная карта статики устарела: переехавшая декорация (REND-8, REND-18). */
  invalidateStatic(): void {
    this.sink?.invalidateStatic();
  }

  /**
   * Пирамида теневой камеры этого кадра (REND-21, REND-30); null — теней нет
   * либо приёмник о них не рассказывает. Спрашивается ОДИН раз на кадр:
   * сведение матриц теневой камеры — не работа на инстанс.
   */
  shadowFrustum(): THREE.Frustum | null {
    return this.sink?.shadowFrustum?.() ?? null;
  }

  /**
   * Позы кадра посчитаны — можно писать контактные пятна (REND-30). Момент
   * принадлежит владельцу инстансов: подсистема освещения зарегистрирована
   * раньше, её кадр идёт первым, и пятна отставали бы от юнитов на кадр.
   */
  blobCastersPosed(): void {
    this.sink?.blobCastersPosed?.();
  }

  markCaster(record: InstanceRecord): void {
    const sink = this.sink;
    if (sink === undefined) return;
    const root = record.batch?.batch.group ?? record.holder;
    if (root !== null) sink.setCaster(root, casterTierOf(record));
  }

  /**
   * Носитель локального света инстанса (REND-33, ASSET-16) — приёмнику света
   * подсистемы освещения. Свет — свойство ЗАПИСИ вида, поэтому носитель
   * заводится по её блоку и снимается вместе с ним: и на создании инстанса, и
   * на переподаче манифеста (REND-17, ED-15).
   *
   * Блок разрешается по КЛЮЧУ ВИДА, а не по `record.visual`: свет несёт и
   * эмиттерная запись (ASSET-14), которую рисует подсистема частиц (REND-24), —
   * факел арены как раз такой, — а `resolveVisual` эмиттерный вид намеренно не
   * отдаёт.
   */
  syncLight(record: InstanceRecord, manifest: VisualManifest): void {
    const sink = this.sink;
    if (sink?.setLightCarrier === undefined) return;
    const kind = record.kind;
    const light = kind === null ? null : resolveVisualLight(manifest, kind);
    if (light === null) {
      this.dropLight(record);
      return;
    }
    const carrier = record.lightCarrier;
    if (carrier !== null) {
      // Правленые числа блока — на ЖИВОМ носителе (REND-17): снятия и повторной
      // регистрации это не требует, и свет виден не позже следующего кадра.
      carrier.light = light;
      return;
    }
    const next: LightCarrier = {
      key: lightCarrierKey(record),
      light,
      pose: (out) => poseOfCarrier(record, out),
    };
    record.lightCarrier = next;
    sink.setLightCarrier(next);
  }

  /** Носитель снят: исчезнувший инстанс либо снятый переподачей блок (REND-33). */
  dropLight(record: InstanceRecord): void {
    const carrier = record.lightCarrier;
    if (carrier === null) return;
    record.lightCarrier = null;
    this.sink?.dropLightCarrier?.(carrier);
  }

  /**
   * Носитель контактного пятна инстанса (REND-30, режим `blob`) — приёмнику
   * подсистемы освещения. Носителями становятся ровно ДИНАМИЧЕСКИЕ кастеры: в
   * `blob` статика теней не отбрасывает, и пятна ей не положены.
   *
   * Заводится он независимо от действующего режима теней: режим — свойство
   * секции, которое автор правит в рантайме (ED-15), и держать реестр по режиму
   * значило бы показывать пятна не раньше, чем пересоздадутся инстансы.
   * Стоимости у реестра нет — по нему ходит только кадр режима `blob`.
   *
   * Радиус — ПРОИЗВОДНАЯ ДАННЫХ (REND-30): горизонтальный габарит записи вида,
   * тот же источник, что у отсечения и LOD, — поэтому он и пересчитывается
   * здесь же, на переподаче манифеста (REND-17).
   */
  syncBlob(record: InstanceRecord): void {
    const sink = this.sink;
    if (sink?.setBlobCaster === undefined) return;
    if (casterTierOf(record) !== 'dynamic') {
      this.dropBlob(record);
      return;
    }
    const existing = record.blobCaster;
    if (existing !== null) {
      existing.radius = blobRadiusOf(record);
      return;
    }
    const next: BlobCaster = {
      radius: blobRadiusOf(record),
      pose: (out) => poseOfBlob(record, out),
    };
    record.blobCaster = next;
    sink.setBlobCaster(next);
  }

  /** Пятно снято: исчезнувший инстанс либо инстанс, ставший статикой (REND-30). */
  dropBlob(record: InstanceRecord): void {
    const caster = record.blobCaster;
    if (caster === null) return;
    record.blobCaster = null;
    this.sink?.dropBlobCaster?.(caster);
  }
}
