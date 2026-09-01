/**
 * Парность источника и сцены по имени (BLND-2) — то же правило, что у парного
 * presentation-документа (`presentation-scene` PRES-1): источник сцены
 * `content/scenes/duel.scene.json` — это `content/scenes/duel.blend`, а его
 * экспорт — `content/scenes/duel.glb`.
 *
 * Ссылок между источником и документами нет ни в одну сторону и быть не должно:
 * состав полей конфига сцены закрыт (SER-7), а sidecar-карта была бы третьим
 * невидимым носителем (design, решение 4). Поэтому связь — только имя, и
 * считается она здесь, а не в трёх местах по-своему.
 *
 * База имени берётся до ПЕРВОЙ точки — тем же правилом, что `presentationPathOf`
 * модуля ассетов: `duel.scene.json` и `duel.presentation.json` имеют общую базу
 * `duel`, и источник обязан вставать в тот же ряд.
 */

/** Суффикс конфига сцены в дереве контента (SER-7, CONT-2). */
export const SCENE_SUFFIX = '.scene.json';

/** Экспорт, который кладёт рядом аддон (BLND-8) и ищет правило синхронизации (BLND-2). */
export const SOURCE_EXTENSION = '.glb';

/**
 * Расширения, которые импорт принимает на вход. Текстовая форма законна ровно
 * так же (BLND-3: формат — glTF 2.0, а не контейнер), и тесты идут от неё:
 * рукописная фикстура читается в ревью, бинарная — нет.
 */
export const SOURCE_EXTENSIONS: readonly string[] = Object.freeze(['.glb', '.gltf']);

/**
 * Сам источник level-дизайна (BLND-2) — файл Blender. Читать его не умеет и не
 * должен никто: импорт идёт от ЭКСПОРТА (BLND-1, BLND-3). Расширение это нужно
 * затем, чтобы честно ответить на вопрос «сопряжена ли сцена с конвейером»:
 * сцена, у которой `.blend` есть, а экспорта ещё нет, конвейеру принадлежит — и
 * молчать о производности её слоя нельзя.
 */
export const BLEND_EXTENSION = '.blend';

/**
 * Всё, чьё присутствие рядом со сценой делает её сопряжённой с конвейером
 * (BLND-2): экспорты в порядке предпочтения и сам источник последним. Порядок
 * значим — сверять слой можно только с экспортом, а `.blend` отвечает лишь на
 * вопрос о принадлежности сцены конвейеру.
 */
export const PAIRED_EXTENSIONS: readonly string[] = Object.freeze([
  ...SOURCE_EXTENSIONS,
  BLEND_EXTENSION,
]);

/** Каталог пути с завершающим слэшем; для верхнего уровня — пустая строка. */
function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash + 1);
}

/** База имени — до первой точки: та же, по которой находится парный документ (PRES-1). */
export function baseNameOf(path: string): string {
  const file = path.slice(directoryOf(path).length);
  const dot = file.indexOf('.');
  return dot < 0 ? file : file.slice(0, dot);
}

/** Экспорт источника, парный сцене. */
export function sourcePathOf(scenePath: string, extension: string = SOURCE_EXTENSION): string {
  return `${directoryOf(scenePath)}${baseNameOf(scenePath)}${extension}`;
}

/** Конфиг сцены, парный источнику. */
export function scenePathOf(sourcePath: string): string {
  return `${directoryOf(sourcePath)}${baseNameOf(sourcePath)}${SCENE_SUFFIX}`;
}

/** Похож ли путь на экспорт источника — по расширению, а не по содержимому. */
export function isSourcePath(path: string): boolean {
  const lower = path.toLowerCase();
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}
