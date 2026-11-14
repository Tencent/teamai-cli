import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { tools } from './definitions.js';

/** OpenCode keeps its sessions behind its CLI, which teamai runs against its data directory. */
const platformFacts = {
  'opencode': {
    store: { in: 'xdg-data', child: 'opencode' },
    resume: (id) => `opencode --session ${id}`,
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep', 'task', 'todo_write', 'web_fetch', 'web_search',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'opencode',
    instanceSessions: true,
  },
} as const satisfies Record<string, SessionPlatformFacts>;

/** What every command may load of this family: its tools, its session platforms' facts and its version detectors. */
export const facts = { tools, platforms: platformFacts, detect: {} } as const satisfies ToolFamilyFacts;
