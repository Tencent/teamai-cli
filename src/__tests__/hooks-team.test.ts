import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let mockFiles: Record<string, unknown> = {};

vi.mock('../utils/fs.js', () => ({
  readJson: vi.fn(async (filePath: string) => mockFiles[filePath] ?? null),
  readJsonObject: vi.fn(async (filePath: string) => (filePath in mockFiles
    ? { kind: 'ok', value: mockFiles[filePath] } : { kind: 'missing' })),
  // The files these tests hold are plain JSON, which the comment-keeping writer writes as writeJson does.
  writeJsonKeepingComments: vi.fn(async (_file: string, _data: unknown, writePlain: () => Promise<void>) => writePlain()),
  writeJson: vi.fn(async (filePath: string, data: unknown) => {
    mockFiles[filePath] = JSON.parse(JSON.stringify(data));
  }),
  expandHome: (p: string) => p,
  ensureDir: vi.fn(),
  // The tool homes (tool-home.ts) look for files through it.
  pathExists: vi.fn(async () => false),
  readFileSafe: vi.fn(async () => null),
}));

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { claudeHookOtherHostSkip, reconcileHooks } from '../hooks.js';
import * as bundledRuntime from '../bundled-runtime.js';
import { useToolInstances } from '../tool-registry.js';
import type { HookDef } from '../types.js';

const SETTINGS = '/test/settings.json';
const CURSOR = '/test/hooks.json';
const MANIFEST = '/test/managed-hooks.json';

function teamDef(over: Partial<HookDef> = {}): HookDef {
  return {
    source: 'team',
    key: 'block-secret',
    event: 'PostToolUse',
    matcher: 'Bash',
    command: 'bash -lc "~/.teamai/team-scripts/scan.sh" || true',
    timeout: 15,
    description: '[teamai:hook:block-secret] scan secrets before bash',
    ...over,
  };
}

function claudeHooks(file = SETTINGS): Record<string, Array<{ matcher?: string; description?: string; hooks: Array<{ command: string }> }>> {
  return (mockFiles[file] as { hooks: Record<string, never> }).hooks as never;
}
function cursorHooks(): Record<string, Array<{ command: string; matcher?: string; timeout?: number }>> {
  return (mockFiles[CURSOR] as { hooks: Record<string, never> }).hooks as never;
}
function manifest(): Record<string, Array<{ id: string; event: string; matcher?: string; command: string }>> {
  return (mockFiles[MANIFEST] as Record<string, never>) ?? {};
}

