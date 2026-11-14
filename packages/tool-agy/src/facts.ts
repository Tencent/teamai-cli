import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { detect } from './detect.js';
import { tools } from './definitions.js';

/** agy keeps its conversations beside its config root, and the Antigravity app its own beside them; teamai reads them and writes none. */
const platformFacts = {
  'agy': {
    // agy 1.4.8 keeps its conversations beside its config root: ~/.gemini/antigravity-cli.
    store: { in: 'tool-home', home: 'agy', dir: '../antigravity-cli' },
    resume: (id) => `agy --conversation ${id}`,
    thinking: true, images: false,
    nativeTools: new Set(['bash', 'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'web_search', 'web_fetch', 'task']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    readOnly: true,
    instanceSessions: false,
  },
} as const satisfies Record<string, SessionPlatformFacts>;

/** What every command may load of this family: its tools, its session platforms' facts and its version detectors. */
export const facts = { tools, platforms: platformFacts, detect } as const satisfies ToolFamilyFacts;
