"""
Типизированный вид над сырыми custom properties (BLND-8).

Носитель данных один — сырые custom properties объекта: `prefab`, `visual`,
`terrain`, `curvature`, `skin`, `walkable` и переопределения вида
`<Компонент>.<поле>` (BLND-3). PropertyGroup здесь ничего не хранит: каждое его свойство —
пара `get`/`set` поверх той самой сырой пары ключ-значение, которую прочитает
импортёр. Второе хранилище рассинхронизировалось бы с первым молча, а закон —
импорт (BLND-6), и правка сырого свойства руками обязана быть видна в панели
немедленно и наоборот.

Настройки авторинга (кисти, превью, авто-экспорт) — данные аддона, а не
конвейера: они живут в PropertyGroup сцены и в экспорт не едут ничем, кроме
`extras` самой сцены glTF, которых импортёр не читает (он читает узлы).

Кэш перечней движка лежит на `WindowManager` намеренно: свойства окна не
сохраняются в `.blend`, и снимок опубликованных списков не превращается в
третий носитель правды внутри файла источника.
"""

import bpy
from bpy.props import (
    BoolProperty,
    CollectionProperty,
    EnumProperty,
    FloatProperty,
    IntProperty,
    PointerProperty,
    StringProperty,
)

# Семантические свойства объекта (BLND-3). Порядок совпадает с порядком
# `SEMANTIC_ITEMS` ниже: `get`/`set` перечисления отображают индекс в ключ.
SEMANTIC_KEYS = ("prefab", "visual", "terrain", "curvature")

#: Custom property скина decoration (PRES-2). Семантикой объекта не является.
SKIN_KEY = "skin"

#: Custom property walkable-флага decoration (BLND-3, PRES-2): поверхность меша
#: вида входит в единое поле высот рендера (REND-9). Семантикой не является.
WALKABLE_KEY = "walkable"

#: Разделитель свойства-переопределения `<Компонент>.<поле>` (BLND-3).
FIELD_SEPARATOR = "."

SEMANTIC_ITEMS = (
    ("NONE", "Нет", "Вспомогательный объект: импорт его игнорирует (BLND-3)"),
    ("PREFAB", "Prefab", "Сим-размещение: запись начальной расстановки (SER-8)"),
    ("VISUAL", "Visual", "Decoration: запись парного presentation-документа (PRES-2)"),
    ("TERRAIN", "Terrain", "Grid-mesh клеточных данных террейна (BLND-9)"),
    ("CURVATURE", "Curvature", "Grid-mesh карты кривизны (BLND-10)"),
)


def override_keys(obj):
    """
    Сырые свойства-переопределения объекта в лексикографическом порядке.
    Ровно те ключи, которые импортёр разберёт как `<Компонент>.<поле>`.
    """
    keys = []
    for key in obj.keys():
        if not isinstance(key, str) or key in SEMANTIC_KEYS or key in (SKIN_KEY, WALKABLE_KEY):
            continue
        separator = key.find(FIELD_SEPARATOR)
        if separator <= 0 or separator == len(key) - 1:
            continue
        value = obj.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            keys.append(key)
        elif isinstance(value, bool):
            keys.append(key)
    keys.sort()
    return keys


def split_override(key):
    """`Health.current` → `("Health", "current")`."""
    separator = key.find(FIELD_SEPARATOR)
    return key[:separator], key[separator + 1 :]


def _string_view(key):
    """Пара `get`/`set` строкового свойства поверх сырого custom property."""

    def getter(self):
        value = self.id_data.get(key)
        return value if isinstance(value, str) else ""

    def setter(self, value):
        obj = self.id_data
        text = value.strip()
        if text == "":
            # Пустая строка — отсутствие свойства, а не свойство с пустым
            # значением: у `skin` это «скин записи» (PRES-2), и лишний ключ
            # был бы шумом в `extras`.
            if key in obj.keys():
                del obj[key]
            return
        obj[key] = text

    return getter, setter


_prefab_get, _prefab_set = _string_view("prefab")
_visual_get, _visual_set = _string_view("visual")
_skin_get, _skin_set = _string_view(SKIN_KEY)


