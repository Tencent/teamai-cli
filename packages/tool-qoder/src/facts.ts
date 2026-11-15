import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { tools } from './definitions.js';

/** Qoder keeps Claude Code-shaped transcripts, each build in its own home. */
const platformFacts = {
  'qoder': {
    // Qoder CLI 1.1.78 stores Claude Code-shaped transcripts under <QODER_CONFIG_DIR or QODER_CLI_HOME/.qoder or ~/.qoder>/projects.
    store: { in: 'tool-home', home: 'qoder', dir: 'projects' },
    resume: (id) => `qodercli --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
      'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    instanceSessions: true,
  },
  'qoder-cn': {
    // Qoder CN stores transcripts under <QODERCN_CONFIG_DIR or QODERCN_CLI_HOME/.qoder-cn or ~/.qoder-cn>/projects.
    store: { in: 'tool-home', home: 'qoder-cn', dir: 'projects' },
    resume: (id) => `qoderclicn --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
      'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    instanceSessions: true,
  },
} as const satisfies Record<string, SessionPlatformFacts>;

/** What every command may load of this family: its tools, its session platforms' facts and its version detectors. */
export const facts = { tools, platforms: platformFacts, detect: {} } as const satisfies ToolFamilyFacts;
