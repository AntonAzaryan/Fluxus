"""
Перечни и правила — из движка, а не из Python (BLND-8).

Модуль читает то, что движок и редактор уже опубликовали в дереве проекта:

- `engine/schemas/*.json` — опубликованные схемы (SER-5): алфавит уровней
  террейна (TERR-3), алфавит типов полей компонентов (ECS-3), состав записи
  расстановки (SER-8);
- `<имя>.scene.json` рядом с `.blend` — конфиг сцены (SER-7): имена prefab'ов,
  схемы компонентов и их полей, ассет террейна;
- `content/visuals/manifest.json` — манифест визуалов (ASSET-9): ключи видов
  для decorations (PRES-2), скины (REND-6) и секция конфига камеры (ASSET-10).

Своего перечня допустимых значений здесь нет ни одного: любой список,
зашитый в Python, разошёлся бы с движком при первом же новом prefab'е
(BLND-8, ED-1, CORE-3). Отсутствие файла — пустой список и сообщение в панели,
а не исключение: Blender открыт, автор вправе работать и без дерева проекта
рядом, а законом остаётся импорт (BLND-6).

Машинный каталог редактора (ED-30) на диске НЕ ЛЕЖИТ: он собирается в момент
запроса из реестров вкладов (`editor/core-ts/src/registry/catalog.ts`) и
хранимого снимка не имеет намеренно. Значит, единственный законный путь к нему
из Python — вызов Node, и он приходит вместе с живой проверкой dry-run'ом
импортёра (задача 8.5): тот же мост, одна реализация правил. Этот модуль
отдаёт только то, что уже опубликовано ФАЙЛАМИ.
"""

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# Масштаб Q16.16 (FP-1). Константа ФОРМАТА, а не игровая величина: размер
# клетки террейна опубликован в конфиге сцены целым числом Q16.16, и перевести
# его в единицы Blender без знания масштаба нельзя. Правил игры это не содержит.
FIXED_ONE = 1 << 16

# Пара «источник ↔ сцена» задаётся именем (BLND-2): у `duel.blend` сосед —
# `duel.scene.json`, а экспорт — `duel.glb`.
SCENE_SUFFIX = ".scene.json"
PRESENTATION_SUFFIX = ".presentation.json"

# Корень проекта опознаётся по published-схемам и дереву контента: ссылок из
# `.blend` на проект нет и быть не должно — парность даёт расположение файла.
ROOT_MARKERS = (os.path.join("engine", "schemas"), "content")
SCHEMAS_RELATIVE = os.path.join("engine", "schemas")
CONTENT_DIR_NAME = "content"
MANIFEST_RELATIVE = os.path.join("visuals", "manifest.json")


@dataclass
class TerrainAsset:
    """Ассет террейна сцены (TERR-2, TERR-3) — сетка, которой обязан совпадать grid-mesh."""

    width: int
    height: int
    # Размер клетки в Q16.16 (TERR-2); в единицах Blender — `cell_size`.
    tile_size: int
    levels: List[str] = field(default_factory=list)
    flags: List[str] = field(default_factory=list)

    @property
    def cell_size(self) -> float:
        return self.tile_size / FIXED_ONE


@dataclass
class CurvatureMap:
    """Карта кривизны (ASSET-7): сетка та же, значение клетки — 1/16 шага высоты."""

    width: int
    height: int
    rows: List[str] = field(default_factory=list)
    path: str = ""


@dataclass
class Sources:
    """Снимок опубликованных данных проекта. Пустой — законное состояние."""

    project_root: Optional[str] = None
    scene_path: Optional[str] = None
    manifest_path: Optional[str] = None
    #: Имена prefab'ов конфига сцены (SER-8).
    prefabs: List[str] = field(default_factory=list)
    #: Компонент → {поле → тип}, типы из алфавита схемы компонента (ECS-3).
    components: Dict[str, Dict[str, str]] = field(default_factory=dict)
    #: Ключи манифеста визуалов в одном пространстве (ASSET-9): entities + decorations.
    visuals: List[str] = field(default_factory=list)
    #: Объединение имён скинов всех записей манифеста (REND-6) — подсказка поиска.
    skins: List[str] = field(default_factory=list)
    terrain: Optional[TerrainAsset] = None
    curvature: Optional[CurvatureMap] = None
    #: Алфавит уровней террейна из опубликованной схемы (TERR-3), например `0123456789ABCDEF`.
    level_alphabet: str = ""
    #: Алфавит типов полей компонента из опубликованной схемы (ECS-3): `i32`, `fixed`.
    field_types: List[str] = field(default_factory=list)
    #: Секция конфига камеры манифеста (CAM-1, ASSET-10) — второго набора чисел в аддоне нет.
    camera: Dict[str, float] = field(default_factory=dict)
    #: Сообщения загрузки: чего не нашлось и где искали. Показываются в панели.
    messages: List[str] = field(default_factory=list)

    @property
    def max_level(self) -> Optional[int]:
        """Верхний уровень алфавита; `None` — схема не прочиталась, и границы аддон не выдумывает."""
        return len(self.level_alphabet) - 1 if self.level_alphabet else None

    @property
    def loaded(self) -> bool:
        return self.project_root is not None


