/**
 * Модель композиции HUD (HUD-4, design Decision 3): состав HUD — какие
 * виджеты, в каких зонах, с какими параметрами, биндингами и действиями —
 * описывается декларативным JSON-сериализуемым значением, отделённым от кода
 * виджетов. Все ссылки — строки-имена, резолвящиеся из реестров
 * (`registry.ts`): именно это делает будущий переезд на JSON-документ HUD в
 * `content/` тривиальным — документ десериализуется в ту же форму, реестры
 * уже есть. Биндинги-замыкания отклонены design'ом: они несериализуемы и
 * превращают переезд в переделку (нарушение HUD-4).
 */
import type { HudZoneName } from './zones.js';

/**
 * JSON-значение: тип закрывает форму от функций и классов на уровне
 * компилятора — несериализуемый параметр в композицию не попадает.
 */
export type HudJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly HudJsonValue[]
  | { readonly [key: string]: HudJsonValue };

/** Параметры записи композиции, передаваемые фабрике вида виджета как есть. */
export type HudParams = Readonly<Record<string, HudJsonValue>>;

/** Одна запись композиции: виджет такого-то вида в такой-то зоне. */
export interface HudCompositionEntry {
  /** Имя вида виджета в реестре видов. */
  readonly widget: string;
  /** Зона экрана из фиксированного словаря хоста (design Decision 5). */
  readonly zone: HudZoneName;
  readonly params?: HudParams;
  /** Слот данных виджета → имя селектора над доставленным состоянием. */
  readonly bindings?: Readonly<Record<string, string>>;
  /** Слот действия виджета → имя действия в реестре действий (HUD-2). */
  readonly actions?: Readonly<Record<string, string>>;
}

/**
 * Композиция HUD — значение, а не код: сегодня его собирает TS, завтра —
 * JSON-документ в `content/`; виджеты и исполнитель различий не видят (HUD-4).
 */
export interface HudComposition {
  readonly entries: readonly HudCompositionEntry[];
}
