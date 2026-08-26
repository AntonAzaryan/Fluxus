/**
 * Отвязываемый сервис (DSK-7): процесс, который ПЕРЕЖИВАЕТ сессию, поднявшую
 * его.
 *
 * Три вещи, которых нет у обычного сервиса, и все три — свойства процесса, а не
 * решения страницы: собственная группа процессов (иначе сигнал, адресованный
 * контейнеру, приходит и ему), файл с адресом (иначе новая сессия не узнает, где
 * пережившего искать) и файл с идентификатором процесса (иначе его нечем
 * остановить явной операцией — владения-то у новой сессии нет).
 *
 * Отвязываемость объявляет ПРОФИЛЬ (DSK-5), и здесь нет ни одной ветви,
 * зависящей от того, что сказала страница: страница называет идентификатор, всё
 * остальное читается из объявления.
 *
 * Модуль — чистый Node: ни Electron, ни IPC. Обе ветви (умирает / переживает)
 * проверяются контрактным сьютом в гейте (DSK-6), и вторая — на тех же опциях
 * spawn, что и в настоящем контейнере.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import type { BridgeServiceId } from '../bridge/types.js';

/**
 * Каталог состояния сервисов по умолчанию: реализация вправе назвать свой.
 *
 * Имя ПЕРСОНАЛЬНОЕ. Общий каталог во временном — это файлы, которые на общей
 * машине вправе создать кто угодно раньше нас: `pid` оттуда получает SIGTERM и
 * SIGKILL, а адрес оттуда уезжает странице как адрес управляющего канала — то
 * есть туда уедет и материал автопейринга (MGR-5, SRV-3). Разделив каталоги по
 * пользователю, мы возвращаем этим файлам того единственного автора, которому
 * они и так уже доверены. Контейнер и без того кладёт их в `userData`
 * (`electron/main.ts`) — умолчание не должно быть слабее.
 */
export function defaultServiceStateDir(): string {
  let who = '';
  try {
    who = String(userInfo().uid);
  } catch {
    // Windows не называет uid — там временный каталог и так свой у сессии.
    who = 'user';
  }
  return join(tmpdir(), `fluxus-desktop-services-${who}`);
}

/**
 * Опции запуска процесса сервиса.
 *
 * Отвязываемый уходит в СВОЮ группу процессов (`detached`), и его потоки
 * отвязываются от контейнера: иначе закрытый контейнер закрыл бы ему stdout, и
 * первая же строка отчёта убила бы переживший процесс. На Windows группы
 * процессов устроены иначе, но флаг тот же и означает то же — «не умирать
 * вместе с родителем»; отдельно гасится только консольное окно, которого в
 * десктопном приложении быть не должно.
 */
export function serviceSpawnOptions(detached: boolean, platform: string): SpawnOptions {
  if (!detached) return { stdio: 'inherit' };
  return {
    detached: true,
    // Наследовать stdio отвязанному нельзя: держатель этих дескрипторов уходит.
    stdio: 'ignore',
    ...(platform === 'win32' ? { windowsHide: true } : {}),
  };
}

/** Файлы отвязываемого сервиса в каталоге состояния (решение D6). */
export interface DetachedFiles {
  readonly addressFile: string;
  readonly pidFile: string;
}

export function detachedFiles(stateDir: string, id: BridgeServiceId): DetachedFiles {
  // Права ЗАДАНЫ: в каталоге лежат идентификатор процесса, которому мы шлём
  // сигналы, и адрес, по которому страница предъявляет материал автопейринга.
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // Имя файла — идентификатор сервиса: он приходит из ОБЪЯВЛЕНИЯ профиля, а не
  // из страницы, поэтому подстановки чужого пути здесь быть не может.
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return {
    addressFile: join(stateDir, `${safe}.address`),
    pidFile: join(stateDir, `${safe}.pid`),
  };
}

