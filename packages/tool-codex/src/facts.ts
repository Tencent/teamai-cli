import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { tools } from './definitions.js';

/** Each Codex build keeps Codex rollouts in its own home, so its sessions stay its own. */
const platformFacts = {
  'codex': {
    store: { in: 'tool-home', home: 'codex', dir: 'sessions' },
    resume: (id) => `codex resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    instanceSessions: true,
  },
  'codex-internal': {
    store: { in: 'tool-home', home: 'codex-internal', dir: 'sessions' },
    resume: (id) => `codex-internal --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    instanceSessions: true,
  },
  'tcodex': {
    store: { in: 'tool-home', home: 'tcodex', dir: 'sessions' },
    resume: (id) => `tcodex --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    instanceSessions: true,
  },
} as const satisfies Record<string, SessionPlatformFacts>;

/**
 * What every command may load of this family: its tools and its session platforms' facts. It has no version detector:
 * `codex --version` sets up helpers in the default Codex home when CODEX_HOME is unset, and every step asks for a version.
 */
export const facts = { tools, platforms: platformFacts, detect: {} } as const satisfies ToolFamilyFacts;
