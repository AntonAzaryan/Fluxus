/**
 * Каталог состояния агента (решение D5): сертификат, токены, книга процессов,
 * материалы краш-постмортема (SRV-6).
 *
 * Раскладка — решение реализации, а не спеки (открытый вопрос дизайна): важно
 * лишь, что она ОДНА и названа в одном месте. Каталог по умолчанию — в домашнем
 * каталоге пользователя, потому что агент одинаково живёт и на машине
 * разработчика, и на VPS (SRV-1), а «рядом с репозиторием» на VPS не значит
 * ничего.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Переменная среды, перекрывающая каталог состояния: упаковке нужен свой. */
export const STATE_DIR_ENV = 'FLUXUS_AGENT_STATE';

export interface AgentPaths {
  /** Корень каталога состояния. */
  readonly root: string;
  readonly keyFile: string;
  readonly certFile: string;
  /** Выданные токены и живые пейринг-коды (SRV-3). */
  readonly tokensFile: string;
  /** Книга процессов: пережившие менеджер серверы (решение D5). */
  readonly bookFile: string;
  /** Корень материалов разбора крашей (SRV-6). */
  readonly crashDir: string;
}

/** Каталог состояния по умолчанию: `$FLUXUS_AGENT_STATE` либо `~/.fluxus/server-agent`. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const named = env[STATE_DIR_ENV];
  if (named !== undefined && named !== '') return named;
  return join(homedir(), '.fluxus', 'server-agent');
}

/**
 * Раскладка каталога состояния. Каталоги создаются здесь же: агент, у которого
 * первым делом не оказалось места под сертификат, не поднимется вовсе, и узнать
 * об этом лучше на старте.
 */
export function agentPaths(root: string): AgentPaths {
  mkdirSync(root, { recursive: true });
  const tls = join(root, 'tls');
  mkdirSync(tls, { recursive: true });
  const crashDir = join(root, 'crash');
  mkdirSync(crashDir, { recursive: true });
  return {
    root,
    keyFile: join(tls, 'agent.key.pem'),
    certFile: join(tls, 'agent.cert.pem'),
    tokensFile: join(root, 'tokens.json'),
    bookFile: join(root, 'book.json'),
    crashDir,
  };
}
