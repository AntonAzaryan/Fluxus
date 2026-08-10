"""
Fluxus: аддон level-дизайна для Blender (capability `blender-pipeline`, BLND-8).

Аддон — ОСНОВНАЯ ПОВЕРХНОСТЬ авторинга, но не закон: правилами владеет импорт
(BLND-6), перечни приходят из опубликованных схем и документов движка (SER-5,
ED-30, BLND-8), а ручной экспорт штатным glTF-экспортёром плюс `npm run import`
остаются работающим путём всегда — без аддона деградирует эргономика, но не
конвейер.

Состав пакета:

- `sources.py` — чтение опубликованных данных проекта (схемы, конфиг сцены,
  манифест визуалов) относительно расположения `.blend`;
- `props.py` — типизированный вид над сырыми custom properties объекта;
- `grids.py` — grid-меши террейна и кривизны и их клеточные данные;
- `preview.py` — превью ступеней, клифов и сглаженного рельефа на Geometry Nodes;
- `placement.py` — операторы размещений, переопределений и камеры превью;
- `brushes.py` — кисти-инструменты (`WorkSpaceTool` + модальные операторы);
- `livecheck.py` — живая проверка экспорта вызовом `import --dry-run`;
- `exporter.py` — авто-экспорт `.glb` по сохранению `.blend`;
- `ui.py` — N-панель.

Версия Blender пиннится `tools/blender-ts/CONVENTIONS.md`: **4.5 LTS**. Другая
версия не запрещена, но паритета не обещает — экспортёр между версиями меняет
представление трансформов, `extras` и буферов.

Модули импорт-безопасны: на верхнем уровне только определения классов и
констант, состояние Blender трогает исключительно `register()`.
"""

bl_info = {
    "name": "Fluxus Level Design",
    "description": "Level-дизайн сцен Fluxus: размещения, террейн, кривизна и экспорт glTF",
    "author": "Fluxus",
    "version": (0, 1, 0),
    # Пин LTS-версии (CONVENTIONS.md). Меньшие версии не поддерживаются:
    # интерфейс групп Geometry Nodes здесь — API 4.0+.
    "blender": (4, 5, 0),
    "location": "View3D > N-панель > Fluxus; панель инструментов (T) — кисти",
    "category": "Import-Export",
    "doc_url": "https://github.com/fluxus/blob/main/tools/blender-addon/README.md",
    "tracker_url": "",
}

if "sources" in locals():  # noqa: F821 — перезагрузка скриптов Blender'ом
    import importlib

    sources = importlib.reload(sources)  # noqa: F821
    props = importlib.reload(props)  # noqa: F821
    grids = importlib.reload(grids)  # noqa: F821
    preview = importlib.reload(preview)  # noqa: F821
    placement = importlib.reload(placement)  # noqa: F821
    brushes = importlib.reload(brushes)  # noqa: F821
    livecheck = importlib.reload(livecheck)  # noqa: F821
    exporter = importlib.reload(exporter)  # noqa: F821
    ui = importlib.reload(ui)  # noqa: F821
else:
    from . import brushes, exporter, grids, livecheck, placement, preview, props, sources, ui

# Порядок важен: свойства регистрируются первыми (на них ссылаются панели и
# операторы), интерфейс — последним. `livecheck` идёт до экспортёра: его
# проверку экспортёр назначает после успешного экспорта.
_MODULES = (props, grids, preview, placement, brushes, livecheck, exporter, ui)


def register():
    for module in _MODULES:
        module.register()


def unregister():
    for module in reversed(_MODULES):
        try:
            module.unregister()
        except Exception as error:  # noqa: BLE001 — снятие не должно останавливаться на первой ошибке
            print("[fluxus] модуль %s не снят: %s" % (module.__name__, error))
