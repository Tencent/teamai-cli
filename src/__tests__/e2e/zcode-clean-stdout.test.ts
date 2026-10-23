import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const TOOL = 'zcode';

it.skipIf(process.platform === 'win32')('delivers a clean JSON reply through the generated zcode process hook and real CLI', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `teamai-${TOOL}-stdout-`)));
  const detached = trackDetachedProcesses(root);
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
      NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' '),
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
    const configFile = path.join(project, '.zcode', 'cli', 'config.json');
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
    await detached.waitForExit();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
