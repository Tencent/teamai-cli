import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const SKILL = 'compound-read';
let sandbox: string;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function usageEvents(home: string): Array<{ skill: string; tool: string }> {
  const file = path.join(home, '.teamai', 'user-usage.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    const { skill, tool } = JSON.parse(line) as { skill: string; tool: string };
    return { skill, tool };
  });
}

function runShell(command: string, home: string, cwd: string): string {
  const result = spawnSync('/bin/bash', ['-c', command], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function dispatchTool(
  home: string,
  cwd: string,
  sessionId: string,
  command: string,
  toolStatus?: 'success' | 'failure',
): RunResult {
  const payload = {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: runShell(command, home, cwd),
    ...(toolStatus === undefined ? {} : { tool_status: toolStatus }),
  };
  const result = spawnSync(process.execPath, [CLI, 'hook-dispatch', 'post-tool-use', '--tool', 'codex', '--matcher', '*', '--bg-only', '--stdin'], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), FORCE_COLOR: '0' },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('real CLI Codex compound skill read attribution (e2e)', () => {
  it('records successful reads and rejects failed readers or invalid empty commands', () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codex-compound-skill-e2e-'));
    const home = path.join(sandbox, 'home');
    const dataHome = path.join(home, '.teamai');
    const repo = path.join(dataHome, 'team-repo');
    const cwd = path.join(sandbox, 'project');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'config.yaml'), [
      'repo:', `  localPath: ${JSON.stringify(repo)}`,
      '  remote: https://example.test/team/repo.git',
      'username: tester', 'scope: user', 'updatePolicy: skip', 'enabledAgents: [codex]', '',
    ].join('\n'));
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), [
      'team: codex-compound-skill-e2e',
      'repo: https://example.test/team/repo.git',
      'provider: git',
      'usageReport: false',
      '',
    ].join('\n'));
    const skillFile = path.join(home, '.codex', 'skills', SKILL, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, '# compound read fixture\n');

    const invalidOption = dispatchTool(home, cwd, 'invalid-option', `true; cat --invalid-option "${skillFile}"`, 'failure');
    expect(invalidOption.status, `${invalidOption.stdout}${invalidOption.stderr}`).toBe(0);
    expect(usageEvents(home)).toEqual([]);

    // Codex does not include an exit code in its Bash tool response.
    const emptyCommand = dispatchTool(home, cwd, 'empty-command', `echo before\ntrue;; cat "${skillFile}"`);
    expect(emptyCommand.status, `${emptyCommand.stdout}${emptyCommand.stderr}`).toBe(0);
    expect(usageEvents(home)).toEqual([]);

    const successfulRead = dispatchTool(home, cwd, 'success', `true; cat "${skillFile}"`, 'success');
    expect(successfulRead.status, `${successfulRead.stdout}${successfulRead.stderr}`).toBe(0);

    expect(usageEvents(home)).toEqual([{ skill: SKILL, tool: 'codex' }]);
  });
});
