"""
Живая проверка источника импортёром (задача 8.5, BLND-8, design, решение 9).

Правил здесь нет ни одного. Проверку выполняет ТОТ ЖЕ импортёр, что пишет
документы, — командой `import --dry-run` в подпроцессе Node; Python читает её
JSON со stdout и показывает находки. Второй перечень правил на стороне аддона
разошёлся бы с импортёром молча (BLND-6, BLND-8, ED-1, CORE-3), поэтому мост
дешёвый и односторонний: аддон умеет позвать и показать, но не судить.

Что зовётся:

    node <корень>/tools/blender-ts/bin/import.mjs <база>.glb \
         --dry-run --root <дерево контента> --locale ru

Прямой вызов `node`, а не `npm run import`: npm добавляет к каждой проверке
запуск своего процесса и разрешение скриптов — задержка, которую платить не за
что. Корень проекта и дерево контента ищет `sources` (парность даёт всё,
ссылок из `.blend` на проект нет — BLND-2), `--root` передаётся ЯВНО: у CLI
умолчание считается от рабочего каталога, а рабочий каталог у Blender чужой.

Проверяется ПОСЛЕДНИЙ ЭКСПОРТ, лежащий рядом с `.blend`, а не текущее
состояние сцены: временный экспорт «как сейчас» был бы вторым путём наружу и
врал бы автору о том, что уедет в импорт. Панель поэтому называет файл и время
проверки и отдельно отмечает, что в `.blend` есть несохранённые правки.

Неблокирующая схема (осознанный выбор для 4.5 LTS):

- подпроцесс крутится в ФОНОВОМ ПОТОКЕ, и поток не трогает bpy ни одной
  строкой — только `subprocess` и переменные этого модуля под замком: bpy не
  потокобезопасен, и вызов из чужого потока роняет Blender не воспроизводимо;
- поток зовёт `subprocess.run(..., capture_output=True)`, то есть читает обе
  трубы ОДНОВРЕМЕННО. Схема «Popen + опрос `poll()` из таймера» отвергнута:
  dry-run печатает в stdout весь целевой слой, это легко больше буфера трубы,
  и недренируемый вывод повесил бы подпроцесс намертво;
- забирает результат, разбирает JSON и просит перерисовку ТАЙМЕР
  `bpy.app.timers` — он выполняется на главном потоке. Тот же таймер держит
  дебаунс.

Состояние — переменные МОДУЛЯ, как строка отчёта экспорта (`exporter`).
Свойств сцены и объектов ни обработчик, ни таймер не пишут: правка ID-данных
после сохранения помечает только что записанный `.blend` изменённым (дефект №2
разбора волны B — не повторять). Панель только читает опубликованный отчёт и на
диск не ходит.
"""

import json
import os
import shutil
import subprocess
import threading
import time

import bpy

from . import sources

#: Точка входа CLI импорта внутри проекта (BLND-5).
IMPORT_ENTRY = os.path.join("tools", "blender-ts", "bin", "import.mjs")

#: Путь к `node` в обход PATH. Blender, запущенный из графической оболочки,
#: часто наследует урезанный PATH (особенно macOS-сборка из Finder), и `node`
#: в нём не виден, хотя в терминале виден. Переменная — честный обход без
#: догадок о расположении менеджеров версий (nvm, fnm, volta): угадывать их
#: пути значило бы завести в аддоне знание о чужих инструментах.
NODE_ENV = "FLUXUS_NODE"

#: Дебаунс: подряд идущие сохранения схлопываются в одну проверку (design 9).
DEBOUNCE_SECONDS = 1.5

#: Шаг опроса таймера. Таймер живёт только пока есть чего ждать.
POLL_INTERVAL = 0.25

#: Потолок ожидания подпроцесса. Больше — считаем, что проверка не отвечает.
TIMEOUT_SECONDS = 120.0

#: Сколько последних строк stderr показывать при неудаче.
OUTPUT_LINES = 6

#: Сколько находок показывать в панели: список не должен выдавливать всё
#: остальное. Полный перечень всегда даёт сама команда.
PANEL_FINDINGS = 20


