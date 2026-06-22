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
  buildHintMessage,
  shouldSkipTodoWriteHint,
  getTodoWriteHintCachePath,
} from '../todowrite-hint.js';

describe('buildHintMessage', () => {
  it('contains the recall subagent reference and the [teamai:] prefix', () => {
    const msg = buildHintMessage();
    expect(msg).toContain('[teamai:todowrite-hint]');
    expect(msg).toContain('teamai-recall');
  });

  it('is bilingual (Chinese + English) so the agent has the strongest cue', () => {
    const msg = buildHintMessage();
    // Chinese prompt body
    expect(msg).toMatch(/任务/);
    // English prompt body
    expect(msg).toMatch(/Task plan detected/);
  });
});

describe('shouldSkipTodoWriteHint — session deduplication', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-todowrite-test-'));
    await fse.ensureDir(path.join(tmpHome, '.teamai', 'sessions'));
    vi.stubEnv('HOME', tmpHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpHome);
  });

  it('returns false on the first call (no prior hint)', () => {
    expect(shouldSkipTodoWriteHint('session-A')).toBe(false);
  });

  it('returns true on the second call (already hinted)', () => {
    shouldSkipTodoWriteHint('session-B');
    expect(shouldSkipTodoWriteHint('session-B')).toBe(true);
  });

  it('treats different sessions independently', () => {
    shouldSkipTodoWriteHint('session-C');
    expect(shouldSkipTodoWriteHint('session-D')).toBe(false);
  });

  it('writes the cache file under ~/.teamai/sessions/<sid>-todowrite-hint.json', () => {
    shouldSkipTodoWriteHint('session-path-test');
    const expectedPath = getTodoWriteHintCachePath('session-path-test');
    expect(expectedPath).toContain(path.join('.teamai', 'sessions'));
    expect(expectedPath).toContain('session-path-test-todowrite-hint.json');
    expect(fse.pathExistsSync(expectedPath)).toBe(true);
  });
});

describe('hooks.ts — TodoWrite hint registration', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-hooks-todowrite-'));
    vi.stubEnv('HOME', tmpHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpHome);
  });

  it('injects TodoWrite hint into Claude settings.json with matcher=TodoWrite', async () => {
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    await injectHooks(settingsPath, 'claude');

    const settings = await fse.readJson(settingsPath);
    const postToolUse = settings.hooks?.PostToolUse ?? [];
    const hint = postToolUse.find((h: { matcher?: string }) => h.matcher === 'TodoWrite');
    expect(hint).toBeDefined();
    expect(hint.matcher).toBe('TodoWrite');
    expect(hint.hooks?.[0]?.command).toContain('teamai hook-dispatch post-tool-use');
    expect(hint.hooks?.[0]?.command).toContain('--matcher TodoWrite');
    expect(hint.hooks?.[0]?.command).toContain('--tool claude');
  });

  it('injects TodoWrite hint into CodeBuddy settings.json (PascalCase, same shape as Claude)', async () => {
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpHome, '.codebuddy', 'settings.json');
    await injectHooks(settingsPath, 'codebuddy');

    const settings = await fse.readJson(settingsPath);
    const postToolUse = settings.hooks?.PostToolUse ?? [];
    const hint = postToolUse.find((h: { matcher?: string }) => h.matcher === 'TodoWrite');
    expect(hint).toBeDefined();
    expect(hint.matcher).toBe('TodoWrite');
    expect(hint.hooks?.[0]?.command).toContain('teamai hook-dispatch post-tool-use');
    expect(hint.hooks?.[0]?.command).toContain('--matcher TodoWrite');
    expect(hint.hooks?.[0]?.command).toContain('--tool codebuddy');
  });

  it('injects TodoWrite hint into Cursor hooks.json (camelCase event keys)', async () => {
    const { injectHooks } = await import('../hooks.js');
    const hooksPath = path.join(tmpHome, '.cursor', 'hooks.json');
    await injectHooks(hooksPath, 'cursor');

    const hooksJson = await fse.readJson(hooksPath);
    const postToolUse = hooksJson.hooks?.postToolUse ?? [];
    const hint = postToolUse.find(
      (h: { command: string; matcher?: string }) =>
        h.command.includes('teamai hook-dispatch post-tool-use') && h.matcher === 'TodoWrite',
    );
    expect(hint).toBeDefined();
    expect(hint.command).toContain('--matcher TodoWrite');
    expect(hint.command).toContain('--tool cursor');
  });

  it('does NOT duplicate TodoWrite hint when injected twice', async () => {
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    await injectHooks(settingsPath, 'claude');
    await injectHooks(settingsPath, 'claude');

    const settings = await fse.readJson(settingsPath);
    const postToolUse = settings.hooks?.PostToolUse ?? [];
    const hits = postToolUse.filter(
      (h: { matcher?: string }) => h.matcher === 'TodoWrite',
    );
    expect(hits.length).toBe(1);
  });
});
