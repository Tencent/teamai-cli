import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  },
}));

import { injectHooks, removeHooks, injectHooksToAllTools, TEAMAI_HOOK_SUBCOMMANDS, CLAUDE_TO_CURSOR_EVENTS } from '../hooks.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-hooks-e2e-'));
});

afterEach(async () => {
  await fse.remove(tmpDir);
});

function claudePath(): string {
  return path.join(tmpDir, 'claude', 'settings.json');
}

function cursorPath(): string {
  return path.join(tmpDir, 'cursor', 'hooks.json');
}

async function readResult(filePath: string): Promise<Record<string, unknown>> {
  return fse.readJson(filePath);
}

describe('hooks E2E — real file I/O', () => {
  describe('inject — full injection to temp directories', () => {
    it('creates Claude settings.json with all 4 events and 10 hooks', async () => {
      const p = claudePath();
      await injectHooks(p, 'claude');

      const result = await readResult(p);
      const hooks = result.hooks as Record<string, unknown[]>;

      expect(Object.keys(hooks)).toEqual(['SessionStart', 'Stop', 'PostToolUse', 'UserPromptSubmit']);
      expect(hooks.SessionStart).toHaveLength(2);
      expect(hooks.Stop).toHaveLength(2);
      expect(hooks.PostToolUse).toHaveLength(4);
      expect(hooks.UserPromptSubmit).toHaveLength(2);
    });

    it('creates Cursor hooks.json with all 4 events and 10 hooks', async () => {
      const p = cursorPath();
      await injectHooks(p, 'cursor');

      const result = await readResult(p);
      expect(result.version).toBe(1);
      const hooks = result.hooks as Record<string, unknown[]>;

      expect(Object.keys(hooks)).toEqual(['sessionStart', 'stop', 'postToolUse', 'beforeSubmitPrompt']);
      expect(hooks.sessionStart).toHaveLength(2);
      expect(hooks.stop).toHaveLength(2);
      expect(hooks.postToolUse).toHaveLength(4);
      expect(hooks.beforeSubmitPrompt).toHaveLength(2);
    });

    it('all TEAMAI_HOOK_SUBCOMMANDS present in Claude output', async () => {
      const p = claudePath();
      await injectHooks(p, 'claude');

      const content = await fse.readFile(p, 'utf-8');
      for (const subcmd of TEAMAI_HOOK_SUBCOMMANDS) {
        expect(content).toContain(`teamai ${subcmd}`);
      }
    });

    it('all TEAMAI_HOOK_SUBCOMMANDS present in Cursor output', async () => {
      const p = cursorPath();
      await injectHooks(p, 'cursor');

      const content = await fse.readFile(p, 'utf-8');
      for (const subcmd of TEAMAI_HOOK_SUBCOMMANDS) {
        expect(content).toContain(`teamai ${subcmd}`);
      }
    });
  });

  describe('Cursor vs Claude semantic alignment', () => {
    it('same set of teamai subcommands in both formats', async () => {
      const cp = claudePath();
      const kp = cursorPath();
      await injectHooks(cp, 'claude');
      await injectHooks(kp, 'cursor');

      const claudeContent = await fse.readFile(cp, 'utf-8');
      const cursorContent = await fse.readFile(kp, 'utf-8');

      for (const subcmd of TEAMAI_HOOK_SUBCOMMANDS) {
        expect(claudeContent).toContain(`teamai ${subcmd}`);
        expect(cursorContent).toContain(`teamai ${subcmd}`);
      }
    });

    it('event names map 1:1 via CLAUDE_TO_CURSOR_EVENTS', async () => {
      const cp = claudePath();
      const kp = cursorPath();
      await injectHooks(cp, 'claude');
      await injectHooks(kp, 'cursor');

      const claudeResult = await readResult(cp);
      const cursorResult = await readResult(kp);
      const claudeHooks = claudeResult.hooks as Record<string, unknown[]>;
      const cursorHooks = cursorResult.hooks as Record<string, unknown[]>;

      for (const [claudeEvent, cursorEvent] of Object.entries(CLAUDE_TO_CURSOR_EVENTS)) {
        expect(claudeHooks[claudeEvent]).toBeDefined();
        expect(cursorHooks[cursorEvent]).toBeDefined();
        expect(claudeHooks[claudeEvent].length).toBe(cursorHooks[cursorEvent].length);
      }
    });

    it('PostToolUse track hook uses Skill matcher in both formats', async () => {
      const cp = claudePath();
      const kp = cursorPath();
      await injectHooks(cp, 'claude');
      await injectHooks(kp, 'cursor');

      const claudeResult = await readResult(cp);
      const cursorResult = await readResult(kp);

      const claudePostTool = (claudeResult.hooks as Record<string, Array<{ matcher: string }>>).PostToolUse;
      const cursorPostTool = (cursorResult.hooks as Record<string, Array<{ matcher?: string; command: string }>>).postToolUse;

      const claudeSkillHook = claudePostTool.find((h) => h.matcher === 'Skill');
      expect(claudeSkillHook).toBeDefined();

      const cursorTrackHook = cursorPostTool.find(
        (h) => h.command.includes('teamai track') && !h.command.includes('track-slash')
      );
      expect(cursorTrackHook).toBeDefined();
      expect(cursorTrackHook?.matcher).toBe('Skill');
    });

    it('tool-specific commands use the correct --tool parameter', async () => {
      const cp = claudePath();
      const kp = cursorPath();
      await injectHooks(cp, 'claude');
      await injectHooks(kp, 'cursor');

      const claudeContent = await fse.readFile(cp, 'utf-8');
      const cursorContent = await fse.readFile(kp, 'utf-8');

      expect(claudeContent).toContain('--tool claude');
      expect(claudeContent).not.toContain('--tool cursor');

      expect(cursorContent).toContain('--tool cursor');
      expect(cursorContent).not.toContain('--tool claude');
    });
  });

  describe('idempotency', () => {
    it('double inject produces identical file content', async () => {
      const p = claudePath();
      await injectHooks(p, 'claude');
      const first = await fse.readFile(p, 'utf-8');

      await injectHooks(p, 'claude');
      const second = await fse.readFile(p, 'utf-8');

      expect(second).toBe(first);
    });

    it('double inject for Cursor produces identical file content', async () => {
      const p = cursorPath();
      await injectHooks(p, 'cursor');
      const first = await fse.readFile(p, 'utf-8');

      await injectHooks(p, 'cursor');
      const second = await fse.readFile(p, 'utf-8');

      expect(second).toBe(first);
    });
  });

  describe('remove — complete cleanup', () => {
    it('Claude: removes all teamai hooks, file remains valid JSON', async () => {
      const p = claudePath();
      await fse.ensureDir(path.dirname(p));
      await fse.writeJson(p, {
        hooks: {
          SessionStart: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'echo "user hook"' }],
              description: 'My hook',
            },
          ],
        },
        language: 'zh',
      });

      await injectHooks(p, 'claude');
      await removeHooks(p, 'claude');

      const result = await readResult(p);
      expect(result.language).toBe('zh');

      const hooks = result.hooks as Record<string, unknown[]>;
      expect(hooks.SessionStart).toHaveLength(1);
      expect(hooks.Stop).toHaveLength(0);
      expect(hooks.PostToolUse).toHaveLength(0);
      expect(hooks.UserPromptSubmit).toHaveLength(0);

      const content = await fse.readFile(p, 'utf-8');
      expect(content).not.toContain('[teamai]');
    });

    it('Cursor: removes all teamai hooks, file remains valid JSON', async () => {
      const p = cursorPath();
      await fse.ensureDir(path.dirname(p));
      await fse.writeJson(p, {
        version: 1,
        hooks: {
          sessionStart: [
            { command: 'echo "user hook"', timeout: 5 },
          ],
        },
      });

      await injectHooks(p, 'cursor');
      await removeHooks(p, 'cursor');

      const result = await readResult(p);
      expect(result.version).toBe(1);

      const hooks = result.hooks as Record<string, unknown[]>;
      expect(hooks.sessionStart).toHaveLength(1);
      expect(hooks.stop).toHaveLength(0);
      expect(hooks.postToolUse).toHaveLength(0);
      expect(hooks.beforeSubmitPrompt).toHaveLength(0);

      const content = await fse.readFile(p, 'utf-8');
      expect(content).not.toContain('teamai pull');
      expect(content).not.toContain('teamai update');
      expect(content).not.toContain('teamai track');
    });
  });

  describe('injectHooksToAllTools — multi-tool E2E', () => {
    it('injects aligned hooks into claude and cursor simultaneously', async () => {
      const originalHome = process.env.HOME;
      process.env.HOME = tmpDir;

      await injectHooksToAllTools({
        claude: { settings: '.claude/settings.json' },
        cursor: { settings: '.cursor/hooks.json' },
        codex: {},
      });

      process.env.HOME = originalHome;

      const claudeFile = path.join(tmpDir, '.claude', 'settings.json');
      const cursorFile = path.join(tmpDir, '.cursor', 'hooks.json');

      expect(await fse.pathExists(claudeFile)).toBe(true);
      expect(await fse.pathExists(cursorFile)).toBe(true);

      const claudeResult = await fse.readJson(claudeFile);
      const cursorResult = await fse.readJson(cursorFile);

      const claudeEvents = Object.keys(claudeResult.hooks);
      const cursorEvents = Object.keys(cursorResult.hooks);

      expect(claudeEvents).toHaveLength(4);
      expect(cursorEvents).toHaveLength(4);

      for (const subcmd of TEAMAI_HOOK_SUBCOMMANDS) {
        const claudeContent = JSON.stringify(claudeResult);
        const cursorContent = JSON.stringify(cursorResult);
        expect(claudeContent).toContain(`teamai ${subcmd}`);
        expect(cursorContent).toContain(`teamai ${subcmd}`);
      }

      expect(JSON.stringify(claudeResult)).toContain('--tool claude');
      expect(JSON.stringify(cursorResult)).toContain('--tool cursor');
    });
  });
});
