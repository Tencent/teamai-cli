import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'dist', 'index.js');

function runCLI(cwd: string, home: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, 'hooks', 'inject'], {
      cwd,
      env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('issue #373 project hook isolation (real CLI)', () => {
  let sandbox: string;
  let home: string;
  let projectA: string;
  let projectB: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error('Run npm run build before e2e tests');
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-373-e2e-'));
    home = path.join(sandbox, 'home');
    projectA = path.join(sandbox, 'project-a');
    projectB = path.join(sandbox, 'project-b');
    for (const project of [projectA, projectB]) {
      fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(project, '.teamai', 'team-repo', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(project, '.teamai', 'config.yaml'), [
        'repo:',
        `  localPath: ${path.join(project, '.teamai', 'team-repo')}`,
        '  remote: https://example.test/team.git',
        'username: e2e',
        'scope: project',
        `projectRoot: ${project}`,
      ].join('\n') + '\n');
    }
    fs.writeFileSync(path.join(projectA, '.teamai', 'team-repo', 'teamai.yaml'), [
      'team: e2e-team', 'repo: https://example.test/team.git',
      'toolPaths:', '  claude:', '    settings: .claude/settings.json',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(projectB, '.teamai', 'team-repo', 'teamai.yaml'), [
      'team: e2e-team', 'repo: https://example.test/team.git',
      'toolPaths:', '  claude:', '    settings: .claude/settings.json',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(projectA, '.teamai', 'team-repo', 'hooks', 'hooks.yaml'), [
      'hooks:', '  - id: a', '    description: project a', '    event: Stop', '    command: echo A',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(projectB, '.teamai', 'team-repo', 'hooks', 'hooks.yaml'), [
      'hooks:', '  - id: b', '    description: project b', '    event: Stop', '    command: echo B',
    ].join('\n') + '\n');
  });

  afterAll(() => { if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true }); });

  it('injects both projects, gates execution by cwd, and removes only the caller project', async () => {
    const a = await runCLI(projectA, home);
    const b = await runCLI(projectB, home);
    expect(a.code, a.output).toBe(0);
    expect(b.code, b.output).toBe(0);

    const settingsPath = path.join(home, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { hooks: { Stop: Array<{ description?: string; hooks: Array<{ command: string }> }> } };
    const team = settings.hooks.Stop.filter((entry) => entry.description?.startsWith('[teamai:hook:'));
    expect(team).toHaveLength(2);
    const commandA = team.find((entry) => entry.hooks[0].command.includes('echo A'))!.hooks[0].command;
    const commandB = team.find((entry) => entry.hooks[0].command.includes('echo B'))!.hooks[0].command;
    expect(execFileSync('sh', ['-c', commandA], { cwd: projectA, encoding: 'utf8' })).toContain('A');
    expect(execFileSync('sh', ['-c', commandA], { cwd: projectB, encoding: 'utf8' })).toBe('');
    expect(execFileSync('sh', ['-c', commandB], { cwd: projectB, encoding: 'utf8' })).toContain('B');

    // A later project reconcile must not remove A's hook from shared HOME.
    expect(JSON.parse(fs.readFileSync(path.join(home, '.teamai', 'managed-hooks.json'), 'utf8')).claude).toHaveLength(2);
  });
});
