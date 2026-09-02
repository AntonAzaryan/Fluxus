/**
 * Стиль менеджера: тёмная ахроматическая база и один лавовый акцент.
 *
 * Взят он у редактора (`editor-ui` ED-22) как СТИЛЬ, а не как норма — решение
 * D11: два инструмента одного репозитория не должны выглядеть чужими друг другу.
 * Нормативной эта таблица не является и в требования не входит; редактор её не
 * импортирует и о ней не знает.
 *
 * Своя копия значений, а не зависимость на пакет редактора, потому что тянуть
 * ради цвета `@fluxus/editor-ui` значило бы тянуть за ним three, вьюпорт и
 * каркас рабочих областей — всё то, чего у менеджера нет и не будет.
 */

/** Токены темы: тот же лавовый акцент на тёмной базе, что у редактора. */
export const MANAGER_TOKENS = `
  --mg-canvas: #08090A;
  --mg-surface: #0E0E0E;
  --mg-raised: #181818;
  --mg-inset: #101010;
  --mg-border: #2C2C2C;
  --mg-text: #E8E8E8;
  --mg-muted: #9E9E9E;
  --mg-faint: #6E6E6E;
  --mg-accent: #FF6A2B;
  --mg-accent-bright: #FF8F4D;
  --mg-accent-wash: #2A1710;
  --mg-on-accent: #180B04;
  --mg-space: 8px;
`;

/**
 * Таблица стилей окна. Одна строка — одно правило; собирается она значением, а
 * не файлом, по той же причине, что у редактора: тема ставится страницей, а не
 * бандлером, и её состав виден из кода.
 */
export const MANAGER_STYLES = `
:root { ${MANAGER_TOKENS} }
body { margin: 0; background: var(--mg-canvas); color: var(--mg-text);
  font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; }
.mg-app { display: flex; flex-direction: column; gap: var(--mg-space); padding: var(--mg-space); }
.mg-top { display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--mg-border); padding-bottom: var(--mg-space); }
.mg-top__title { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: 0.02em; }
.mg-hosts, .mg-servers, .mg-details, .mg-launch { background: var(--mg-surface);
  border: 1px solid var(--mg-border); border-radius: 4px; padding: var(--mg-space); }
.mg-hosts__title, .mg-servers__title, .mg-details__title, .mg-launch__title {
  font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--mg-muted); margin: 0 0 var(--mg-space); }
.mg-host, .mg-server, .mg-slot { display: flex; align-items: center; gap: var(--mg-space);
  padding: 4px 0; border-bottom: 1px solid var(--mg-border); }
.mg-host--live .mg-host__label { color: var(--mg-accent-bright); }
.mg-host__url, .mg-host__version, .mg-server__address { color: var(--mg-faint); font-family: ui-monospace, monospace; }
.mg-host__state { color: var(--mg-muted); }
.mg-host__failure, .mg-notice { color: var(--mg-accent-bright); }
.mg-server--selected { background: var(--mg-accent-wash); }
.mg-server__pick { background: none; border: none; color: var(--mg-text); cursor: pointer;
  font: inherit; text-align: left; min-width: 220px; }
.mg-server__state, .mg-server__phase, .mg-server__slots { color: var(--mg-muted); min-width: 72px; }
.mg-server__restarts { color: var(--mg-muted); min-width: 108px; }
.mg-details__postmortem { color: var(--mg-accent-bright); font-family: ui-monospace, monospace; }
.mg-details__limited { color: var(--mg-muted); }
.mg-launch { display: flex; align-items: flex-end; flex-wrap: wrap; gap: var(--mg-space); }
.mg-launch__title { flex-basis: 100%; }
.mg-field { display: flex; flex-direction: column; gap: 2px; }
.mg-field__label { color: var(--mg-faint); font-size: 11px; letter-spacing: 0.04em; }
.mg-slot__name { min-width: 96px; }
.mg-slot__status { min-width: 96px; color: var(--mg-muted); }
.mg-slot--active .mg-slot__status { color: var(--mg-accent-bright); }
.mg-slot--removed .mg-slot__status, .mg-slot--rejected .mg-slot__status { color: var(--mg-faint); }
.mg-slot__rtt, .mg-slot__response, .mg-slot__snapshots, .mg-metrics { color: var(--mg-muted); font-family: ui-monospace, monospace; }
.mg-action { background: var(--mg-raised); border: 1px solid var(--mg-border); border-radius: 3px;
  color: var(--mg-text); cursor: pointer; font: inherit; padding: 2px 10px; }
.mg-action:disabled { opacity: 0.38; cursor: default; }
.mg-action--primary { background: var(--mg-accent); border-color: var(--mg-accent); color: var(--mg-on-accent); }
.mg-toggle { background: var(--mg-raised); border: 1px solid var(--mg-border); border-radius: 3px;
  color: var(--mg-muted); cursor: pointer; font: inherit; padding: 4px 12px; }
.mg-toggle--on { background: var(--mg-accent-wash); border-color: var(--mg-accent); color: var(--mg-accent-bright); }
.mg-input { background: var(--mg-inset); border: 1px solid var(--mg-border); border-radius: 3px;
  color: var(--mg-text); font: inherit; padding: 3px 8px; }
.mg-log { background: var(--mg-inset); border: 1px solid var(--mg-border); border-radius: 3px;
  color: var(--mg-muted); max-height: 180px; overflow: auto; padding: var(--mg-space); margin: 0; }
.mg-log__line { display: block; font-family: ui-monospace, monospace; white-space: pre-wrap; }
`;
