import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { injectOpenClawHooks, removeOpenClawHooks, OPENCLAW_HOOK_DIR } from '../openclaw-hooks.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-openclaw-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('injectOpenClawHooks', () => {
  it('writes HOOK.md + handler.ts under <hooksDir>/teamai-status-report', async () => {
    const hooksDir = path.join(tmpDir, 'hooks');
    await injectOpenClawHooks(hooksDir, 'openclaw');

    const dir = path.join(hooksDir, OPENCLAW_HOOK_DIR);
    const hookMd = fs.readFileSync(path.join(dir, 'HOOK.md'), 'utf-8');
    const handler = fs.readFileSync(path.join(dir, 'handler.ts'), 'utf-8');

    expect(hookMd).toContain('events:');
    expect(hookMd).toContain('session:start');
    expect(hookMd).toContain('command:new');
    expect(handler).toContain('hook-dispatch');
    expect(handler).toContain('openclaw');
    // Maps OpenClaw events to teamai dispatch events.
    expect(handler).toContain('session-start');
    expect(handler).toContain('prompt-submit');
  });

  it('is idempotent (re-inject overwrites cleanly)', async () => {
    const hooksDir = path.join(tmpDir, 'hooks');
    await injectOpenClawHooks(hooksDir, 'openclaw');
    await injectOpenClawHooks(hooksDir, 'openclaw');
    const dir = path.join(hooksDir, OPENCLAW_HOOK_DIR);
    expect(fs.existsSync(path.join(dir, 'HOOK.md'))).toBe(true);
  });
});

describe('removeOpenClawHooks', () => {
  it('removes the injected hook dir and is a no-op when absent', async () => {
    const hooksDir = path.join(tmpDir, 'hooks');
    await injectOpenClawHooks(hooksDir, 'openclaw');
    await removeOpenClawHooks(hooksDir);
    expect(fs.existsSync(path.join(hooksDir, OPENCLAW_HOOK_DIR))).toBe(false);
    // second removal does not throw
    await expect(removeOpenClawHooks(hooksDir)).resolves.toBeUndefined();
  });
});
