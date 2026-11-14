import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { toolLauncherConformance } from '@teamai/tool-launch/testing';
import { processProvider } from './testing/process-provider.js';
import { sandboxProcess } from './step.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

toolLauncherConformance('a step\'s tool in its sandbox', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sandbox-process-'));
  dirs.push(cwd);

  return { start: sandboxProcess(processProvider(), 'sandbox-1', []).start, cwd };
});
