import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

describe('workflow requirements safety (real CLI, #1082)', () => {
  it('scopes and masks CI secrets, rejects missing keys, and stops a timed-out command', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-safety-')));
    const home = path.join(root, 'home'); const cwd = path.join(root, 'work');
    const secret = 'fixture-workflow-private-token';
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
      WORKFLOW_SAFETY_TOKEN: secret, WORKFLOW_OTHER_TOKEN: 'fixture-withheld-token',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
    const run = (command: string, args: string[]) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
    const call = (...args: string[]) => run(process.execPath, [cli, ...args]);
    const envelope = (stdout: string) => JSON.parse(stdout.trim().split('\n').filter((line) => line.startsWith('{')).at(-1)!);
    try {
      fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(home);
      expect(run('git', ['init', '-q', '-b', 'main']).status).toBe(0);
      fs.writeFileSync(path.join(cwd, 'README.md'), '# fixture\n');
      fs.writeFileSync(path.join(cwd, '.gitignore'), '.npmrc\n');
      expect(run('git', ['add', '.']).status).toBe(0);
      expect(run('git', ['commit', '-qm', 'fixture']).status).toBe(0);
      expect(run('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git']).status).toBe(0);
      const initialized = call('init', '--self', '--agent', 'claude', '--force');
      expect(initialized.status, initialized.stderr + initialized.stdout).toBe(0);
      const workflows = path.join(cwd, '.teamai', 'workflows'); fs.mkdirSync(workflows, { recursive: true });
      const secrets = path.join(cwd, '.teamai', 'env'); fs.mkdirSync(secrets, { recursive: true });
      fs.writeFileSync(path.join(secrets, 'secrets.yaml'), 'secrets:\n  - key: WORKFLOW_SAFETY_TOKEN\n  - key: WORKFLOW_OTHER_TOKEN\n  - key: WORKFLOW_MISSING_TOKEN\n');
      fs.writeFileSync(path.join(workflows, 'safe.yaml'), `schemaVersion: v1alpha1
name: safe
description: Scope CI credentials.
steps:
  - id: inspect
    requires: { env: [WORKFLOW_SAFETY_TOKEN] }
    command: node -e 'console.log(JSON.stringify({token:process.env.WORKFLOW_SAFETY_TOKEN,other:process.env.WORKFLOW_OTHER_TOKEN??null}))'
`);
      fs.writeFileSync(path.join(workflows, 'missing.yaml'), `schemaVersion: v1alpha1
name: missing
description: Refuse absent credentials.
steps:
  - id: inspect
    requires: { env: [WORKFLOW_MISSING_TOKEN] }
    command: echo must-not-run
`);
      fs.writeFileSync(path.join(workflows, 'deadline.yaml'), `schemaVersion: v1alpha1
name: deadline
description: Stop a command past its lease deadline.
steps:
  - id: wait
    timeout: 100ms
    command: node -e 'setTimeout(()=>process.exit(0),15000)'
`);
      fs.writeFileSync(path.join(workflows, 'setup-secret.yaml'), `schemaVersion: v1alpha1
name: setup-secret
description: Refuse a credential retained by setup.
setup:
  command: node -e 'require("fs").writeFileSync(".npmrc",process.env.WORKFLOW_OTHER_TOKEN)'
  requires: { env: [WORKFLOW_OTHER_TOKEN] }
steps:
  - id: work
    workspace: new
    command: echo must-not-run
`);
      fs.writeFileSync(path.join(workflows, 'setup-timeout.yaml'), `schemaVersion: v1alpha1
name: setup-timeout
description: Stop setup before launching work.
setup:
  command: node -e 'setInterval(()=>{},1000)'
  timeout: 100ms
steps:
  - id: work
    workspace: new
    command: echo must-not-run
`);
      const pulled = call('pull'); expect(pulled.status, pulled.stderr).toBe(0);
      const started = call('workflow', 'start', 'safe'); expect(started.status, started.stderr).toBe(0);
      const runId = envelope(started.stdout).data.run;
      const next = call('workflow', 'next', runId, '--json', JSON.stringify({ driver: { kind: 'fixture', machine: 'test', workspace: cwd, can: { env: true } } }));
      expect(next.stdout).not.toContain(secret);
      expect(envelope(next.stdout)).toMatchObject({ data: { lease: { requires: { env: ['WORKFLOW_SAFETY_TOKEN'] } } } });
      // A separate run uses the actual local executor, including its environment overlay and result artifact.
      const local = call('workflow', 'start', 'safe', '--driver', 'local');
      expect(local.status, local.stderr).toBe(0);
      expect(envelope(local.stdout)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const missing = call('workflow', 'start', 'missing', '--driver', 'local');
      expect(missing.status).toBe(1);
      expect(envelope(missing.stdout)).toMatchObject({ data: { done: { outcome: 'failed' } } });
      const before = Date.now(); const timed = call('workflow', 'start', 'deadline', '--driver', 'local');
      expect(timed.status, timed.stderr).toBe(1);
      expect(Date.now() - before).toBeLessThan(12_000);
      expect(envelope(timed.stdout)).toMatchObject({ data: { done: { outcome: 'failed' } } });
      const setup = call('workflow', 'start', 'setup-secret', '--driver', 'local');
      expect(setup.status, setup.stderr).toBe(1);
      expect(envelope(setup.stdout)).toMatchObject({ data: { done: { outcome: 'failed' } } });
      const setupBefore = Date.now(); const setupTimeout = call('workflow', 'start', 'setup-timeout', '--driver', 'local');
      expect(setupTimeout.status, setupTimeout.stderr).toBe(1);
      expect(Date.now() - setupBefore).toBeLessThan(12_000);
      expect(envelope(setupTimeout.stdout)).toMatchObject({ data: { done: { outcome: 'failed' } } });
      const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
      const stateFiles = files(path.join(home, '.teamai')).filter((file) => file.endsWith('.json') && file.includes(`${path.sep}workflows${path.sep}`));
      expect(stateFiles.length).toBeGreaterThan(3);
      const persisted = stateFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
      expect(persisted).not.toContain(secret); expect(persisted).not.toContain('fixture-withheld-token');
      expect(persisted).toContain('[REDACTED]'); expect(persisted).toContain('"other": null');
      expect(persisted).toContain('missing_env'); expect(persisted).toContain('timeout');
      expect(persisted).toContain('setup_secret');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
