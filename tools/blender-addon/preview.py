"""
Превью террейна и кривизны на Geometry Nodes (design 7, BLND-8).

Модель та же, что у кисти редактора: **правишь клеточные данные — производное
перестраивается** (ED-10, TERR-5). Превью строит из тех же данных, что уедут в
импорт:

- ступени: высота клетки, умноженная на «шаг высоты превью» — множитель ТОЛЬКО
  вьюпорта, клеточные данные он не меняет;
- клифы: выдавливание каждой клетки вниз до нуля. Стенка появляется ровно там,
  где у соседей разные уровни, — то самое правило, по которому клифы строит
  движок (TERR-5). Из Blender клифы НЕ экспортируются: модификатор при экспорте
  не применяется (`export_apply=False`), и в `.glb` уезжает исходная сетка;
- сглаженный рельеф: сварка сетки и размытие высоты — приближение того, как
  поверхность выглядит с кривизной;
- маркеры рамп и снятого пола: инстансы на клетках, где стоит клеточный атрибут.

Превью — приближение, точным считается кадр движка (BLND-11). Ошибка сборки
графа не должна ломать авторинг: любая неизвестная нода — понятное сообщение,
а конвейер и без превью работает целиком.

API-замечание: интерфейс групп (`group.interface.new_socket`) — Blender 4.0+,
аддон пинится на 4.5 LTS (CONVENTIONS). Значения входов модификатора
адресуются идентификаторами сокетов (`Socket_2` и т.п.), которые Blender
раздаёт сам, поэтому имя сокета мы разрешаем в идентификатор каждый раз, а не
запоминаем строкой.
"""

import bpy

from .grids import NOFLOOR_ATTRIBUTE, PAINT_ATTRIBUTE, RAMP_ATTRIBUTE

TERRAIN_GROUP = "FluxusTerrainPreview"
CURVATURE_GROUP = "FluxusCurvaturePreview"
MODIFIER_NAME = "Fluxus Preview"

INPUT_HEIGHT_STEP = "Height Step"
INPUT_SKIRT = "Skirt"
INPUT_SMOOTH = "Smooth Relief"
INPUT_SMOOTH_ITERATIONS = "Smooth Iterations"
INPUT_MARKERS = "Show Markers"
INPUT_MARKER_SIZE = "Marker Size"


class PreviewError(RuntimeError):
    """Граф не собрался: версия Blender не знает нужной ноды."""


def _node(tree, bl_idname, location=(0.0, 0.0)):
    try:
        node = tree.nodes.new(bl_idname)
    except RuntimeError as error:
        raise PreviewError("нода %s недоступна (%s)" % (bl_idname, error))
    node.location = location
    return node


def _socket(node, collection, name, index):
    """Сокет по имени, а при расхождении имён между версиями — по позиции."""
    socket = collection.get(name)
    if socket is not None:
        return socket
    if index < len(collection):
        return collection[index]
    raise PreviewError("у ноды %s нет сокета %r" % (node.bl_idname, name))


def _in(node, name, index=0):
    return _socket(node, node.inputs, name, index)


def _out(node, name, index=0):
    return _socket(node, node.outputs, name, index)


def _new_socket(group, name, socket_type, in_out="INPUT", **attributes):
    socket = group.interface.new_socket(name=name, in_out=in_out, socket_type=socket_type)
    for key, value in attributes.items():
        try:
            setattr(socket, key, value)
        except (AttributeError, TypeError):
            # Ограничения сокета (min/max) — украшение, а не правило: их
            # отсутствие в какой-то версии не повод падать.
            pass
    return socket


def input_identifier(group, name):
    """Идентификатор входного сокета группы — ключ значения в модификаторе."""
    for item in group.interface.items_tree:
        if getattr(item, "item_type", "SOCKET") != "SOCKET":
            continue
        if item.in_out == "INPUT" and item.name == name:
            return item.identifier
    return None


