import { expect, it, vi } from 'vitest';
import * as builtinHooks from '../builtin-hooks.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { injectHermesHooks } from '../hermes-hooks.js';

it.runIf(process.platform !== 'win32')('runs a hook in a home containing spaces and apostrophes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hermes-command-'));
  const saved = process.env.HERMES_HOME;
  try {
    process.env.HERMES_HOME = path.join(tmpDir, "member's Hermes home");
    const entry = path.join(tmpDir, 'installed entry.cjs');
    fs.writeFileSync(entry, `const fs=require('node:fs'); fs.writeFileSync(process.env.RECEIPT,process.argv.slice(2).join('\\n')+'\\n');process.stdin.on('data',c=>fs.appendFileSync(process.env.RECEIPT,c));`);
    vi.spyOn(builtinHooks, 'resolveCliEntry').mockReturnValue(entry);
    await injectHermesHooks();
    const config = YAML.parse(fs.readFileSync(path.join(process.env.HERMES_HOME, 'config.yaml'), 'utf8'));
    const command = config.hooks.on_session_start[0].command;
    const receipt = path.join(tmpDir, 'receipt');
    const run = spawnSync('sh', ['-c', command], {
      input: '{"session_id":"quoted-home"}', encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin', RECEIPT: receipt },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(receipt, 'utf8')).toBe('hook-dispatch\nsession-start\n--tool\nhermes\n{"session_id":"quoted-home"}');
  } finally {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
