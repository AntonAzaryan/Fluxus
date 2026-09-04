"""
N-панель авторинга (BLND-8): типизированный вид над сырыми свойствами.

Панель ничего не вычисляет и на диск не ходит — рисование использует только
снимок `sources`, собранный оператором обновления, обработчиком открытия файла
и таймером запуска. Подсказки о неизвестных именах — именно подсказки по
опубликованным перечням движка: правило одно, и живёт оно в импортёре
(BLND-6, BLND-8). Находки живой проверки панель тоже только показывает: зовёт
импортёр подпроцессом и публикует отчёт модуль `livecheck`.
"""

import bpy

from . import exporter, livecheck, props, sources
from .grids import CURVATURE_KEY, NOFLOOR_ATTRIBUTE, PAINT_ATTRIBUTE, RAMP_ATTRIBUTE, TERRAIN_KEY

#: Семантика скалпт-поверхности (BLND-13) — сырое свойство, как у grid-объектов.
SCULPT_KEY = "sculpt"

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
        layout.operator("fluxus.snap_to_relief", icon="SNAP_ON")

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
            # Только чекбокс свойства: превью walkable-посадки аддон не ведёт —
            # правда — кадр движка через watch (BLND-12), правил у аддона нет (BLND-8).
            layout.prop(settings, "walkable")
            layout.label(text="позиция, yaw и scale — из трансформа", icon="INFO")
        elif kind in {"TERRAIN", "CURVATURE"}:
            layout.label(text="клеточные данные правятся кистями", icon="BRUSH_DATA")
            layout.label(text="применяйте трансформ перед экспортом", icon="INFO")
            if any(SCULPT_KEY in other.keys() for other in context.scene.objects):
                # Правда — находки импорта (BLND-6); панель лишь предупреждает
                # заранее о взаимоисключении BLND-13.
                layout.label(text="в сцене есть sculpt-объект: grid-сетка", icon="ERROR")
                layout.label(text="вместе с ним — ошибка импорта (BLND-13)")
        elif kind == "SCULPT":
            layout.label(text="скалпт-поверхность: рельеф дискретизирует", icon="SCULPTMODE_HLT")
            layout.label(text="импорт — уровни, рампы, пол, кривизна (BLND-13)")
            layout.prop(settings, "cliff_jump")
            raw = obj.get(props.CLIFF_JUMP_KEY)
            if raw is not None and (
                isinstance(raw, bool) or not isinstance(raw, (int, float)) or raw <= 0
            ):
                # Вид FloatProperty такое значение показать не может и подставил
                # бы умолчание — а импорт откажет; молчать о расхождении нельзя.
                layout.label(text="cliffJump: %r — не положительное число," % (raw,), icon="ERROR")
                layout.label(text="импорт откажет (BLND-13)")
            layout.label(text="объектов сколько угодно: рельеф — их объединение", icon="INFO")
            layout.label(text="дыра в меше — клетка без пола", icon="INFO")
            # Раскраска скалпта — заливка ОБЪЕКТА: клеток у него нет, а вершины
            # грани пересечения обязаны нести одно значение (BLND-14).
            box = layout.box()
            box.label(text="Раскраска: слот на объект целиком", icon="BRUSH_DATA")
            # Слот кисти — настройка СЦЕНЫ (общая с клеточной кистью), а не
            # свойство объекта: `settings` выше — настройки объекта.
            box.prop(context.scene.fluxus, "brush_paint_slot")
            row = box.row(align=True)
            row.operator("fluxus.sculpt_paint_fill", text="Красить").action = "SET"
            row.operator("fluxus.sculpt_paint_fill", text="Взять").action = "PICK"
            box.label(text="несколько покрытий — несколько объектов", icon="INFO")
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
        if any(SCULPT_KEY in obj.keys() for obj in scene.objects):
            layout.label(text="в сцене sculpt-объект: рельеф ведёт он, grid-", icon="ERROR")
            layout.label(text="сетки вместе с ним — ошибка импорта (BLND-13)")
            # Раскраска у скалпта своя: клеточных кистей у него нет, слот
            # заливается объекту целиком (BLND-14).
            row = layout.row(align=True)
            row.operator("fluxus.sculpt_paint_fill", text="Красить sculpt").action = "SET"
            row.operator("fluxus.sculpt_paint_fill", text="Взять слот").action = "PICK"

        box = layout.box()
        box.label(text="Кисти — на панели инструментов (T)", icon="BRUSH_DATA")
        box.prop(settings, "brush_radius")
        box.prop(settings, "brush_level_step")
        box.prop(settings, "brush_level_target")
        box.prop(settings, "brush_flag", expand=True)
        box.prop(settings, "brush_paint_slot")
        box.prop(settings, "brush_curvature_step")
        box.prop(settings, "brush_curvature_falloff")
        box.label(
            text="атрибуты клеток: %s, %s, %s" % (RAMP_ATTRIBUTE, NOFLOOR_ATTRIBUTE, PAINT_ATTRIBUTE),
            icon="INFO",
        )

        box = layout.box()
        box.label(text="Превью (приближение, правда — кадр движка)", icon="SHADING_RENDERED")
        row = box.row(align=True)
        row.operator("fluxus.setup_preview", text="Террейн").target = "TERRAIN"
        row.operator("fluxus.setup_preview", text="Кривизна").target = "CURVATURE"
        # Раскраска показывается МАТЕРИАЛОМ, а не геометрией: она про цвет
        # поверхности, и нодами модификатора её не увидеть (BLND-14).
        box.operator("fluxus.paint_preview", text="Раскраска")
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