def _height_scale_chain(tree, geometry_socket, height_step_socket, x=0):
    """
    Set Position, поднимающий вершины до `z × шаг`: смещение `z × (шаг − 1)`.
    Возвращает выход геометрии.
    """
    position = _node(tree, "GeometryNodeInputPosition", (x, -200))
    separate = _node(tree, "ShaderNodeSeparateXYZ", (x + 160, -200))
    tree.links.new(_out(position, "Position", 0), _in(separate, "Vector", 0))

    minus_one = _node(tree, "ShaderNodeMath", (x + 160, -360))
    minus_one.operation = "SUBTRACT"
    tree.links.new(height_step_socket, minus_one.inputs[0])
    minus_one.inputs[1].default_value = 1.0

    scaled = _node(tree, "ShaderNodeMath", (x + 320, -280))
    scaled.operation = "MULTIPLY"
    tree.links.new(_out(separate, "Z", 2), scaled.inputs[0])
    tree.links.new(minus_one.outputs[0], scaled.inputs[1])

    combine = _node(tree, "ShaderNodeCombineXYZ", (x + 480, -280))
    tree.links.new(scaled.outputs[0], _in(combine, "Z", 2))

    set_position = _node(tree, "GeometryNodeSetPosition", (x + 640, 0))
    tree.links.new(geometry_socket, _in(set_position, "Geometry", 0))
    tree.links.new(_out(combine, "Vector", 0), _in(set_position, "Offset", 3))
    return _out(set_position, "Geometry", 0)


def _reset_interface(group):
    """Сокеты группы пересобираются вместе с графом, иначе они удвоятся."""
    try:
        group.interface.clear()
    except (AttributeError, RuntimeError):
        pass


def _marker_branch(tree, marker_size, geometry_socket, attribute_name, node_idname, x, y):
    """Инстансы-маркеры на клетках, где стоит целочисленный клеточный атрибут."""
    named = _node(tree, "GeometryNodeInputNamedAttribute", (x, y))
    # Атрибут хранится целым (`INT`), читается булевым: ноль — нет флага.
    # Приведение делает сама система атрибутов, второго представления не нужно.
    named.data_type = "BOOLEAN"
    _in(named, "Name", 0).default_value = attribute_name

    points = _node(tree, "GeometryNodeMeshToPoints", (x + 200, y))
    points.mode = "FACES"
    tree.links.new(geometry_socket, _in(points, "Mesh", 0))
    tree.links.new(_out(named, "Attribute", 0), _in(points, "Selection", 1))

    shape = _node(tree, node_idname, (x + 200, y - 180))
    if node_idname == "GeometryNodeMeshCone":
        tree.links.new(marker_size, _in(shape, "Radius Bottom", 4))
        tree.links.new(marker_size, _in(shape, "Depth", 5))
    else:
        # Куб принимает размер вектором: скалярный вход в него не подать.
        combine = _node(tree, "ShaderNodeCombineXYZ", (x + 40, y - 320))
        for index in range(3):
            tree.links.new(marker_size, combine.inputs[index])
        tree.links.new(_out(combine, "Vector", 0), _in(shape, "Size", 0))

    instances = _node(tree, "GeometryNodeInstanceOnPoints", (x + 400, y))
    tree.links.new(_out(points, "Points", 0), _in(instances, "Points", 0))
    tree.links.new(_out(shape, "Mesh", 0), _in(instances, "Instance", 2))
    return _out(instances, "Instances", 0)


