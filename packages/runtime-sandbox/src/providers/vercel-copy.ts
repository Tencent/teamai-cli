import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readRegularFileSync, writeNewFileSync } from '@teamai/shared/regular-file';

// ─── Copying a hosted sandbox's work back to the host ───
//
//  A hosted sandbox hands its work back as one tar archive of the place's roots (vercel.ts). Nothing in it is trusted:
//  each entry is written only inside a root it names, never through a symlink on the way there, a link is written as a
//  link, and a path the step deleted is deleted here, all with lstat so no link is ever followed.
//

/** One entry of a tar archive: its absolute path, and what it is. */
export type TarEntry = { at: string; mode: number } & ({ kind: 'file'; data: Buffer } | { kind: 'dir' } | { kind: 'link'; target: string } | { kind: 'hardlink'; target: string });

const BLOCK = 512;

function text(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);

  return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

function octal(header: Buffer, start: number, length: number): number {
  const field = text(header, start, length).trim();

  return field === '' ? 0 : Number.parseInt(field, 8);
}

/** The pax records of an extended header, by key (`path`, `linkpath`, `size`). */
function paxOf(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;

  while (at < data.length) {
    const space = data.indexOf(0x20, at);

    if (space === -1) break;
    const length = Number(data.subarray(at, space).toString('utf8'));

    if (!Number.isInteger(length) || length <= 0) break;
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');

    if (equals !== -1) records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }

  return records;
}

/**
 * The entries of a ustar, pax or GNU tar archive whose names are relative to `/`, as GNU tar writes `tar -C / …`.
 * Anything it does not know (a device, a FIFO) is left out.
 */
export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax = new Map<string, string>();

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);

    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const data = archive.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      pax = paxOf(data);
      continue;
    }

    if (type === 'L' || type === 'K') {
      const value = data.toString('utf8').replace(/\0+$/, '');

      if (type === 'L') longName = value;
      else longLink = value;
      continue;
    }

    if (type === 'g') continue;
    const prefix = text(header, 345, 155);
    const name = pax.get('path') ?? longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    const target = pax.get('linkpath') ?? longLink ?? text(header, 157, 100);
    const mode = octal(header, 100, 8) & 0o7777;
    longName = undefined;
    longLink = undefined;
    pax = new Map();
    const at = path.posix.join('/', name).replace(/(.)\/+$/, '$1');

    if (type === '0' || type === '\0' || type === '7') entries.push({ at, mode, kind: 'file', data: Buffer.from(data) });
    else if (type === '5') entries.push({ at, mode, kind: 'dir' });
    else if (type === '2') entries.push({ at, mode, kind: 'link', target });
    else if (type === '1') entries.push({ at, mode, kind: 'hardlink', target: path.posix.join('/', target) });
  }

  return entries;
}

/** Whether `inner` is `outer` or inside it. */
function isWithin(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function lstatOf(at: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(at);
  } catch {
    return undefined;
  }
}

/** Whether every directory from `root` down to `at`'s parent is a real directory, never a link. */
function hasRealParents(root: string, at: string): boolean {
  const parts = path.relative(root, path.dirname(at)).split(path.sep).filter((part) => part !== '');
  let current = root;

  for (const part of parts) {
    current = path.join(current, part);

    if (!lstatOf(current)?.isDirectory()) return false;
  }

  return lstatOf(root)?.isDirectory() === true;
}

/** Every path under `root`, depth first, children before their directory; links are listed, never followed. */
function walk(root: string): string[] {
  const stat = lstatOf(root);

  if (!stat?.isDirectory()) return [];

  return fs.readdirSync(root).flatMap((name) => {
    const at = path.join(root, name);

    return [...walk(at), at];
  });
}

/** The sha256 of `data`, hex. */
export function fingerprintOf(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Each regular file under `root`, by path, with its fingerprint: what a copy-in sends of it. */
export function fingerprintsOf(root: string): Record<string, string> {
  return Object.fromEntries(walk(root).flatMap((at) => (lstatOf(at)?.isFile() ? [[at, fingerprintOf(readRegularFileSync(at))]] : [])));
}

/**
 * Makes each of `roots` on the host match the archive's copy of it: what the archive holds is written, what it lacks is
 * deleted. Of `added.roots` (the run directory, which other steps write too), only the regular files the step changed
 * come back: a file whose bytes match `added.wentIn` (its fingerprint as it went in) is left as the host has it now, a
 * link is not brought back, a directory is made only when missing, and no path there is ever removed. A path under one of `kept` (the git paths) is never written or deleted, and an entry outside every root is
 * left out. Everything is written before anything is deleted, and a directory takes its mode last, deepest first, so a
 * copy that stops halfway (a full disk) deletes nothing and a read-only directory still gets its files.
 */
export function applyTar(entries: TarEntry[], { roots, added = { roots: [], wentIn: {} }, kept }: { roots: string[]; added?: { roots: string[]; wentIn: Record<string, string> }; kept: string[] }): void {
  const isKept = (at: string): boolean => kept.some((keep) => isWithin(at, keep));
  const rootOf = (at: string): string | undefined => [...roots, ...added.roots].find((root) => isWithin(at, root));
  const listed = new Set(entries.map((entry) => entry.at));
  const archived = new Map(entries.flatMap((entry) => (entry.kind === 'file' ? [[entry.at, entry.data] as const] : [])));
  const files = new Map<string, Buffer>();
  const dirs: Array<{ at: string; mode: number }> = [];

  for (const entry of entries) {
    const root = rootOf(entry.at);

    if (root === undefined || isKept(entry.at) || !hasRealParents(root, entry.at)) continue;

    const existing = lstatOf(entry.at);

    if (added.roots.includes(root)) {
      const data = entry.kind === 'file' ? entry.data : entry.kind === 'hardlink' ? archived.get(entry.target) : undefined;

      if (entry.kind === 'dir' && existing === undefined) fs.mkdirSync(entry.at, { mode: entry.mode || 0o755 });

      if (data !== undefined && (existing === undefined || existing.isFile()) && added.wentIn[entry.at] !== fingerprintOf(data)) {
        writeNewFileSync(entry.at, data, { mode: entry.mode || 0o644 });
      }

      continue;
    }

    if (entry.kind === 'dir') {
      if (existing && !existing.isDirectory()) fs.rmSync(entry.at, { force: true });

      if (!existing?.isDirectory()) fs.mkdirSync(entry.at);
      fs.chmodSync(entry.at, 0o700);
      dirs.push({ at: entry.at, mode: entry.mode || 0o755 });
      continue;
    }

    if (existing) fs.rmSync(entry.at, { recursive: true, force: true });

    switch (entry.kind) {
      case 'link':
        fs.symlinkSync(entry.target, entry.at);
        break;
      case 'file':
      case 'hardlink': {
        const data = entry.kind === 'file' ? entry.data : files.get(entry.target);

        if (data === undefined) break;
        files.set(entry.at, data);
        writeNewFileSync(entry.at, data, { mode: entry.mode || 0o644 });
        fs.chmodSync(entry.at, entry.mode || 0o644);
        break;
      }

      default: {
        const unhandled: never = entry;

        return unhandled;
      }
    }
  }

  // What the step deleted. A root the archive does not hold is not taken as emptied: nothing of it is deleted.
  for (const root of roots) {
    if (!listed.has(root)) continue;

    for (const at of walk(root)) if (!listed.has(at) && !isKept(at)) fs.rmSync(at, { recursive: true, force: true });
  }

  for (const { at, mode } of dirs.sort((a, b) => b.at.length - a.at.length)) fs.chmodSync(at, mode);
}