describe('reconcileHooks — team (B) hooks', () => {
  beforeEach(() => {
    mockFiles = {};
    vi.clearAllMocks();
    // An instance of Claude Code, as a member's ~/.teamai/tools/acme-claude.yaml defines it.
    // One that shares Claude's home; one with a home of its own on Claude's command, whose hooks are in a project's
    // `.claude/settings.json`, which Cursor and Copilot load, and in its own home in user scope, which they never load;
    // and one with its own build too.
    useToolInstances(new Map([['acme-claude', {
      kind: 'instance', name: 'acme-claude', extends: 'claude',
      source: 'personal', file: '/home/.teamai/tools/acme-claude.yaml', location: '~/.teamai/tools/acme-claude.yaml', revision: 'r1',
    }], ['own-claude', {
      kind: 'instance', name: 'own-claude', extends: 'claude', home: { dir: '.own-claude' },
      source: 'personal', file: '/home/.teamai/tools/own-claude.yaml', location: '~/.teamai/tools/own-claude.yaml', revision: 'r1',
    }], ['built-claude', {
      kind: 'instance', name: 'built-claude', extends: 'claude', command: 'built-claude', home: { dir: '.built-claude' },
      source: 'personal', file: '/home/.teamai/tools/built-claude.yaml', location: '~/.teamai/tools/built-claude.yaml', revision: 'r1',
    }], ['paths-claude', {
      // Its settings file is where its paths put it, which neither loads; and one whose paths keep Claude's file, which both do.
      kind: 'instance', name: 'paths-claude', extends: 'claude', paths: { skills: '.paths-claude/skills', settings: '.paths-claude/settings.json' },
      source: 'personal', file: '/home/.teamai/tools/paths-claude.yaml', location: '~/.teamai/tools/paths-claude.yaml', revision: 'r1',
    }], ['kept-claude', {
      kind: 'instance', name: 'kept-claude', extends: 'claude', home: { dir: '.kept-claude' }, paths: { skills: '.kept-claude/skills', settings: '.claude/settings.json' },
      source: 'personal', file: '/home/.teamai/tools/kept-claude.yaml', location: '~/.teamai/tools/kept-claude.yaml', revision: 'r1',
    }]]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useToolInstances(new Map());
  });

  describe('Claude format', () => {
    it.each([
      ['claude', SETTINGS, true], ['acme-claude', SETTINGS, true], ['own-claude', '/project/.claude/settings.json', true],
      ['own-claude', '/home/.own-claude/settings.json', false], ['built-claude', '/project/.built-claude/settings.json', false],
      ['paths-claude', '/home/.paths-claude/settings.json', false], ['kept-claude', '/home/.claude/settings.json', true],
    ])('injects a team hook after the built-in hooks in its event, for %s into %s, guarded against Cursor and Copilot: %s', async (tool, file, guarded) => {
      await reconcileHooks(file, tool, [teamDef()], { manifestPath: MANIFEST });

      const postToolUse = claudeHooks(file).PostToolUse;
      expect(postToolUse).toHaveLength(2); // 1 built-in + 1 team
      const team = postToolUse[postToolUse.length - 1];
      expect(team.description).toBe('[teamai:hook:block-secret] scan secrets before bash');
      expect(team.matcher).toBe('Bash');
      expect(team.hooks[0].command).toBe(`${guarded ? claudeHookOtherHostSkip('PostToolUse', 'Bash', teamDef().command) : ''}${teamDef().command}`);
    });

    it.each([
      ['claude', SETTINGS, true], ['acme-claude', SETTINGS, true], ['own-claude', '/project/.claude/settings.json', true],
      ['own-claude', '/home/.own-claude/settings.json', false], ['built-claude', '/project/.built-claude/settings.json', false],
    ])('writes a PowerShell team command with an explicit shell on Windows, for %s into %s, guarded: %s', async (tool, file, guarded) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.spyOn(bundledRuntime, 'findGitBashWindows').mockReturnValue(null);
      await reconcileHooks(file, tool, [teamDef()], { manifestPath: MANIFEST });

      const hook = claudeHooks(file).PostToolUse.at(-1)!.hooks[0] as { command: string; shell?: string };
      expect(hook.shell).toBe('powershell');
      expect(hook.command.includes('$env:CURSOR_VERSION')).toBe(guarded);
      expect(hook.command).not.toContain('grep -q');
    });

    it('records the team hook in the manifest', async () => {
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      expect(manifest().claude).toEqual([
        { id: 'block-secret', event: 'PostToolUse', matcher: 'Bash', command: expect.stringContaining('scan.sh') },
      ]);
    });

    it('removes a team hook when it disappears from the desired set, leaving built-in intact', async () => {
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      await reconcileHooks(SETTINGS, 'claude', [], { manifestPath: MANIFEST });

      expect(claudeHooks().PostToolUse).toHaveLength(1); // built-in only
      const descs = claudeHooks().PostToolUse.map((h) => h.description);
      expect(descs.every((d) => d?.startsWith('[teamai] '))).toBe(true);
      expect(manifest().claude).toBeUndefined();
    });

    it('updates a team hook when its command changes', async () => {
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      await reconcileHooks(SETTINGS, 'claude', [teamDef({ command: 'echo changed' })], { manifestPath: MANIFEST });

      const team = claudeHooks().PostToolUse.find((h) => h.description?.startsWith('[teamai:hook:block-secret]'));
      expect(team?.hooks[0].command).toBe(`${claudeHookOtherHostSkip('PostToolUse', 'Bash', 'echo changed')}echo changed`);
      expect(claudeHooks().PostToolUse).toHaveLength(2);
    });

    it('does not touch user-authored hooks', async () => {
      mockFiles[SETTINGS] = {
        hooks: {
          PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user' }], description: 'mine' }],
        },
      };
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });

      expect(claudeHooks().PostToolUse[0]).toEqual({
        matcher: '*', hooks: [{ type: 'command', command: 'echo user' }], description: 'mine',
      });
      expect(claudeHooks().PostToolUse).toHaveLength(3); // user + 1 built-in + 1 team
    });

    it('is idempotent with team hooks present', async () => {
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      const first = JSON.stringify(mockFiles[SETTINGS]);
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      expect(JSON.stringify(mockFiles[SETTINGS])).toBe(first);
    });
  });

  describe('Cursor format (manifest-tracked)', () => {
    it('injects a team hook and records it in the manifest', async () => {
      await reconcileHooks(CURSOR, 'cursor', [teamDef()], { manifestPath: MANIFEST });

      expect(cursorHooks().postToolUse).toHaveLength(2);
      const team = cursorHooks().postToolUse.find((h) => h.command.includes('scan.sh'));
      expect(team?.command).toBe(teamDef().command);
      expect(team).toMatchObject({ matcher: 'Bash', timeout: 15 });
      expect(manifest().cursor?.[0].id).toBe('block-secret');
    });

    it('removes a stale team hook using the manifest (command carries no teamai marker)', async () => {
      await reconcileHooks(CURSOR, 'cursor', [teamDef()], { manifestPath: MANIFEST });
      await reconcileHooks(CURSOR, 'cursor', [], { manifestPath: MANIFEST });

      expect(cursorHooks().postToolUse).toHaveLength(1); // built-in only
      expect(cursorHooks().postToolUse.some((h) => h.command.includes('scan.sh'))).toBe(false);
      expect(manifest().cursor).toBeUndefined();
    });
  });

  describe('tool filtering', () => {
    it('skips a team hook whose tools list excludes the tool', async () => {
      const claudeOnly = teamDef({ tools: ['claude'] });
      await reconcileHooks(CURSOR, 'cursor', [claudeOnly], { manifestPath: MANIFEST });
      expect(cursorHooks().postToolUse).toHaveLength(1);
      expect(manifest().cursor).toBeUndefined();

      await reconcileHooks(SETTINGS, 'claude', [claudeOnly], { manifestPath: MANIFEST });
      expect(claudeHooks().PostToolUse).toHaveLength(2);
    });

    it('skips a team hook for an event Cursor does not support, but injects it for Claude', async () => {
      const preToolUse = teamDef({ key: 'pre', event: 'PreToolUse', description: '[teamai:hook:pre] x' });
      await reconcileHooks(CURSOR, 'cursor', [preToolUse], { manifestPath: MANIFEST });
      // No PreToolUse mapping for cursor → nothing injected, only built-in events present
      expect(Object.keys(cursorHooks())).toEqual(['sessionStart', 'stop', 'postToolUse', 'beforeSubmitPrompt']);

      await reconcileHooks(SETTINGS, 'claude', [preToolUse], { manifestPath: MANIFEST });
      expect(claudeHooks().PreToolUse).toHaveLength(1);
    });
  });

  describe('coexistence (§5 mixed-version safety)', () => {
    it('a built-in-only refresh (no manifest) preserves existing team hooks', async () => {
      // Team pass injects A + B.
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      expect(claudeHooks().PostToolUse).toHaveLength(2);

      // An old/builtin-only injector runs (no team context): must NOT drop the team hook.
      await reconcileHooks(SETTINGS, 'claude', []);

      const team = claudeHooks().PostToolUse.find((h) => h.description?.startsWith('[teamai:hook:block-secret]'));
      expect(team).toBeDefined();
      expect(claudeHooks().PostToolUse).toHaveLength(2);
    });

    it('Cursor: a built-in-only refresh preserves team hooks (manifest-tracked)', async () => {
      await reconcileHooks(CURSOR, 'cursor', [teamDef()], { manifestPath: MANIFEST });
      expect(cursorHooks().postToolUse).toHaveLength(2);

      await reconcileHooks(CURSOR, 'cursor', []);
      expect(cursorHooks().postToolUse.some((h) => h.command.includes('scan.sh'))).toBe(true);
      expect(cursorHooks().postToolUse).toHaveLength(2);
    });

    it('Cursor: a built-in-only refresh keeps a member hook that runs a teamai command outside the built-in markers', async () => {
      const member = 'teamai env exec -- npm test';
      mockFiles[CURSOR] = { version: 1, hooks: { postToolUse: [{ command: member }] } };

      await reconcileHooks(CURSOR, 'cursor', []);

      expect(cursorHooks().postToolUse.map((h) => h.command)).toContain(member);
    });
  });

  describe('removeAll', () => {
    it('removes both built-in and team hooks and clears the manifest', async () => {
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { removeAll: true, manifestPath: MANIFEST });

      for (const entries of Object.values(claudeHooks())) {
        expect(entries).toHaveLength(0);
      }
      expect(manifest().claude).toBeUndefined();
    });
  });
});