def build_terrain_preview(group):
    """Собрать граф превью террейна в пустой группе."""
    group.nodes.clear()
    _reset_interface(group)
    _new_socket(group, "Geometry", "NodeSocketGeometry", "INPUT")
    _new_socket(group, "Geometry", "NodeSocketGeometry", "OUTPUT")
    _new_socket(group, INPUT_HEIGHT_STEP, "NodeSocketFloat", default_value=0.6, min_value=0.01)
    _new_socket(group, INPUT_SKIRT, "NodeSocketFloat", default_value=0.5, min_value=0.0)
    _new_socket(group, INPUT_SMOOTH, "NodeSocketBool", default_value=False)
    _new_socket(group, INPUT_SMOOTH_ITERATIONS, "NodeSocketInt", default_value=2, min_value=0)
    _new_socket(group, INPUT_MARKERS, "NodeSocketBool", default_value=True)
    _new_socket(group, INPUT_MARKER_SIZE, "NodeSocketFloat", default_value=0.3, min_value=0.01)

    group_input = _node(group, "NodeGroupInput", (-800, 0))
    group_output = _node(group, "NodeGroupOutput", (1600, 0))

    geometry = _out(group_input, "Geometry", 0)
    height_step = _out(group_input, INPUT_HEIGHT_STEP, 1)
    skirt = _out(group_input, INPUT_SKIRT, 2)
    smooth_flag = _out(group_input, INPUT_SMOOTH, 3)
    smooth_iterations = _out(group_input, INPUT_SMOOTH_ITERATIONS, 4)
    markers_flag = _out(group_input, INPUT_MARKERS, 5)
    marker_size = _out(group_input, INPUT_MARKER_SIZE, 6)

    scaled = _height_scale_chain(group, geometry, height_step, x=-600)

    # Ступени и клифы: каждая клетка выдавливается вниз до нуля, и стенка
    # возникает там, где уровни соседей разошлись (TERR-5).
    position = _node(group, "GeometryNodeInputPosition", (200, -420))
    separate = _node(group, "ShaderNodeSeparateXYZ", (360, -420))
    group.links.new(_out(position, "Position", 0), _in(separate, "Vector", 0))
    depth = _node(group, "ShaderNodeMath", (520, -420))
    depth.operation = "ADD"
    group.links.new(_out(separate, "Z", 2), depth.inputs[0])
    group.links.new(skirt, depth.inputs[1])

    extrude = _node(group, "GeometryNodeExtrudeMesh", (700, 0))
    extrude.mode = "FACES"
    group.links.new(scaled, _in(extrude, "Mesh", 0))
    _in(extrude, "Offset", 2).default_value = (0.0, 0.0, -1.0)
    group.links.new(depth.outputs[0], _in(extrude, "Offset Scale", 3))
    columns = _out(extrude, "Mesh", 0)

    # Сглаженный рельеф: сварка клеток и размытие высоты по соседям.
    merge = _node(group, "GeometryNodeMergeByDistance", (200, 320))
    group.links.new(scaled, _in(merge, "Geometry", 0))
    smooth_position = _node(group, "GeometryNodeInputPosition", (200, 200))
    smooth_separate = _node(group, "ShaderNodeSeparateXYZ", (360, 200))
    group.links.new(_out(smooth_position, "Position", 0), _in(smooth_separate, "Vector", 0))
    blur = _node(group, "GeometryNodeBlurAttribute", (520, 200))
    blur.data_type = "FLOAT"
    group.links.new(_out(smooth_separate, "Z", 2), _in(blur, "Value", 0))
    group.links.new(smooth_iterations, _in(blur, "Iterations", 1))
    smooth_combine = _node(group, "ShaderNodeCombineXYZ", (700, 200))
    group.links.new(_out(smooth_separate, "X", 0), _in(smooth_combine, "X", 0))
    group.links.new(_out(smooth_separate, "Y", 1), _in(smooth_combine, "Y", 1))
    group.links.new(_out(blur, "Value", 0), _in(smooth_combine, "Z", 2))
    smooth_set = _node(group, "GeometryNodeSetPosition", (880, 320))
    group.links.new(_out(merge, "Geometry", 0), _in(smooth_set, "Geometry", 0))
    group.links.new(_out(smooth_combine, "Vector", 0), _in(smooth_set, "Position", 2))
    smoothed = _out(smooth_set, "Geometry", 0)

    relief = _node(group, "GeometryNodeSwitch", (1060, 0))
    relief.input_type = "GEOMETRY"
    group.links.new(smooth_flag, _in(relief, "Switch", 0))
    group.links.new(columns, _in(relief, "False", 1))
    group.links.new(smoothed, _in(relief, "True", 2))

    ramp_markers = _marker_branch(
        group, marker_size, scaled, RAMP_ATTRIBUTE, "GeometryNodeMeshCone", 200, -700
    )
    floor_markers = _marker_branch(
        group, marker_size, scaled, NOFLOOR_ATTRIBUTE, "GeometryNodeMeshCube", 200, -1100
    )
    join = _node(group, "GeometryNodeJoinGeometry", (1240, -400))
    group.links.new(_out(relief, "Output", 0), _in(join, "Geometry", 0))
    group.links.new(ramp_markers, _in(join, "Geometry", 0))
    group.links.new(floor_markers, _in(join, "Geometry", 0))

    markers = _node(group, "GeometryNodeSwitch", (1420, 0))
    markers.input_type = "GEOMETRY"
    group.links.new(markers_flag, _in(markers, "Switch", 0))
    group.links.new(_out(relief, "Output", 0), _in(markers, "False", 1))
    group.links.new(_out(join, "Geometry", 0), _in(markers, "True", 2))

    group.links.new(_out(markers, "Output", 0), _in(group_output, "Geometry", 0))