def _walkable_get(self):
    value = self.id_data.get(WALKABLE_KEY)
    # Целые 0/1 экспорта равноправны булеву (BLND-3): панель показывает ровно
    # то, что прочитает импортёр, а не своё второе толкование.
    return value is True or value == 1


def _walkable_set(self, value):
    obj = self.id_data
    if value:
        obj[WALKABLE_KEY] = True
        return
    # Выключенный флаг — отсутствие свойства, а не `False` в `extras`:
    # отсутствующее и ложное в документе неразличимы (PRES-2), и лишний ключ
    # был бы шумом — та же конвенция, что у пустого `skin` выше.
    if WALKABLE_KEY in obj.keys():
        del obj[WALKABLE_KEY]


def _semantic_get(self):
    obj = self.id_data
    keys = obj.keys()
    for index, key in enumerate(SEMANTIC_KEYS, start=1):
        if key in keys:
            return index
    return 0


def _semantic_set(self, value):
    obj = self.id_data
    chosen = None if value == 0 else SEMANTIC_KEYS[value - 1]
    for key in SEMANTIC_KEYS:
        if key != chosen and key in obj.keys():
            del obj[key]
    if chosen is None or chosen in obj.keys():
        return
    # `prefab` и `visual` — строки (имя prefab'а, ключ манифеста); `terrain` и
    # `curvature` — маркеры, значение которых импортёр не читает (BLND-3).
    obj[chosen] = "" if chosen in ("prefab", "visual") else 1


class FluxusObjectProps(bpy.types.PropertyGroup):
    """Вид над сырыми свойствами объекта. Собственного хранилища не имеет."""

    semantic: EnumProperty(
        name="Семантика",
        description="Какому слою принадлежит объект (BLND-3). Два свойства сразу — ошибка импорта",
        items=SEMANTIC_ITEMS,
        get=_semantic_get,
        set=_semantic_set,
    )
    prefab: StringProperty(
        name="Prefab",
        description="Имя prefab'а конфига сцены (SER-8). Свободный ввод законен: закон — импорт (BLND-6)",
        get=_prefab_get,
        set=_prefab_set,
    )
    visual: StringProperty(
        name="Visual",
        description="Ключ манифеста визуалов (ASSET-9) записи decoration (PRES-2)",
        get=_visual_get,
        set=_visual_set,
    )
    skin: StringProperty(
        name="Skin",
        description="Имя скина записи вида (REND-6); пусто — скин записи манифеста",
        get=_skin_get,
        set=_skin_set,
    )
    walkable: BoolProperty(
        name="Walkable",
        description=(
            "Поверхность меша вида входит в единое поле высот рендера (REND-9): "
            "юнит визуально стоит на ней. Только картинка — проходимость задают "
            "клетки уровней и рамп террейна (PRES-2)"
        ),
        get=_walkable_get,
        set=_walkable_set,
    )


