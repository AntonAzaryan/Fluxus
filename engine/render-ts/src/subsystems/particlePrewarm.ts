/**
 * Прогрев эффектов частиц по манифесту (REND-24) — вынесенная механика
 * `ParticlesSubsystem.prewarm`: сбор ссылок на эффекты и ожидание исхода их
 * загрузки. Сама развёртка остаётся у подсистемы (`warm` — её замыкание): пул,
 * группа и батч-рендерер — её собственность.
 */
import type { AssetService, ParticleEffectDocument, VisualManifest } from '@game-mvp/assets';
import { resolveVisualEmitter } from '@game-mvp/assets';

/**
 * Все asset id эффектов, на которые ссылается манифест: секции частиц
 * (byKind/byState/byEvent) и эмиттерные виды обоих разделов (ASSET-14).
 */
export function effectIdsOf(manifest: VisualManifest): ReadonlySet<string> {
  const ids = new Set<string>();
  const particles = manifest.particles;
  for (const section of [particles?.byKind, particles?.byState, particles?.byEvent]) {
    if (section === undefined) continue;
    for (const record of Object.values(section)) ids.add(record.effect);
  }
  const decorations = manifest.decorations ?? {};
  for (const key of [...Object.keys(manifest.entities), ...Object.keys(decorations)]) {
    const emitter = resolveVisualEmitter(manifest, key);
    if (emitter !== undefined) ids.add(emitter.effect);
  }
  return ids;
}

/**
 * Ожидание исхода загрузки каждого эффекта и его прогрев. `request` идемпотентен
 * (ASSET-2), подписка приносит текущее состояние немедленно (ASSET-4) — уже
 * доехавший документ греется сразу и промиса не задерживает. Синхронный отказ
 * конфликта видов уже пойман и обруган потребителем (`document`) — такой ассет
 * не ждётся. Не доехавший документ прогрев не держит (ASSET-4): `warm` по нему
 * просто не найдёт документа, и запись сыграет прежним ленивым путём.
 */
export function settleEffects(
  assets: AssetService,
  kind: string,
  ids: ReadonlySet<string>,
  ready: (id: string) => boolean,
  warm: (id: string) => void,
): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const id of ids) {
    if (ready(id)) {
      warm(id);
      continue;
    }
    try {
      const handle = assets.request<ParticleEffectDocument>(kind, id);
      waits.push(
        new Promise<void>((resolve) => {
          assets.subscribe(handle, (state) => {
            if (state.status !== 'loading') resolve();
          });
        }).then(() => {
          warm(id);
        }),
      );
    } catch {
      // Причина названа предупреждением потребителя — прогреву тут нечего.
    }
  }
  return Promise.all(waits).then(() => undefined);
}