def build_curvature_preview(group):
    """
    Превью кривизны: то же преувеличение высоты и то же сглаживание, без
    ступеней и клифов — кривизна их не порождает (ASSET-7). Совмещённый вид
    «террейн плюс кривизна» — кадр движка, а не Blender (BLND-11).
    """
    group.nodes.clear()
    _reset_interface(group)
    _new_socket(group, "Geometry", "NodeSocketGeometry", "INPUT")
    _new_socket(group, "Geometry", "NodeSocketGeometry", "OUTPUT")
    _new_socket(group, INPUT_HEIGHT_STEP, "NodeSocketFloat", default_value=1.0, min_value=0.01)
    _new_socket(group, INPUT_SMOOTH, "NodeSocketBool", default_value=True)
    _new_socket(group, INPUT_SMOOTH_ITERATIONS, "NodeSocketInt", default_value=1, min_value=0)

    group_input = _node(group, "NodeGroupInput", (-800, 0))
    group_output = _node(group, "NodeGroupOutput", (1000, 0))
    geometry = _out(group_input, "Geometry", 0)
    height_step = _out(group_input, INPUT_HEIGHT_STEP, 1)
    smooth_flag = _out(group_input, INPUT_SMOOTH, 2)
    smooth_iterations = _out(group_input, INPUT_SMOOTH_ITERATIONS, 3)

    scaled = _height_scale_chain(group, geometry, height_step, x=-600)

    merge = _node(group, "GeometryNodeMergeByDistance", (200, 200))
    group.links.new(scaled, _in(merge, "Geometry", 0))
    position = _node(group, "GeometryNodeInputPosition", (200, 0))
    separate = _node(group, "ShaderNodeSeparateXYZ", (360, 0))
    group.links.new(_out(position, "Position", 0), _in(separate, "Vector", 0))
    blur = _node(group, "GeometryNodeBlurAttribute", (520, 0))
    blur.data_type = "FLOAT"
    group.links.new(_out(separate, "Z", 2), _in(blur, "Value", 0))
    group.links.new(smooth_iterations, _in(blur, "Iterations", 1))
    combine = _node(group, "ShaderNodeCombineXYZ", (700, 0))
    group.links.new(_out(separate, "X", 0), _in(combine, "X", 0))
    group.links.new(_out(separate, "Y", 1), _in(combine, "Y", 1))
    group.links.new(_out(blur, "Value", 0), _in(combine, "Z", 2))
    smooth_set = _node(group, "GeometryNodeSetPosition", (860, 200))
    group.links.new(_out(merge, "Geometry", 0), _in(smooth_set, "Geometry", 0))
    group.links.new(_out(combine, "Vector", 0), _in(smooth_set, "Position", 2))

    switch = _node(group, "GeometryNodeSwitch", (900, -200))
    switch.input_type = "GEOMETRY"
    group.links.new(smooth_flag, _in(switch, "Switch", 0))
    group.links.new(scaled, _in(switch, "False", 1))
    group.links.new(_out(smooth_set, "Geometry", 0), _in(switch, "True", 2))
    group.links.new(_out(switch, "Output", 0), _in(group_output, "Geometry", 0))


def ensure_group(name, builder, rebuild=False):
    """Группа превью; собирается один раз и переcобирается только по просьбе."""
    group = bpy.data.node_groups.get(name)
    if group is None:
        group = bpy.data.node_groups.new(name, "GeometryNodeTree")
        rebuild = True
    if rebuild or not group.nodes:
        builder(group)
    return group


