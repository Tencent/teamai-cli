import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Refuse inherited Git roots before fixtures can write into the contributor's checkout. */
export function assertSafeTmpdir(directory = os.tmpdir()): void {
  const temporary = fs.realpathSync.native(directory);
  for (let current = temporary; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) {
      throw new Error(
        `TMPDIR ${temporary} is inside the Git checkout ${current}. `
        + 'Tests could write delivered files into that checkout. '
        + 'Set TMPDIR, TMP and TEMP to a directory outside every Git checkout before running tests.',
      );
    }
    if (path.dirname(current) === current) return;
  }
}

export default function setup(): void {
  assertSafeTmpdir();
}
