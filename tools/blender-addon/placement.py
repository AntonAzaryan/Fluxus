"""
Операторы авторинга размещений (BLND-8, задачи 8.2 и 8.3).

Все операторы пишут ровно те сырые custom properties, которые прочитает
импортёр (BLND-3): `prefab` у сим-размещения, `visual` и `skin` у decoration,
`<Компонент>.<поле>` у переопределений. Панель и операторы — эргономика;
законом остаётся импорт (BLND-6), и то же самое автор вправе сделать руками
через «Custom Properties» стандартной панели объекта.

Значения выпадающих списков приходят из опубликованных данных движка
(`sources`): имена prefab'ов и компонентов — из конфига сцены (SER-7, SER-8),
ключи видов и скины — из манифеста визуалов (ASSET-9, REND-6). Ни одного
перечня, зашитого в Python, здесь нет — он разошёлся бы с движком молча
(BLND-8).
"""

import math

import bpy

from . import props, sources

# Динамические перечни отдаются Blender'у как временные списки, и без
# собственной ссылки строки в них может собрать сборщик мусора Python — это
# известная ловушка `EnumProperty(items=...)`. Держим последний список здесь.
_ENUM_CACHE = {}


def _enum_items(key, values, empty_label):
    if not values:
        items = [("", empty_label, "")]
    else:
        items = [(value, value, "") for value in values]
    _ENUM_CACHE[key] = items
    return items


def _component_items(self, context):
    snapshot = sources.get()
    return _enum_items(
        "components", sorted(snapshot.components.keys()), "компонентов нет: обновите перечни"
    )


def _field_items(self, context):
    snapshot = sources.get()
    fields = snapshot.components.get(self.component, {})
    # Значением перечня остаётся ИМЯ поля; тип из схемы показан только меткой.
    items = [(name, "%s (%s)" % (name, fields[name]), "") for name in sorted(fields.keys())]
    if not items:
        items = [("", "полей нет: выберите компонент", "")]
    _ENUM_CACHE["fields"] = items
    return items


class FLUXUS_OT_refresh_sources(bpy.types.Operator):
    """Перечитать опубликованные данные проекта рядом с этим `.blend`"""

    bl_idname = "fluxus.refresh_sources"
    bl_label = "Обновить перечни"
    bl_options = {"REGISTER"}

    def execute(self, context):
        snapshot = sources.refresh(bpy.data.filepath)
        props.fill_lists(context.window_manager, snapshot)
        if not snapshot.loaded:
            self.report({"WARNING"}, "; ".join(snapshot.messages) or "перечни не загружены")
            return {"FINISHED"}
        self.report(
            {"INFO"},
            "prefab'ов %d, ключей видов %d, компонентов %d"
            % (len(snapshot.prefabs), len(snapshot.visuals), len(snapshot.components)),
        )
        return {"FINISHED"}


class FLUXUS_OT_add_placement(bpy.types.Operator):
    """Добавить сим-размещение: empty со свойством `prefab` (SER-8, BLND-3)"""

    bl_idname = "fluxus.add_placement"
    bl_label = "Добавить юнита / prop"
    bl_options = {"REGISTER", "UNDO"}

    prefab: bpy.props.StringProperty(
        name="Prefab",
        description="Имя prefab'а конфига сцены (SER-8)",
    )
    object_name: bpy.props.StringProperty(
        name="Имя объекта",
        description="Имя объекта Blender — ключ порядка записей и адрес в сообщениях импорта (BLND-4)",
    )

    def invoke(self, context, event):
        if not self.prefab:
            snapshot = sources.get()
            if snapshot.prefabs:
                self.prefab = snapshot.prefabs[0]
        return context.window_manager.invoke_props_dialog(self)

    def draw(self, context):
        layout = self.layout
        lists = context.window_manager.fluxus_lists
        layout.prop_search(self, "prefab", lists, "prefabs", text="Prefab", icon="OUTLINER_OB_GROUP_INSTANCE")
        layout.prop(self, "object_name")
        layout.label(text="Имя объекта задаёт порядок записей `initial` (BLND-4)", icon="INFO")

    def execute(self, context):
        name = self.object_name.strip() or (self.prefab.strip() or "placement")
        obj = bpy.data.objects.new(name, None)
        # Empty экспортируется узлом без геометрии: заглушек в кадре не
        # появляется, а импортёр читает только трансформ и `extras` (BLND-3).
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 0.5
        obj.location = context.scene.cursor.location
        obj["prefab"] = self.prefab.strip()
        context.collection.objects.link(obj)
        for other in context.selected_objects:
            other.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        return {"FINISHED"}