def ensure_modifier(obj, group):
    modifier = obj.modifiers.get(MODIFIER_NAME)
    if modifier is None:
        modifier = obj.modifiers.new(MODIFIER_NAME, "NODES")
    modifier.node_group = group
    return modifier


def apply_settings(modifier, group, values):
    """Значения входов модификатора по ИМЕНАМ сокетов группы."""
    for name, value in values.items():
        identifier = input_identifier(group, name)
        if identifier is None:
            continue
        try:
            modifier[identifier] = value
        except (KeyError, TypeError):
            pass


class FLUXUS_OT_setup_preview(bpy.types.Operator):
    """Собрать (или пересобрать) превью на выбранной сетке"""

    bl_idname = "fluxus.setup_preview"
    bl_label = "Собрать превью"
    bl_options = {"REGISTER", "UNDO"}

    target: bpy.props.EnumProperty(
        name="Сетка",
        items=(
            ("TERRAIN", "Террейн", "Превью ступеней, клифов и маркеров (BLND-9)"),
            ("CURVATURE", "Кривизна", "Превью карты кривизны (BLND-10)"),
        ),
        default="TERRAIN",
    )
    rebuild: bpy.props.BoolProperty(
        name="Пересобрать граф",
        description="Собрать группу нод заново, потеряв ручные правки графа",
        default=False,
    )

    def execute(self, context):
        from .grids import CURVATURE_KEY, TERRAIN_KEY, resolve_grid

        key = TERRAIN_KEY if self.target == "TERRAIN" else CURVATURE_KEY
        obj = resolve_grid(context, key)
        if obj is None:
            self.report({"ERROR"}, "в сцене нет объекта со свойством %r (BLND-3)" % key)
            return {"CANCELLED"}
        settings = context.scene.fluxus
        try:
            if self.target == "TERRAIN":
                group = ensure_group(TERRAIN_GROUP, build_terrain_preview, self.rebuild)
                values = {
                    INPUT_HEIGHT_STEP: settings.preview_height_step,
                    INPUT_SKIRT: settings.preview_skirt,
                    INPUT_SMOOTH: settings.preview_smooth,
                    INPUT_SMOOTH_ITERATIONS: settings.preview_smooth_iterations,
                    INPUT_MARKERS: settings.preview_markers,
                }
            else:
                group = ensure_group(CURVATURE_GROUP, build_curvature_preview, self.rebuild)
                values = {
                    INPUT_HEIGHT_STEP: settings.preview_height_step,
                    INPUT_SMOOTH: settings.preview_smooth,
                    INPUT_SMOOTH_ITERATIONS: settings.preview_smooth_iterations,
                }
        except PreviewError as error:
            self.report({"ERROR"}, "превью не собрано: %s" % error)
            return {"CANCELLED"}
        modifier = ensure_modifier(obj, group)
        apply_settings(modifier, group, values)
        self.report({"INFO"}, "превью собрано на объекте %s" % obj.name)
        return {"FINISHED"}


#: Имя материала предпросмотра раскраски. Одно на сцену: материал показывает
#: АТРИБУТ, а не покрытие конкретной арены.
PAINT_MATERIAL = "FluxusTerrainPaint"

#: Плоские цвета слотов предпросмотра. Совпадения с кадром движка аддон не
#: обещает (BLND-8, BLND-14): гарантия конвейера — импорт, а цвета здесь нужны,
#: чтобы автор ВИДЕЛ границы раскраски и попадал кистью.
PAINT_PREVIEW_COLORS = (
    (0.35, 0.55, 0.22, 1.0),
    (0.55, 0.42, 0.26, 1.0),
    (0.52, 0.52, 0.55, 1.0),
    (0.72, 0.66, 0.42, 1.0),
)