# Кэш последнего чтения: панель рисуется десятки раз в секунду и диск не трогает.
_CACHE: Sources = Sources()
_CACHE_KEY: Optional[Tuple[str, ...]] = None


def get() -> Sources:
    """Последний снимок. Чтения с диска не делает — его делает `refresh()`."""
    return _CACHE


def _read_json(path: str, messages: List[str], what: str) -> Optional[Any]:
    """JSON или `None` с сообщением: отсутствие документа — не авария аддона."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        messages.append("%s: нет файла %s" % (what, path))
    except (OSError, ValueError) as error:
        messages.append("%s: не прочитан (%s)" % (what, error))
    return None


def find_project_root(start: str) -> Optional[str]:
    """
    Корень проекта — ближайший предок каталога `.blend`, где лежат и
    опубликованные схемы, и дерево контента. Ссылок из источника на проект нет
    (BLND-2): парность и расположение — единственный способ связи.
    """
    if not start:
        return None
    current = os.path.abspath(start)
    while True:
        if all(os.path.isdir(os.path.join(current, marker)) for marker in ROOT_MARKERS):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def scene_document_path(blend_path: str) -> Optional[str]:
    """`<база>.scene.json` рядом с `.blend` (BLND-2)."""
    if not blend_path:
        return None
    base, _ = os.path.splitext(blend_path)
    return base + SCENE_SUFFIX


def presentation_document_path(blend_path: str) -> Optional[str]:
    """`<база>.presentation.json` рядом со сценой (PRES-1)."""
    if not blend_path:
        return None
    base, _ = os.path.splitext(blend_path)
    return base + PRESENTATION_SUFFIX


def export_path(blend_path: str) -> Optional[str]:
    """Детерминированное имя экспорта: `<база>.glb` рядом с `.blend` (BLND-2)."""
    if not blend_path:
        return None
    base, _ = os.path.splitext(blend_path)
    return base + ".glb"


def content_root(blend_path: str, project_root: Optional[str]) -> Optional[str]:
    """
    Корень дерева контента: ближайший предок `content` пути источника, а если
    источник лежит вне дерева — `content` корня проекта. Идентификатор ассета —
    путь от этого корня (ASSET-2).
    """
    current = os.path.abspath(os.path.dirname(blend_path)) if blend_path else ""
    while current:
        if os.path.basename(current) == CONTENT_DIR_NAME:
            return current
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    if project_root is not None:
        candidate = os.path.join(project_root, CONTENT_DIR_NAME)
        if os.path.isdir(candidate):
            return candidate
    return None


def _char_class(pattern: str) -> str:
    """
    Символы класса регулярного выражения схемы: `^[0-9A-F]+$` → `0123456789ABCDEF`.
    Алфавит уровней принадлежит формату (TERR-3) и приходит из опубликованной
    схемы, а не из перечня в Python (BLND-8).
    """
    start = pattern.find("[")
    end = pattern.find("]", start + 1)
    if start < 0 or end < 0:
        return ""
    body = pattern[start + 1 : end]
    out: List[str] = []
    index = 0
    while index < len(body):
        if index + 2 < len(body) and body[index + 1] == "-":
            for code in range(ord(body[index]), ord(body[index + 2]) + 1):
                out.append(chr(code))
            index += 3
        else:
            out.append(body[index])
            index += 1
    return "".join(out)


def _load_schemas(project_root: str, result: Sources) -> None:
    """Алфавиты формата из опубликованных схем (SER-5)."""
    schemas_dir = os.path.join(project_root, SCHEMAS_RELATIVE)
    scene_schema = _read_json(
        os.path.join(schemas_dir, "scene.schema.json"), result.messages, "схема сцены"
    )
    if isinstance(scene_schema, dict):
        defs = scene_schema.get("$defs")
        terrain = defs.get("terrain") if isinstance(defs, dict) else None
        properties = terrain.get("properties") if isinstance(terrain, dict) else None
        levels = properties.get("levels") if isinstance(properties, dict) else None
        items = levels.get("items") if isinstance(levels, dict) else None
        pattern = items.get("pattern") if isinstance(items, dict) else None
        if isinstance(pattern, str):
            result.level_alphabet = _char_class(pattern)
    component_schema = _read_json(
        os.path.join(schemas_dir, "component.schema.json"), result.messages, "схема компонента"
    )
    if isinstance(component_schema, dict):
        properties = component_schema.get("properties")
        fields = properties.get("fields") if isinstance(properties, dict) else None
        additional = fields.get("additionalProperties") if isinstance(fields, dict) else None
        enum = additional.get("enum") if isinstance(additional, dict) else None
        if isinstance(enum, list):
            result.field_types = [str(value) for value in enum]


def _load_scene(scene_path: str, result: Sources) -> None:
    """Prefab'ы, схемы компонентов и ассет террейна конфига сцены (SER-7, SER-8, TERR-2)."""
    document = _read_json(scene_path, result.messages, "конфиг сцены")
    if not isinstance(document, dict):
        return
    prefabs = document.get("prefabs")
    if isinstance(prefabs, list):
        for entry in prefabs:
            if isinstance(entry, dict) and isinstance(entry.get("name"), str):
                result.prefabs.append(entry["name"])
    components = document.get("components")
    if isinstance(components, list):
        for entry in components:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            fields = entry.get("fields")
            if isinstance(name, str) and isinstance(fields, dict):
                result.components[name] = {
                    str(key): str(value) for key, value in fields.items()
                }
    terrain = document.get("terrain")
    if isinstance(terrain, dict):
        width = terrain.get("width")
        height = terrain.get("height")
        tile = terrain.get("tileSize")
        if isinstance(width, int) and isinstance(height, int) and isinstance(tile, int):
            levels = terrain.get("levels")
            flags = terrain.get("flags")
            result.terrain = TerrainAsset(
                width=width,
                height=height,
                tile_size=tile,
                levels=[str(row) for row in levels] if isinstance(levels, list) else [],
                flags=[str(row) for row in flags] if isinstance(flags, list) else [],
            )