class Finding:
    """Находка импорта: важность, ИМЯ ОБЪЕКТА BLENDER и текст (BLND-6)."""

    __slots__ = ("severity", "object_name", "message")

    def __init__(self, severity, object_name, message):
        self.severity = severity
        self.object_name = object_name
        self.message = message

    @property
    def is_error(self):
        return self.severity == "error"


class Report:
    """
    Опубликованный отчёт последней проверки. Читается панелью, пишется только
    главным потоком (таймером либо оператором).
    """

    def __init__(self):
        #: `idle` — не проверяли, `done` — команда ответила, `failed` — проверка
        #: не выполнилась (нет node, нет экспорта, ответ не разобран).
        self.status = "idle"
        #: Проверенный `.glb`; `None` — проверки не было.
        self.source = None
        self.finished_at = None
        #: Прошёл ли импорт: `ok` команды. При `failed` смысла не имеет.
        self.ok = False
        self.findings = []
        self.errors = 0
        self.warnings = 0
        #: Причина отказа импорта, как её назвала команда.
        self.refusal = None
        #: Находки валидации, которыми сохранение отвергло бы запись (ED-21).
        self.blocking = []
        #: Размер целевого слоя: записи `initial` (SER-8) и `decorations` (PRES-2).
        self.initial = 0
        self.decorations = 0
        #: Что импорт изменил бы в документах — строками «слот: …».
        self.changes = []
        #: Почему проверка не выполнилась (только для `failed`).
        self.problem = None
        #: Хвост stderr команды — человеческий текст находок и отказов.
        self.output = []

    @property
    def checked(self):
        return self.status != "idle"

    def time_text(self):
        """Время проверки часами локальной зоны; пусто — проверки не было."""
        if self.finished_at is None:
            return ""
        return time.strftime("%H:%M:%S", time.localtime(self.finished_at))


# Состояние модуля. `_LOCK` защищает ТОЛЬКО обмен с фоновым потоком (`_OUTCOME`):
# всё остальное пишет главный поток.
_LOCK = threading.Lock()
_OUTCOME = None
_WORKER = None
_REPORT = Report()
_RUNNING = False
_DEADLINE = None
_REQUEST = None
_TIMER_ON = False


def report():
    """Последний отчёт. Ни чтения с диска, ни запуска — их делает `schedule()`."""
    return _REPORT


def is_running():
    """Идёт ли проверка прямо сейчас."""
    return _RUNNING


def wrapped(text, width=46):
    """
    Текст строками не длиннее `width`: `UILayout.label` не переносит сам, а
    сообщения импорта длинные. Перенос по пробелам, слово длиннее ширины
    режется — обрезать сообщение молча хуже, чем показать его некрасиво.
    """
    lines = []
    for paragraph in str(text).splitlines() or [""]:
        current = ""
        for word in paragraph.split():
            while len(word) > width:
                if current:
                    lines.append(current)
                    current = ""
                lines.append(word[:width])
                word = word[width:]
            if not current:
                current = word
            elif len(current) + 1 + len(word) <= width:
                current = "%s %s" % (current, word)
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return [line for line in lines if line] or [""]


def _node_executable():
    """Путь к `node`: переменная окружения важнее PATH; `None` — не найден."""
    override = os.environ.get(NODE_ENV, "").strip()
    if override:
        return override if os.path.isfile(override) else None
    return shutil.which("node")


def plan(blend_path):
    """
    Что и чем проверять для этого `.blend`.

    Возвращает `(команда, причина)`: команда — словарь `argv`/`cwd`/`source`,
    причина — текст, почему проверки не будет. Всё, что может не сойтись
    (файл не сохранён, экспорта нет, корень не найден, node не найден),
    называется здесь и одинаково для кнопки и для авто-проверки.
    """
    if not blend_path:
        return None, "файл не сохранён: сохраните `.blend` рядом со сценой (BLND-2)"

    source = sources.export_path(blend_path)
    if source is None or not os.path.isfile(source):
        return None, (
            "экспорта рядом нет: ожидался %s. Сохраните `.blend` при включённом "
            "авто-экспорте либо нажмите «Экспортировать .glb»" % (source or "<путь неизвестен>")
        )

    root = sources.find_project_root(os.path.dirname(blend_path))
    if root is None:
        return None, "корень проекта не найден: ожидались каталоги %s выше `.blend`" % ", ".join(
            sources.ROOT_MARKERS
        )

    entry = os.path.join(root, IMPORT_ENTRY)
    if not os.path.isfile(entry):
        return None, "команда импорта не найдена: ожидался %s" % entry

    content = sources.content_root(blend_path, root)
    if content is None:
        return None, "дерево контента не найдено: `.blend` вне `content/`"

    node = _node_executable()
    if node is None:
        override = os.environ.get(NODE_ENV, "").strip()
        if override:
            return None, "%s указывает на %r, а такого файла нет" % (NODE_ENV, override)
        return None, (
            "`node` не найден в PATH этого процесса Blender: укажите путь переменной "
            "окружения %s (Blender, запущенный из графической оболочки, часто не видит "
            "PATH терминала)" % NODE_ENV
        )

    # `--root` явно: умолчание CLI считается от рабочего каталога процесса, а у
    # Blender он произвольный. `--locale ru` — тот же язык, что у панелей.
    argv = [node, entry, source, "--dry-run", "--root", content, "--locale", "ru"]
    return {"argv": argv, "cwd": root, "source": source}, None


