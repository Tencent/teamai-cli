import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installOf, locate, sessionStoreDir } from '../locate.js';
import type { Host } from '../tool-home.js';
import { describeLocateMatrix, type FilesRow, type OtherRow } from './helpers/locate-matrix.js';

const CODEBUDDY_SOURCE = '@tencent-ai/codebuddy-code 2.176.0 dist/codebuddy.js: resolveCliHomeDir() is CODEBUDDY_CONFIG_DIR, else ~/.codebuddy; getHomeProjectsDir() joins "projects", "all project transcripts (.jsonl)"';
const OPENCODE_SOURCE = 'opencode v2.1.2 binary, Global.Path: data = (XDG_DATA_HOME || ~/.local/share)/opencode';
const IGNORED_ROOT = 'toolRoots takes claude, codex, cursor-data and cursor-config only (RELOCATABLE_TOOLS): an entry for an internal build is ignored for its store as for its other files';

const store = (tool: string, at: `~/${string}` | `/${string}`, rest: Omit<Partial<FilesRow>, 'tool' | 'writes' | 'reads'> = {}): FilesRow => ({
  tool, scope: 'user', existingDirs: [], installed: null, gates: 'none',
  writes: [at], reads: [{ at, when: 'always' }],
  source: 'issue #1221 matrix, Sessions column',
  ...rest,
});

const ROWS: readonly (FilesRow | OtherRow)[] = [
  store('claude', '~/.claude/projects'),
  store('claude', '~/.claude-work/projects', { toolRoots: { claude: '~/.claude-work' }, source: 'CLAUDE_CONFIG_DIR recorded by teamai init (RELOCATABLE_TOOLS)' }),
  store('claude', '~/.claude-work/projects', { scope: 'project', userToolRoots: { claude: '~/.claude-work' }, source: 'a project config that records no toolRoots follows the user config (resolveMemberToolRoots)' }),
  store('claude-internal', '~/.claude-internal/projects'),
  store('claude-internal', '~/.claude-internal/projects', { toolRoots: { 'claude-internal': '~/.ci-work' }, source: IGNORED_ROOT }),
  store('tclaude', '~/.tclaude/projects'),
  store('codex', '~/.codex/sessions'),
  store('codex', '~/.codex-work/sessions', { toolRoots: { codex: '~/.codex-work' }, source: 'CODEX_HOME recorded by teamai init (RELOCATABLE_TOOLS)' }),
  store('codex-internal', '~/.codex-internal/sessions', { toolRoots: { 'codex-internal': '~/.cx-work' }, source: IGNORED_ROOT }),
  store('tcodex', '~/.tcodex/sessions'),
  store('cursor', '~/.cursor/projects'),
  store('cursor', '~/.cursor-data/projects', { toolRoots: { 'cursor-data': '~/.cursor-data' }, source: 'cursor-agent 2026.09.28: transcripts under CURSOR_DATA_DIR (RELOCATABLE_TOOLS)' }),
  store('cursor', '~/.cursor/projects', { toolRoots: { 'cursor-config': '~/.cursor-config' }, source: 'CURSOR_CONFIG_DIR moves cli-config.json only (RELOCATABLE_TOOLS)' }),
  store('codebuddy', '~/.codebuddy/projects', { source: CODEBUDDY_SOURCE }),
  store('codebuddy', '/cb/projects', { env: { CODEBUDDY_CONFIG_DIR: '/cb' }, source: CODEBUDDY_SOURCE }),
  store('codebuddy', '/cb/projects', { toolRoots: { codebuddy: '~/.cb-work' }, env: { CODEBUDDY_CONFIG_DIR: '/cb' }, source: `${IGNORED_ROOT}, so the moved home still holds it` }),
  store('codebuddy', '/recorded/codebuddy/projects', { toolHomes: { codebuddy: '/recorded/codebuddy' }, source: `${CODEBUDDY_SOURCE}; a recorded home wins over a shell without the variable` }),
  store('workbuddy', '~/.workbuddy/projects', { source: 'WorkBuddy: <uuid>.jsonl and <uuid>.meta.json under ~/.workbuddy/projects (session-flow/adapters/workbuddy.ts)' }),
  store('opencode', '~/.local/share/opencode', { source: OPENCODE_SOURCE }),
  store('opencode', '/data/opencode', { env: { XDG_DATA_HOME: '/data' }, source: OPENCODE_SOURCE }),
  store('opencode', '~/.local/share/opencode', { env: { XDG_CONFIG_HOME: '/xdg' }, source: `${OPENCODE_SOURCE}: the config home does not move the data directory` }),
  { tool: 'copilot', scope: 'user', channel: 'none', existingDirs: [], installed: null, gates: 'none', source: 'issue #1221 matrix: Copilot keeps sessions teamai reads none of (+s)' },
  { tool: 'pi', scope: 'user', channel: 'none', existingDirs: [], installed: null, gates: 'none', source: 'Pi 0.99 dist/core/session-manager.js: JSONL under ~/.pi/agent/sessions, which teamai reads none of' },
  { tool: 'joycode', scope: 'user', channel: 'unknown', existingDirs: [], installed: null, gates: 'none', source: 'JoyCode FAQ and changelog name no session store' },
  { tool: 'my-tool', scope: 'user', channel: 'unknown', existingDirs: [], installed: null, gates: 'none', source: 'a custom tool id has no descriptor' },
];

describeLocateMatrix('sessions', ROWS);

describe('a session store on Windows when HOME is not the profile home', () => {
  const host: Host = {
    platform: 'win32', path: path.win32, home: 'D:\\member', profileHome: 'C:\\Users\\member', env: {}, toolHomes: { kind: 'missing' },
    cwd: () => 'D:\\repo', exists: async () => false, readJson: async () => ({ kind: 'missing' }),
    realpath: async (file) => file, readText: async () => null, userToolRoots: async () => undefined,
  };
  const at = (toolRoots: Record<string, string>) => installOf({ toolPaths: {} }, { scope: 'user', repo: {}, toolRoots });

  it('puts the default store under the profile home, where the tool writes it, and agrees with the adapters', async () => {
    const located = await locate('cursor', 'sessions', at({}), host);

    expect(located.channel === 'files' && located.own?.path).toBe('C:\\Users\\member\\.cursor\\projects');
    expect(sessionStoreDir('cursor', {}, host)).toBe('C:\\Users\\member\\.cursor\\projects');
  });

  it('keeps a recorded root, which teamai init accepted under HOME', async () => {
    const located = await locate('cursor', 'sessions', at({ 'cursor-data': 'D:\\member\\.cursor-data' }), host);

    expect(located.channel === 'files' && located.own?.path).toBe('D:\\member\\.cursor-data\\projects');
  });
});
