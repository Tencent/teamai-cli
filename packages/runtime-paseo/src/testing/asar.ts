import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { entriesUnder } from '@teamai/shared/entries-under';

// ─── A Paseo desktop app, for tests ──────────────────────
//
//  The Paseo app ships its CLI as a shell script in Contents/Resources/bin, and its client only inside
//  Contents/Resources/app.asar, an Electron archive: a pickle holding the header's size, a pickle holding the header as
//  JSON, then every file's bytes. The header names each file's offset, size and SHA-256.
//

type AsarDir = { files: Record<string, AsarDir | AsarFile> };

type AsarFile = { size: number; offset: string; integrity: { algorithm: 'SHA256'; hash: string; blockSize: number; blocks: string[] } };

const BLOCK = 4 * 1024 * 1024;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Packs `files`, by their path in the archive, into an asar archive at `file`. `corrupt`: a path whose bytes change after
 * the header hashed them, as a damaged download leaves them.
 */
export function packAsar(file: string, files: Map<string, Buffer>, corrupt?: string): void {
  const root: AsarDir = { files: {} };
  const bodies: Buffer[] = [];
  let offset = 0;

  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const parts = name.split('/');
    let dir = root;

    for (const part of parts.slice(0, -1)) {
      const next = dir.files[part] ?? { files: {} };
      dir.files[part] = next;

      if (!('files' in next)) throw new Error(`${name} is under a file`);
      dir = next;
    }

    const blocks = Array.from({ length: Math.max(1, Math.ceil(bytes.length / BLOCK)) }, (_, index) => sha256(bytes.subarray(index * BLOCK, (index + 1) * BLOCK)));
    dir.files[parts.at(-1) ?? name] = { size: bytes.length, offset: String(offset), integrity: { algorithm: 'SHA256', hash: sha256(bytes), blockSize: BLOCK, blocks } };
    bodies.push(name === corrupt ? Buffer.concat([bytes.subarray(0, -1), Buffer.from('!')]) : bytes);
    offset += bytes.length;
  }

  const json = Buffer.from(JSON.stringify(root));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded.length, 4);
  header.writeUInt32LE(4 + padded.length, 8);
  header.writeUInt32LE(json.length, 12);
  fs.writeFileSync(file, Buffer.concat([header, padded, ...bodies]));
}

const ManifestSchema = z.object({ name: z.string(), dependencies: z.record(z.string(), z.string()).optional() });

/** Every file under `dir` but its own node_modules, by its path relative to `dir`. */
function filesOf(dir: string): string[] {
  return entriesUnder(dir).map(({ entry }) => entry)
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .filter((name) => !name.split(path.sep).includes('node_modules'));
}

/** The package `name` as Node resolves it from `from`: the nearest node_modules at or above it that holds it. */
function packageFrom(from: string, name: string): string {
  for (let at = from; ; at = path.dirname(at)) {
    const candidate = path.join(at, 'node_modules', name);

    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);

    if (path.dirname(at) === at) throw new Error(`${name} does not resolve from ${from}`);
  }
}

/** The client at `client` and every package it depends on, as the app's archive holds them under node_modules. */
export function clientClosure(client: string): Map<string, Buffer> {
  const packed = new Map<string, Buffer>();
  const seen = new Set<string>();
  const pending = [fs.realpathSync(client)];

  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')));

    for (const name of filesOf(dir)) packed.set(['node_modules', manifest.name, ...name.split(path.sep)].join('/'), fs.readFileSync(path.join(dir, name)));

    for (const dependency of Object.keys(manifest.dependencies ?? {})) pending.push(packageFrom(dir, dependency));
  }

  return packed;
}

/**
 * A Paseo app under `dir`, its client packed from `client`, with its CLI script; answers the script's path, which the
 * app's install-CLI action links into ~/.local/bin.
 */
export function paseoApp(dir: string, client: string, corrupt?: string): string {
  const resources = path.join(dir, 'Paseo.app', 'Contents', 'Resources');
  fs.mkdirSync(path.join(resources, 'bin'), { recursive: true });
  packAsar(path.join(resources, 'app.asar'), clientClosure(client), corrupt);
  const cli = path.join(resources, 'bin', 'paseo');
  fs.writeFileSync(cli, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  return cli;
}
