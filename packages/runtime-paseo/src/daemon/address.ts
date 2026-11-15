import path from 'node:path';
import { expandHome } from '@teamai/shared/home';
import type { RuntimeFailure } from '@teamai/runtime-protocol';
import { z } from 'zod';
import { readRegularFileSync } from '@teamai/shared/regular-file';

// ─── The daemon's address ────────────────────────────────
//
//  The daemon the runtime connects to when its definition names none: the one Paseo's own config names.
//

/** The daemon's address when Paseo's config names none, as Paseo listens by default. */
const DEFAULT_URL = 'ws://127.0.0.1:6767/ws';

const PaseoConfigSchema = z.object({ daemon: z.object({ listen: z.string().min(1).optional() }).optional() });

/** A path as Paseo expands it: `~` and `~/…` under the member's home, then resolved. */

/**
 * The WebSocket address of a daemon that listens at `listen`, read as Paseo reads its own `daemon.listen`: a Unix socket
 * path (`/…`, `~/…` or `unix://…`), a port alone on 127.0.0.1, or `host:port`. A daemon that listens on every
 * interface is reached on 127.0.0.1. Or why this runtime cannot reach it.
 */
function urlOfListen(listen: string): { url: string } | { cannot: string } {
  const trimmed = listen.trim();

  if (trimmed.startsWith('pipe://') || trimmed.startsWith('\\\\.\\pipe\\')) return { cannot: `it listens on the Windows named pipe ${trimmed}, which teamai-runtime-paseo cannot reach` };

  if (trimmed.startsWith('unix://')) return { url: `ws+unix://${path.resolve(expandHome(trimmed.slice('unix://'.length)))}:/ws` };

  if (trimmed.startsWith('/') || trimmed.startsWith('~')) return { url: `ws+unix://${path.resolve(expandHome(trimmed))}:/ws` };

  if (/^\d+$/.test(trimmed)) return { url: `ws://127.0.0.1:${trimmed}/ws` };
  const at = trimmed.lastIndexOf(':');
  const port = trimmed.slice(at + 1);

  if (at === -1 || !/^\d+$/.test(port)) return { cannot: `"${listen}" is neither a port, a host and port, nor a socket path` };
  const host = trimmed.slice(0, at).replace(/^\[(.*)\]$/, '$1');
  const reached = host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return { url: `ws://${reached.includes(':') ? `[${reached}]` : reached}:${port}/ws` };
}

/** The member's Paseo home: `PASEO_HOME`, or `~/.paseo` as Paseo defaults it. */
export const paseoHome = (env: NodeJS.ProcessEnv): string => path.resolve(expandHome(env.PASEO_HOME || '~/.paseo'));

/**
 * The address of the daemon the member's Paseo runs: the one `daemon.listen` names in Paseo's own config,
 * `$PASEO_HOME/config.json` (`PASEO_HOME` defaults to `~/.paseo`), or Paseo's default address when that config names
 * none. A config that cannot be read fails, rather than send teamai's steps to another daemon.
 */
export function daemonUrl(env: NodeJS.ProcessEnv): { url: string } | RuntimeFailure {
  const file = path.join(paseoHome(env), 'config.json');

  const cannot = (why: string): RuntimeFailure => ({
    code: 'paseo_config',
    message: `teamai-runtime-paseo could not read the Paseo daemon's address from ${file}: ${why}. Fix that file, or set the runtime's url option to the daemon's address.`,
  });

  let text: string;

  try {
    text = readRegularFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { url: DEFAULT_URL };

    return cannot(error instanceof Error ? error.message : String(error));
  }

  let config: z.infer<typeof PaseoConfigSchema>;

  try {
    const parsed = PaseoConfigSchema.safeParse(JSON.parse(text));

    if (!parsed.success) return cannot(`its daemon section is not what Paseo writes (${parsed.error.issues[0]?.message ?? 'unexpected shape'})`);
    config = parsed.data;
  } catch (error) {
    return cannot(error instanceof Error ? error.message : String(error));
  }

  const listen = config.daemon?.listen;

  if (listen === undefined) return { url: DEFAULT_URL };
  const address = urlOfListen(listen);

  return 'cannot' in address ? cannot(address.cannot) : address;
}

/** Whether `url` names a daemon on this machine: a Unix socket, or a loopback address, the only one whose host is surely this one. */
export function isOnThisMachine(url: string): boolean {
  if (url.startsWith('ws+unix://')) return true;
  const host = new URL(url).hostname.replace(/^\[(.*)\]$/, '$1');

  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

