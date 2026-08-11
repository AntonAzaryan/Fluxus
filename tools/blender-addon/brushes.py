"""
Кисти террейна и кривизны: `WorkSpaceTool` плюс модальные операторы (design 9).

Штатные кисти Blender (sculpt/paint) из Python не расширяются, поэтому кисть
конвейера — инструмент рабочего пространства с модальным оператором: нажатие
левой кнопки начинает мазок, движение мыши красит клетки под курсором,
отпускание завершает, `Esc` / правая кнопка откатывает мазок целиком.

**Снап по построению (BLND-9, design 7).** Кисть уровня двигает клетку целыми
уровнями и записывает высоту как `уровень × LEVEL_UNIT`: «высота между
уровнями» мазком недостижима, и отказ импорта по этой причине означает правку
мимо кисти — тогда он уместен. Кисть кривизны двигает УЗЛЫ — общие вершины
связной сетки — удобным шагом, но правилом это не делает: квантование к
решётке 1/32 выполняет импорт, а клампа амплитуды нет вовсе (BLND-10) —
читаемость перепадов в кадре держит cliff-кромка (REND-9).

Клетка под курсором ищется лучом по BVH, собранному из ИСХОДНОГО меша, а не по
`Object.ray_cast`: у объекта висит превью-модификатор Geometry Nodes, и
вычисленная геометрия ни номерами граней, ни формой не совпадает с клеточными
данными. Дерево собирается один раз на мазок — поверхность под курсором не
«убегает» вверх, пока автор ведёт мышью.

Границы уровней приходят из алфавита опубликованной схемы (TERR-3), размеры
сетки — из ассета террейна сцены (TERR-2): своих чисел у кисти нет (BLND-8).
"""

import bpy
from bpy_extras import view3d_utils
from mathutils.bvhtree import BVHTree

from . import sources
from .grids import (
    CURVATURE_KEY,
    LEVEL_UNIT,
    NOFLOOR_ATTRIBUTE,
    RAMP_ATTRIBUTE,
    TERRAIN_KEY,
    cell_attribute,
    cell_height,
    cell_index,
    ensure_int_attribute,
    grid_dimensions,
    resolve_grid,
    set_cell_attribute,
    set_cell_height,
)


