import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agyHookPayload, agyHookReply } from '../agy-hook-io.js';

// Payloads as agy 1.4.8 sends them, captured from a real session.
const COMMON = {
  conversationId: '3fa76afc-bf4b-4fab-b887-502589d2f711',
  workspacePaths: ['/work/shop'],
  transcriptPath: '/home/u/.gemini/antigravity-cli/brain/3fa76afc-bf4b-4fab-b887-502589d2f711/.system_generated/logs/transcript_full.jsonl',
  modelName: 'gemini-3.8-flash-low',
  lastUserInput: 'Draft the release notes',
};

describe('agy hook payloads', () => {
  it('gives a tool call the names a Claude Code hook reads', () => {
    expect(agyHookPayload('post-tool-use', { ...COMMON, stepIdx: 4, error: '', toolCall: { name: 'read_file', args: { Path: '/work/shop/.agents/skills/release-notes/SKILL.md' } } }))
      .toMatchObject({
        hook_event_name: 'PostToolUse',
        session_id: COMMON.conversationId,
        cwd: '/work/shop',
        tool_name: 'Read',
        tool_input: { file_path: '/work/shop/.agents/skills/release-notes/SKILL.md' },
      });
    expect(agyHookPayload('pre-tool-use', { ...COMMON, toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf build', Cwd: '/work/shop' } } }))
      .toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    expect(agyHookPayload('post-tool-use', { ...COMMON, toolCall: { name: 'view_file', args: { AbsolutePath: '/work/shop/README.md', StartLine: 1 } } }))
      .toMatchObject({ tool_name: 'Read', tool_input: { file_path: '/work/shop/README.md' } });
  });

  // PreInvocation fires before every model call of a turn; only the first one is the prompt.
  it('takes only the first invocation of a turn as the prompt', () => {
    expect(agyHookPayload('prompt-submit', { ...COMMON, invocationNum: 0, initialNumSteps: 1 }))
      .toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: 'Draft the release notes', session_id: COMMON.conversationId });
    expect(agyHookPayload('prompt-submit', { ...COMMON, invocationNum: 3, initialNumSteps: 11 })).toBeNull();
  });

  it('names the session start and stop events', () => {
    expect(agyHookPayload('session-start', COMMON)).toMatchObject({ hook_event_name: 'SessionStart', cwd: '/work/shop' });
    expect(agyHookPayload('stop', { ...COMMON, terminationReason: 'NO_TOOL_CALL' })).toMatchObject({ hook_event_name: 'Stop' });
  });
});

describe('agy hook replies', () => {
  const claudeContext = (event: string, text: string): string =>
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

  it('merges teamai and team context: session-start stays in the conversation, prompt context lasts the turn', () => {
    expect(JSON.parse(agyHookReply('session-start', { builtin: claudeContext('SessionStart', 'Team: Acme'), team: JSON.stringify({ context: 'Payments code lives in services/pay.' }) })))
      .toEqual({ injectSteps: [{ systemMessage: { systemMessage: 'Team: Acme\n\nPayments code lives in services/pay.' } }] });
    expect(JSON.parse(agyHookReply('prompt-submit', { builtin: 'Share what you learned with `teamai share`.', team: '' })))
      .toEqual({ injectSteps: [{ ephemeralMessage: 'Share what you learned with `teamai share`.' }] });
  });

  it("turns a team hook's block into agy's deny", () => {
    expect(JSON.parse(agyHookReply('pre-tool-use', { builtin: '', team: JSON.stringify({ block: 'rm -rf is not allowed here' }) })))
      .toEqual({ decision: 'deny', reason: 'rm -rf is not allowed here' });
  });

  it('writes nothing when there is nothing to say', () => {
    expect(agyHookReply('post-tool-use', { builtin: 'ignored', team: '' })).toBe('');
    expect(agyHookReply('pre-tool-use', { builtin: '', team: '' })).toBe('');
    expect(agyHookReply('session-start', { builtin: JSON.stringify({ continue: true }), team: '' })).toBe('');
  });
});

describe('agy hooks.json', () => {
  let home: string;
  let file: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hooks-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    file = path.join(home, '.gemini', 'config', 'hooks.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function load(): Promise<typeof import('../agy-hooks.js')> {
    vi.resetModules();
    return import('../agy-hooks.js');
  }

  it("adds teamai's named hook beside the member's own", async () => {
    const mine = { 'lint-checker': { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }] } };
    fs.writeFileSync(file, JSON.stringify(mine));
    const { reconcileAgyHooks, hasAgyHooks } = await load();
    await reconcileAgyHooks();
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written['lint-checker']).toEqual(mine['lint-checker']);
    expect(Object.keys(written.teamai).sort()).toEqual(['PostToolUse', 'PreInvocation', 'SessionStart', 'Stop']);
    expect(written.teamai.SessionStart[0].command).toContain('hook-dispatch session-start --tool agy');
    expect(written.teamai.PostToolUse[0]).toMatchObject({ matcher: '*' });
    expect(await hasAgyHooks()).toBe(true);
  });

  it('leaves a hooks.json it cannot parse as it is', async () => {
    fs.writeFileSync(file, '{ "lint-checker": ');
    const { reconcileAgyHooks } = await load();
    await expect(reconcileAgyHooks()).rejects.toThrow(/hooks\.json/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "lint-checker": ');
  });

  it("gives an agy event the longest of its team hooks' timeouts, so agy does not kill a slow guard first", async () => {
    const manifest = path.join(home, '.teamai', 'managed-hooks.json');
    const slow = (key: string, event: string, timeout: number) => ({
      source: 'team' as const, key, event, matcher: event === 'PreToolUse' ? 'Bash' : '', timeout,
      command: './scripts/' + key + '.sh', description: `[teamai:hook:${key}] ${key}`,
    });
    vi.resetModules();
    const { reconcileHooksToAllTools } = await import('../hooks.js');
    await reconcileHooksToAllTools({ agy: {} }, home, [slow('scan-secrets', 'PreToolUse', 120), slow('prompt-lint', 'UserPromptSubmit', 90)], manifest);
    const teamai = JSON.parse(fs.readFileSync(file, 'utf8')).teamai;
    expect(teamai.PreToolUse[0].hooks[0].timeout).toBe(120);
    expect(teamai.PreInvocation[0].timeout).toBe(90);
    expect(teamai.SessionStart[0].timeout).toBe(60);
  });

  it("removes only teamai's named hook", async () => {
    const { reconcileAgyHooks, hasAgyHooks } = await load();
    fs.writeFileSync(file, JSON.stringify({ mine: { Stop: [{ command: './done.sh' }] } }));
    await reconcileAgyHooks();
    await reconcileAgyHooks({ removeAll: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mine: { Stop: [{ command: './done.sh' }] } });
    expect(await hasAgyHooks()).toBe(false);
  });
});
