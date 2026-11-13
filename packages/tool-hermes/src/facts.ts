import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { detect } from './detect.js';
import { tools } from './definitions.js';

/** Hermes keeps every profile's sessions in one SQLite store in its home; teamai reads them and writes none. */
const platformFacts = {
  hermes: {
    // Hermes Agent stores every profile's sessions in <Hermes home>/state.db; source identifies the surface.
    store: { in: 'tool-home', home: 'hermes', dir: '.' },
    resume: (id) => `hermes -c ${id}`,
    thinking: true, images: false,
    nativeTools: new Set([
      'terminal', 'read_file', 'write_file', 'patch', 'search_files', 'delegate_task',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'hermes',
    readOnly: true,
    instanceSessions: false,
  },
} as const satisfies Record<string, SessionPlatformFacts>;

/** What every command may load of this family: its tools, its session platforms' facts and its version detectors. */
export const facts = { tools, platforms: platformFacts, detect } as const satisfies ToolFamilyFacts;