class GridBrushBase:
    """Общая механика мазка: разрешение сетки, луч, радиус, откат."""

    #: Семантическое свойство объекта, на котором работает кисть (BLND-3).
    grid_key = TERRAIN_KEY

    @classmethod
    def poll(cls, context):
        return (
            context.mode == "OBJECT"
            and context.area is not None
            and context.area.type == "VIEW_3D"
        )

    # -- подготовка ------------------------------------------------------

    def _prepare(self, context):
        self.grid = resolve_grid(context, self.grid_key)
        if self.grid is None:
            self.report({"ERROR"}, "в сцене нет объекта со свойством %r (BLND-3)" % self.grid_key)
            return False
        if self.grid.type != "MESH":
            self.report({"ERROR"}, "объект %s не меш" % self.grid.name)
            return False

        snapshot = sources.get()
        dimensions = grid_dimensions(snapshot)
        if dimensions is None:
            self.report(
                {"ERROR"},
                "размеры сетки неизвестны: нет ассета террейна в конфиге сцены (TERR-2). Обновите перечни",
            )
            return False
        self.width, self.height, self.cell_size = dimensions
        self.max_level = snapshot.max_level
        self.radius = context.scene.fluxus.brush_radius

        mesh = self.grid.data
        if len(mesh.polygons) != self.width * self.height:
            self.report(
                {"ERROR"},
                "сетка объекта (%d клеток) не совпадает с ассетом террейна %d×%d (TERR-2)"
                % (len(mesh.polygons), self.width, self.height),
            )
            return False

        vertices = [vertex.co.copy() for vertex in mesh.vertices]
        polygons = [tuple(polygon.vertices) for polygon in mesh.polygons]
        self.tree = BVHTree.FromPolygons(vertices, polygons, all_triangles=False, epsilon=0.0)
        self.painted = set()
        self._snapshot_state(mesh)
        return True

    def _snapshot_state(self, mesh):
        """Состояние до мазка — для отката по `Esc`."""
        self.saved_heights = [vertex.co.z for vertex in mesh.vertices]
        self.saved_attributes = {}
        for name in (RAMP_ATTRIBUTE, NOFLOOR_ATTRIBUTE):
            attribute = mesh.attributes.get(name)
            if attribute is not None:
                self.saved_attributes[name] = [item.value for item in attribute.data]

    def _restore_state(self):
        mesh = self.grid.data
        for index, value in enumerate(self.saved_heights):
            mesh.vertices[index].co.z = value
        for name, values in self.saved_attributes.items():
            attribute = mesh.attributes.get(name)
            if attribute is None:
                continue
            for index, value in enumerate(values):
                attribute.data[index].value = value
        mesh.update()

    # -- геометрия -------------------------------------------------------

    def _cell_under_mouse(self, context, event):
        region = context.region
        region_data = context.region_data
        if region is None or region_data is None:
            return None
        coord = (event.mouse_region_x, event.mouse_region_y)
        direction = view3d_utils.region_2d_to_vector_3d(region, region_data, coord)
        origin = view3d_utils.region_2d_to_origin_3d(region, region_data, coord)
        inverse = self.grid.matrix_world.inverted()
        local_origin = inverse @ origin
        local_direction = (inverse.to_3x3() @ direction).normalized()
        hit = self.tree.ray_cast(local_origin, local_direction)
        # `FromPolygons` нумерует грани так же, как исходный меш: грань — клетка.
        return None if hit is None or hit[2] is None else hit[2]

    def _cells_in_radius(self, index):
        radius = self.radius
        x = index % self.width
        y = index // self.width
        if radius <= 0:
            return [(index, 1.0)]
        out = []
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                cx = x + dx
                cy = y + dy
                if cx < 0 or cy < 0 or cx >= self.width or cy >= self.height:
                    continue
                distance = max(abs(dx), abs(dy))
                if distance > radius:
                    continue
                weight = 1.0 - distance / float(radius + 1)
                out.append((cell_index(cx, cy, self.width), weight))
        return out

    # -- мазок -----------------------------------------------------------

    def _paint(self, context, event):
        index = self._cell_under_mouse(context, event)
        if index is None:
            return
        mesh = self.grid.data
        changed = False
        for cell, weight in self._cells_in_radius(index):
            if cell in self.painted:
                continue
            self.painted.add(cell)
            if self.apply_to_cell(context, mesh, cell, weight):
                changed = True
        if changed:
            mesh.update()

    def apply_to_cell(self, context, mesh, index, weight):  # pragma: no cover - переопределяется
        raise NotImplementedError

    def invoke(self, context, event):
        if not self._prepare(context):
            return {"CANCELLED"}
        self._paint(context, event)
        context.window_manager.modal_handler_add(self)
        return {"RUNNING_MODAL"}

    def modal(self, context, event):
        if event.type == "MOUSEMOVE":
            self._paint(context, event)
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "RELEASE":
            return {"FINISHED"}
        if event.type in {"RIGHTMOUSE", "ESC"}:
            self._restore_state()
            return {"CANCELLED"}
        return {"RUNNING_MODAL"}


class FLUXUS_OT_terrain_level_brush(GridBrushBase, bpy.types.Operator):
    """Кисть уровня: двигает клетки целыми уровнями (BLND-9)"""

    bl_idname = "fluxus.terrain_level_brush"
    bl_label = "Кисть уровня террейна"
    bl_options = {"REGISTER", "UNDO"}

    grid_key = TERRAIN_KEY

    mode: bpy.props.EnumProperty(
        name="Режим",
        items=(
            ("RAISE", "Поднять", "Поднять клетку на шаг уровня"),
            ("LOWER", "Опустить", "Опустить клетку на шаг уровня"),
            ("SET", "Задать", "Выставить клетке целевой уровень"),
        ),
        default="RAISE",
    )

    def apply_to_cell(self, context, mesh, index, weight):
        settings = context.scene.fluxus
        current = int(round(cell_height(mesh, index) / LEVEL_UNIT))
        if self.mode == "SET":
            target = settings.brush_level_target
        elif self.mode == "RAISE":
            target = current + settings.brush_level_step
        else:
            target = current - settings.brush_level_step
        if target < 0:
            target = 0
        if self.max_level is not None and target > self.max_level:
            target = self.max_level
        if target == current:
            return False
        # Высота — ЦЕЛЫЙ уровень, умноженный на единицу уровня: дробной она
        # после кисти не бывает по построению (BLND-9).
        set_cell_height(mesh, index, float(target) * LEVEL_UNIT)
        return True


