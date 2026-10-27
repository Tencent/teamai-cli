import type { ToolId } from '../../types.js';

/**
 * Where a platform keeps its sessions on a machine, resolved by `sessionStoreDir` (locate.ts).
 * - `tool-home`: `<dir>` in `home`'s root: the member's recorded `toolRoots[root]` (`root`
 *   defaults to `home`), else that tool's home, which a recorded or env move relocates. `home` is
 *   the tool whose `sessions` lists the platform (session-platform-facts.test.ts).
 * - `xdg-data`: `$XDG_DATA_HOME/<child>`, else `~/.local/share/<child>`.
 * - `ide-history`: the CodeBuddy IDE's own data directories (`listIdeHistoryRoots`).
 */
export type SessionStore =
  | { readonly in: 'tool-home'; readonly home: ToolId; readonly dir: string; readonly root?: string }
  | { readonly in: 'xdg-data'; readonly child: string }
  | { readonly in: 'ide-history' };

/**
 * Session storage and migration facts, declared once beside the adapter registry.
 * `tool`: only on a platform no `TOOLS` entry lists in its `sessions`, the tool id its sessions
 * are credited to (session-platform-facts.test.ts).
 */
export interface SessionPlatformFacts {
  tool?: string;
  store: SessionStore;
  /** The command that continues a session of this platform in its CLI. */
  resume: (sessionId: string) => string;
  thinking: boolean;
  images: boolean;
  nativeTools: ReadonlySet<string>;
  legacyIdWithoutWorkspace: boolean;
  sqliteRegistrationOnWindows: boolean;
  idFormat: 'uuid' | 'opencode';
}

export const SESSION_PLATFORM_FACTS = {
  'claude-code': {
    store: { in: 'tool-home', home: 'claude', dir: 'projects' },
    resume: (id) => `claude --resume ${id}`,
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
    store: { in: 'tool-home', home: 'claude-internal', dir: 'projects' },
    resume: (id) => `claude-internal --resume ${id}`,
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
    store: { in: 'tool-home', home: 'tclaude', dir: 'projects' },
    resume: (id) => `tclaude --resume ${id}`,
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
    store: { in: 'tool-home', home: 'codex', dir: 'sessions' },
    resume: (id) => `codex resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
  },
  'codex-internal': {
    store: { in: 'tool-home', home: 'codex-internal', dir: 'sessions' },
    resume: (id) => `codex-internal --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
  },
  'tcodex': {
    store: { in: 'tool-home', home: 'tcodex', dir: 'sessions' },
    resume: (id) => `tcodex --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
  },
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
  },
  'cursor': {
    // The Cursor CLI's transcripts move with CURSOR_DATA_DIR, recorded under its own root (RELOCATABLE_TOOLS).
    store: { in: 'tool-home', home: 'cursor', dir: 'projects', root: 'cursor-data' },
    resume: (id) => `cursor --resume ${id}`,
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
    store: { in: 'xdg-data', child: 'opencode' },
    resume: (id) => `opencode --session ${id}`,
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep', 'task', 'todo_write', 'web_fetch', 'web_search',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'opencode',
  },
} satisfies Record<string, SessionPlatformFacts>;

/** A platform teamai has a session adapter for. */
export type SessionPlatform = keyof typeof SESSION_PLATFORM_FACTS;

/** A platform whose store `sessionStoreDir` resolves: every one but a store its adapter finds itself. */
export type StoredSessionPlatform = {
  [P in SessionPlatform]: (typeof SESSION_PLATFORM_FACTS)[P]['store'] extends { readonly in: 'ide-history' } ? never : P
}[SessionPlatform];

export function isSessionPlatform(platform: string): platform is SessionPlatform {
  return Object.hasOwn(SESSION_PLATFORM_FACTS, platform);
}

export function sessionPlatformFacts(platform: string): SessionPlatformFacts | undefined {
  return isSessionPlatform(platform) ? SESSION_PLATFORM_FACTS[platform] : undefined;
}

/** The command that continues a restored session in its platform's CLI. */
export function resumeCommand(platform: SessionPlatform, sessionId: string): string {
  const facts: SessionPlatformFacts = SESSION_PLATFORM_FACTS[platform];
  return facts.resume(sessionId);
}
