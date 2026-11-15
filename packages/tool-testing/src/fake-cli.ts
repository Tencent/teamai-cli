import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRegularFileSync } from '@teamai/shared/regular-file';

/**
 * A fake tool executable named `command` in a fresh directory: whatever its arguments, it prints `stdout` and exits
 * `exitCode`. Put the returned directory first on PATH. POSIX shells only.
 */
export function fakeCli(command: string, { stdout, exitCode = 0 }: { stdout: string; exitCode?: number }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fake-cli-'));
  const file = path.join(dir, command);

  writeRegularFileSync(file, `#!/bin/sh\ncat <<'TEAMAI_FAKE_CLI'\n${stdout}\nTEAMAI_FAKE_CLI\nexit ${exitCode}\n`);
  fs.chmodSync(file, 0o755);

  return dir;
}