def _load_manifest(manifest_path: str, content_dir: Optional[str], result: Sources) -> None:
    """Ключи видов, скины и секция камеры манифеста (ASSET-9, REND-6, ASSET-10)."""
    document = _read_json(manifest_path, result.messages, "манифест визуалов")
    if not isinstance(document, dict):
        return
    skins: List[str] = []
    for section in ("entities", "decorations"):
        entries = document.get(section)
        if not isinstance(entries, dict):
            continue
        for key, value in entries.items():
            result.visuals.append(str(key))
            if isinstance(value, dict) and isinstance(value.get("skins"), dict):
                for skin in value["skins"].keys():
                    if str(skin) not in skins:
                        skins.append(str(skin))
    result.skins = skins
    camera = document.get("cameraConfig")
    if isinstance(camera, dict):
        result.camera = {
            str(key): float(value)
            for key, value in camera.items()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        }
    terrain = document.get("terrain")
    curvature_id = terrain.get("curvatureMap") if isinstance(terrain, dict) else None
    if isinstance(curvature_id, str) and content_dir is not None:
        # Идентификатор ассета — путь от корня дерева контента (ASSET-2).
        curvature_path = os.path.join(content_dir, *curvature_id.split("/"))
        document = _read_json(curvature_path, result.messages, "карта кривизны")
        if isinstance(document, dict):
            width = document.get("width")
            height = document.get("height")
            rows = document.get("rows")
            if isinstance(width, int) and isinstance(height, int):
                result.curvature = CurvatureMap(
                    width=width,
                    height=height,
                    rows=[str(row) for row in rows] if isinstance(rows, list) else [],
                    path=curvature_path,
                )


def refresh(blend_path: str) -> Sources:
    """
    Перечитать опубликованные данные проекта для этого `.blend`. Вызывается
    оператором обновления, обработчиком открытия файла и после сохранения —
    но НИКОГДА из `draw()`: рисование панели не ходит на диск.
    """
    global _CACHE, _CACHE_KEY
    result = Sources()
    if not blend_path:
        result.messages.append(
            "файл не сохранён: сохраните `.blend` рядом со сценой (`<имя>.scene.json`) — парность даёт имя (BLND-2)"
        )
        _CACHE = result
        _CACHE_KEY = None
        return result

    root = find_project_root(os.path.dirname(blend_path))
    result.project_root = root
    if root is None:
        result.messages.append(
            "корень проекта не найден: ожидались каталоги %s выше `.blend`" % ", ".join(ROOT_MARKERS)
        )
    else:
        _load_schemas(root, result)

    scene_path = scene_document_path(blend_path)
    if scene_path is not None and os.path.isfile(scene_path):
        result.scene_path = scene_path
        _load_scene(scene_path, result)
    else:
        result.messages.append(
            "конфиг сцены не найден: ожидался %s" % (scene_path or "<путь неизвестен>")
        )

    content_dir = content_root(blend_path, root)
    if content_dir is not None:
        manifest_path = os.path.join(content_dir, MANIFEST_RELATIVE)
        if os.path.isfile(manifest_path):
            result.manifest_path = manifest_path
            _load_manifest(manifest_path, content_dir, result)
        else:
            result.messages.append("манифест визуалов не найден: ожидался %s" % manifest_path)
    else:
        result.messages.append("дерево контента не найдено: `.blend` вне `content/`")

    _CACHE = result
    _CACHE_KEY = (blend_path,)
    return result


def cache_key() -> Optional[Tuple[str, ...]]:
    """Для чего снимок был собран; `None` — не собирался ни разу."""
    return _CACHE_KEY
