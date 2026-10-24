import { expect, it } from 'vitest';
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
    await injectHermesHooks();
    const config = YAML.parse(fs.readFileSync(path.join(process.env.HERMES_HOME, 'config.yaml'), 'utf8'));
    const command = config.hooks.on_session_start[0].command;
    const bin = path.join(tmpDir, 'bin');
    fs.mkdirSync(bin);
    const receipt = path.join(tmpDir, 'receipt');
    fs.writeFileSync(path.join(bin, 'teamai'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$RECEIPT"\ncat >> "$RECEIPT"\n', { mode: 0o755 });
    const run = spawnSync('sh', ['-c', command], {
      input: '{"session_id":"quoted-home"}', encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RECEIPT: receipt },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(receipt, 'utf8')).toBe('hook-dispatch\nsession-start\n--tool\nhermes\n{"session_id":"quoted-home"}');
  } finally {
    if (saved === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