class FLUXUS_OT_add_decoration(bpy.types.Operator):
    """Добавить decoration: объект со свойством `visual` (PRES-2, BLND-3)"""

    bl_idname = "fluxus.add_decoration"
    bl_label = "Добавить decoration"
    bl_options = {"REGISTER", "UNDO"}

    visual: bpy.props.StringProperty(
        name="Visual",
        description="Ключ манифеста визуалов (ASSET-9)",
    )
    skin: bpy.props.StringProperty(
        name="Skin",
        description="Имя скина (REND-6); пусто — скин записи манифеста",
    )
    object_name: bpy.props.StringProperty(name="Имя объекта")

    def invoke(self, context, event):
        if not self.visual:
            snapshot = sources.get()
            if snapshot.visuals:
                self.visual = snapshot.visuals[0]
        return context.window_manager.invoke_props_dialog(self)

    def draw(self, context):
        layout = self.layout
        lists = context.window_manager.fluxus_lists
        layout.prop_search(self, "visual", lists, "visuals", text="Visual", icon="OBJECT_DATA")
        layout.prop_search(self, "skin", lists, "skins", text="Skin", icon="MATERIAL")
        layout.prop(self, "object_name")
        layout.label(text="Позиция, `yaw` и `scale` — из трансформа объекта (PRES-2)", icon="INFO")

    def execute(self, context):
        name = self.object_name.strip() or (self.visual.strip() or "decoration")
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 0.5
        obj.location = context.scene.cursor.location
        obj["visual"] = self.visual.strip()
        skin = self.skin.strip()
        if skin:
            obj[props.SKIN_KEY] = skin
        context.collection.objects.link(obj)
        for other in context.selected_objects:
            other.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        return {"FINISHED"}


class FLUXUS_OT_override_add(bpy.types.Operator):
    """Добавить переопределение поля компонента: свойство `<Компонент>.<поле>` (SER-8, CMD-6)"""

    bl_idname = "fluxus.override_add"
    bl_label = "Добавить переопределение"
    bl_options = {"REGISTER", "UNDO"}

    component: bpy.props.EnumProperty(name="Компонент", items=_component_items)
    field: bpy.props.EnumProperty(name="Поле", items=_field_items)
    value: bpy.props.FloatProperty(
        name="Значение",
        description="В ОБЫЧНЫХ единицах: 0.5, а не 32768 — в Q16.16 переводит импорт (FP-1)",
        default=0.0,
    )

    @classmethod
    def poll(cls, context):
        return context.object is not None

    def invoke(self, context, event):
        return context.window_manager.invoke_props_dialog(self)

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "component")
        layout.prop(self, "field")
        layout.prop(self, "value")
        snapshot = sources.get()
        kind = snapshot.components.get(self.component, {}).get(self.field)
        if kind == "i32":
            layout.label(text="поле типа i32: нецелое значение — ошибка импорта", icon="ERROR")
        elif kind == "fixed":
            layout.label(text="поле типа fixed: значение уедет в Q16.16 (FP-1)", icon="INFO")

    def execute(self, context):
        obj = context.object
        if not self.component or not self.field:
            self.report({"ERROR"}, "компонент и поле не выбраны — перечни не загружены?")
            return {"CANCELLED"}
        snapshot = sources.get()
        kind = snapshot.components.get(self.component, {}).get(self.field, "")
        key = "%s%s%s" % (self.component, props.FIELD_SEPARATOR, self.field)
        # Тип значения — из схемы компонента (ECS-3): `i32` пишется целым,
        # `fixed` — обычным числом, которое импорт переведёт в Q16.16 (FP-1).
        obj[key] = int(round(self.value)) if kind == "i32" else float(self.value)
        try:
            obj.id_properties_ui(key).update(
                description="%s: поле типа %s (ECS-3); значение в обычных единицах" % (key, kind or "?")
            )
        except (AttributeError, TypeError):
            # `id_properties_ui` — 3.0+; описание свойства украшение, не правило.
            pass
        # Проверку «поле занято трансформом» (BLND-3) аддон не делает намеренно:
        # привязка позиции и курса — настройка проекта (ED-16), и второй её
        # экземпляр в Python разошёлся бы с проектом. Назовёт её живая проверка
        # импортёра (задача 8.5) и сам импорт.
        return {"FINISHED"}


class FLUXUS_OT_override_remove(bpy.types.Operator):
    """Убрать переопределение поля компонента"""

    bl_idname = "fluxus.override_remove"
    bl_label = "Убрать переопределение"
    bl_options = {"REGISTER", "UNDO"}

    key: bpy.props.StringProperty(name="Свойство")

    @classmethod
    def poll(cls, context):
        return context.object is not None

    def execute(self, context):
        obj = context.object
        if self.key in obj.keys():
            del obj[self.key]
        return {"FINISHED"}


#: Семантики объектов-носителей рельефа: по ним оператор посадки ищет поверхность.
_RELIEF_KEYS = ("sculpt", "terrain", "curvature")

#: Высота, с которой бросается луч посадки: заведомо выше любого рельефа сцены.
_SNAP_CEILING = 1.0e5


