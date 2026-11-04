import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = path.resolve(import.meta.dirname, '../../../dist/index.js');

describe('environment arguments through the native shell', () => {
  it('expands an argument after the shell has parsed it', () => {
    const result = spawnSync(`"${process.execPath}" "${cli}" --env-args @FLAG`, {
      shell: true, encoding: 'utf8', env: { ...process.env, FLAG: '--version' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('keeps quotes and shell operators literal rather than executing them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-env-args-'));
    const marker = path.join(root, 'injected');
    const value = `missing-command "quoted words" & echo injected > "${marker}"`;
    const result = spawnSync(`"${process.execPath}" "${cli}" --env-args @COMMAND`, {
      shell: true, encoding: 'utf8', env: { ...process.env, COMMAND: value }, cwd: root,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(value);
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
