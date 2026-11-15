import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { tools } from './definitions.js';

/** JoyCode keeps Codex rollouts in its own home. */
const platformFacts = {
  'joycode': {
    store: { in: 'tool-home', home: 'joycode', dir: 'sessions' },
    resume: (id) => `joycode --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    instanceSessions: true,
  },
} as const satisfies Record<string, SessionPlatformFacts>;

/** What every command may load of this family: its tools, its session platforms' facts and its version detectors. */
export const facts = { tools, platforms: platformFacts, detect: {} } as const satisfies ToolFamilyFacts;
