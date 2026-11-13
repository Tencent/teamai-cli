import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { tools } from './definitions.js';

/** Copilot CLI keeps one append-only event log per session in its home; teamai reads them and writes none. */
const platformFacts = {
  copilot: {
    // Copilot CLI stores one append-only events.jsonl under <Copilot home>/session-state/<id>/.
    store: { in: 'tool-home', home: 'copilot', dir: 'session-state' },
    resume: (id) => `copilot --resume ${id}`,
    thinking: false, images: false,
    nativeTools: new Set([
      'powershell', 'bash', 'view', 'edit', 'grep', 'glob', 'web_fetch', 'task',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    readOnly: true,
    instanceSessions: false,
  },
} as const satisfies Record<string, SessionPlatformFacts>;

/** What every command may load of this family: its tools, its session platforms' facts and its version detectors. */
export const facts = { tools, platforms: platformFacts, detect: {} } as const satisfies ToolFamilyFacts;