def _relief_height(depsgraph, scene, x, y):
    """
    Высота рельефа под точкой плана: максимум по вертикальным попаданиям в меши
    объектов с семантикой рельефа. Считается по evaluated-геометрии — скалпт с
    незаприменёнными модификаторами (Multires, Subdivision) сажает по тому, что
    автор видит.
    """
    from mathutils import Vector

    best = None
    for obj in scene.objects:
        if obj.type != "MESH" or not any(key in obj.keys() for key in _RELIEF_KEYS):
            continue
        evaluated = obj.evaluated_get(depsgraph)
        matrix = evaluated.matrix_world
        try:
            inverted = matrix.inverted()
        except ValueError:
            # Вырожденный трансформ (нулевой масштаб) луч не примет.
            continue
        origin = inverted @ Vector((x, y, _SNAP_CEILING))
        direction = (inverted.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized()
        hit, location, _normal, _index = evaluated.ray_cast(origin, direction)
        if not hit:
            continue
        world_z = (matrix @ location).z
        if best is None or world_z > best:
            best = world_z
    return best


class FLUXUS_OT_snap_to_relief(bpy.types.Operator):
    """Посадить выделенные размещения на рельеф: z — по верхней поверхности скалпта или сетки"""

    bl_idname = "fluxus.snap_to_relief"
    bl_label = "Посадить на рельеф"
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        return bool(context.selected_objects)

    def execute(self, context):
        depsgraph = context.evaluated_depsgraph_get()
        snapped = 0
        missed = 0
        for obj in context.selected_objects:
            # Носители рельефа не сажаются сами на себя.
            if any(key in obj.keys() for key in _RELIEF_KEYS):
                continue
            location = obj.matrix_world.translation
            height = _relief_height(depsgraph, context.scene, location.x, location.y)
            if height is None:
                missed += 1
                continue
            world = obj.matrix_world.copy()
            world.translation.z = height
            obj.matrix_world = world
            snapped += 1
        if snapped == 0 and missed == 0:
            self.report({"WARNING"}, "среди выделенного нет размещений: носители рельефа не сажаются")
            return {"CANCELLED"}
        message = "посажено объектов: %d" % snapped
        if missed:
            message += "; без рельефа под собой: %d" % missed
        self.report({"INFO"} if snapped else {"WARNING"}, message)
        return {"FINISHED"}


class FLUXUS_OT_sync_preview_camera(bpy.types.Operator):
    """Построить камеру превью из секции конфига камеры манифеста (CAM-1, ASSET-10, BLND-11)"""

    bl_idname = "fluxus.sync_preview_camera"
    bl_label = "Камера превью из манифеста"
    bl_options = {"REGISTER", "UNDO"}

    camera_name = "fluxus-preview-camera"

    def execute(self, context):
        snapshot = sources.get()
        config = snapshot.camera
        if not config:
            self.report(
                {"ERROR"},
                "в манифесте нет секции конфига камеры (ASSET-10); своих чисел камеры у аддона нет (BLND-11)",
            )
            return {"CANCELLED"}

        pitch = config.get("pitch")
        yaw = config.get("yaw")
        distance = config.get("distance")
        fov_deg = config.get("fovDeg")
        missing = [
            name
            for name, value in (("pitch", pitch), ("yaw", yaw), ("distance", distance))
            if value is None
        ]
        if missing:
            self.report({"ERROR"}, "в секции камеры нет параметров: %s" % ", ".join(missing))
            return {"CANCELLED"}

        obj = context.scene.objects.get(self.camera_name)
        if obj is None or obj.type != "CAMERA":
            data = bpy.data.cameras.new(self.camera_name)
            obj = bpy.data.objects.new(self.camera_name, data)
            context.collection.objects.link(obj)

        target = context.scene.cursor.location.copy()
        obj.location = (
            target.x + distance * math.cos(pitch) * math.cos(yaw),
            target.y + distance * math.cos(pitch) * math.sin(yaw),
            target.z + distance * math.sin(pitch),
        )
        # Камера Blender смотрит вдоль −Z: поворот на π/2 по X ставит её
        # горизонтально, наклон снимает `pitch`, азимут добавляет `yaw`.
        obj.rotation_euler = (math.pi / 2.0 - pitch, 0.0, yaw + math.pi / 2.0)
        if fov_deg is not None:
            obj.data.sensor_fit = "VERTICAL"
            obj.data.angle_y = math.radians(fov_deg)
        context.scene.camera = obj
        self.report(
            {"INFO"},
            "камера превью из манифеста: наклон %.3f, азимут %.3f, дистанция %.2f" % (pitch, yaw, distance),
        )
        return {"FINISHED"}


CLASSES = (
    FLUXUS_OT_refresh_sources,
    FLUXUS_OT_add_placement,
    FLUXUS_OT_add_decoration,
    FLUXUS_OT_override_add,
    FLUXUS_OT_override_remove,
    FLUXUS_OT_snap_to_relief,
    FLUXUS_OT_sync_preview_camera,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
