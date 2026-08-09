"""
Grid-меши террейна и кривизны: построение, чтение и запись клеточных данных.

## Представление, выбранное аддоном

Оба объекта — сетка из ОТДЕЛЬНЫХ четырёхугольников, по одному на клетку
(вершины соседних клеток не сварены), в порядке строк: клетка `(x, y)` — грань
`y * width + x`, её вершины — `4 * index … 4 * index + 3` по углам
`(x0,y0) (x1,y0) (x1,y1) (x0,y1)`, где `x0 = x · cell`, `x1 = (x+1) · cell`.

Почему не сварная сетка «вершина = угол клетки»: у сварной сетки уровень клетки
приходится выводить из четырёх углов, и клетка с углами на разных уровнях не
разрешается в целый уровень однозначно — импортёру пришлось бы либо угадывать,
либо отказывать там, где автор ничего плохого не делал. Отдельная грань на
клетку делает дискретность уровней свойством ПОСТРОЕНИЯ (design 7, BLND-9):
у клетки ровно одно значение высоты, и «высота между уровнями» недостижима
мазком кисти.

- **Высота**: `z` вершин клетки = `уровень × LEVEL_UNIT`, где `LEVEL_UNIT`
  равен единице: 1 уровень = 1 единица Blender = 1 мировая единица (CONVENTIONS,
  «1 юнит = 1 мировая единица»). Визуальное преувеличение высоты живёт в
  превью-модификаторе и клеточных данных не трогает.
- **Рампа и снятый пол**: целочисленные атрибуты `RAMP` и `NOFLOOR` на домене
  точек (`POINT`), одинаковые у всех четырёх вершин клетки. Домен точек выбран
  ради экспорта: атрибуты граней glTF не выражает, а per-vertex атрибуты
  штатный экспортёр отдаёт как `_RAMP` и `_NOFLOOR` (префикс `_` — требование
  glTF к пользовательским каналам). Ноль — обычная клетка (TERR-3 `.`), чтобы
  нейтральным было ЗНАЧЕНИЕ ПО УМОЛЧАНИЮ нового атрибута.
- **Кривизна**: та же сетка, `z` клетки — визуальное смещение в долях шага
  высоты; квантование в алфавит карты и кламп амплитуды делает импорт (BLND-10),
  кисть лишь ходит удобным шагом.

Канал экспорта атрибутов в glTF зафиксирован CONVENTIONS.md («Terrain-объект»):
`_RAMP` и `_NOFLOOR`, атрибуты вершин. Имена здесь — без префикса: его добавляет
штатный экспортёр (требование glTF к пользовательским каналам), и импорт читает
именно каналы с префиксом.

**Для чтения на стороне импортёра**: адрес клетки надёжнее восстанавливать по
ГРАНИ (центр грани, делённый на размер клетки), а не по порядку вершин —
экспортёр вправе слить вершины с совпадающими позицией и атрибутами, и тогда
«по четыре вершины на клетку» перестаёт выполняться. Значения при такой сварке
не теряются: сливаются только вершины, у которых они совпадают.

## Что здесь НЕ решается

Размер сетки, размер клетки и алфавит уровней приходят из документов движка
(`sources`), а не из констант Python (BLND-8): grid-mesh обязан совпадать с
сеткой ассета террейна сцены (TERR-2), и второй источник размеров разошёлся бы
с первым.
"""

import bpy

from . import sources

#: Единица уровня в единицах Blender. 1 уровень = 1 мировая единица.
LEVEL_UNIT = 1.0

#: Имена клеточных атрибутов. В glTF уезжают как `_RAMP` и `_NOFLOOR`.
RAMP_ATTRIBUTE = "RAMP"
NOFLOOR_ATTRIBUTE = "NOFLOOR"

TERRAIN_KEY = "terrain"
CURVATURE_KEY = "curvature"

DEFAULT_TERRAIN_NAME = "terrain"
DEFAULT_CURVATURE_NAME = "curvature"


def cell_index(x, y, width):
    return y * width + x


def cell_vertices(index):
    """Индексы четырёх вершин клетки: сетка не сварена, клетки не делят вершин."""
    base = index * 4
    return (base, base + 1, base + 2, base + 3)


def build_grid_mesh(name, width, height, cell_size, heights=None):
    """
    Сетка `width × height` отдельных четырёхугольников. `heights` — высота
    клетки в единицах Blender (не уровень!); пусто — плоская сетка на нуле.
    """
    verts = []
    faces = []
    for y in range(height):
        for x in range(width):
            index = cell_index(x, y, width)
            z = 0.0 if heights is None else float(heights[index])
            x0 = x * cell_size
            x1 = (x + 1) * cell_size
            y0 = y * cell_size
            y1 = (y + 1) * cell_size
            base = len(verts)
            verts.extend([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)])
            faces.append((base, base + 1, base + 2, base + 3))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    return mesh


