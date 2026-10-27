/**
 * Cursor's two relocatable roots.
 *
 * Cursor CLI moves two directories — `CURSOR_DATA_DIR` for the transcripts,
 * `CURSOR_CONFIG_DIR` for `cli-config.json` — while the rest of `~/.cursor`
 * (the user `mcp.json`, `rules/`, `commands/`) stays there whatever the
 * variables say. So the two roots are recorded under `cursor-data` and
 * `cursor-config`, never under the `cursor` key the tool's `toolPaths` entry
 * uses. These cases pin down both halves: the writers that address a root
 * follow the recorded value, and `toolPaths.cursor` does not move.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import {
  CURSOR_CONFIG_TOOL_ID,
  CURSOR_DATA_TOOL_ID,
  DEFAULT_CURSOR_ROOT,
  RELOCATABLE_TOOLS,
  StateSchema,
  cursorConfigDir,
  detectToolRoot,
  scopedToolPaths,
} from '../types.js';
import type { LocalConfig, State, TeamaiConfig } from '../types.js';
import { reconcileCoAuthorForConfig } from '../coauthor-reconcile.js';
import { encodeCwdGeneric } from '../session-flow/fs.js';
import { sessionStoreDir } from '../locate.js';
import { getAdapter } from '../session-flow/adapters/index.js';
import { getCursorStateRoot } from '../session-flow/cursor-store.js';

const TOOL_PATHS = {
  claude: { skills: '.claude/skills', settings: '.claude/settings.json' },
  cursor: { skills: '.cursor/skills', settings: '.cursor/hooks.json' },
};

describe('Cursor roots', () => {
  let tmpDir: string;
  let home: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-cursor-roots-'));
    home = path.join(tmpDir, 'home');
    await fse.ensureDir(path.join(home, '.teamai'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CURSOR_DATA_DIR', '');
    vi.stubEnv('CURSOR_CONFIG_DIR', '');
    vi.stubEnv('XDG_CONFIG_HOME', '');
  });

  // Removing the fixture is I/O bound, and this box's temp volume is slow enough that the
  // 15s default occasionally loses the race; the repo declares a budget on 84 other cleanup
  // hooks for the same reason.
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  }, 60_000);

  const team = (): TeamaiConfig => ({
    team: 't',
    description: '',
    repo: 'r',
    provider: 'tgit',
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '~/.teamai/docs' },
      env: { injectShellProfile: false },
    },
    toolPaths: TOOL_PATHS,
  }) as unknown as TeamaiConfig;

  const local = (toolRoots?: Record<string, string>): LocalConfig => ({
    repo: { localPath: path.join(tmpDir, 'team-repo'), remote: 'r' },
    username: 'u',
    scope: 'user',
    additionalRoles: [],
    ...(toolRoots ? { toolRoots } : {}),
  }) as unknown as LocalConfig;

  describe('the recorded keys', () => {
    it('reads the two roots from their own variables, never from `cursor`', () => {
      const data = path.join(home, '.cursor-data');
      const config = path.join(home, '.cursor-config');

      expect(detectToolRoot(CURSOR_DATA_TOOL_ID, { CURSOR_DATA_DIR: data })).toBe(path.resolve(data));
      expect(detectToolRoot(CURSOR_CONFIG_TOOL_ID, { CURSOR_CONFIG_DIR: config })).toBe(path.resolve(config));
      // A `cursor` entry would move toolPaths.cursor, which has to stay at ~/.cursor.
      expect(RELOCATABLE_TOOLS.cursor).toBeUndefined();
    });

    it('treats an unset or blank variable as nothing to record', () => {
      expect(detectToolRoot(CURSOR_DATA_TOOL_ID, {})).toBeNull();
      expect(detectToolRoot(CURSOR_DATA_TOOL_ID, { CURSOR_DATA_DIR: '   ' })).toBeNull();
      expect(detectToolRoot(CURSOR_CONFIG_TOOL_ID, {})).toBeNull();
    });

    it('leaves toolPaths.cursor at ~/.cursor, unlike claude and codex', () => {
      const roots = {
        [CURSOR_DATA_TOOL_ID]: path.join(home, '.cursor-data'),
        [CURSOR_CONFIG_TOOL_ID]: path.join(home, '.cursor-config'),
      };

      const rooted = scopedToolPaths(team(), local(roots));

      expect(rooted.cursor).toEqual(TOOL_PATHS.cursor);

      const claude = scopedToolPaths(team(), local({ claude: path.join(home, '.claude-work') }));
      expect(claude.claude.skills).toBe('.claude-work/skills');
    });
  });

  describe('the transcript store', () => {
    it('keeps <home>/.cursor/projects when neither root is recorded', () => {
      // `os.homedir()`, which is what the fs.ts helper reads, rather than the
      // stubbed HOME: on Windows the two disagree inside vitest.
      const fallback = path.join(os.homedir(), DEFAULT_CURSOR_ROOT, 'projects');
      expect(sessionStoreDir('cursor', undefined)).toBe(fallback);
      // The config root is a separate directory and must not move the store.
      expect(sessionStoreDir('cursor', { [CURSOR_CONFIG_TOOL_ID]: path.join(home, '.cursor-config') })).toBe(fallback);
    });

    it('resolves <data root>/projects from the recorded root', () => {
      const root = path.join(home, '.cursor-data');
      expect(sessionStoreDir('cursor', { [CURSOR_DATA_TOOL_ID]: root })).toBe(path.join(root, 'projects'));
    });

    it('keeps the recorded root when the profile home is not HOME, as on Windows', () => {
      // init accepted the root under HOME; only the default store sits under the profile home.
      const root = path.join(home, '.cursor-data');
      const profile = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmpDir, 'profile'));
      try {
        expect(sessionStoreDir('cursor', { [CURSOR_DATA_TOOL_ID]: root })).toBe(path.join(root, 'projects'));
        expect(sessionStoreDir('cursor', undefined)).toBe(path.join(tmpDir, 'profile', DEFAULT_CURSOR_ROOT, 'projects'));
      } finally {
        profile.mockRestore();
      }
    });

    it('reads and writes under the recorded root, not ~/.cursor', async () => {
      const root = path.join(home, '.cursor-data');
      const toolRoots = { [CURSOR_DATA_TOOL_ID]: root };
      const cwd = path.join(home, 'work', 'alpha');
      const sessionId = '11111111-2222-3333-4444-555555555555';
      const under = (base: string, id: string): string =>
        path.join(base, 'projects', encodeCwdGeneric(cwd), 'agent-transcripts', id, `${id}.jsonl`);

      await fse.outputJson(under(root, sessionId), { role: 'user', cwd, message: { content: [{ type: 'text', text: 'relocated' }] } });
      await fse.outputJson(under(path.join(home, DEFAULT_CURSOR_ROOT), sessionId), { role: 'user', cwd, message: { content: [{ type: 'text', text: 'stale' }] } });

      const adapter = getAdapter('cursor', toolRoots);
      expect(adapter.isReady()).toBe(true);

      const listed = await adapter.listConversations();
      expect(listed.map((s) => s.filePath)).toEqual([under(root, sessionId)]);

      const read = await adapter.readSession({ sessionId, projectPath: cwd });
      expect(read.messages[0]?.content[0]).toEqual({ type: 'text', text: 'relocated' });

      const writtenId = await adapter.writeSession(
        {
          sessionId: '99999999-8888-7777-6666-555555555555',
          title: 'copy',
          cwd,
          platform: 'cursor',
          createdAt: '2026-10-01T10:00:00.000Z',
          updatedAt: '2026-10-01T10:00:00.000Z',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hello' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          ],
          metadata: {},
        },
        cwd,
      );
      expect(await fse.pathExists(under(root, writtenId))).toBe(true);
      expect(await fse.pathExists(under(path.join(home, DEFAULT_CURSOR_ROOT), writtenId))).toBe(false);
    });
  });

  describe('the config root', () => {
    it('follows CURSOR_CONFIG_DIR when one is recorded', () => {
      const root = path.join(home, '.cursor-config');
      vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
      expect(cursorConfigDir({ [CURSOR_CONFIG_TOOL_ID]: root })).toBe(root);
    });

    it('falls back to $XDG_CONFIG_HOME/cursor, then ~/.cursor', () => {
      const xdg = path.join(home, '.config');
      vi.stubEnv('XDG_CONFIG_HOME', xdg);
      expect(cursorConfigDir()).toBe(path.join(xdg, 'cursor'));

      vi.stubEnv('XDG_CONFIG_HOME', '');
      expect(cursorConfigDir()).toBe(path.join(home, DEFAULT_CURSOR_ROOT));
    });

    it('writes the co-author setting there, not to ~/.cursor', async () => {
      const root = path.join(home, '.cursor-config');
      await fse.ensureDir(path.join(home, '.cursor', 'skills'));
      await fse.ensureDir(root);

      const { changes } = await reconcileCoAuthorForConfig(
        { ...team(), sharing: { ...team().sharing, coAuthor: { enabled: false } } } as unknown as TeamaiConfig,
        local({ [CURSOR_CONFIG_TOOL_ID]: root }),
        StateSchema.parse({}) as State,
      );

      expect(changes.some((c) => c.tool === 'cursor')).toBe(true);
      expect(await fse.readJson(path.join(root, 'cli-config.json')))
        .toEqual({ attribution: { attributeCommitsToAgent: false } });
      expect(await fse.pathExists(path.join(home, DEFAULT_CURSOR_ROOT, 'cli-config.json'))).toBe(false);
    });
  });

  describe('the IDE store root', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    it('honors XDG_CONFIG_HOME on Linux, as ide-history does', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const xdg = path.join(home, 'xdg');
      vi.stubEnv('XDG_CONFIG_HOME', xdg);
      expect(getCursorStateRoot()).toBe(path.join(xdg, 'Cursor'));

      vi.stubEnv('XDG_CONFIG_HOME', undefined);
      // `os.homedir()`, which is what cursor-store reads.
      expect(getCursorStateRoot()).toBe(path.join(os.homedir(), '.config', 'Cursor'));
    });

    it('treats a blank XDG_CONFIG_HOME as unset, not as the working directory', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      vi.stubEnv('XDG_CONFIG_HOME', '');
      // `??` would keep the empty string, leaving the result a relative `Cursor`.
      expect(getCursorStateRoot()).toBe(path.join(os.homedir(), '.config', 'Cursor'));
    });
  });
});
