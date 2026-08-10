/**
 * Панель действий героя (задача 5.1): кнопка на каждое семантическое действие
 * из словаря биндингов демо (`bindings.json`, INP-4) — cast, dodge, jump.
 * Нажатие уходит мировым действием обратного канала: слот действия кнопки
 * называется именем способности, и композиция ведёт его к записи реестра
 * `{ target: 'world', action: <то же имя из словаря биндингов> }` — «кнопка
 * неотличима от клавиши» (HUD-2) собирается из данных, а не из логики виджета.
 *
 * Иконки — по asset ID через таблицу «идентификатор → asset ID» из params
 * (HUD-4, `icons.ts`): URL в композиции нет, резолвит их шов `HudIconSource`,
 * который держит фабрика вида — потому вид панели создаётся функцией
 * `abilityBarKind(icons)`, а не константой: шов — инъекция сборки клиента,
 * как камера у фасада действий, и в JSON-значении композиции ему не место.
 */
import type { HudParams } from '../composition.js';
import { el, type HudNode } from '../dom/node.js';
import { interactive } from '../host.js';
import { iconTableFromParams, resolveIcon, type HudIconSource } from '../icons.js';
import type { HudActionsPort, HudUpdate, HudWidget, HudWidgetKind } from '../widget.js';

/** Имя вида в реестре — то, на что ссылается запись композиции. */
export const ABILITY_BAR_WIDGET = 'ability-bar';

/** Параметр params со списком способностей — имена семантических действий (INP-4). */
export const ABILITY_BAR_ABILITIES_PARAM = 'abilities';
/** Параметр params с таблицей иконок «идентификатор → asset ID» (HUD-4). */
export const ABILITY_BAR_ICONS_PARAM = 'icons';

/** Список способностей из params: непустой массив строк, ошибка — с именем параметра. */
function abilitiesFromParams(params: HudParams): readonly string[] {
  const raw = params[ABILITY_BAR_ABILITIES_PARAM];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `параметр "${ABILITY_BAR_ABILITIES_PARAM}": ожидался непустой список имён семантических действий (INP-4)`,
    );
  }
  return raw.map((item, index) => {
    if (typeof item !== 'string' || item === '') {
      throw new Error(
        `параметр "${ABILITY_BAR_ABILITIES_PARAM}", элемент #${String(index)}: имя действия обязано быть непустой строкой`,
      );
    }
    return item;
  });
}

/** Одна кнопка панели: имя способности и уже отрезолвленный URL иконки. */
interface AbilityButton {
  readonly ability: string;
  readonly iconUrl: string;
}

class AbilityBarWidget implements HudWidget {
  private readonly buttons: readonly AbilityButton[];
  private actions: HudActionsPort | null = null;

  /**
   * Иконки резолвятся при создании — до монтирования, как резолв имён
   * композиции (`registry.ts`): дырка в таблице валит `apply` целиком и
   * называет идентификатор, а не молчит до первого показа.
   */
  constructor(params: HudParams, icons: HudIconSource) {
    const table = iconTableFromParams(params, ABILITY_BAR_ICONS_PARAM);
    this.buttons = abilitiesFromParams(params).map((ability) => ({
      ability,
      iconUrl: resolveIcon(table, icons, ability),
    }));
  }

  mount(actions: HudActionsPort): HudNode {
    this.actions = actions;
    return el('div', {
      // Сам контейнер указатель не перехватывает — интерактивны только кнопки (HUD-3).
      classes: ['hud-ability-bar'],
      children: this.buttons.map((button) => this.buttonNode(button)),
    });
  }

  private buttonNode(button: AbilityButton): HudNode {
    return interactive(
      el('button', {
        classes: ['hud-ability-bar__button'],
        attrs: { type: 'button', 'data-ability': button.ability, title: button.ability },
        on: {
          click: () => {
            // Слот действия = имя способности; куда он ведёт — знает композиция (HUD-2).
            this.actions?.trigger(button.ability);
          },
        },
        children: [
          el('img', {
            classes: ['hud-ability-bar__icon'],
            attrs: { src: button.iconUrl, alt: button.ability, draggable: 'false' },
          }),
        ],
      }),
    );
  }

  /**
   * Динамики у панели пока нет: перезарядки и доступность способностей в
   * доставленном подмножестве (`delivery.ts`) не представлены. Когда появятся,
   * их индикаторы обязаны чтить `update.snap` — прыжок к доставленному
   * значению вместо доигрывания анимации через разрыв (HUD-5); сегодня
   * накопленного состояния нет и снапать нечего.
   */
  update(_update: HudUpdate): void {
    // Пусто намеренно — см. комментарий выше.
  }

  dispose(): void {
    this.actions = null;
  }
}

/**
 * Вид панели действий героя. Шов иконок — инъекция сборки клиента (HUD-4,
 * design Decision 7): фабрика замыкает его, композиция остаётся JSON-значением.
 */
export function abilityBarKind(icons: HudIconSource): HudWidgetKind {
  return {
    name: ABILITY_BAR_WIDGET,
    create: (params) => new AbilityBarWidget(params, icons),
  };
}
