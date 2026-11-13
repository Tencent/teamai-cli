import path from 'node:path';
import type { SandboxProviderName } from './options.js';
import { SYSTEM_BIN } from './this-machine.js';

/**
 * The executable each provider runs on this machine: a name looked up on PATH, or the path the OS ships it at; none for
 * one that runs elsewhere. Every provider names one here, so whatever puts them on a PATH misses none. Its own module,
 * with no import that runs code, so a caller that wants only the names loads nothing of the runtime.
 */
export const PROVIDER_COMMANDS = {
  sbx: 'sbx',
  docker: 'docker',
  podman: 'podman',
  seatbelt: path.join(SYSTEM_BIN, 'sandbox-exec'),
  bwrap: 'bwrap',
  vercel: undefined,
} as const satisfies Record<SandboxProviderName, string | undefined>;