class FLUXUS_OT_terrain_flag_brush(GridBrushBase, bpy.types.Operator):
    """Кисть флагов клетки: рампа и снятый пол (TERR-3, BLND-9)"""

    bl_idname = "fluxus.terrain_flag_brush"
    bl_label = "Кисть флагов террейна"
    bl_options = {"REGISTER", "UNDO"}

    grid_key = TERRAIN_KEY

    action: bpy.props.EnumProperty(
        name="Действие",
        items=(
            ("SET", "Поставить", "Поставить флаг клетке"),
            ("CLEAR", "Снять", "Снять флаг с клетки"),
        ),
        default="SET",
    )

    def apply_to_cell(self, context, mesh, index, weight):
        settings = context.scene.fluxus
        name = RAMP_ATTRIBUTE if settings.brush_flag == "RAMP" else NOFLOOR_ATTRIBUTE
        if ensure_int_attribute(mesh, name) is None:
            self.report({"ERROR"}, "атрибут %s занят другим доменом" % name)
            return False
        target = 1 if self.action == "SET" else 0
        if cell_attribute(mesh, name, index) == target:
            return False
        set_cell_attribute(mesh, name, index, target)
        return True


class FLUXUS_OT_curvature_brush(GridBrushBase, bpy.types.Operator):
    """Кисть кривизны: визуальное смещение узлов сетки (BLND-10)"""

    bl_idname = "fluxus.curvature_brush"
    bl_label = "Кисть кривизны"
    bl_options = {"REGISTER", "UNDO"}

    grid_key = CURVATURE_KEY

    direction: bpy.props.EnumProperty(
        name="Направление",
        items=(
            ("UP", "Вверх", "Выпуклость"),
            ("DOWN", "Вниз", "Вогнутость"),
        ),
        default="UP",
    )

    def _paint(self, context, event):
        """
        Мазок по узлам: вершины у сетки кривизны общие (build_node_grid_mesh),
        и единица мазка — вершина-узел, а не клетка; каждый узел за мазок
        двигается один раз, сколько бы клеток радиуса его ни разделяло.
        """
        index = self._cell_under_mouse(context, event)
        if index is None:
            return
        mesh = self.grid.data
        settings = context.scene.fluxus
        changed = False
        for cell, weight in self._cells_in_radius(index):
            step = settings.brush_curvature_step * LEVEL_UNIT
            if settings.brush_curvature_falloff:
                step *= weight
            if self.direction == "DOWN":
                step = -step
            for vertex in mesh.polygons[cell].vertices:
                if vertex in self.painted:
                    continue
                self.painted.add(vertex)
                mesh.vertices[vertex].co.z += step
                changed = True
        if changed:
            mesh.update()


def _draw_level_settings(context, layout, tool):
    settings = context.scene.fluxus
    layout.prop(settings, "brush_radius")
    layout.prop(settings, "brush_level_step")
    layout.prop(settings, "brush_level_target")


def _draw_flag_settings(context, layout, tool):
    settings = context.scene.fluxus
    layout.prop(settings, "brush_radius")
    layout.prop(settings, "brush_flag", expand=True)


def _draw_curvature_settings(context, layout, tool):
    settings = context.scene.fluxus
    layout.prop(settings, "brush_radius")
    layout.prop(settings, "brush_curvature_step")
    layout.prop(settings, "brush_curvature_falloff")


