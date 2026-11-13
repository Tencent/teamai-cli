import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { detect } from './detect.js';
import { tools } from './definitions.js';

/** Cursor keeps the CLI's transcripts in its home, and registers the IDE's composers in its state database. */
const platformFacts = {
  'cursor': {
    // The Cursor CLI's transcripts move with CURSOR_DATA_DIR, recorded under its own root (RELOCATABLE_TOOLS).
    store: { in: 'tool-home', home: 'cursor', dir: 'projects', root: 'cursor-data' },
    resume: (id) => `cursor-agent --resume ${id}`,
    thinking: false, images: false,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'delete_file',
      'web_fetch', 'web_search', 'semantic_search',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: true,
    idFormat: 'uuid',
    instanceSessions: true,
  },
} as const satisfies Record<string, SessionPlatformFacts>;

/** What every command may load of this family: its tools, its session platforms' facts and its version detectors. */
export const facts = { tools, platforms: platformFacts, detect } as const satisfies ToolFamilyFacts;
