import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@teamai/shared/log';
import { SessionEvidence } from '../session-flow/session-evidence.js';

const cutLine = (bytes: number): string => `\n[teamai: cut at ${bytes} bytes: the archive keeps at most 1 MiB of a file and 10 MiB of a step's evidence]\n`;

const mask = (text: string): string => text.split('hunter2').join('<REDACTED:secret>');

describe('evidence a step left in its out/ directory', () => {
  let out: string;

  beforeEach(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-evidence-'));
  });

  afterEach(() => {
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('keeps a text file masked and lists an image by name, type, size and hash only', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    fs.writeFileSync(path.join(out, 'run.log'), 'logged in with hunter2\n');
    fs.writeFileSync(path.join(out, 'screen.png'), png);

    expect(await SessionEvidence.collect(out, mask)).toEqual({
      version: 1,
      files: [
        { kind: 'text', path: 'run.log', type: 'text/plain', size: 23, text: 'logged in with <REDACTED:secret>\n', cut: false },
        { kind: 'listed', path: 'screen.png', type: 'image/png', size: 10, sha256: createHash('sha256').update(png).digest('hex') },
      ],
    });
  });
  it('lists a text file that is not UTF-8 instead of archiving text the mask may not have read whole', async () => {
    const bytes = Buffer.concat([Buffer.from('token hunter2 '), Buffer.from([0xc3, 0x28, 0xff])]);
    fs.writeFileSync(path.join(out, 'dump.txt'), bytes);

    expect((await SessionEvidence.collect(out, mask))?.files).toEqual([
      { kind: 'listed', path: 'dump.txt', type: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    ]);
  });
  it('cuts a text file at 1 MiB after masking it whole, so a secret across the cut leaves none of itself, and marks the cut', async () => {
    const MiB = 1024 * 1024;
    const body = `${'a'.repeat(MiB - 3)}hunter2${'b'.repeat(MiB / 2)}`;
    fs.writeFileSync(path.join(out, 'big.log'), body);

    const [file] = (await SessionEvidence.collect(out, mask))?.files ?? [];

    expect(file).toEqual({
      kind: 'text', path: 'big.log', type: 'text/plain', size: body.length, cut: true,
      text: `${'a'.repeat(MiB - 3)}<RE${cutLine(MiB)}`,
    });
  });
  it('keeps at most 10 MiB of text of one step, and cuts the files past it', async () => {
    const MiB = 1024 * 1024;
    for (let index = 0; index < 11; index += 1) fs.writeFileSync(path.join(out, `part-${String(index).padStart(2, '0')}.log`), 'x'.repeat(MiB));

    const files = (await SessionEvidence.collect(out, mask))?.files ?? [];

    expect(files.map((file) => (file.kind === 'text' ? [file.cut, file.text.length] : file.kind))).toEqual([
      ...Array.from({ length: 10 }, () => [false, MiB]),
      [true, cutLine(0).length],
    ]);
  });

  it('keeps the first 100 files of a step, by path, and counts the ones it left out', async () => {
    for (let index = 0; index < 102; index += 1) fs.writeFileSync(path.join(out, `shot-${String(index).padStart(3, '0')}.png`), 'x');

    const evidence = await SessionEvidence.collect(out, mask);

    expect(evidence?.files.map((file) => file.path)).toEqual(Array.from({ length: 100 }, (_, index) => `shot-${String(index).padStart(3, '0')}.png`));
    expect(evidence?.leftOut).toBe(2);
  });

  it('lists a text file too large to mask whole in memory, over 64 MiB, instead of reading it', async () => {
    const bytes = Buffer.alloc(64 * 1024 * 1024 + 1, 'x');
    fs.writeFileSync(path.join(out, 'huge.log'), bytes);

    expect((await SessionEvidence.collect(out, mask))?.files).toEqual([
      { kind: 'listed', path: 'huge.log', type: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    ]);
  });

  it('never follows a link out of the directory, and masks the names it keeps', async () => {
    const outside = path.join(out, '..', `${path.basename(out)}-secret.txt`);
    fs.writeFileSync(outside, 'private');
    fs.mkdirSync(path.join(out, 'logs'));
    fs.symlinkSync(outside, path.join(out, 'logs', 'linked.txt'));
    fs.writeFileSync(path.join(out, 'logs', 'hunter2.txt'), 'ok');

    try {
      expect((await SessionEvidence.collect(out, mask))?.files).toEqual([
        { kind: 'text', path: 'logs/<REDACTED:secret>.txt', type: 'text/plain', size: 2, text: 'ok', cut: false },
      ]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  // A backslash is a file-name character on POSIX, and a path separator on Windows, where no such file can be made.
  it.skipIf(process.platform === 'win32')('leaves out only a file whose name the archive cannot keep, and names it', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    fs.writeFileSync(path.join(out, 'logs\\run.txt'), 'refused');
    fs.writeFileSync(path.join(out, 'run.log'), 'kept');

    try {
      expect((await SessionEvidence.collect(out, mask))?.files).toEqual([
        { kind: 'text', path: 'run.log', type: 'text/plain', size: 4, text: 'kept', cut: false },
      ]);
      expect(warn.mock.calls.map(([message]) => String(message))).toEqual([expect.stringContaining('logs\\run.txt')]);
    } finally {
      warn.mockRestore();
    }
  });

  it('holds nothing for a step that left no out/ directory', async () => {
    expect(await SessionEvidence.collect(path.join(out, 'missing'), mask)).toBeUndefined();
  });
});
