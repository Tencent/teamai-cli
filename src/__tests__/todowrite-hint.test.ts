import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('@teamai/shared/log', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

// The machine's own Claude Code never answers: at 2.1.119 or later its file takes the unwaited form (builtinHookForm).
vi.mock('../agent-version.js', () => ({ getAgentVersion: vi.fn(async () => '') }));

import {
  buildHintMessage,
  shouldSkipTodoWriteHint,
  getTodoWriteHintCachePath,
} from '../todowrite-hint.js';
import { DefaultFolders } from '../default-folders.js';

const todoWriteHint = await DefaultFolders.load({ kind: 'hooks', name: 'teamai-todowrite-hint' }, null);

describe('buildHintMessage', () => {
  it('contains the recall subagent reference and the [teamai:] prefix', () => {
    const msg = buildHintMessage(todoWriteHint);
    expect(msg).toContain('[teamai:todowrite-hint]');
    expect(msg).toContain('teamai-recall');
  });

  it('is bilingual (Chinese + English) so the agent has the strongest cue', () => {
    const msg = buildHintMessage(todoWriteHint);
    // Chinese prompt body
    expect(msg).toMatch(/任务/);
    // English prompt body
    expect(msg).toMatch(/Task plan detected/);
  });

  it('is English-only when the team language is en (#1014)', () => {
    const msg = buildHintMessage(todoWriteHint, 'en');
    expect(msg).toContain('[teamai:todowrite-hint]');
    expect(msg).toContain('teamai-recall');
    expect(msg).toMatch(/Task plan detected/);
    expect(msg).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('stays byte-identical to the bilingual hint when language is omitted or zh (#1014)', () => {
    const omitted = buildHintMessage(todoWriteHint);
    expect(buildHintMessage(todoWriteHint, 'zh')).toBe(omitted);
    expect(omitted).toMatch(/任务/);
    expect(omitted).toMatch(/Task plan detected/);
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

  // The hint runs in the wildcard pass since #1788, so no tool gets an entry of its own for it.
  it.each([
    ['claude', '.claude/settings.json', 'PostToolUse'],
    ['codebuddy', '.codebuddy/settings.json', 'PostToolUse'],
    ['cursor', '.cursor/hooks.json', 'postToolUse'],
  ])('injects one PostToolUse entry into %s, and none for TodoWrite', async (tool, file, event) => {
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpHome, file);
    await injectHooks(settingsPath, tool);

    const entries: { matcher?: string; command?: string; hooks?: { command: string }[] }[] = (await fse.readJson(settingsPath)).hooks?.[event] ?? [];
    const commands = entries.map((entry) => entry.command ?? entry.hooks?.[0]?.command ?? '');
    expect(commands).toEqual([expect.stringContaining(`teamai hook-dispatch post-tool-use --tool ${tool}`)]);
    expect(commands[0]).not.toContain('--matcher');
    expect(entries.map((entry) => entry.matcher)).not.toContain('TodoWrite');
  });
});

describe('todowrite hint follows teamai.yaml language (#1014)', () => {
  let tmpHome: string;
  let repo: string;

  beforeEach(async () => {
    tmpHome = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-todowrite-lang-'));
    repo = path.join(tmpHome, 'team');
    await fse.ensureDir(repo);
    vi.stubEnv('HOME', tmpHome);
    vi.stubEnv('TEAMAI_RECALL_DISABLED', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpHome);
  });

  async function hint(language?: 'en' | 'zh'): Promise<string> {
    // The hint names teamai-recall, which only a team with recall on has.
    const lines = ['team: t', 'repo: https://example.invalid/t.git', 'sharing:', '  recall:', '    enabled: true'];
    if (language) lines.push(`language: ${language}`);
    await fse.writeFile(path.join(repo, 'teamai.yaml'), `${lines.join('\n')}\n`);
    const { buildHandlerRegistry } = await import('../hook-handlers.js');
    const { LocalConfigSchema } = await import('../types.js');
    const local = LocalConfigSchema.parse({
      repo: { localPath: repo, remote: 'https://example.invalid/t.git' },
      username: 'a',
      scope: 'user',
    });
    const handler = buildHandlerRegistry().find((r) => r.handler.name === 'todowrite-hint')!.handler;
    const raw = await handler.execute(
      { tool_name: 'TodoWrite', session_id: `sid-${language ?? 'omit'}-${Date.now()}` },
      'claude',
      local,
    );
    return JSON.parse(String(raw)).hookSpecificOutput.additionalContext as string;
  }

  it('emits an English-only hint when language is en', async () => {
    const msg = await hint('en');
    expect(msg).toContain('[teamai:todowrite-hint]');
    expect(msg).toContain('teamai-recall');
    expect(msg).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('keeps the bilingual hint when language is omitted or zh', async () => {
    const omitted = await hint();
    const zh = await hint('zh');
    expect(zh).toBe(omitted);
    expect(omitted).toMatch(/任务/);
    expect(omitted).toMatch(/Task plan detected/);
  });
});

describe('the TodoWrite hint comes from the PostToolUse * pass (#1788)', () => {
  let tmpHome: string;
  let repo: string;

  beforeEach(async () => {
    tmpHome = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-todowrite-wildcard-'));
    repo = path.join(tmpHome, 'team');
    await fse.ensureDir(repo);
    await fse.writeFile(path.join(repo, 'teamai.yaml'), `${TEAM_YAML}sharing:\n  recall:\n    enabled: true\n`);
    vi.stubEnv('HOME', tmpHome);
    vi.stubEnv('TEAMAI_RECALL_DISABLED', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpHome);
  });

  const TEAM_YAML = 'team: t\nrepo: https://example.invalid/t.git\nlanguage: en\n';
  let call = 0;

  /** What the foreground of the one PostToolUse entry the tool now has replies to a `tool_name` call. */
  async function wildcardReply(tool: string, toolName = 'TodoWrite'): Promise<string | null> {
    const { buildHandlerRegistry, filterHandlersForConfig } = await import('../hook-handlers.js');
    const { createDispatcher } = await import('../hook-dispatch.js');
    const { LocalConfigSchema } = await import('../types.js');
    const local = LocalConfigSchema.parse({ repo: { localPath: repo, remote: 'https://example.invalid/t.git' }, username: 'a', scope: 'user' });
    const dispatcher = createDispatcher({ handlers: filterHandlersForConfig(buildHandlerRegistry(), local), localConfig: local });
    const result = await dispatcher.dispatch('post-tool-use', '*', { tool_name: toolName, session_id: `wildcard-${tool}-${call++}` }, tool, 'foreground');

    return result.output;
  }

  const disable = (...keys: string[]) => fse.outputFile(path.join(repo, 'hooks', 'hooks.yaml'), `builtin:\n  disabled:\n${keys.map((key) => `    - ${key}\n`).join('')}`);

  it.each(['claude', 'codebuddy', 'cursor', 'codex', 'dsh'])('nudges %s, which had the TodoWrite entry, from its wildcard pass', async (tool) => {
    expect(await wildcardReply(tool)).toContain('[teamai:todowrite-hint]');
  });

  it('says nothing for a tool call other than TodoWrite', async () => {
    expect(await wildcardReply('claude', 'Read')).toBeNull();
  });

  it.each(['opencode', 'pi', 'omp', 'agy'])('gives %s, whose adapter never installed the TodoWrite entry, no hint', async (tool) => {
    expect(await wildcardReply(tool)).toBeNull();
  });

  it.each([
    ['the retired TodoWrite key', 'Hook dispatch post-tool-use TodoWrite'],
    ['the wildcard key', 'Hook dispatch post-tool-use wildcard'],
  ])('stays off where the team lists %s under builtin.disabled', async (_case, key) => {
    await disable(key);

    expect(await wildcardReply('claude')).toBeNull();
  });

  // With recall off, pull removes the teamai-recall agent and rule the hint would send the agent to.
  it('gives no hint while recall is off, its default', async () => {
    await fse.writeFile(path.join(repo, 'teamai.yaml'), TEAM_YAML);

    expect(await wildcardReply('claude')).toBeNull();
  });

  it('stays on where the team disables another built-in', async () => {
    await disable('Hook dispatch stop');

    expect(await wildcardReply('claude')).toContain('[teamai:todowrite-hint]');
  });
});
