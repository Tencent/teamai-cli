import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { toolLauncherConformance } from '@teamai/tool-launch/testing';
import { hostProcess } from './step.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

toolLauncherConformance('the host process', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-host-process-'));
  dirs.push(cwd);

  return { start: hostProcess(), cwd };
});
