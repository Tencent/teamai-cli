/** Session storage and migration facts, declared once beside the adapter registry. */
export interface SessionPlatformFacts {
  tool: string;
  thinking: boolean;
  images: boolean;
  nativeTools: ReadonlySet<string>;
  legacyIdWithoutWorkspace: boolean;
  sqliteRegistrationOnWindows: boolean;
  idFormat: 'uuid' | 'opencode';
}

export const SESSION_PLATFORM_FACTS = {
  'claude-code': {
    tool: 'claude',
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
      'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
  },
  'claude-internal': {
    tool: 'claude-internal',
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
      'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
  },
  'tclaude': {
    tool: 'tclaude',
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
      'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
  },
  'codex': {
    tool: 'codex',
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
  },
  'codex-internal': {
    tool: 'codex-internal',
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
  },
  'tcodex': {
    tool: 'tcodex',
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
  },
  'codebuddy': {
    tool: 'codebuddy',
    thinking: true, images: false,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'task', 'todo_write',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
  },
  'codebuddy-ide': {
    tool: 'codebuddy-ide',
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
  },
  'workbuddy': {
    tool: 'workbuddy',
    thinking: true, images: false,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'task', 'todo_write',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: true,
    idFormat: 'uuid',
  },
  'cursor': {
    tool: 'cursor',
    thinking: false, images: false,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'delete_file',
      'web_fetch', 'web_search', 'semantic_search',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: true,
    idFormat: 'uuid',
  },
  'opencode': {
    tool: 'opencode',
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep', 'task', 'todo_write', 'web_fetch', 'web_search',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'opencode',
  },
} satisfies Record<string, SessionPlatformFacts>;

export function sessionPlatformFacts(platform: string): SessionPlatformFacts | undefined {
  return Object.hasOwn(SESSION_PLATFORM_FACTS, platform)
    ? SESSION_PLATFORM_FACTS[platform as keyof typeof SESSION_PLATFORM_FACTS]
    : undefined;
}

/** How each CLI continues a session; the rest are assumed to take `<platform> --resume <id>`. */
const RESUME_COMMANDS: Partial<Record<string, (sessionId: string) => string>> = {
  'claude-code': (id) => `claude --resume ${id}`,
  'codex': (id) => `codex resume ${id}`,
  'opencode': (id) => `opencode --session ${id}`,
};

/** The command that continues a restored session in its platform's CLI. */
export function resumeCommand(platform: string, sessionId: string): string {
  return RESUME_COMMANDS[platform]?.(sessionId) ?? `${platform} --resume ${sessionId}`;
}
