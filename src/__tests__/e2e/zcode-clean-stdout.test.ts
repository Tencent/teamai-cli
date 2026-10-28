import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const TOOL = 'zcode';

it.skipIf(process.platform === 'win32')('delivers a clean JSON reply through the generated zcode process hook and real CLI', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `teamai-${TOOL}-stdout-`)));
  try {
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const bin = path.join(root, 'shells');
    fs.mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
    fs.mkdirSync(path.join(project, '.teamai', 'rules'), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(project, '.teamai', 'rules', 'clean.md'), 'CLEAN-HOOK-CODEWORD.\n');
    const env = {
      ...process.env, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test',
      GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
      FORCE_COLOR: '0', TEAMAI_NONINTERACTIVE: '1',
    };
    const run = (command: string, args: string[]) => spawnSync(command, args, { cwd: project, env, encoding: 'utf8', timeout: 30_000 });
    for (const args of [['init', '-q', '-b', 'main'], ['remote', 'add', 'origin', 'https://127.0.0.1:9/team/clean.git'], ['add', '.'], ['commit', '-qm', 'seed']]) {
      const result = run('git', args);
      expect(result.status, result.stderr).toBe(0);
    }
    const init = run(process.execPath, [CLI, 'init', '.', '--provider', 'git', '--agent', TOOL]);
    expect(init.status, init.stdout + init.stderr).toBe(0);
    // A fake shell models noisy login startup; the hook still invokes the real dispatcher.
    fs.writeFileSync(path.join(bin, 'bash'), '#!/bin/sh\nif [ "$1" = "-lc" ]; then\n printf "profile banner\\n"\n shift\n exec /bin/bash -c "$@"\nfi\nexec /bin/bash "$@"\n', { mode: 0o755 });
    const configFile = path.join(home, '.zcode', 'cli', 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const entry = config.hooks.events.SessionStart[0].hooks[0];
    const result = spawnSync(entry.command, entry.args, {
      cwd: project, env: { ...env, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
      input: JSON.stringify({ cwd: project, hook_event_name: 'SessionStart', source: 'startup' }),
      encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('CLEAN-HOOK-CODEWORD');
    expect(result.stdout).not.toContain('profile banner');
  } finally {
    await waitForDetachedChildren();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


it.skipIf(process.platform === 'win32')('delivers user-scope context without a login PATH or a project git-hook wrapper', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `teamai-${TOOL}-user-stdout-`)));
  try {
    const home = path.join(root, 'home');
    const seed = path.join(root, 'seed');
    const repo = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(path.join(seed, 'rules'), { recursive: true });
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    fs.mkdirSync(path.join(home, TOOL === 'zcode' ? '.zcode/cli' : '.dsh'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), `team: user-hook
repo: ${seed}
provider: git
usageReport: false
`);
    fs.writeFileSync(path.join(seed, 'rules', 'clean.md'), 'USER-HOOK-CODEWORD.\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test', GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
      FORCE_COLOR: '0', TEAMAI_NONINTERACTIVE: '1' };
    for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-qm', 'seed']]) {
      const result = spawnSync('git', args, { cwd: seed, env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(spawnSync('git', ['clone', '-q', seed, repo], { env, encoding: 'utf8' }).status).toBe(0);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), JSON.stringify({ repo: { localPath: repo, remote: seed }, username: 'tester', scope: 'user', enabledAgents: [TOOL], updatePolicy: 'skip' }));
    expect(fs.existsSync(path.join(home, '.teamai', 'bin', 'teamai'))).toBe(false);
    const pull = spawnSync(process.execPath, [CLI, 'pull', '--force'], { cwd: home, env, encoding: 'utf8', timeout: 30000 });
    expect(pull.status, pull.stdout + pull.stderr).toBe(0);
    const configFile = TOOL === 'zcode' ? path.join(home, '.zcode/cli/config.json') : path.join(home, '.teamai/dsh/hooks.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const entry = TOOL === 'zcode' ? config.hooks.events.SessionStart[0].hooks[0] : config.hooks.SessionStart[0].hooks[0];
    // No Node installation directory or global teamai is available to the hook.
    const hook = spawnSync(TOOL === 'zcode' ? entry.command : '/bin/sh', TOOL === 'zcode' ? entry.args : ['-c', entry.command], {
      cwd: home, env: { ...env, PATH: '/usr/bin:/bin' }, input: JSON.stringify({ session_id: 'user-scope-wrapper', cwd: home, hook_event_name: 'SessionStart', source: 'startup' }), encoding: 'utf8', timeout: 15000,
    });
    expect(hook.status, hook.stderr).toBe(0);
    const events = fs.readFileSync(path.join(home, '.teamai/dashboard/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ sessionId: 'user-scope-wrapper', type: 'session_start' }));
  } finally { await waitForDetachedChildren(); fs.rmSync(root, { recursive: true, force: true }); }
});
