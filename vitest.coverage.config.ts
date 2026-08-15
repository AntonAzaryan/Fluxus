/**
 * Конфиг только для сводного покрытия: `npm run coverage` из корня.
 *
 * Имя неканоническое намеренно. Пакеты запускают тесты без конфига
 * (`npm test` → `vitest run` в каждой папке), а vitest ищет `vitest.config.*`
 * и вверх по дереву тоже — корневой файл с обычным именем перехватил бы каждый
 * пакетный прогон и попытался развернуть проекты относительно папки пакета.
 *
 * Отдельный корневой прогон нужен по одной причине: попакетное покрытие врёт.
 * `integration-ts` гоняет код core/net/render, но при запуске из папки пакета
 * этот код в отчёт не попадает — `net-ts/src/match/world.ts` выглядит на 77%,
 * тогда как в сводном прогоне он на 92%.
 *
 * Охват прогона — весь код, который гейт держит тестами: пакеты движка,
 * редактор (`editor/*`), импортёр Blender (`tools/blender-ts`) и сборка игры.
 * У сборки игры измеряется `app/` — своего `src/` у неё нет, код приложения
 * лежит в `app/`, и без этой строки демо было бы в прогоне, но не в отчёте.
 * Глоб именно `*.ts`, а не `**`: рядом с кодом там лежат `index.html`,
 * `README.md` и `bindings.json`, и провайдер пытался бы разобрать их как
 * модули.
 * Вне охвата один пакет — `desktop/shell-ts`: Electron-контейнер стоит вне
 * гейта (DSK-6), и мерить его сводным прогоном значило бы показывать ноль.
 *
 * Порогов здесь нет намеренно: процент — не цель. Отчёт полезен списком
 * неисполненного (оператор DSL, который не вызвал ни один тест; ветка
 * транспорта, куда не ходит ни один матч), а не итоговой цифрой. Защитные
 * `throw` контрактных проверок так и останутся непокрытыми — гнать их до 100%
 * значит писать тесты на текст исключений.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Пути от файла, а не от cwd: конфиг задаётся флагом и не обязан совпадать с корнем процесса. */
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      'engine/core-ts',
      'engine/net-ts',
      'engine/render-ts',
      'engine/assets-ts',
      'engine/client-ts',
      'engine/hud-ts',
      'engine/bot-ts',
      'engine/integration-ts',
      'editor/core-ts',
      'editor/ui-ts',
      'tools/blender-ts',
      'game/demo-ts',
    ].map((pkg) => root + pkg),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: root + 'coverage',
      include: [
        'engine/*/src/**',
        'editor/*/src/**',
        'tools/blender-ts/src/**',
        'game/demo-ts/app/**/*.ts',
      ],
    },
  },
});