class FluxusSceneProps(bpy.types.PropertyGroup):
    """Настройки авторинга: кисти, превью, авто-экспорт. Данные конвейера — не здесь."""

    auto_export: BoolProperty(
        name="Авто-экспорт при сохранении",
        description="Экспортировать `<база>.glb` рядом с `.blend` по сохранению (BLND-12)",
        default=True,
    )
    # Результата последнего экспорта здесь нет намеренно: его пишет обработчик
    # `save_post` — уже ПОСЛЕ записи файла, — и правка свойства сцены пометила бы
    # только что сохранённый `.blend` изменённым. Строка живёт состоянием модуля
    # `exporter` (`exporter.last_report`) и в файл не попадает.

    terrain_object: PointerProperty(
        name="Terrain",
        description="Grid-mesh клеточных данных террейна (BLND-9)",
        type=bpy.types.Object,
    )
    curvature_object: PointerProperty(
        name="Curvature",
        description="Grid-mesh карты кривизны (BLND-10)",
        type=bpy.types.Object,
    )

    brush_radius: IntProperty(
        name="Радиус кисти",
        description="Радиус мазка в клетках: 0 — одна клетка",
        default=0,
        min=0,
        max=32,
    )
    brush_level_step: IntProperty(
        name="Шаг уровня",
        description="На сколько целых уровней двигает мазок (снап по построению, BLND-9)",
        default=1,
        min=1,
        max=15,
    )
    brush_level_target: IntProperty(
        name="Целевой уровень",
        description="Уровень, который выставляет режим «задать»",
        default=0,
        min=0,
    )
    brush_flag: EnumProperty(
        name="Флаг клетки",
        description="Какой клеточный атрибут красит кисть флагов",
        items=(
            ("RAMP", "Рампа", "Клетка-рампа (TERR-3 `^`)"),
            ("NOFLOOR", "Нет пола", "Клетка без пола (TERR-3 `_`)"),
        ),
        default="RAMP",
    )
    brush_curvature_step: FloatProperty(
        name="Шаг кривизны",
        description=(
            "Шаг мазка кривизны в долях шага высоты. Ориентир авторинга, а не правило: "
            "квантование к решётке 1/32 делает импорт, предела амплитуды нет (BLND-10)"
        ),
        default=1.0 / 32.0,
        min=0.001,
        max=4.0,
        precision=4,
    )
    brush_curvature_falloff: BoolProperty(
        name="Сглаженный мазок",
        description="Плавное затухание мазка кривизны к краю радиуса",
        default=True,
    )

    preview_height_step: FloatProperty(
        name="Шаг высоты превью",
        description=(
            "Множитель высоты ТОЛЬКО для превью во вьюпорте: клеточные данные он не меняет, "
            "в экспорт не попадает (модификаторы не применяются). Правда — кадр движка (BLND-11)"
        ),
        default=0.6,
        min=0.01,
        max=10.0,
    )
    preview_skirt: FloatProperty(
        name="Глубина юбки",
        description="На сколько превью опускает стенки ниже нуля, чтобы клифы были видны",
        default=0.5,
        min=0.0,
        max=10.0,
    )
    preview_smooth: BoolProperty(
        name="Сглаженный рельеф",
        description="Показывать сглаженное приближение вместо ступеней с клифами (design 7)",
        default=False,
    )
    preview_smooth_iterations: IntProperty(
        name="Итерации сглаживания",
        default=2,
        min=0,
        max=20,
    )
    preview_markers: BoolProperty(
        name="Маркеры рамп и пола",
        description="Показывать клетки с флагами рампы и снятого пола",
        default=True,
    )


class FluxusNameItem(bpy.types.PropertyGroup):
    """Строка кэша перечня. Значение — в штатном поле `name`."""


class FluxusLists(bpy.types.PropertyGroup):
    """
    Снимок перечней движка для выпадающих списков (`prop_search`). Живёт на
    `WindowManager` — в `.blend` не сохраняется и вторым носителем не становится.
    """

    prefabs: CollectionProperty(type=FluxusNameItem)
    visuals: CollectionProperty(type=FluxusNameItem)
    skins: CollectionProperty(type=FluxusNameItem)
    components: CollectionProperty(type=FluxusNameItem)
    status: StringProperty(default="перечни не загружены — нажмите «Обновить»")
    loaded: BoolProperty(default=False)


def fill_lists(window_manager, snapshot):
    """Перелить снимок `sources.Sources` в кэш перечней окна."""
    lists = getattr(window_manager, "fluxus_lists", None)
    if lists is None:
        return
    for collection, values in (
        (lists.prefabs, snapshot.prefabs),
        (lists.visuals, snapshot.visuals),
        (lists.skins, snapshot.skins),
        (lists.components, sorted(snapshot.components.keys())),
    ):
        collection.clear()
        for value in values:
            collection.add().name = value
    lists.loaded = snapshot.loaded
    if snapshot.messages:
        lists.status = "; ".join(snapshot.messages)
    else:
        lists.status = "перечни движка загружены"


CLASSES = (
    FluxusObjectProps,
    FluxusSceneProps,
    FluxusNameItem,
    FluxusLists,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Object.fluxus = PointerProperty(type=FluxusObjectProps)
    bpy.types.Scene.fluxus = PointerProperty(type=FluxusSceneProps)
    bpy.types.WindowManager.fluxus_lists = PointerProperty(type=FluxusLists)


def unregister():
    del bpy.types.WindowManager.fluxus_lists
    del bpy.types.Scene.fluxus
    del bpy.types.Object.fluxus
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