def _no_console():
    """Windows: не мигать окном консоли на каждой проверке."""
    if os.name != "nt":
        return {}
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}


def _work(command):
    """
    Тело фонового потока. bpy здесь НЕ ВЫЗЫВАЕТСЯ ни разу — только подпроцесс и
    публикация сырого результата под замком. Разбор и перерисовку делает таймер
    на главном потоке.
    """
    global _OUTCOME
    outcome = {"source": command["source"], "code": None, "stdout": "", "stderr": "", "problem": None}
    try:
        completed = subprocess.run(  # noqa: S603 — argv собран нами, не строкой оболочки
            command["argv"],
            cwd=command["cwd"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=TIMEOUT_SECONDS,
            **_no_console()
        )
        outcome["code"] = completed.returncode
        # Декодируем сами: локаль процесса Blender может быть какой угодно, а
        # вывод команды — UTF-8 всегда. `replace` вместо исключения: сломанный
        # байт не повод потерять весь отчёт.
        outcome["stdout"] = (completed.stdout or b"").decode("utf-8", "replace")
        outcome["stderr"] = (completed.stderr or b"").decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        outcome["problem"] = "проверка не ответила за %g с и снята" % TIMEOUT_SECONDS
    except OSError as error:
        outcome["problem"] = "команду не удалось запустить: %s" % error
    except Exception as error:  # noqa: BLE001 — исключение в потоке иначе теряется молча
        outcome["problem"] = "проверка сорвалась: %s" % error
    with _LOCK:
        _OUTCOME = outcome


def _take_outcome():
    global _OUTCOME
    with _LOCK:
        outcome = _OUTCOME
        _OUTCOME = None
    return outcome


def _has_outcome():
    with _LOCK:
        return _OUTCOME is not None


def _tail(text):
    lines = [line.rstrip() for line in str(text).splitlines() if line.strip()]
    return lines[-OUTPUT_LINES:]


def _slot_change(name, value):
    """Строка «что изменилось в слоте» из ответа операции импорта."""
    if not isinstance(value, dict):
        return None
    counts = []
    for key, label in (("set", "изменено"), ("appended", "добавлено"), ("removed", "снято")):
        number = value.get(key)
        if isinstance(number, int) and not isinstance(number, bool) and number > 0:
            counts.append("%s %d" % (label, number))
    return None if not counts else "%s: %s" % (name, ", ".join(counts))


def _parse(outcome):
    """
    Ответ команды в отчёт. Разбор ОБОРОНИТЕЛЬНЫЙ: любое расхождение с ожидаемой
    формой — «проверка не выполнилась» с текстом, а не исключение в таймере.
    Аддон не имеет права падать от чужого вывода.
    """
    result = Report()
    result.source = outcome.get("source")
    result.finished_at = time.time()
    result.output = _tail(outcome.get("stderr", ""))

    if outcome.get("problem"):
        result.status = "failed"
        result.problem = outcome["problem"]
        return result

    document = None
    text = str(outcome.get("stdout", "")).strip()
    if text:
        try:
            document = json.loads(text)
        except ValueError as error:
            result.status = "failed"
            result.problem = "ответ команды не разобран как JSON: %s" % error
            return result

    if not isinstance(document, dict):
        # Код 2 — отказ разбора аргументов или чтения источника: JSON команда
        # в этом случае не печатает, и человеческий текст лежит в stderr.
        result.status = "failed"
        first = result.output[0] if result.output else "вывода нет"
        result.problem = "команда завершилась с кодом %s: %s" % (outcome.get("code"), first)
        return result

    result.status = "done"
    result.ok = document.get("ok") is True
    findings = document.get("findings")
    if isinstance(findings, list):
        for entry in findings:
            if not isinstance(entry, dict):
                continue
            severity = "error" if entry.get("severity") == "error" else "warning"
            finding = Finding(
                severity,
                str(entry.get("object", "") or ""),
                str(entry.get("message", "") or ""),
            )
            result.findings.append(finding)
            if finding.is_error:
                result.errors += 1
            else:
                result.warnings += 1

    layer = document.get("layer")
    if isinstance(layer, dict):
        for key in ("initial", "decorations"):
            entries = layer.get(key)
            if isinstance(entries, list):
                setattr(result, key, len(entries))

    changes = document.get("changes")
    if isinstance(changes, dict):
        for key, value in changes.items():
            line = _slot_change(str(key), value)
            if line is not None:
                result.changes.append(line)

    refusal = document.get("refusal")
    result.refusal = refusal if isinstance(refusal, str) and refusal else None

    blocking = document.get("blocking")
    if isinstance(blocking, list):
        for entry in blocking:
            if not isinstance(entry, dict):
                continue
            # Текста у находки валидации нет по устройству (ED-27, ED-28):
            # в JSON лежит ключ ресурса, а сложенную фразу команда печатает в
            # stderr. Панель поэтому называет адрес, а фразу показывает хвостом
            # вывода — второй словарь строк в Python был бы тем же грехом, что
            # второй перечень правил.
            document_id = str(entry.get("documentId", "?"))
            rule = str(entry.get("ruleId", "?"))
            path = entry.get("path")
            address = "/".join(str(part) for part in path) if isinstance(path, list) and path else ""
            result.blocking.append("%s%s — %s" % (document_id, "/" + address if address else "", rule))

    return result


def _redraw():
    """
    Пометить панели к перерисовке. Только с главного потока: `tag_redraw` —
    вызов bpy, и из фонового потока он недопустим.
    """
    window_manager = getattr(bpy.context, "window_manager", None)
    windows = getattr(window_manager, "windows", None) or ()
    try:
        for window in windows:
            screen = getattr(window, "screen", None)
            for area in getattr(screen, "areas", None) or ():
                if getattr(area, "type", "") == "VIEW_3D":
                    area.tag_redraw()
    except (AttributeError, RuntimeError):
        # Контекста может не быть (запуск в фоне, окно закрывается) — это не
        # повод ронять таймер: отчёт уже опубликован, панель прочтёт его сама.
        pass


def _publish(result):
    global _REPORT
    _REPORT = result
    _redraw()


def _start():
    """Запустить проверку. Только главный поток (таймер либо оператор)."""
    global _WORKER, _RUNNING, _DEADLINE, _REQUEST
    blend_path = _REQUEST
    _DEADLINE = None
    _REQUEST = None

    command, problem = plan(blend_path)
    if command is None:
        result = Report()
        result.status = "failed"
        result.finished_at = time.time()
        result.problem = problem
        _publish(result)
        return

    _RUNNING = True
    # daemon: поток не должен удерживать закрытие Blender. Убить подпроцесс
    # снаружи нельзя, но у него есть свой потолок ожидания, а результат
    # опоздавшего потока просто некому забрать — bpy он не трогает.
    _WORKER = threading.Thread(target=_work, args=(command,), name="fluxus-livecheck", daemon=True)
    _WORKER.start()
    _redraw()


def _worker_running():
    return _WORKER is not None and _WORKER.is_alive()


def _pump():
    """
    Насос главного потока: забрать готовый результат, выдержать дебаунс,
    запустить проверку. Возвращает интервал следующего вызова либо `None` —
    ждать больше нечего, и таймер снимается сам.
    """
    global _TIMER_ON, _RUNNING

    outcome = _take_outcome()
    if outcome is not None:
        _RUNNING = False
        _publish(_parse(outcome))

    if _worker_running():
        return POLL_INTERVAL

    if _DEADLINE is not None:
        if time.monotonic() >= _DEADLINE:
            _start()
        return POLL_INTERVAL

    # Поток мог завершиться между выемкой и проверкой `is_alive()` — тогда
    # результат уже лежит и снимать таймер рано.
    if _has_outcome():
        return POLL_INTERVAL

    _RUNNING = False
    _TIMER_ON = False
    return None


def _ensure_timer():
    global _TIMER_ON
    if _TIMER_ON:
        return
    # Флаг ставится ПОСЛЕ успешной регистрации: иначе отказ регистрации оставил
    # бы модуль уверенным, что таймер живёт, и проверки молча перестали бы идти.
    bpy.app.timers.register(_pump, first_interval=POLL_INTERVAL)
    _TIMER_ON = True


def schedule(blend_path, delay=DEBOUNCE_SECONDS):
    """
    Назначить проверку экспорта этого `.blend` через `delay` секунд.

    Дебаунс — сдвиг срока: повторный вызов до его наступления отодвигает
    проверку, поэтому серия быстрых сохранений даёт ОДИН запуск (design 9).
    Пока проверка идёт, срок ждёт её конца — двух подпроцессов разом не бывает.
    """
    global _DEADLINE, _REQUEST
    _REQUEST = blend_path
    _DEADLINE = time.monotonic() + max(0.0, delay)
    _ensure_timer()


def checked_source_matches(blend_path):
    """
    Об этом ли `.blend` последний отчёт. Панель отмечает несовпадение: после
    «Save As» отчёт остаётся о прежнем файле, и молчать об этом нельзя.
    """
    if _REPORT.source is None:
        return True
    expected = sources.export_path(blend_path) if blend_path else None
    if expected is None:
        return False
    return os.path.normpath(expected) == os.path.normpath(_REPORT.source)


class FLUXUS_OT_check_now(bpy.types.Operator):
    """Проверить последний экспорт импортёром (`import --dry-run`)"""

    bl_idname = "fluxus.check_now"
    bl_label = "Проверить сейчас"
    bl_options = {"REGISTER"}

    def execute(self, context):
        command, problem = plan(bpy.data.filepath)
        if command is None:
            # Причину показываем и в отчёте панели: всплывающее сообщение
            # оператора живёт секунды, а панель — до следующей проверки.
            result = Report()
            result.status = "failed"
            result.finished_at = time.time()
            result.problem = problem
            _publish(result)
            self.report({"ERROR"}, problem)
            return {"CANCELLED"}
        schedule(bpy.data.filepath, delay=0.0)
        self.report({"INFO"}, "проверка запущена: %s" % os.path.basename(command["source"]))
        return {"FINISHED"}


class FLUXUS_OT_select_object(bpy.types.Operator):
    """Выделить объект, названный находкой"""

    bl_idname = "fluxus.select_object"
    bl_label = "Показать объект"
    bl_options = {"REGISTER", "UNDO"}

    object_name: bpy.props.StringProperty(name="Имя объекта")

    def execute(self, context):
        scene = getattr(context, "scene", None)
        obj = scene.objects.get(self.object_name) if scene is not None else None
        if obj is None:
            self.report(
                {"WARNING"},
                "объекта %r в сцене нет: возможно, он переименован после проверки"
                % self.object_name,
            )
            return {"CANCELLED"}
        try:
            # Выделение — состояние вида, и меняет его ЯВНОЕ действие автора,
            # а не обработчик: тем же кликом в outliner Blender делает то же.
            for other in context.selected_objects:
                other.select_set(False)
            obj.select_set(True)
            context.view_layer.objects.active = obj
        except (AttributeError, RuntimeError) as error:
            self.report({"WARNING"}, "объект %r не выделяется: %s" % (self.object_name, error))
            return {"CANCELLED"}
        return {"FINISHED"}


CLASSES = (FLUXUS_OT_check_now, FLUXUS_OT_select_object)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister():
    global _TIMER_ON, _RUNNING
    try:
        bpy.app.timers.unregister(_pump)
    except (ValueError, TypeError, AttributeError):
        # Таймер снимается сам, когда ждать нечего: снятие уже снятого — не беда.
        pass
    _TIMER_ON = False
    _RUNNING = False
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
