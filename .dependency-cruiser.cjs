/**
 * Архитектурные границы (`npm run lint:arch`).
 *
 * Дублирует НЕ всё: тонкие инварианты (relative-only импорты ядра, запрет
 * глобалов, чистый цикл net) живут в AST-сканере `engine/tests/guard/` и
 * guard/boundary-тестах пакетов. Здесь — межпакетный граф: циклы и то, какому
 * слою куда нельзя. severity везде error — warning в репозитории не используется.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Циклическая зависимость между модулями.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-depends-on-nothing',
      comment:
        'У детерминированного ядра ноль зависимостей: ни рендерера, ни three, ' +
        'ни других пакетов workspace, ни node_modules вообще (guard-тест ' +
        'подтверждает то же по package.json).',
      severity: 'error',
      from: { path: '^engine/core-ts/src' },
      to: {
        path: '^(engine/(render|net|client|assets|hud|bot)-ts|editor/|tools/|node_modules/)',
      },
    },
    {
      name: 'no-reverse-hud',
      comment:
        'HUD — потребитель оболочки, вершина слоёв (match-hud HUD-1): рендер, ' +
        'клиент, net и assets его не импортируют — обратная слоистость.',
      severity: 'error',
      from: { path: '^engine/(render|net|client|assets)-ts/src' },
      to: { path: '^engine/hud-ts/' },
    },
    {
      name: 'client-no-server-code',
      comment:
        'Библиотека оболочки не лезет ВНУТРЬ серверной стороны net: путь туда — ' +
        'опубликованная поверхность пакета (барьер @game-mvp/net), а не файл под ' +
        'src/server или src/lobby. Оболочке сервер не нужен вовсе, поэтому запрет ' +
        'здесь абсолютный.',
      severity: 'error',
      from: { path: '^engine/client-ts/src' },
      to: { path: '^engine/net-ts/src/(server|lobby)/' },
    },
    {
      name: 'game-no-server-code',
      comment:
        'Тот же барьер для сборки игры, и исключение названо явно, а не проходит ' +
        'по недосмотру: сборка демо — основатель сессии `local` (net-session SES-1, ' +
        'change demo-net-play D1), и MatchServer во вкладке она поднимает законно. ' +
        'Законно ИМЕННО барьером: сессия отличается от выделенной только сборкой ' +
        '(SES-2), и знать о внутренностях сервера ей для этого не требуется.',
      severity: 'error',
      from: { path: '^game/demo-ts/app' },
      to: { path: '^engine/net-ts/src/(server|lobby)/' },
    },
    {
      name: 'engine-no-content',
      comment:
        'Пакеты движка не импортируют дерево контента (game-content CONT-4): ' +
        '«Дерево контента отсутствует → тесты движка проходят полностью». Сцена, ' +
        'матч, манифест и профиль бота — документы игры, и эталон движка обязан ' +
        'краснеть от правки движка, а не от ретюна числа геймдизайнером. Читает ' +
        'их сборка игры (game/demo-ts) — ей это законно, она и есть игра.',
      severity: 'error',
      from: { path: '^engine/' },
      to: { path: '^content/' },
    },
    {
      name: 'server-no-client-code',
      comment: 'Серверная сторона net не импортирует клиентский пакет.',
      severity: 'error',
      from: { path: '^engine/net-ts/src' },
      to: { path: '^engine/client-ts/' },
    },
    {
      name: 'engine-no-authoring',
      comment:
        'Рантайм (engine/*) не тянет authoring-конвейер Blender и редактор — ' +
        'соответствует authoringBoundary-тесту (BLND-7).',
      severity: 'error',
      from: { path: '^engine/(core|net|render|assets|client|hud|bot)-ts/src' },
      to: { path: '^(tools/blender-ts/|editor/)' },
    },
    {
      name: 'no-three-outside-render-layer',
      comment:
        'three — деталь слоя представления: рендерер, клиент, editor-ui, сборка ' +
        'игры и их тесты. Ядру, net, assets и editor-core он запрещён.',
      severity: 'error',
      from: { path: '^(engine/(core|net|assets|bot)-ts|editor/core-ts|tools/)' },
      to: { path: '^node_modules/three/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.eslint.json' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
