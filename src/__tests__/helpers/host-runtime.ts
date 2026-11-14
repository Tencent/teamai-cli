import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { hostStepRuntime, type HostStepRuntime } from '../../workflow/runtimes/host.js';
import type { LocalConfig } from '../../types.js';

/** The host runtime of an install whose data home is under `root`, where it records the process groups of its execs. */
export function hostRuntimeIn(root: string): HostStepRuntime {
  const config: LocalConfig = { repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };

  return hostStepRuntime({ config });
}

/**
 * The host runtime over a data home of its own, removed when the test ends, for a test that stands it in for some step
 * runtime before any install exists: no stop of an install looks where it records its execs' process groups.
 */
export function scratchHostRuntime(): HostStepRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-host-runtime-'));
  onTestFinished(() => { fs.rmSync(root, { recursive: true, force: true }); });

  return hostRuntimeIn(root);
}