/** Адрес, записанный самим процессом; пустая строка — файла нет или он пуст. */
export function readAddressFile(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Идентификатор процесса и его момент старта. */
export interface PidRecord {
  readonly pid: number;
  /** Момент старта относительно загрузки (Linux, поле 22 stat); `0` — неизвестно. */
  readonly startProc: number;
}

/**
 * Записывает pid ВМЕСТЕ с моментом старта процесса. Момент нужен против
 * переиспользования номера: после перезагрузки тот же PID носит чужой процесс, и
 * без сверки момента `stopPid` убил бы постороннего, а пере-обнаружение
 * воскресило бы фантомный сервис (DSK-7, «пережил сессию» — а не «PID занят»).
 */
export function writePid(file: string, pid: number): void {
  writeFileSync(file, `${String(pid)} ${String(processStartTicks(pid))}\n`);
}

/** Запись pid-файла: pid и момент старта; `pid = 0` — файла нет или он битый. */
export function readPidRecord(file: string): PidRecord {
  try {
    const parts = readFileSync(file, 'utf8').trim().split(/\s+/);
    const pid = Number(parts[0]);
    const startProc = Number(parts[1] ?? '0');
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
      startProc: Number.isFinite(startProc) ? startProc : 0,
    };
  } catch {
    return { pid: 0, startProc: 0 };
  }
}

/** Идентификатор процесса из файла; `0` — файла нет или в нём не число. */
export function readPid(file: string): number {
  return readPidRecord(file).pid;
}

export function forgetDetached(files: DetachedFiles): void {
  rmSync(files.pidFile, { force: true });
  rmSync(files.addressFile, { force: true });
}

/** Жив ли процесс: сигнал `0` ничего не делает, но отвечает на вопрос существования. */
export function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM означает «процесс есть, но он не наш» — для вопроса «жив ли» это да.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Момент старта процесса относительно загрузки (Linux, поле 22 `/proc/<pid>
 * /stat`); `0` — прочитать не удалось. Имя процесса в поле 2 бывает со скобками,
 * поэтому счёт полей ведётся ПОСЛЕ последней `)`.
 */
export function processStartTicks(pid: number): number {
  if (pid <= 0) return 0;
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const starttime = Number(tail[19]);
    return Number.isFinite(starttime) ? starttime : 0;
  } catch {
    return 0;
  }
}

/**
 * Тот ли это процесс, что записан: жив И момент старта совпадает с запомненным.
 * Момент неизвестен (`startProc === 0`, не Linux) — падаем на голое
 * существование: лучшего на этой ОС нет.
 */
export function sameProcess(record: PidRecord): boolean {
  if (!pidAlive(record.pid)) return false;
  if (record.startProc === 0) return true;
  const current = processStartTicks(record.pid);
  return current === 0 || current === record.startProc;
}

/**
 * Остановка процесса, которым эта сессия не владеет (DSK-7: «Остановка
 * отвязываемого сервиса SHALL оставаться доступной приложению явной
 * операцией»). Сперва вежливо, потом — как придётся.
 *
 * Сигнал шлётся ТОЛЬКО тому процессу, чей момент старта совпадает (`record`): за
 * время между записью pid и остановкой номер мог переиспользоваться, и SIGKILL
 * постороннему процессу — куда худший исход, чем не остановленный сервис.
 */
export async function stopPid(record: PidRecord, graceMs: number): Promise<void> {
  if (!sameProcess(record)) return;
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch {
    return; // Ушёл сам между проверкой и сигналом — это и есть цель.
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && sameProcess(record)) {
    await new Promise((done) => setTimeout(done, 50));
  }
  if (!sameProcess(record)) return;
  try {
    process.kill(record.pid, 'SIGKILL');
  } catch {
    // Тот же случай: ушёл сам.
  }
}

/** Есть ли шанс, что отвязанный процесс жив: пара «pid жив» и «файл адреса есть». */
export function detachedSurvivor(
  files: DetachedFiles,
): { pid: number; startProc: number; address: string } | undefined {
  const record = readPidRecord(files.pidFile);
  // Именно ТОТ процесс, а не занявший его номер после перезагрузки.
  if (!sameProcess(record)) return undefined;
  return { ...record, address: readAddressFile(files.addressFile) };
}
