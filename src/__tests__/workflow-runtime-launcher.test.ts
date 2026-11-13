import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { toolLauncherConformance } from '@teamai/tool-launch/testing';
import { runtimeLauncher } from '../workflow/steps/runtime-steps.js';
import { attemptRun } from '../workflow/runtimes/attempt.js';
import { hostStepRuntime } from '../workflow/runtimes/host.js';
import { AttemptIdSchema, RunIdSchema } from '../workflow/store.js';
import type { LocalConfig } from '../types.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

toolLauncherConformance('a step runtime\'s exec, on the host runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-launcher-'));
  dirs.push(root);
  const config: LocalConfig = { repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  const run = attemptRun({ config, run: RunIdSchema.parse('r0123abcd'), attempt: AttemptIdSchema.parse('a00000001'), runtime: hostStepRuntime({ config }), driver: 'conformance' });
  const view = { worktree: root, readonly: [], result: path.join(root, 'out'), runDir: path.join(root, 'scratch'), toolHome: {} };

  return { start: runtimeLauncher(run, { view, tool: 'claude', toolHome: { tool: 'claude', dir: path.join(root, 'home') }, unset: [], credentials: {}, setUp: async () => undefined }), cwd: root };
});
