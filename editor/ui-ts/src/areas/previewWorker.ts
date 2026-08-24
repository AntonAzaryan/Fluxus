/**
 * @contribution Воркер превью (ED-9, `client-shell` SHELL-1): здесь и только
 * здесь живёт симуляция прогона.
 *
 * Модуль намеренно пуст по смыслу — вся сборка в `scenePreview.ts`, потому что
 * её обязан уметь прогнать и тест, у которого настоящего воркера нет. Здесь
 * остаётся ровно то, что бывает только в воркере: ожидание сцены и порт.
 *
 * Сцена приходит сообщением, а не читается из дерева контента: прогонять надо
 * текущее состояние документов, включая несохранённые правки (ED-9), а они
 * живут в сессии главного потока. Обратно из воркера не уходит ничего, кроме
 * handshake и конвертов тиков (SHELL-2, SHELL-5), — записать в документы отсюда
 * нечем.
 */
import { shellPort } from '@fluxus/client';
import { isPreviewSceneMessage, startPreviewSimulation } from './scenePreview.js';

const port = shellPort(self as unknown as Worker);
let started = false;

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  // Сцена приезжает один раз: второй прогон — второй воркер, а не второй мир в
  // этом. Иначе у оболочки оказалось бы два тикера на один порт.
  if (started || !isPreviewSceneMessage(event.data)) return;
  started = true;
  startPreviewSimulation(port, event.data).shell.start();
});