def ensure_int_attribute(mesh, name):
    """Целочисленный атрибут на домене точек; уже есть — возвращается он же."""
    attribute = mesh.attributes.get(name)
    if attribute is not None and (attribute.domain != "POINT" or attribute.data_type != "INT"):
        # Атрибут того же имени с другим доменом — не наш; переименовать его
        # молча аддон не вправе, поэтому просто сообщаем отсутствие.
        return None
    if attribute is None:
        attribute = mesh.attributes.new(name, "INT", "POINT")
    return attribute


def attribute_values(mesh, name):
    """Значение атрибута по клеткам (берётся у первой вершины клетки)."""
    attribute = mesh.attributes.get(name)
    if attribute is None:
        return None
    data = attribute.data
    return [data[index * 4].value for index in range(len(mesh.polygons))]


def set_cell_attribute(mesh, name, index, value):
    """Значение клеточного атрибута — сразу всем четырём вершинам клетки."""
    attribute = ensure_int_attribute(mesh, name)
    if attribute is None:
        return False
    for vertex in cell_vertices(index):
        attribute.data[vertex].value = int(value)
    return True


def cell_attribute(mesh, name, index):
    attribute = mesh.attributes.get(name)
    if attribute is None:
        return 0
    return int(attribute.data[index * 4].value)


def cell_height(mesh, index):
    """Высота клетки в единицах Blender (z её первой вершины)."""
    return mesh.vertices[index * 4].co.z


def set_cell_height(mesh, index, z):
    for vertex in cell_vertices(index):
        mesh.vertices[vertex].co.z = z


def cell_level(mesh, index):
    """Целый уровень клетки; дробная высота (правка мимо кисти) округляется ТОЛЬКО для показа."""
    return int(round(cell_height(mesh, index) / LEVEL_UNIT))


def set_cell_level(mesh, index, level):
    set_cell_height(mesh, index, float(level) * LEVEL_UNIT)


def find_object_with_key(scene, key):
    """Первый объект сцены с этим семантическим свойством (BLND-3)."""
    for obj in scene.objects:
        if key in obj.keys():
            return obj
    return None


def resolve_grid(context, key):
    """
    Объект-сетка для кистей: сначала явный выбор в настройках сцены, затем
    поиск по семантическому свойству. Выбор не сохраняется автоматически —
    правда о семантике всегда в сыром свойстве.
    """
    settings = context.scene.fluxus
    explicit = settings.terrain_object if key == TERRAIN_KEY else settings.curvature_object
    if explicit is not None and key in explicit.keys():
        return explicit
    return find_object_with_key(context.scene, key)


def grid_dimensions(snapshot):
    """Размеры сетки и клетки из ассета террейна сцены (TERR-2); нет ассета — `None`."""
    terrain = snapshot.terrain
    if terrain is None:
        return None
    return terrain.width, terrain.height, terrain.cell_size


def _levels_from_asset(snapshot):
    """
    Затравка высот из карты уровней ассета (TERR-3). Символ → уровень берётся
    ПОЗИЦИЕЙ В АЛФАВИТЕ ОПУБЛИКОВАННОЙ СХЕМЫ, а не таблицей в Python (BLND-8).
    """
    terrain = snapshot.terrain
    alphabet = snapshot.level_alphabet
    if terrain is None or not alphabet or not terrain.levels:
        return None, "карта уровней недоступна: сетка построена плоской"
    heights = [0.0] * (terrain.width * terrain.height)
    for y in range(min(terrain.height, len(terrain.levels))):
        row = terrain.levels[y]
        for x in range(min(terrain.width, len(row))):
            position = alphabet.find(row[x])
            if position < 0:
                return None, "символ %r ряда %d вне алфавита уровней схемы" % (row[x], y)
            heights[cell_index(x, y, terrain.width)] = position * LEVEL_UNIT
    return heights, ""


def _flags_from_asset(snapshot):
    """
    Затравка флагов из карты вида клеток (TERR-3): `.` обычная, `^` рампа,
    `_` нет пола. Символы читаются из уже существующего документа сцены —
    правилом это не становится: отказ и проверки остаются за импортом (BLND-6).
    """
    terrain = snapshot.terrain
    if terrain is None or not terrain.flags:
        return None, None
    size = terrain.width * terrain.height
    ramp = [0] * size
    noflo = [0] * size
    for y in range(min(terrain.height, len(terrain.flags))):
        row = terrain.flags[y]
        for x in range(min(terrain.width, len(row))):
            index = cell_index(x, y, terrain.width)
            if row[x] == "^":
                ramp[index] = 1
            elif row[x] == "_":
                noflo[index] = 1
    return ramp, noflo