def build_paint_material(material):
    """Материал предпросмотра раскраски: атрибут `_PAINT` → плоские цвета слотов.

    Читается ТОТ ЖЕ атрибут, который уезжает в экспорт и который читает импорт
    (BLND-14): второй источник правды о раскраске в сцене Blender не заводится,
    и «покрашено для вида» от «покрашено данными» не расходится.
    """
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    attribute = tree.nodes.new("ShaderNodeAttribute")
    attribute.attribute_name = PAINT_ATTRIBUTE
    attribute.location = (-600, 0)
    # Индекс слота — целое; делением на число цветов оно ложится на [0, 1]
    # ступенями, а `CONSTANT`-интерполяция рампы держит их плоскими.
    divide = tree.nodes.new("ShaderNodeMath")
    divide.operation = "DIVIDE"
    divide.location = (-400, 0)
    divide.inputs[1].default_value = float(len(PAINT_PREVIEW_COLORS))
    tree.links.new(attribute.outputs["Fac"], divide.inputs[0])
    ramp = tree.nodes.new("ShaderNodeValToRGB")
    ramp.location = (-220, 0)
    ramp.color_ramp.interpolation = "CONSTANT"
    while len(ramp.color_ramp.elements) > 1:
        ramp.color_ramp.elements.remove(ramp.color_ramp.elements[-1])
    for index, color in enumerate(PAINT_PREVIEW_COLORS):
        position = index / float(len(PAINT_PREVIEW_COLORS))
        element = ramp.color_ramp.elements[0] if index == 0 else ramp.color_ramp.elements.new(position)
        element.position = position
        element.color = color
    tree.links.new(divide.outputs["Value"], ramp.inputs["Fac"])
    shader = tree.nodes.new("ShaderNodeBsdfDiffuse")
    shader.location = (0, 0)
    tree.links.new(ramp.outputs["Color"], shader.inputs["Color"])
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    output.location = (200, 0)
    tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return material


def ensure_paint_material(rebuild=False):
    """Материал предпросмотра; `rebuild` пересобирает граф, теряя ручные правки."""
    material = bpy.data.materials.get(PAINT_MATERIAL)
    if material is None:
        material = bpy.data.materials.new(PAINT_MATERIAL)
        return build_paint_material(material)
    if rebuild:
        build_paint_material(material)
    return material


class FLUXUS_OT_paint_preview(bpy.types.Operator):
    """Материал предпросмотра раскраски на объект террейна (BLND-14)"""

    bl_idname = "fluxus.paint_preview"
    bl_label = "Превью раскраски"
    bl_options = {"REGISTER", "UNDO"}

    rebuild: bpy.props.BoolProperty(
        name="Пересобрать материал",
        description="Собрать граф материала заново, потеряв ручные правки",
        default=False,
    )

    def execute(self, context):
        from .grids import TERRAIN_KEY, resolve_grid

        obj = resolve_grid(context, TERRAIN_KEY)
        if obj is None:
            self.report({"ERROR"}, "в сцене нет объекта со свойством %r (BLND-3)" % TERRAIN_KEY)
            return {"CANCELLED"}
        material = ensure_paint_material(self.rebuild)
        if material.name not in obj.data.materials:
            obj.data.materials.append(material)
        self.report({"INFO"}, "превью раскраски на объекте %s" % obj.name)
        return {"FINISHED"}


class FLUXUS_OT_sync_preview(bpy.types.Operator):
    """Подать настройки превью в существующие модификаторы"""

    bl_idname = "fluxus.sync_preview"
    bl_label = "Обновить превью"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        settings = context.scene.fluxus
        touched = 0
        for obj in context.scene.objects:
            modifier = obj.modifiers.get(MODIFIER_NAME) if obj.type == "MESH" else None
            group = modifier.node_group if modifier is not None else None
            if group is None:
                continue
            apply_settings(
                modifier,
                group,
                {
                    INPUT_HEIGHT_STEP: settings.preview_height_step,
                    INPUT_SKIRT: settings.preview_skirt,
                    INPUT_SMOOTH: settings.preview_smooth,
                    INPUT_SMOOTH_ITERATIONS: settings.preview_smooth_iterations,
                    INPUT_MARKERS: settings.preview_markers,
                },
            )
            touched += 1
        self.report({"INFO"}, "обновлено модификаторов: %d" % touched)
        return {"FINISHED"}


CLASSES = (
    FLUXUS_OT_setup_preview,
    FLUXUS_OT_paint_preview,
    FLUXUS_OT_sync_preview,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
