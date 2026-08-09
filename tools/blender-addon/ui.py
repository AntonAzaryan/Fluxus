"""
N-панель авторинга (BLND-8): типизированный вид над сырыми свойствами.

Панель ничего не вычисляет и на диск не ходит — рисование использует только
снимок `sources`, собранный оператором обновления, обработчиком открытия файла
и таймером запуска. Подсказки о неизвестных именах — именно подсказки по
опубликованным перечням движка: правило одно, и живёт оно в импортёре
(BLND-6, BLND-8). Живая проверка dry-run'ом импортёра — задача 8.5, её место
здесь же, отдельной строкой находок.
"""

import bpy

from . import exporter, props, sources
from .grids import CURVATURE_KEY, NOFLOOR_ATTRIBUTE, RAMP_ATTRIBUTE, TERRAIN_KEY

CATEGORY = "Fluxus"


class FluxusPanel:
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = CATEGORY


class FLUXUS_PT_sources(FluxusPanel, bpy.types.Panel):
    bl_idname = "FLUXUS_PT_sources"
    bl_label = "Проект"

    def draw(self, context):
        layout = self.layout
        snapshot = sources.get()
        lists = context.window_manager.fluxus_lists

        layout.operator("fluxus.refresh_sources", icon="FILE_REFRESH")

        column = layout.column(align=True)
        if not bpy.data.filepath:
            column.label(text="файл не сохранён", icon="ERROR")
            column.label(text="сохраните `.blend` рядом с `<имя>.scene.json`")
        else:
            column.label(text="источник: %s" % bpy.path.basename(bpy.data.filepath), icon="BLENDER")
            export = sources.export_path(bpy.data.filepath)
            if export is not None:
                column.label(text="экспорт: %s" % bpy.path.basename(export), icon="EXPORT")

        box = layout.box()
        box.label(text="Перечни движка", icon="PRESET")
        if snapshot.scene_path is None:
            box.label(text="конфиг сцены не найден", icon="ERROR")
        else:
            box.label(text="prefab'ов: %d" % len(snapshot.prefabs))
            box.label(text="компонентов: %d" % len(snapshot.components))
        if snapshot.manifest_path is None:
            box.label(text="манифест визуалов не найден", icon="ERROR")
        else:
            box.label(text="ключей видов: %d" % len(snapshot.visuals))
        if snapshot.terrain is not None:
            box.label(
                text="сетка террейна: %d×%d по %.3f"
                % (snapshot.terrain.width, snapshot.terrain.height, snapshot.terrain.cell_size)
            )
        if snapshot.level_alphabet:
            box.label(text="уровни: 0…%d (алфавит схемы)" % (snapshot.max_level or 0))

        if lists.status:
            for line in lists.status.split("; "):
                layout.label(text=line, icon="INFO")

        layout.separator()
        layout.operator("fluxus.sync_preview_camera", icon="CAMERA_DATA")
        layout.label(text="числа камеры — из манифеста (CAM-1, ASSET-10)", icon="INFO")


class FLUXUS_PT_object(FluxusPanel, bpy.types.Panel):
    bl_idname = "FLUXUS_PT_object"
    bl_label = "Размещение"

    def draw(self, context):
        layout = self.layout
        snapshot = sources.get()
        lists = context.window_manager.fluxus_lists

        row = layout.row(align=True)
        row.operator("fluxus.add_placement", icon="OUTLINER_OB_EMPTY")
        row.operator("fluxus.add_decoration", icon="OUTLINER_OB_MESH")

        obj = context.object
        if obj is None:
            layout.label(text="объект не выбран", icon="INFO")
            return

        settings = obj.fluxus
        layout.prop(settings, "semantic")
        kind = settings.semantic

        if kind == "PREFAB":
            layout.prop_search(settings, "prefab", lists, "prefabs", text="Prefab")
            if settings.prefab == "":
                layout.label(text="prefab не задан — импорт откажет (SER-8)", icon="ERROR")
            elif snapshot.prefabs and settings.prefab not in snapshot.prefabs:
                layout.label(text="нет в конфиге сцены — проверит импорт", icon="ERROR")
            self._draw_overrides(layout, obj, snapshot)
        elif kind == "VISUAL":
            layout.prop_search(settings, "visual", lists, "visuals", text="Visual")
            if settings.visual == "":
                layout.label(text="ключ вида не задан (PRES-2)", icon="ERROR")
            elif snapshot.visuals and settings.visual not in snapshot.visuals:
                layout.label(text="нет в манифесте — импорт предупредит", icon="INFO")
            layout.prop_search(settings, "skin", lists, "skins", text="Skin")
            layout.label(text="позиция, yaw и scale — из трансформа", icon="INFO")
        elif kind in {"TERRAIN", "CURVATURE"}:
            layout.label(text="клеточные данные правятся кистями", icon="BRUSH_DATA")
            layout.label(text="применяйте трансформ перед экспортом", icon="INFO")
        else:
            layout.label(text="вспомогательный объект: импорт его игнорирует", icon="INFO")

    def _draw_overrides(self, layout, obj, snapshot):
        box = layout.box()
        header = box.row(align=True)
        header.label(text="Переопределения полей", icon="PROPERTIES")
        header.operator("fluxus.override_add", text="", icon="ADD")
        keys = props.override_keys(obj)
        if not keys:
            box.label(text="нет: позиция и курс приезжают из трансформа", icon="INFO")
            return
        for key in keys:
            component, field = props.split_override(key)
            kind = snapshot.components.get(component, {}).get(field)
            row = box.row(align=True)
            # Значение правится ПРЯМО в сыром свойстве: панель — вид над ним,
            # а не его копия (BLND-8).
            row.prop(obj, '["%s"]' % key, text=key)
            row.label(text=kind or "?")
            row.operator("fluxus.override_remove", text="", icon="X").key = key


