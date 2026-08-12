import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { injectOpenClawHooks, removeOpenClawHooks, OPENCLAW_HOOK_DIR } from '../openclaw-hooks.js';

let tmpDir: string;
let origStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-openclaw-test-'));
  origStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(() => {
  if (origStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = origStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('injectOpenClawHooks', () => {
  it('writes HOOK.md + handler.ts under <hooksDir>/teamai-status-report', async () => {
    await injectOpenClawHooks('unused-when-env-set', 'openclaw');

    // OPENCLAW_STATE_DIR is set to tmpDir, so hooks land at tmpDir/hooks/
    const dir = path.join(tmpDir, 'hooks', OPENCLAW_HOOK_DIR);
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

  it('is idempotent (re-inject overwrites cleanly)', async () => {
    await injectOpenClawHooks('unused-when-env-set', 'openclaw');
    await injectOpenClawHooks('unused-when-env-set', 'openclaw');
    const dir = path.join(tmpDir, 'hooks', OPENCLAW_HOOK_DIR);
    expect(fs.existsSync(path.join(dir, 'HOOK.md'))).toBe(true);
  });
});

describe('removeOpenClawHooks', () => {
  it('removes the injected hook dir and is a no-op when absent', async () => {
    const hooksDir = path.join(tmpDir, 'hooks');
    await injectOpenClawHooks('unused-when-env-set', 'openclaw');
    // removeOpenClawHooks checks both the passed-in dir and OPENCLAW_STATE_DIR
    await removeOpenClawHooks(hooksDir);
    expect(fs.existsSync(path.join(hooksDir, OPENCLAW_HOOK_DIR))).toBe(false);
    // second removal does not throw
    await expect(removeOpenClawHooks(hooksDir)).resolves.toBeUndefined();
  });
});
