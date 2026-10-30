import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgedTeamHookEvents, bridgedTeamHookFile, isBridgedTeamHookTool, runBridgedTeamHooks } from '../bridged-team-hooks.js';
import { applyBridgedAgentHook, reconcileHooksToAllTools } from '../hooks.js';
import type { HookDef } from '../types.js';

describe('the team hooks a bridge runs', () => {
  const originalHome = process.env.HOME;
  let root: string;
  let project: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-bridged-')));
    process.env.HOME = path.join(root, 'home');
    project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const install = (tool: string, hooks: Record<string, unknown[]>) => {
    const file = bridgedTeamHookFile(tool);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hooks }));
  };
  const entry = (command: string, matcher = '*', id = 'team') => ({
    matcher, hooks: [{ type: 'command', command }], description: `[teamai:hook:${id}]`,
  });

  it('a PreToolUse hook on Bash blocks OMP\'s bash call with the reason the hook printed', async () => {
    install('omp', { PreToolUse: [entry('echo "Commit message names a ticket: add one" >&2; exit 2', 'Bash')] });
    const reply = await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: { command: 'git commit -m wip' } }));
    expect(reply).toEqual({ code: 0, stdout: JSON.stringify({ block: 'Commit message names a ticket: add one' }), stderr: '' });
  });

  it('when two PreToolUse hooks block, the first gives the reason and the other\'s stderr still reaches the host', async () => {
    install('omp', { PreToolUse: [
      entry('echo \'{"decision":"block","reason":"No force push"}\'', 'Bash', 'no-force-push'),
      entry('echo "Run the tests first" >&2; exit 2', 'Bash', 'tests-first'),
    ] });
    const reply = await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: { command: 'git push -f' } }));
    expect(reply).toEqual({ code: 0, stdout: JSON.stringify({ block: 'No force push' }), stderr: 'Run the tests first\n' });
  });

  it('a hook on Bash leaves OMP\'s read call alone', async () => {
    install('omp', { PreToolUse: [entry('exit 2', 'Bash')] });
    const reply = await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'read', tool_input: { path: 'README.md' } }));
    expect(reply).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('a hook gets the Claude payload: Claude\'s tool name, file_path, and the session directory', async () => {
    install('pi', { PreToolUse: [entry('cat > seen.json', 'Edit|Write')] });
    await runBridgedTeamHooks('pi', 'PreToolUse', JSON.stringify({ cwd: project, session_id: 's1', tool_name: 'write', tool_input: { path: 'src/a.ts', content: 'x' } }));
    expect(JSON.parse(fs.readFileSync(path.join(project, 'seen.json'), 'utf8'))).toEqual({
      cwd: project, session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { path: 'src/a.ts', content: 'x', file_path: 'src/a.ts' },
    });
  });

  it('a JSON permission decision of deny blocks, as in Claude Code', async () => {
    const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No writes under migrations/' } });
    install('opencode', { PreToolUse: [entry(`echo '${deny}'`, 'Write')] });
    const reply = await runBridgedTeamHooks('opencode', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'write', tool_input: { path: 'migrations/1.sql' } }));
    expect(JSON.parse(reply.stdout)).toEqual({ block: 'No writes under migrations/' });
  });

  it('UserPromptSubmit hooks add their stdout, plain or as additionalContext, to the context', async () => {
    const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Sprint 42 ends Friday.' } });
    install('omp', { UserPromptSubmit: [entry('echo "On-call: @ana"', '*', 'oncall'), entry(`echo '${json}'`, '*', 'sprint')] });
    const reply = await runBridgedTeamHooks('omp', 'UserPromptSubmit', JSON.stringify({ cwd: project, prompt: 'fix the build' }));
    expect(reply).toEqual({ code: 0, stdout: JSON.stringify({ context: 'On-call: @ana\n\nSprint 42 ends Friday.' }), stderr: '' });
  });

  it.each([
    ['a JSON decision of block', `echo '${JSON.stringify({ decision: 'block' })}'`],
    ['exit 2 with nothing on stderr', 'exit 2'],
  ])('%s blocks, naming the hook when it gives no reason', async (_case, command) => {
    install('omp', { PreToolUse: [entry(command, 'Bash', 'no-deploy')] });
    const reply = await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: { command: 'make deploy' } }));
    expect(JSON.parse(reply.stdout)).toEqual({ block: 'Blocked by team hook no-deploy' });
  });

  it('a hook that fails decides nothing, and its stderr reaches the host', async () => {
    install('omp', { PreToolUse: [entry('echo "jq: command not found" >&2; exit 127', 'Bash')] });
    const reply = await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: { command: 'ls' } }));
    expect(reply).toEqual({ code: 0, stdout: '', stderr: 'jq: command not found\n' });
  });

  it('a payload that is not JSON still runs the event\'s hooks', async () => {
    install('omp', { SessionStart: [entry('echo "Release freeze until Monday"')] });
    expect(JSON.parse((await runBridgedTeamHooks('omp', 'SessionStart', 'not json')).stdout)).toEqual({ context: 'Release freeze until Monday' });
  });

  it('Hermes gives a hook the prompt it sends as a list of parts', async () => {
    install('hermes', { UserPromptSubmit: [entry('node -e "process.stdin.on(\'data\', (d) => console.log(JSON.parse(d).prompt))"')] });
    const reply = await runBridgedTeamHooks('hermes', 'UserPromptSubmit', JSON.stringify({
      cwd: project, extra: { user_message: [{ type: 'text', text: 'fix the build' }, { type: 'image' }, { type: 'text', text: 'on main' }] },
    }));
    expect(JSON.parse(reply.stdout)).toEqual({ context: 'fix the build\non main' });
  });

  it.each([undefined, '*'])('a tool hook with matcher %s runs on every tool call', async (matcher) => {
    install('omp', { PreToolUse: [{ ...entry('exit 2'), matcher }] });
    for (const tool of ['bash', 'read']) {
      const reply = await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: tool, tool_input: {} }));
      expect(JSON.parse(reply.stdout), tool).toEqual({ block: 'Blocked by team hook team' });
    }
  });

  it('a hook that succeeds passes its stderr to the host, and one without teamai\'s id is named "team"', async () => {
    install('omp', { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "scanned 3 files" >&2' }] }] });
    expect(await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: {} })))
      .toEqual({ code: 0, stdout: '', stderr: 'scanned 3 files\n' });
    install('omp', { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 2' }] }] });
    expect(JSON.parse((await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: {} }))).stdout))
      .toEqual({ block: 'Blocked by team hook team' });
  });

  it.each([
    ['a failing hook\'s output', 'UserPromptSubmit', `echo "partial"; exit 1`],
    ['a failing hook\'s deny', 'PreToolUse', `echo '${JSON.stringify({ decision: 'block' })}'; exit 1`],
    ['JSON with no decision', 'SessionStart', `echo '${JSON.stringify({ continue: true })}'`],
  ])('%s decides nothing', async (_case, event, command) => {
    install('omp', { [event]: [entry(command, 'Bash')] });
    const reply = await runBridgedTeamHooks('omp', event, JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: {}, prompt: 'hi' }));
    expect(reply.stdout).toBe('');
  });

  it('Hermes runs a prompt hook when the payload has no extra', async () => {
    install('hermes', { UserPromptSubmit: [entry('echo "Sprint 42 ends Friday."')] });
    const reply = await runBridgedTeamHooks('hermes', 'UserPromptSubmit', JSON.stringify({ cwd: project }));
    expect(JSON.parse(reply.stdout)).toEqual({ context: 'Sprint 42 ends Friday.' });
  });

  it('the events a file has hooks on leave out an event whose entries carry no command', async () => {
    install('kiro', { SessionStart: [entry('true')], Stop: [{ matcher: '*', hooks: [] }] });
    expect([...(await bridgedTeamHookEvents('kiro')).keys()]).toEqual(['SessionStart']);
  });

  it.each([['shell', 'Bash'], ['execute_bash', 'Bash'], ['read', 'Read'], ['fs_read', 'Read'], ['write', 'Write']])(
    'a Kiro %s call is the Claude %s tool a team hook matches', async (kiroTool, claudeTool) => {
      install('kiro', { PreToolUse: [entry('exit 2', claudeTool)] });
      const reply = await runBridgedTeamHooks('kiro', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: kiroTool, tool_input: {} }));
      expect(reply.code).toBe(2);
    });

  it('only the adapter tools run team hooks through the bridge', () => {
    expect(['opencode', 'omp', 'pi', 'openclaw', 'kiro', 'hermes'].filter(isBridgedTeamHookTool)).toHaveLength(6);
    expect(['claude', 'codex', 'cursor', 'dsh', 'joycode', 'trae', 'my-tool'].filter(isBridgedTeamHookTool)).toEqual([]);
  });

  it('a hand-edited file that is not a hook file runs nothing, and says how to fix it', async () => {
    install('omp', { PreToolUse: [entry('exit 2', 'Bash'), { matcher: 'Bash', hooks: {} }] });
    const reply = await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: {} }));
    expect(reply.stdout).toBe('');
    expect(reply.stderr).toContain(`teamai: ${bridgedTeamHookFile('omp')} is not a hook file`);
    expect(reply.stderr).toContain('so no team hook runs. Delete it, then run teamai pull to write it again.');
  });

  it('a PostToolUse or Stop hook runs, and decides nothing for the host but shows its stderr', async () => {
    install('pi', { Stop: [entry('touch stopped; echo "keep going" >&2; exit 2')] });
    const reply = await runBridgedTeamHooks('pi', 'Stop', JSON.stringify({ cwd: project }));
    expect(fs.existsSync(path.join(project, 'stopped'))).toBe(true);
    expect(reply).toEqual({ code: 0, stdout: '', stderr: 'keep going\n' });
  });

  it('a UserPromptSubmit hook that refuses with exit 2 cannot block the prompt there, and its reason reaches the host', async () => {
    install('omp', { UserPromptSubmit: [entry('echo "Say which ticket this is for" >&2; exit 2')] });
    const reply = await runBridgedTeamHooks('omp', 'UserPromptSubmit', JSON.stringify({ cwd: project, prompt: 'fix it' }));
    expect(reply).toEqual({ code: 0, stdout: '', stderr: 'Say which ticket this is for\n' });
  });

  it('a hook that outlives its timeout decides nothing, and says so on stderr', async () => {
    install('omp', { PreToolUse: [{ ...entry('', 'Bash', 'slow-scan'), hooks: [{ type: 'command', command: 'sleep 5; exit 2', timeout: 0.2 }] }] });
    const reply = await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: { command: 'ls' } }));
    expect(reply).toEqual({ code: 0, stdout: '', stderr: 'teamai: team hook slow-scan timed out after 0.2s\n' });
  });

  it('a hook that times out keeps what it wrote on stderr after the timeout line', async () => {
    install('omp', { PostToolUse: [{ ...entry('', 'Bash', 'slow-lint'), hooks: [{ type: 'command', command: 'echo "linting 412 files" >&2; sleep 5', timeout: 0.5 }] }] });
    const reply = await runBridgedTeamHooks('omp', 'PostToolUse', JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: {} }));
    expect(reply.stderr).toBe('teamai: team hook slow-lint timed out after 0.5s\nlinting 412 files\n');
  });

  it('TEAMAI_HOOKS_DISABLED stops the team\'s hooks a pull applied, and leaves the agent\'s', async () => {
    install('omp', { PreToolUse: [
      entry('echo "Use --force-with-lease" >&2; exit 2', 'Bash', 'no-force-push'),
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "No rm -rf" >&2; exit 2' }], description: '[teamai:agent-hook:no-rm]' },
    ] });
    process.env.TEAMAI_HOOKS_DISABLED = '1';
    try {
      const reply = await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: {} }));
      expect(JSON.parse(reply.stdout)).toEqual({ block: 'No rm -rf' });
    } finally {
      delete process.env.TEAMAI_HOOKS_DISABLED;
    }
  });

  it('Kiro reads a block as exit 2 with the reason on stderr, and context as plain stdout', async () => {
    install('kiro', { PreToolUse: [entry('echo "Run the tests first" >&2; exit 2', 'Bash')], SessionStart: [entry('echo "Release freeze until Monday"')] });
    expect(await runBridgedTeamHooks('kiro', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'execute_bash', tool_input: { command: 'npm publish' } })))
      .toEqual({ code: 2, stdout: '', stderr: 'Run the tests first\n' });
    expect(await runBridgedTeamHooks('kiro', 'SessionStart', JSON.stringify({ cwd: project })))
      .toEqual({ code: 0, stdout: 'Release freeze until Monday\n', stderr: '' });
  });

  it('Hermes reads a block as its decision JSON, and runs SessionStart context on the first turn\'s prompt', async () => {
    install('hermes', {
      PreToolUse: [entry('echo "No force push" >&2; exit 2', 'Bash')],
      SessionStart: [entry('echo "Release freeze until Monday"')],
      UserPromptSubmit: [entry('node -e "process.stdin.on(\'data\', (d) => console.log(JSON.parse(d).prompt))"')],
    });
    const block = await runBridgedTeamHooks('hermes', 'PreToolUse', JSON.stringify({ hook_event_name: 'pre_tool_call', cwd: project, tool_name: 'terminal', tool_input: { command: 'rm -rf build' } }));
    expect(block).toEqual({ code: 0, stdout: JSON.stringify({ decision: 'block', reason: 'No force push' }), stderr: '' });
    const first = await runBridgedTeamHooks('hermes', 'UserPromptSubmit', JSON.stringify({ hook_event_name: 'pre_llm_call', cwd: project, extra: { is_first_turn: true, user_message: 'hello' } }));
    expect(first).toEqual({ code: 0, stdout: JSON.stringify({ context: 'Release freeze until Monday\n\nhello' }), stderr: '' });
    const later = await runBridgedTeamHooks('hermes', 'UserPromptSubmit', JSON.stringify({ hook_event_name: 'pre_llm_call', cwd: project, extra: { is_first_turn: false, user_message: 'again' } }));
    expect(JSON.parse(later.stdout)).toEqual({ context: 'again' });
  });

  it('Hermes gets exit 1 when a hook wrote on stderr, so it shows it as a warning and still reads the decision', async () => {
    install('hermes', {
      PreToolUse: [entry('echo "No force push" >&2; exit 2', 'Bash'), entry('echo "scanned 3 files" >&2', 'Bash')],
      PostToolUse: [entry('echo "prettier: command not found" >&2; exit 127')],
    });
    const payload = JSON.stringify({ hook_event_name: 'pre_tool_call', cwd: project, tool_name: 'terminal', tool_input: { command: 'git push -f' } });
    expect(await runBridgedTeamHooks('hermes', 'PreToolUse', payload))
      .toEqual({ code: 1, stdout: JSON.stringify({ decision: 'block', reason: 'No force push' }), stderr: 'scanned 3 files\n' });
    expect(await runBridgedTeamHooks('hermes', 'PostToolUse', JSON.stringify({ hook_event_name: 'post_tool_call', cwd: project, tool_name: 'write_file' })))
      .toEqual({ code: 1, stdout: '', stderr: 'prettier: command not found\n' });
  });
});

