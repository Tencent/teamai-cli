import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../../utils/partition.js';

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
    for (const name of ['TEAMAI_LAUNCHED_BY', 'TEAMAI_WORKFLOW_ATTEMPT', 'CURSOR_VERSION', 'COPILOT_PROJECT_DIR', 'TEAMAI_HTTP_ENDPOINT', 'TEAMAI_ENDPOINT', 'TEAMAI_API_BASE_URL']) delete env[name];
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

  describe('outside any teamai scope', () => {
    beforeEach(() => fs.rmSync(path.join(home, '.teamai', 'config.yaml')));

    it('runs no background handler on a machine that does not sync over HTTP', async () => {
      const result = hook(['post-tool-use', '--tool', 'claude'], readPayload());

      expect(result.status, result.stderr).toBe(0);
      const log = await waitForLog(/\[hook-dispatch\] post-tool-use\/claude no scope/);
      expect(log).toContain('[hook-dispatch] post-tool-use/claude fast path');
      expect(log).not.toMatch(/post-tool-use\/claude background:/);
    });

    // The HTTP local agent is the one handler that runs without a scope. Port 9 is closed, so nothing leaves the machine.
    it.each([
      ['local-agent/config.json', () => fs.writeFileSync(path.join(home, '.teamai', 'local-agent', 'config.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:9', createdAt: '2026-01-01T00:00:00.000Z', workspaceBindings: {} }))],
      ['TEAMAI_HTTP_ENDPOINT', () => { env.TEAMAI_HTTP_ENDPOINT = 'http://127.0.0.1:9'; }],
    ])('keeps the local agent\'s handler on a machine enrolled through %s', async (_case, enroll) => {
      fs.mkdirSync(path.join(home, '.teamai', 'local-agent'), { recursive: true });
      enroll();
      const result = hook(['post-tool-use', '--tool', 'claude'], readPayload());

      expect(result.status, result.stderr).toBe(0);
      const log = await waitForLog(/post-tool-use\/claude background: \d+ms total/);
      expect(log).toMatch(/background: .*local-agent-sync=\d+ms\(ok\)/);
      expect(log).not.toContain('no scope');
    });
  });

  // A scope found by any other rule than the user config keeps its handlers: the gate only reads "no scope" (#1788).
  describe('in a project scope, with no user scope', () => {
    const projectConfig = (dir: string, root = project) => {
      const teamRepo = path.join(dir, 'team-repo');
      fs.mkdirSync(teamRepo, { recursive: true });
      fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), 'team: fast-path-project\nrepo: https://example.com/project-team.git\nprovider: git\n');
      fs.writeFileSync(path.join(dir, 'config.yaml'), [
        'repo:', `  localPath: ${teamRepo}`, '  remote: https://example.com/project-team.git', 'username: e2e-user', 'scope: project', `projectRoot: ${root}`,
      ].join('\n'));
    };

    beforeEach(() => fs.rmSync(path.join(home, '.teamai', 'config.yaml')));

    it.each([
      ['set up in its partition, with no .teamai folder in the checkout', () => {
        execFileSync('git', ['init', '-q'], { cwd: project });
        const partition = path.join(home, '.teamai', 'projects', projectSlug(project));
        fs.mkdirSync(partition, { recursive: true });
        fs.writeFileSync(path.join(partition, 'anchor'), `${project}\n`);
        projectConfig(partition);
      }],
      ['installed the legacy way, in <project>/.teamai', () => {
        fs.mkdirSync(path.join(project, '.teamai'));
        projectConfig(path.join(project, '.teamai'));
      }],
    ])('runs the background handlers of a project %s', async (_case, setUp) => {
      setUp();
      const result = hook(['post-tool-use', '--tool', 'claude'], readPayload());

      expect(result.status, result.stderr).toBe(0);
      const log = await waitForLog(/post-tool-use\/claude background: \d+ms total/);
      expect(log).toMatch(/background: .*dashboard-report=\d+ms\(ok\)/);
      expect(log).not.toContain('no scope');
    });

    // A multi-repo workspace (#913): the plain parent folder holds a legacy .teamai, each repo in it its own partition.
    it('runs the background handlers of a child repo of a multi-repo workspace', async () => {
      const child = path.join(project, 'svc-a');
      fs.mkdirSync(path.join(project, '.teamai'), { recursive: true });
      projectConfig(path.join(project, '.teamai'));
      fs.mkdirSync(child);
      execFileSync('git', ['init', '-q'], { cwd: child });
      const partition = path.join(home, '.teamai', 'projects', projectSlug(child));
      fs.mkdirSync(partition, { recursive: true });
      fs.writeFileSync(path.join(partition, 'anchor'), `${child}\n`);
      projectConfig(partition, child);

      const result = hook(['post-tool-use', '--tool', 'claude'], { ...readPayload(), cwd: child });

      expect(result.status, result.stderr).toBe(0);
      const log = await waitForLog(/post-tool-use\/claude background: \d+ms total/);
      expect(log).toMatch(/background: .*dashboard-report=\d+ms\(ok\)/);
      expect(log).not.toContain('no scope');
    });
  });

  describe('a prompt', () => {
    const promptPayload = (sessionId: string) => ({
      session_id: sessionId, transcript_path: path.join(sandbox, 't.jsonl'), cwd: project, hook_event_name: 'UserPromptSubmit', prompt: 'add a test for the parser',
    });

    const totals = (log: string) => log.split('\n').filter((line) => /prompt-submit\/claude background: \d+ms total/.test(line));

    it('takes the fast path with no hint waiting, and its child records the prompt', async () => {
      const result = hook(['prompt-submit', '--tool', 'claude'], promptPayload('p-1'));

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      const log = await waitForLog(/prompt-submit\/claude background: \d+ms total/);
      expect(log).toContain('[hook-dispatch] prompt-submit/claude fast path');
      expect(totals(log)[0]).toContain('skill-mention=');
      expect(totals(log)[0]).toContain('dashboard-report=');
      const events = fs.readFileSync(path.join(home, '.teamai', 'dashboard', 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(events).toContainEqual(expect.objectContaining({ type: 'prompt_submit', sessionId: 'p-1', runMode: 'attended' }));
    });

    it('prints a waiting package hint on each of 20 prompts, and completes every background pass', async () => {
      const hintFile = path.join(home, '.teamai', 'package-hints', 'p-2.pending.json');
      fs.mkdirSync(path.dirname(hintFile), { recursive: true });

      for (let run = 0; run < 20; run++) {
        fs.writeFileSync(hintFile, JSON.stringify({ message: `Run npm install (${run})` }));
        const result = hook(['prompt-submit', '--tool', 'claude'], promptPayload('p-2'));

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe(`Run npm install (${run})`);
      }

      for (let waited = 0; waited < 30_000 && totals(debugLog()).length < 20; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(totals(debugLog())).toHaveLength(20);
      expect(debugLog()).not.toContain('prompt-submit/claude fast path');
    });
  });

  it('runs the full dispatch for a payload without a session id', async () => {
    const { session_id: _omitted, ...payload } = readPayload();
    const result = hook(['post-tool-use', '--tool', 'claude'], payload);

    expect(result.status, result.stderr).toBe(0);
    const log = await waitForLog(/\[hook-dispatch\] post-tool-use\/claude background: \d+ms total/);
    expect(log).not.toContain('fast path');
  });
});
