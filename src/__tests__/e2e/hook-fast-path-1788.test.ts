import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

/**
 * A tool call's hook exits before the CLI bundle loads, and its handlers still
 * run in the detached child (#1788). Real CLI, real payloads as Claude Code
 * sends them, observed through debug.log and the dashboard's events.
 */
describe.skipIf(process.platform === 'win32')('hook fast path (#1788, real CLI)', () => {
  let sandbox: string;
  let home: string;
  let project: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fast-path-')));
    home = path.join(sandbox, 'home');
    project = path.join(sandbox, 'project');
    const teamRepo = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(teamRepo, { recursive: true });
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), 'team: fast-path-e2e\nrepo: https://example.com/team.git\nprovider: git\n');
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:', `  localPath: ${teamRepo}`, '  remote: https://example.com/team.git', 'username: e2e-user', 'scope: user',
    ].join('\n'));
    env = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', CI: '', TEAMAI_MODE: '' };
    for (const name of ['TEAMAI_LAUNCHED_BY', 'TEAMAI_WORKFLOW_ATTEMPT', 'CURSOR_VERSION', 'COPILOT_PROJECT_DIR']) delete env[name];
  });

  afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const hook = (args: string[], payload: object) => spawnSync(process.execPath, [cli, 'hook-dispatch', ...args], {
    cwd: project, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 30_000,
  });

  const debugLog = () => fs.readFileSync(path.join(home, '.teamai', 'debug.log'), 'utf8');

  /** debug.log once it has a line matching `pattern`: the background child finishes after the hook returned. */
  async function waitForLog(pattern: RegExp): Promise<string> {
    for (let waited = 0; waited < 20_000; waited += 100) {
      const log = fs.existsSync(path.join(home, '.teamai', 'debug.log')) ? debugLog() : '';

      if (pattern.test(log)) return log;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`debug.log never matched ${pattern}:\n${debugLog()}`);
  }

  const readPayload = () => ({
    session_id: 's-1', transcript_path: path.join(sandbox, 't.jsonl'), cwd: project, hook_event_name: 'PostToolUse',
    tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_response: { content: 'hello' },
  });

  it('takes the fast path for a Read, and its background child records the event with the session\'s run mode', async () => {
    const result = hook(['post-tool-use', '--tool', 'claude'], readPayload());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    const log = await waitForLog(/\[hook-dispatch\] post-tool-use\/claude background: \d+ms total/);
    expect(log).toContain('[hook-dispatch] post-tool-use/claude fast path');
    const events = fs.readFileSync(path.join(home, '.teamai', 'dashboard', 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use', sessionId: 's-1', toolName: 'Read', runMode: 'attended' }));
  });

  it('runs the full dispatch for a payload without a session id', async () => {
    const { session_id: _omitted, ...payload } = readPayload();
    const result = hook(['post-tool-use', '--tool', 'claude'], payload);

    expect(result.status, result.stderr).toBe(0);
    const log = await waitForLog(/\[hook-dispatch\] post-tool-use\/claude background: \d+ms total/);
    expect(log).not.toContain('fast path');
  });
});