class FLUXUS_TOOL_terrain_level(bpy.types.WorkSpaceTool):
    # Иконка инструмента (`bl_icon`) намеренно не задана: годится только
    # идентификатор из набора иконок Blender, а проверить его в среде без
    # Blender нельзя — неверный идентификатор даёт ошибку регистрации.
    bl_space_type = "VIEW_3D"
    bl_context_mode = "OBJECT"
    bl_idname = "fluxus.terrain_level_tool"
    bl_label = "Fluxus: уровень"
    bl_description = "ЛКМ — поднять клетку, Ctrl — опустить, Shift — задать целевой уровень"
    bl_widget = None
    bl_keymap = (
        (
            "fluxus.terrain_level_brush",
            {"type": "LEFTMOUSE", "value": "PRESS"},
            {"properties": [("mode", "RAISE")]},
        ),
        (
            "fluxus.terrain_level_brush",
            {"type": "LEFTMOUSE", "value": "PRESS", "ctrl": True},
            {"properties": [("mode", "LOWER")]},
        ),
        (
            "fluxus.terrain_level_brush",
            {"type": "LEFTMOUSE", "value": "PRESS", "shift": True},
            {"properties": [("mode", "SET")]},
        ),
    )
    draw_settings = _draw_level_settings


class FLUXUS_TOOL_terrain_flags(bpy.types.WorkSpaceTool):
    bl_space_type = "VIEW_3D"
    bl_context_mode = "OBJECT"
    bl_idname = "fluxus.terrain_flags_tool"
    bl_label = "Fluxus: рампа и пол"
    bl_description = "ЛКМ — поставить выбранный флаг клетке, Ctrl — снять"
    bl_widget = None
    bl_keymap = (
        (
            "fluxus.terrain_flag_brush",
            {"type": "LEFTMOUSE", "value": "PRESS"},
            {"properties": [("action", "SET")]},
        ),
        (
            "fluxus.terrain_flag_brush",
            {"type": "LEFTMOUSE", "value": "PRESS", "ctrl": True},
            {"properties": [("action", "CLEAR")]},
        ),
    )
    draw_settings = _draw_flag_settings


class FLUXUS_TOOL_curvature(bpy.types.WorkSpaceTool):
    bl_space_type = "VIEW_3D"
    bl_context_mode = "OBJECT"
    bl_idname = "fluxus.curvature_tool"
    bl_label = "Fluxus: кривизна"
    bl_description = "ЛКМ — выпуклость, Ctrl — вогнутость (превью; квантует импорт)"
    bl_widget = None
    bl_keymap = (
        (
            "fluxus.curvature_brush",
            {"type": "LEFTMOUSE", "value": "PRESS"},
            {"properties": [("direction", "UP")]},
        ),
        (
            "fluxus.curvature_brush",
            {"type": "LEFTMOUSE", "value": "PRESS", "ctrl": True},
            {"properties": [("direction", "DOWN")]},
        ),
    )
    draw_settings = _draw_curvature_settings


OPERATORS = (
    FLUXUS_OT_terrain_level_brush,
    FLUXUS_OT_terrain_flag_brush,
    FLUXUS_OT_curvature_brush,
)

TOOLS = (
    FLUXUS_TOOL_terrain_level,
    FLUXUS_TOOL_terrain_flags,
    FLUXUS_TOOL_curvature,
)


def register():
    for cls in OPERATORS:
        bpy.utils.register_class(cls)
    previous = None
    for tool in TOOLS:
        try:
            bpy.utils.register_tool(
                tool,
                after={previous.bl_idname} if previous is not None else {"builtin.transform"},
                separator=previous is None,
                group=False,
            )
        except Exception as error:  # noqa: BLE001 — место в панели инструментов не критично
            print("[fluxus] инструмент %s не встал на место: %s" % (tool.bl_idname, error))
            bpy.utils.register_tool(tool)
        previous = tool


def unregister():
    for tool in reversed(TOOLS):
        try:
            bpy.utils.unregister_tool(tool)
        except Exception as error:  # noqa: BLE001
            print("[fluxus] инструмент %s не снят: %s" % (tool.bl_idname, error))
    for cls in reversed(OPERATORS):
        bpy.utils.unregister_class(cls)
