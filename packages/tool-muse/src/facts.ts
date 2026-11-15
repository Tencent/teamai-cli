import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { detect } from './detect.js';
import { tools } from './definitions.js';

/** Muse Code keeps its sessions under the XDG data home; teamai reads them and writes none. */
const platformFacts = {
  muse: {
    // Muse 1.4.x: ${XDG_DATA_HOME:-~/.local/share}/muse/sessions/YYYY/MM/DD/<id>/session.jsonl.
    store: { in: 'xdg-data', child: 'muse/sessions' },
    resume: (id) => `muse resume ${id}`,
    thinking: true, images: false,
    nativeTools: new Set([
      'bash', 'read_file', 'write_file', 'edit_file', 'search', 'web_search',
      'read_memory', 'add_memory', 'edit_memory', 'todo_write', 'task',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    readOnly: true,
    instanceSessions: false,
  },
} as const satisfies Record<string, SessionPlatformFacts>;

/** What every command may load of this family: its tools, its session platforms' facts and its version detectors. */
export const facts = { tools, platforms: platformFacts, detect } as const satisfies ToolFamilyFacts;
