import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { tools } from './definitions.js';

const platformFacts = {
  zcode: {
    store: { in: 'tool-home', home: 'zcode', dir: 'cli' },
    resume: (id) => `zcode --resume sess_${id}`,
    thinking: true,
    images: true,
    nativeTools: new Set(['Bash', 'Read', 'Write']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    readOnly: true,
    instanceSessions: false,
  },
} as const satisfies Record<string, SessionPlatformFacts>;

/** What every command may load of this family: its tool and read-only session platform. */
export const facts = { tools, platforms: platformFacts, detect: {} } as const satisfies ToolFamilyFacts;
