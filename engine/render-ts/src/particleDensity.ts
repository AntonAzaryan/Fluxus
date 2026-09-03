/**
 * Плотность частиц (`render-quality` QUAL-1, REND-24) — множитель эмиссии
 * поверх документа эффекта, вынесенный из пула экземпляров отдельно: «что такое
 * экземпляр и кто им владеет» и «насколько густо он эмитит» — разные вопросы,
 * и второй целиком принадлежит пресету качества.
 *
 * Ручка правит ЧИСЛО живых частиц, но не состав кадра: гуще или реже — вопрос
 * картинки, а не того, что в кадре есть (QUAL-2). Поэтому у ручки положительный
 * минимум: эмиттер — изображение сущности (REND-37), и нулевая эмиссия отняла бы
 * у игрока информацию.
 */
import type { FunctionJSON, GeneratorMemory, FunctionValueGenerator, ValueGenerator } from 'three.quarks';
import type { EffectInstance, EmissionGenerator } from './particleEffects.js';

/**
 * Плотность частиц экземпляра (`render-quality` QUAL-1, REND-24): множитель
 * поверх ДОКУМЕНТНОЙ эмиссии — и потоковой, и единовременных выбросов. Единица
 * возвращает документные генераторы теми же объектами: пресет «баланс» стоит
 * ровно столько же, сколько его отсутствие.
 *
 * Правится ЭКЗЕМПЛЯР, документ не трогается: он разделяется всеми экземплярами
 * эффекта (design D6), и множитель, записанный в него, копился бы на каждом
 * взятии из пула. Информации у игрока множитель не отнимает (QUAL-2): гуще или
 * реже — вопрос картинки, а не того, что в кадре есть.
 */
export function setInstanceDensity(instance: EffectInstance, density: number): void {
  for (const entry of instance.systems) {
    entry.system.emissionOverTime = scaleEmission(entry.emission, density);
    const bursts = entry.system.emissionBursts;
    for (let i = 0; i < bursts.length; i++) {
      const source = entry.bursts[i];
      const burst = bursts[i];
      if (source === undefined || burst === undefined) continue;
      burst.count = scaleEmission(source, density);
    }
  }
}

/** Генератор документа под множителем; множитель 1 — он сам, без обёртки. */
function scaleEmission(source: EmissionGenerator, density: number): EmissionGenerator {
  if (density === 1) return source;
  return source.type === 'function'
    ? new ScaledFunction(source, density)
    : new ScaledValue(source, density);
}

/** Множитель поверх постоянного генератора документа (`type: 'value'`). */
class ScaledValue implements ValueGenerator {
  readonly type = 'value';
  private readonly source: ValueGenerator;
  private readonly factor: number;

  constructor(source: ValueGenerator, factor: number) {
    this.source = source;
    this.factor = factor;
  }

  startGen(memory: GeneratorMemory): void {
    this.source.startGen(memory);
  }

  genValue(memory: GeneratorMemory): number {
    return this.source.genValue(memory) * this.factor;
  }

  /** Сериализуется ДОКУМЕНТНОЕ значение: множитель — настройка, а не данные эффекта. */
  toJSON(): FunctionJSON {
    return this.source.toJSON();
  }

  clone(): ValueGenerator {
    return new ScaledValue(this.source.clone(), this.factor);
  }
}

/** То же для генератора, зависящего от фазы жизни системы (`type: 'function'`). */
class ScaledFunction implements FunctionValueGenerator {
  readonly type = 'function';
  private readonly source: FunctionValueGenerator;
  private readonly factor: number;

  constructor(source: FunctionValueGenerator, factor: number) {
    this.source = source;
    this.factor = factor;
  }

  startGen(memory: GeneratorMemory): void {
    this.source.startGen(memory);
  }

  genValue(memory: GeneratorMemory, t: number): number {
    return this.source.genValue(memory, t) * this.factor;
  }

  toJSON(): FunctionJSON {
    return this.source.toJSON();
  }

  clone(): FunctionValueGenerator {
    return new ScaledFunction(this.source.clone(), this.factor);
  }
}

