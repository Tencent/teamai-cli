import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { detect } from './detect.js';
import { tools } from './definitions.js';

/** pi and omp keep their sessions in their own homes; teamai reads them and writes none. */
const platformFacts = {
  'pi': {
    // Pi 1.4.0: PI_CODING_AGENT_SESSION_DIR or settings.sessionDir, else <PI_CODING_AGENT_DIR or ~/.pi/agent>/sessions.
    store: { in: 'tool-home', home: 'pi', dir: 'sessions' },
    resume: (id) => `pi --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'web_search', 'web_fetch', 'task']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    readOnly: true,
    instanceSessions: false,
  },
  'omp': {
    // OMP 18.12.6: <resolved profile agent root>/sessions/<cwd>/<timestamp>_<id>.jsonl.
    store: { in: 'tool-home', home: 'omp', dir: 'sessions' },
    resume: (id) => `omp --resume ${id}`,
    thinking: true, images: true,
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
