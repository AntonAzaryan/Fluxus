"""
Авто-экспорт `.glb` по сохранению `.blend` (задача 8.6, BLND-12).

Экспортирует ШТАТНЫЙ glTF-экспортёр Blender (design, решение 1): своего
сериализатора у конвейера нет и быть не должно — он стал бы второй реализацией
правил формата.

Пиннит `tools/blender-ts/CONVENTIONS.md` две настройки, и обе здесь
обязательные:

- `export_yup=True` — «+Y Up»: вертикаль мира — ось `+Y` glTF, конверсию осей
  делает экспортёр, а не импортёр;
- `export_extras=True` — custom properties объектов уезжают в `extras` узлов;
  без них экспорт пуст по смыслу (BLND-3).

Остальное — выбор аддона в пределах, которые конвенции оставляют открытыми
(«Apply Modifiers — по вкусу»), а не норма конвейера:

- `use_active_scene=True` — экспортируется текущая сцена, и только она;
- `export_apply=False` — модификаторы НЕ применяются, и это выбор со смыслом:
  превью ступеней и клифов на Geometry Nodes в импорт не входит, клифы движок
  строит сам (TERR-5). Трансформов ОБЪЕКТОВ настройка не касается вовсе —
  экспортёр всегда пишет их узлами, — поэтому требование конвенций «применить
  трансформы до экспорта» она не подменяет и не отменяет: это ручной шаг автора
  для вспомогательной геометрии и grid-мешей;
- `export_attributes=True` — клеточные атрибуты рампы, пола и раскраски уезжают
  каналами `_RAMP`, `_NOFLOOR` и `_PAINT` (`CONVENTIONS.md`, «Terrain-объект»).
  Без неё экспортёр пропускает пользовательские атрибуты, и импорт прочитал бы
  сетку без единой рампы (BLND-9) и без раскраски (BLND-14); отсутствие
  настройки в версии Blender — предупреждение, а не отказ, потому что сцена без
  рамп, провалов и раскраски ими не пользуется.

Имя выхода детерминировано: `<база>.glb` рядом с `.blend`, парность со сценой
даёт имя (BLND-2).

Ключи оператора экспорта между версиями Blender меняются, а проверить их в
среде без Blender нельзя, поэтому набор фильтруется по RNA самого оператора:
неизвестный ключ отбрасывается с сообщением, а отсутствие КЛЮЧЕВОЙ настройки
(`export_extras`, `export_yup`) — отказ экспорта, а не тихий экспорт не в том
формате. Тихо отдать импортёру файл без `extras` хуже, чем не отдать ничего.

После успешного экспорта — и по сохранению, и по кнопке — назначается живая
проверка (`livecheck`, задача 8.5): назначение дешёвое, запуск отложен
дебаунсом, сохранение `.blend` подпроцесса не ждёт.

Обработчик `save_post` регистрируется с `@persistent` и защитой от повторной
регистрации (отчёт `docs/reviews/2026-08-09-blender-level-editor.md`, §5):
после «Reload Scripts» в списке остаётся старая функция, поэтому снимаем по
имени, а не по тождеству объекта.
"""

import os

import bpy
from bpy.app.handlers import persistent

from . import livecheck, props, sources

#: Настройки, без которых экспорт бессмыслен: их отсутствие в RNA — отказ.
REQUIRED_SETTINGS = {
    "export_extras": True,
    "export_yup": True,
}

#: Настройки, уточняющие выход. Отсутствие — предупреждение, не отказ.
OPTIONAL_SETTINGS = {
    "export_format": "GLB",
    "use_active_scene": True,
    "use_selection": False,
    "use_visible": False,
    "use_renderable": False,
    "export_apply": False,
    "export_attributes": True,
    "export_cameras": False,
    "export_lights": False,
    "export_animations": False,
}


def _operator_properties():
    """Имена свойств оператора экспорта в этой версии Blender."""
    export = getattr(bpy.ops.export_scene, "gltf", None)
    if export is None:
        return None
    try:
        return set(export.get_rna_type().properties.keys())
    except (AttributeError, RuntimeError):
        return None


def build_settings():
    """Настройки экспорта и сообщения о том, что версия Blender не приняла."""
    known = _operator_properties()
    messages = []
    if known is None:
        return None, ["glTF-экспортёр недоступен: включите аддон «Import-Export: glTF 2.0»"]
    settings = {}
    for key, value in REQUIRED_SETTINGS.items():
        if key not in known:
            return None, [
                "экспортёр не знает настройки %r — экспорт остановлен: файл без неё импорту не годится (BLND-3)"
                % key
            ]
        settings[key] = value
    for key, value in OPTIONAL_SETTINGS.items():
        if key in known:
            settings[key] = value
        else:
            messages.append("настройка %r в этой версии Blender отсутствует" % key)
    return settings, messages


