import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { injectOpenClawHooks, removeOpenClawHooks, OPENCLAW_HOOK_DIR } from '../openclaw-hooks.js';
import { reconcileHooksToAllTools } from '../hooks.js';

let tmpDir: string;
let wsDir: string;
let origStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-openclaw-test-'));
  // OPENCLAW_STATE_DIR holds openclaw.json; the engine workspace lives under it.
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'openclaw.json'),
    JSON.stringify({ agents: { defaults: { workspace: wsDir } } }, null, 2),
  );
  origStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(() => {
  if (origStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = origStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('injectOpenClawHooks', () => {
  it('writes HOOK.md + handler.ts under <workspace>/hooks/teamai-status-report', async () => {
    await injectOpenClawHooks(wsDir, 'openclaw');

    // Hooks land in the resolved workspace dir, where the engine reads them.
    const dir = path.join(wsDir, 'hooks', OPENCLAW_HOOK_DIR);
    const hookMd = fs.readFileSync(path.join(dir, 'HOOK.md'), 'utf-8');
    const handler = fs.readFileSync(path.join(dir, 'handler.ts'), 'utf-8');

    expect(hookMd).toContain('metadata:');
    expect(hookMd).toContain('"openclaw"');
    expect(hookMd).toContain('session:start');
    expect(hookMd).toContain('command:new');
    expect(handler).toContain('hook-dispatch');
    expect(handler).toContain('openclaw');
    // Maps OpenClaw events to teamai dispatch events.
    expect(handler).toContain('session-start');
    expect(handler).toContain('prompt-submit');
  });

  it('enables hooks.internal.enabled in openclaw.json, preserving existing fields', async () => {
    await injectOpenClawHooks(wsDir, 'openclaw');

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'openclaw.json'), 'utf-8'));
    expect(cfg.hooks.internal.enabled).toBe(true);
    // Deep-merge must not clobber pre-existing fields.
    expect(cfg.agents.defaults.workspace).toBe(wsDir);
  });

  it('is idempotent (re-inject overwrites cleanly)', async () => {
    await injectOpenClawHooks(wsDir, 'openclaw');
    await injectOpenClawHooks(wsDir, 'openclaw');
    const dir = path.join(wsDir, 'hooks', OPENCLAW_HOOK_DIR);
    expect(fs.existsSync(path.join(dir, 'HOOK.md'))).toBe(true);
  });
});

describe('removeOpenClawHooks', () => {
  it('removes the injected hook dir and is a no-op when absent', async () => {
    const hooksDir = path.join(wsDir, 'hooks');
    await injectOpenClawHooks(wsDir, 'openclaw');
    // removeOpenClawHooks removes the passed-in hooks dir's teamai-status-report.
    await removeOpenClawHooks(hooksDir);
    expect(fs.existsSync(path.join(hooksDir, OPENCLAW_HOOK_DIR))).toBe(false);
    // second removal does not throw
    await expect(removeOpenClawHooks(hooksDir)).resolves.toBeUndefined();
  });
});

describe('reconcileHooksToAllTools routes the OpenClaw family to its adapter', () => {
    // `hooks inject` / `init` / `pull` all go through this path. Without an
    // OpenClaw branch it skipped the claw variants for lack of a `settings`
    // path, so their hooks were only ever written by the legacy migration.
    const toolPaths = { openclaw: { skills: '.openclaw/skills' } } as Record<string, { settings?: string }>;

    it('injects, then removeAll deletes, the workspace hook dir', async () => {
        const manifest = path.join(tmpDir, 'managed-hooks.json');
        const hookDir = path.join(wsDir, 'hooks', OPENCLAW_HOOK_DIR);

        await reconcileHooksToAllTools(toolPaths, tmpDir, [], manifest);
        expect(fs.existsSync(path.join(hookDir, 'handler.ts'))).toBe(true);

        await reconcileHooksToAllTools(toolPaths, tmpDir, [], manifest, { removeAll: true });
        expect(fs.existsSync(hookDir)).toBe(false);
    });

    it('does nothing when the workspace cannot be resolved', async () => {
        delete process.env.OPENCLAW_STATE_DIR;
        const home = path.join(tmpDir, 'empty-home');
        fs.mkdirSync(home, { recursive: true });
        const prevHome = process.env.HOME;
        process.env.HOME = home;
        try {
            await reconcileHooksToAllTools(toolPaths, home, [], path.join(tmpDir, 'managed-hooks.json'));
        } finally {
            if (prevHome === undefined) delete process.env.HOME;
            else process.env.HOME = prevHome;
        }
        expect(fs.existsSync(path.join(home, '.openclaw'))).toBe(false);
    });
});