def _curvature_offset(char):
    """
    Символ карты кривизны → смещение в 1/16 шага высоты (ASSET-7).

    Читается ТОЛЬКО ради затравки сетки существующей картой; правило записи
    (квантование и кламп амплитуды) остаётся за импортом (BLND-10), и при
    расхождении прав импорт. Алфавит карты движок не публикует схемой — при
    его появлении в `engine/schemas/` эту функцию заменяет чтение схемы.
    """
    if char == ".":
        return 0
    if "1" <= char <= "7":
        return ord(char) - ord("0")
    if "a" <= char <= "g":
        return -(ord(char) - ord("a") + 1)
    return None


class FLUXUS_OT_create_terrain_grid(bpy.types.Operator):
    """Создать grid-mesh террейна по сетке ассета сцены (BLND-9)"""

    bl_idname = "fluxus.create_terrain_grid"
    bl_label = "Создать сетку террейна"
    bl_options = {"REGISTER", "UNDO"}

    seed_from_asset: bpy.props.BoolProperty(
        name="Затравка из ассета",
        description="Взять уровни и флаги из ассета террейна сцены (TERR-3)",
        default=True,
    )

    def execute(self, context):
        snapshot = sources.get()
        dimensions = grid_dimensions(snapshot)
        if dimensions is None:
            self.report(
                {"ERROR"},
                "сетка неизвестна: в конфиге сцены нет ассета террейна (TERR-2). Обновите перечни",
            )
            return {"CANCELLED"}
        width, height, cell_size = dimensions

        heights = None
        ramp = None
        noflo = None
        if self.seed_from_asset:
            heights, message = _levels_from_asset(snapshot)
            if message:
                self.report({"WARNING"}, message)
            ramp, noflo = _flags_from_asset(snapshot)

        mesh = build_grid_mesh(DEFAULT_TERRAIN_NAME, width, height, cell_size, heights)
        obj = bpy.data.objects.new(DEFAULT_TERRAIN_NAME, mesh)
        obj[TERRAIN_KEY] = 1
        context.collection.objects.link(obj)

        for name, values in ((RAMP_ATTRIBUTE, ramp), (NOFLOOR_ATTRIBUTE, noflo)):
            attribute = ensure_int_attribute(mesh, name)
            if attribute is None:
                self.report({"WARNING"}, "атрибут %s занят другим доменом" % name)
                continue
            if values is None:
                continue
            flat = []
            for index in range(width * height):
                flat.extend([int(values[index])] * 4)
            attribute.data.foreach_set("value", flat)
        mesh.update()

        context.scene.fluxus.terrain_object = obj
        self.report({"INFO"}, "сетка террейна %d×%d создана" % (width, height))
        return {"FINISHED"}


class FLUXUS_OT_create_curvature_grid(bpy.types.Operator):
    """Создать grid-mesh карты кривизны по сетке террейна (BLND-10)"""

    bl_idname = "fluxus.create_curvature_grid"
    bl_label = "Создать сетку кривизны"
    bl_options = {"REGISTER", "UNDO"}

    seed_from_asset: bpy.props.BoolProperty(
        name="Затравка из карты",
        description="Взять смещения из карты кривизны манифеста (ASSET-7)",
        default=True,
    )

    def execute(self, context):
        snapshot = sources.get()
        dimensions = grid_dimensions(snapshot)
        if dimensions is None:
            self.report(
                {"ERROR"},
                "сетка неизвестна: в конфиге сцены нет ассета террейна (TERR-2). Обновите перечни",
            )
            return {"CANCELLED"}
        width, height, cell_size = dimensions

        heights = None
        curvature = snapshot.curvature
        if self.seed_from_asset and curvature is not None:
            if curvature.width != width or curvature.height != height:
                self.report(
                    {"WARNING"},
                    "карта кривизны %d×%d не совпадает с сеткой террейна %d×%d — затравка пропущена"
                    % (curvature.width, curvature.height, width, height),
                )
            else:
                heights = [0.0] * (width * height)
                for y in range(min(height, len(curvature.rows))):
                    row = curvature.rows[y]
                    for x in range(min(width, len(row))):
                        offset = _curvature_offset(row[x])
                        if offset is None:
                            self.report(
                                {"WARNING"},
                                "символ %r ряда %d вне алфавита карты кривизны" % (row[x], y),
                            )
                            offset = 0
                        heights[cell_index(x, y, width)] = offset / 16.0 * LEVEL_UNIT

        mesh = build_grid_mesh(DEFAULT_CURVATURE_NAME, width, height, cell_size, heights)
        obj = bpy.data.objects.new(DEFAULT_CURVATURE_NAME, mesh)
        obj[CURVATURE_KEY] = 1
        context.collection.objects.link(obj)
        context.scene.fluxus.curvature_object = obj
        self.report({"INFO"}, "сетка кривизны %d×%d создана" % (width, height))
        return {"FINISHED"}


CLASSES = (
    FLUXUS_OT_create_terrain_grid,
    FLUXUS_OT_create_curvature_grid,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