def export_scene(context, filepath):
    """Экспорт текущей сцены в `.glb`. Возвращает `(успех, сообщения)`."""
    settings, messages = build_settings()
    if settings is None:
        return False, messages
    try:
        bpy.ops.export_scene.gltf(filepath=filepath, **settings)
    except (RuntimeError, TypeError) as error:
        return False, messages + ["экспорт не выполнен: %s" % error]
    return True, messages


def _target_path():
    return sources.export_path(bpy.data.filepath)


#: Результат последнего экспорта. Состояние МОДУЛЯ, а не свойство сцены:
#: обработчик `save_post` отрабатывает уже ПОСЛЕ записи файла, и правка любого
#: свойства ID-данных (сцены) пометила бы только что сохранённый `.blend`
#: изменённым — автор видел бы звёздочку несохранённых правок сразу после
#: каждого сохранения и получал бы вопрос «сохранить?» на выходе. Показать
#: строку в панели это не мешает: панель читает её отсюда, как читает и снимок
#: перечней (`sources.get`), и в `.blend` она не попадает.
_LAST_REPORT = ""


def last_report():
    """Строка результата последнего экспорта; пусто — экспорта в этой сессии не было."""
    return _LAST_REPORT


def _report(text):
    global _LAST_REPORT
    _LAST_REPORT = text
    print("[fluxus] %s" % text)


class FLUXUS_OT_export_now(bpy.types.Operator):
    """Экспортировать `<база>.glb` рядом с `.blend` прямо сейчас"""

    bl_idname = "fluxus.export_now"
    bl_label = "Экспортировать .glb"
    bl_options = {"REGISTER"}

    def execute(self, context):
        target = _target_path()
        if target is None:
            self.report({"ERROR"}, "файл не сохранён: сохраните `.blend` рядом со сценой (BLND-2)")
            return {"CANCELLED"}
        ok, messages = export_scene(context, target)
        for message in messages:
            self.report({"WARNING"}, message)
        if not ok:
            _report("экспорт не выполнен")
            return {"CANCELLED"}
        _report("экспортировано: %s" % target)
        livecheck.schedule(bpy.data.filepath)
        self.report({"INFO"}, "экспортировано: %s" % os.path.basename(target))
        return {"FINISHED"}


@persistent
def fluxus_export_on_save(*_args):
    """
    Обработчик `save_post`. Аргументы между версиями Blender различаются
    (путь файла либо пустышка), поэтому принимаем что угодно и не читаем их:
    путь берётся из `bpy.data.filepath` — того самого, куда файл сохранён.
    """
    scene = getattr(bpy.context, "scene", None)
    settings = getattr(scene, "fluxus", None) if scene is not None else None
    if settings is not None and not settings.auto_export:
        return
    target = _target_path()
    if target is None:
        return
    ok, messages = export_scene(bpy.context, target)
    for message in messages:
        print("[fluxus] %s" % message)
    _report(("экспортировано: %s" if ok else "экспорт не выполнен: %s") % target)
    if ok:
        # Живая проверка свежего экспорта (задача 8.5). Только НАЗНАЧЕНИЕ: сам
        # запуск отложен дебаунсом и идёт таймером, поэтому сохранение `.blend`
        # не ждёт ни Node, ни импортёра. Свойств обработчик по-прежнему не
        # пишет — состояние проверки живёт в модуле `livecheck`.
        livecheck.schedule(bpy.data.filepath)


@persistent
def fluxus_refresh_on_load(*_args):
    """После открытия `.blend` перечни движка перечитываются под новый путь."""
    snapshot = sources.refresh(bpy.data.filepath)
    window_manager = getattr(bpy.context, "window_manager", None)
    if window_manager is not None:
        props.fill_lists(window_manager, snapshot)


def _drop_by_name(handlers, function):
    """Снять обработчик по имени: после перезагрузки скриптов объект уже другой."""
    for handler in list(handlers):
        if getattr(handler, "__name__", "") == function.__name__:
            handlers.remove(handler)


def _deferred_refresh():
    """Разовое чтение перечней после запуска: в `register()` контекста ещё нет."""
    snapshot = sources.refresh(bpy.data.filepath)
    window_manager = getattr(bpy.context, "window_manager", None)
    if window_manager is not None:
        props.fill_lists(window_manager, snapshot)
    return None


CLASSES = (FLUXUS_OT_export_now,)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    _drop_by_name(bpy.app.handlers.save_post, fluxus_export_on_save)
    bpy.app.handlers.save_post.append(fluxus_export_on_save)
    _drop_by_name(bpy.app.handlers.load_post, fluxus_refresh_on_load)
    bpy.app.handlers.load_post.append(fluxus_refresh_on_load)
    bpy.app.timers.register(_deferred_refresh, first_interval=0.5)


def unregister():
    try:
        bpy.app.timers.unregister(_deferred_refresh)
    except (ValueError, TypeError):
        pass
    _drop_by_name(bpy.app.handlers.load_post, fluxus_refresh_on_load)
    _drop_by_name(bpy.app.handlers.save_post, fluxus_export_on_save)
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