describe('pull delivers the team hooks to a bridged tool', () => {
  const originalHome = process.env.HOME;
  let root: string;
  let home: string;
  let project: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-bridged-pull-')));
    home = path.join(root, 'home');
    process.env.HOME = home;
    project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const manifest = () => path.join(home, '.teamai', 'managed-hooks.json');
  const teamHook = (over: Partial<HookDef> = {}): HookDef => ({
    source: 'team', key: 'no-force-push', event: 'PreToolUse', matcher: 'Bash',
    command: 'grep -Eq \'push (-f|--force)\\b\' && { echo "Use --force-with-lease" >&2; exit 2; } || true',
    timeout: 10, description: '[teamai:hook:no-force-push] Refuse a force push', ...over,
  });
  const bash = (command: string) => JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: { command } });

  it('OMP: a team PreToolUse hook reaches its file and blocks the call it names', async () => {
    fs.mkdirSync(path.join(home, '.omp', 'agent'), { recursive: true });
    await reconcileHooksToAllTools({ omp: {} }, home, [teamHook(), teamHook({ key: 'claude-only', tools: ['claude'], description: '[teamai:hook:claude-only]' })], manifest());
    const hooks = JSON.parse(fs.readFileSync(bridgedTeamHookFile('omp'), 'utf8')).hooks;
    expect(Object.keys(hooks)).toEqual(['PreToolUse']);
    expect(hooks.PreToolUse.map((e: { description: string }) => e.description)).toEqual(['[teamai:hook:no-force-push] Refuse a force push']);
    expect(JSON.parse((await runBridgedTeamHooks('omp', 'PreToolUse', bash('jj push -f origin main'))).stdout)).toEqual({ block: 'Use --force-with-lease' });
    expect((await runBridgedTeamHooks('omp', 'PreToolUse', bash('jj push origin main'))).stdout).toBe('');
  });

  it('a pull keeps the agent hook the HTTP local agent installed beside the team\'s', async () => {
    fs.mkdirSync(path.join(home, '.omp', 'agent'), { recursive: true });
    await applyBridgedAgentHook('omp', { slug: 'no-rm', event: 'PreToolUse', matcher: 'Bash', command: 'grep -q "rm -rf" && { echo "No rm -rf" >&2; exit 2; } || true' });

    await reconcileHooksToAllTools({ omp: {} }, home, [teamHook()], manifest());
    await reconcileHooksToAllTools({ omp: {} }, home, [teamHook()], manifest());

    expect(JSON.parse((await runBridgedTeamHooks('omp', 'PreToolUse', bash('rm -rf build'))).stdout)).toEqual({ block: 'No rm -rf' });
    expect(JSON.parse((await runBridgedTeamHooks('omp', 'PreToolUse', bash('jj push -f'))).stdout)).toEqual({ block: 'Use --force-with-lease' });
  });
});