class FLUXUS_PT_check(FluxusPanel, bpy.types.Panel):
    """
    Живая проверка (задача 8.5, BLND-8): показ находок импортёра.

    Панель ничего не проверяет сама — она рисует отчёт, опубликованный модулем
    `livecheck` (правило одно, и живёт оно в импортёре, BLND-6). IO здесь нет:
    ни запуска подпроцесса, ни чтения файлов — только опубликованное состояние
    и вопросы к уже открытым данным.
    """

    bl_idname = "FLUXUS_PT_check"
    bl_label = "Проверка"

    def draw(self, context):
        layout = self.layout
        layout.operator("fluxus.check_now", icon="CHECKMARK")
        layout.label(text="правила называет импортёр, не аддон (BLND-6)", icon="INFO")

        if livecheck.is_running():
            layout.label(text="проверка идёт…", icon="TIME")

        report = livecheck.report()
        if not report.checked:
            layout.label(text="в этой сессии не проверялось", icon="INFO")
            return

        column = layout.column(align=True)
        if report.source:
            column.label(text="файл: %s" % bpy.path.basename(report.source), icon="FILE")
        column.label(text="проверено: %s" % report.time_text(), icon="TIME")
        if not livecheck.checked_source_matches(bpy.data.filepath):
            column.label(text="отчёт о другом файле — проверьте заново", icon="ERROR")
        elif bpy.data.is_dirty:
            # Проверяется последний ЭКСПОРТ, а он пишется по сохранению:
            # несохранённые правки в отчёт не попали, и молчать об этом нельзя.
            column.label(text="есть несохранённые правки — отчёт о", icon="ERROR")
            column.label(text="последнем сохранении")

        if report.status == "failed":
            box = layout.box()
            box.label(text="проверка не выполнена", icon="CANCEL")
            for line in livecheck.wrapped(report.problem or ""):
                box.label(text=line)
            self._draw_output(layout, report)
            return

        box = layout.box()
        if report.errors or report.warnings:
            box.label(
                text="ошибок: %d, предупреждений: %d" % (report.errors, report.warnings),
                icon="CANCEL" if report.errors else "ERROR",
            )
        else:
            box.label(text="находок нет", icon="CHECKMARK")
        box.label(text="слой: initial %d, decorations %d" % (report.initial, report.decorations))
        # Клеточные слои называются отдельно: ассет, которого источник не даёт,
        # импорт не переписывает вовсе (BLND-2), и «переписывается» обязано быть
        # видно до записи, а не после диффа.
        if report.maps:
            box.label(text="ассеты: %s" % ", ".join(report.maps), icon="MESH_GRID")
        for line in report.changes:
            box.label(text=line, icon="FILE_REFRESH")
        if report.status == "done" and not report.changes and report.ok:
            box.label(text="документы совпадают с источником", icon="INFO")

        self._draw_findings(layout, report)

        if report.refusal:
            box = layout.box()
            box.label(text="импорт отказал", icon="CANCEL")
            for line in livecheck.wrapped(report.refusal):
                box.label(text=line)
        if report.blocking:
            box = layout.box()
            box.label(text="запись отвергнута валидацией (ED-21)", icon="CANCEL")
            for address in report.blocking[: livecheck.PANEL_FINDINGS]:
                for line in livecheck.wrapped(address):
                    box.label(text=line)
            # Текст находки валидации складывает команда, и лежит он в её
            # выводе: в JSON у неё ключ ресурса, а не фраза (ED-27, ED-28).
            self._draw_output(layout, report)

    def _draw_findings(self, layout, report):
        if not report.findings:
            return
        box = layout.box()
        box.label(text="Находки", icon="TEXT")
        for finding in report.findings[: livecheck.PANEL_FINDINGS]:
            # Красный крест — ошибка (импорт откажет), треугольник —
            # предупреждение (импорт пройдёт).
            icon = "CANCEL" if finding.is_error else "ERROR"
            row = box.row(align=True)
            if finding.object_name:
                # Имя объекта — кнопка: клик уводит выделение к нему (BLND-6:
                # адрес находки — имя объекта Blender, и оно должно работать).
                row.operator(
                    "fluxus.select_object", text=finding.object_name, icon=icon
                ).object_name = finding.object_name
            else:
                row.label(text="(находка не об объекте)", icon=icon)
            for line in livecheck.wrapped(finding.message):
                # Отступ пробелами: `label` не переносит и не отступает сам, а
                # пустая иконка-заполнитель — версионно чувствительный идентификатор.
                box.label(text="    " + line)
        hidden = len(report.findings) - livecheck.PANEL_FINDINGS
        if hidden > 0:
            box.label(text="и ещё %d — полный перечень даёт команда импорта" % hidden, icon="INFO")

    def _draw_output(self, layout, report):
        if not report.output:
            return
        box = layout.box()
        box.label(text="Вывод команды (хвост)", icon="CONSOLE")
        for line in report.output:
            for piece in livecheck.wrapped(line):
                box.label(text=piece)


CLASSES = (
    FLUXUS_PT_sources,
    FLUXUS_PT_object,
    FLUXUS_PT_terrain,
    FLUXUS_PT_export,
    FLUXUS_PT_check,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
