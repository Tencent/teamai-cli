import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { detect } from './detect.js';
import { tools } from './definitions.js';

/** CodeBuddy keeps the CLI's and the IDE's sessions in two stores, and WorkBuddy in its own. */
const platformFacts = {
  'codebuddy': {
    // CodeBuddy 2.176.0 bundle: getHomeProjectsDir() is <CODEBUDDY_CONFIG_DIR or ~/.codebuddy>/projects.
    store: { in: 'tool-home', home: 'codebuddy', dir: 'projects' },
    resume: (id) => `codebuddy --resume ${id}`,
    thinking: true, images: false,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'task', 'todo_write',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    instanceSessions: false,
  },
  'codebuddy-ide': {
    tool: 'codebuddy-ide',
    store: { in: 'ide-history' },
    resume: (id) => `codebuddy-ide --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'write_to_file', 'edit_file', 'replace_in_file', 'delete_file',
      'bash', 'execute_command', 'grep', 'search_content', 'glob', 'list_dir', 'codebase_search',
      'web_search', 'web_fetch', 'preview_url', 'lsp', 'task', 'todo_write', 'use_skill',
      'update_memory', 'image_gen',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    instanceSessions: false,
  },
  'workbuddy': {
    store: { in: 'tool-home', home: 'workbuddy', dir: 'projects' },
    resume: (id) => `workbuddy --resume ${id}`,
    thinking: true, images: false,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'task', 'todo_write',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: true,
    idFormat: 'uuid',
    instanceSessions: false,
  },
} as const satisfies Record<string, SessionPlatformFacts>;

/** What every command may load of this family: its tools, its session platforms' facts and its version detectors. */
export const facts = { tools, platforms: platformFacts, detect } as const satisfies ToolFamilyFacts;