class FLUXUS_PT_terrain(FluxusPanel, bpy.types.Panel):
    bl_idname = "FLUXUS_PT_terrain"
    bl_label = "Террейн и кривизна"

    def draw(self, context):
        layout = self.layout
        settings = context.scene.fluxus
        scene = context.scene

        column = layout.column(align=True)
        column.operator("fluxus.create_terrain_grid", icon="MESH_GRID")
        column.operator("fluxus.create_curvature_grid", icon="MOD_SMOOTH")

        layout.prop(settings, "terrain_object")
        layout.prop(settings, "curvature_object")

        found_terrain = any(TERRAIN_KEY in obj.keys() for obj in scene.objects)
        found_curvature = any(CURVATURE_KEY in obj.keys() for obj in scene.objects)
        if not found_terrain:
            layout.label(text="объекта со свойством `terrain` в сцене нет", icon="INFO")
        if not found_curvature:
            layout.label(text="объекта со свойством `curvature` в сцене нет", icon="INFO")

        box = layout.box()
        box.label(text="Кисти — на панели инструментов (T)", icon="BRUSH_DATA")
        box.prop(settings, "brush_radius")
        box.prop(settings, "brush_level_step")
        box.prop(settings, "brush_level_target")
        box.prop(settings, "brush_flag", expand=True)
        box.prop(settings, "brush_curvature_step")
        box.prop(settings, "brush_curvature_falloff")
        box.label(text="атрибуты клеток: %s, %s" % (RAMP_ATTRIBUTE, NOFLOOR_ATTRIBUTE), icon="INFO")

        box = layout.box()
        box.label(text="Превью (приближение, правда — кадр движка)", icon="SHADING_RENDERED")
        row = box.row(align=True)
        row.operator("fluxus.setup_preview", text="Террейн").target = "TERRAIN"
        row.operator("fluxus.setup_preview", text="Кривизна").target = "CURVATURE"
        box.prop(settings, "preview_height_step")
        box.prop(settings, "preview_skirt")
        box.prop(settings, "preview_smooth")
        box.prop(settings, "preview_smooth_iterations")
        box.prop(settings, "preview_markers")
        box.operator("fluxus.sync_preview", icon="FILE_REFRESH")


class FLUXUS_PT_export(FluxusPanel, bpy.types.Panel):
    bl_idname = "FLUXUS_PT_export"
    bl_label = "Экспорт"

    def draw(self, context):
        layout = self.layout
        settings = context.scene.fluxus
        layout.prop(settings, "auto_export")
        layout.operator("fluxus.export_now", icon="EXPORT")
        target = sources.export_path(bpy.data.filepath)
        if target is None:
            layout.label(text="файл не сохранён", icon="ERROR")
        else:
            layout.label(text=bpy.path.basename(target), icon="FILE")
        report = exporter.last_report()
        if report:
            layout.label(text=report, icon="INFO")
        layout.label(text="«+Y Up», custom properties, только текущая сцена", icon="INFO")


CLASSES = (
    FLUXUS_PT_sources,
    FLUXUS_PT_object,
    FLUXUS_PT_terrain,
    FLUXUS_PT_export,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
