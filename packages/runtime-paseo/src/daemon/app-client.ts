import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeFailure } from '@teamai/runtime-protocol';
import { z } from 'zod';
import { openRegularFileSync, readRegularFileSync } from '@teamai/shared/regular-file';

// ─── The client inside the Paseo app ─────────────────────
//
//  The Paseo desktop app installs its CLI as a shell script, Contents/Resources/bin/paseo, which runs through the app's
//  own Electron; its client lives only inside Contents/Resources/app.asar, which Node cannot load from. So the runtime
//  unpacks the client and the packages it depends on, once per app build, into a directory it keeps, checking each file
//  against the SHA-256 the archive records, and loads the client from there.
//
//  app.asar: a pickle holding the header's size, a pickle holding the header as JSON, then the files' bytes. The header
//  is a tree of directories ({ files }) and files ({ offset, size, integrity }); a file with `unpacked` sits beside the
//  archive in app.asar.unpacked instead.
//

const IntegritySchema = z.object({ algorithm: z.literal('SHA256'), hash: z.string() });

type Entry = { files: Record<string, Entry> } | { size: number; offset?: string; unpacked?: boolean; integrity?: z.infer<typeof IntegritySchema> } | { link: string };

const EntrySchema: z.ZodType<Entry> = z.lazy(() => z.union([
  z.object({ files: z.record(z.string(), EntrySchema) }),
  z.object({ size: z.number().int().nonnegative(), offset: z.string().optional(), unpacked: z.boolean().optional(), integrity: IntegritySchema.optional() }),
  z.object({ link: z.string() }),
]));

const ManifestSchema = z.object({ version: z.string().optional(), dependencies: z.record(z.string(), z.string()).optional() });

/** An app.asar opened for reading: its header, and where its files' bytes start. */
interface Archive {
  file: string;
  root: Entry;
  /** The SHA-256 of the header, which names every file's hash: the build the archive is. */
  build: string;
  base: number;
}

function openArchive(file: string): Archive {
  const fd = openRegularFileSync(file);

  try {
    const sizes = Buffer.alloc(16);
    fs.readSync(fd, sizes, 0, 16, 0);
    const headerPickle = sizes.readUInt32LE(4);
    const json = Buffer.alloc(sizes.readUInt32LE(12));
    fs.readSync(fd, json, 0, json.length, 16);

    return { file, root: EntrySchema.parse(JSON.parse(json.toString('utf8'))), build: createHash('sha256').update(json).digest('hex'), base: 8 + headerPickle };
  } catch (error) {
    throw new Error(`${path.basename(file)} has no header that can be read (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  } finally {
    fs.closeSync(fd);
  }
}

/** The entry at `name`, a path in the archive, or undefined when it holds none. */
function entryAt(archive: Archive, name: string): Entry | undefined {
  let entry: Entry | undefined = archive.root;

  for (const part of name.split('/').filter(Boolean)) entry = entry && 'files' in entry ? entry.files[part] : undefined;

  return entry;
}

/** The bytes of the file at `name`, checked against the hash the archive records for it. */
function readEntry(archive: Archive, name: string): Buffer {
  const entry = entryAt(archive, name);

  if (!entry || !('size' in entry)) throw new Error(`${name} is not a file the app holds`);

  let bytes: Buffer;

  if (entry.unpacked) {
    bytes = readRegularFileSync(path.join(`${archive.file}.unpacked`, ...name.split('/')));
  } else {
    bytes = Buffer.alloc(entry.size);
    const fd = openRegularFileSync(archive.file);

    try {
      fs.readSync(fd, bytes, 0, entry.size, archive.base + Number(entry.offset ?? 0));
    } finally {
      fs.closeSync(fd);
    }
  }

  if (entry.integrity && createHash('sha256').update(bytes).digest('hex') !== entry.integrity.hash) {
    throw new Error(`${name} does not match the SHA-256 the app records for it`);
  }

  return bytes;
}

/** The package `name` as Node resolves it from the package at `from`: the nearest node_modules at or above it that holds it. */
function packageFrom(archive: Archive, from: string, name: string): string {
  for (let at = from; ; at = at.includes('/node_modules/') ? at.slice(0, at.lastIndexOf('/node_modules/')) : '') {
    const candidate = [at, 'node_modules', name].filter(Boolean).join('/');

    if (entryAt(archive, `${candidate}/package.json`)) return candidate;

    if (at === '') throw new Error(`${name}, which ${from || 'the app'} depends on, is not in the app`);
  }
}

/** Every file under the directory entry at `name`, by its path in the archive, leaving out its own node_modules. */
function filesUnder(archive: Archive, name: string): string[] {
  const entry = entryAt(archive, name);

  if (!entry || !('files' in entry)) return [];

  return Object.entries(entry.files).flatMap(([child, inner]) => {
    if (child === 'node_modules' && 'files' in inner) return [];

    if ('link' in inner) throw new Error(`${name}/${child} is a link, which teamai-runtime-paseo does not unpack`);

    return 'files' in inner ? filesUnder(archive, `${name}/${child}`) : [`${name}/${child}`];
  });
}

/** The client and every package it depends on, by their directories in the archive. */
function closureOf(archive: Archive): string[] {
  const seen = new Set<string>();
  const pending = [packageFrom(archive, '', '@getpaseo/client')];

  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = ManifestSchema.parse(JSON.parse(readEntry(archive, `${dir}/package.json`).toString('utf8')));

    for (const dependency of Object.keys(manifest.dependencies ?? {})) pending.push(packageFrom(archive, dir, dependency));
  }

  return [...seen];
}

/**
 * The directory of the client inside the Paseo app whose CLI script `cli` is, unpacked into `keep` once per app build;
 * undefined when `cli` is not the app's script; or why it cannot be unpacked. With `unpackInto`, a build `keep` does
 * not hold yet is unpacked there instead, and `keep` is only read: a caller that writes nothing of its own removes it.
 */
export function clientInApp(cli: string, { keep, unpackInto }: { keep: string; unpackInto?: string }): { dir: string } | RuntimeFailure | undefined {
  const script = fs.realpathSync(cli);
  const resources = path.dirname(path.dirname(script));
  const asar = path.join(resources, 'app.asar');

  if (path.basename(path.dirname(script)) !== 'bin' || !fs.existsSync(asar)) return undefined;

  // The app itself: Paseo.app on macOS, else the directory that holds its resources.
  const app = path.basename(path.dirname(resources)) === 'Contents' ? path.dirname(path.dirname(resources)) : path.dirname(resources);

  try {
    const archive = openArchive(asar);
    const version = ManifestSchema.parse(JSON.parse(readEntry(archive, `${packageFrom(archive, '', '@getpaseo/client')}/package.json`).toString('utf8'))).version ?? 'unknown';
    const build = `${version}-${archive.build.slice(0, 16)}`;
    const keptClient = path.join(keep, build, 'node_modules', '@getpaseo', 'client');

    if (fs.existsSync(path.join(keptClient, 'package.json'))) return { dir: keptClient };
    const into = unpackInto ?? keep;
    const kept = path.join(into, build);
    const client = path.join(kept, 'node_modules', '@getpaseo', 'client');

    // Unpacked beside where it is kept, then renamed into place, so a runtime never loads a half-written client.
    fs.mkdirSync(into, { recursive: true });
    const unpacking = fs.mkdtempSync(path.join(into, '.unpacking-'));

    try {
      for (const name of closureOf(archive).flatMap((dir) => filesUnder(archive, dir))) {
        const target = path.join(unpacking, ...name.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, readEntry(archive, name));
      }

      try {
        fs.renameSync(unpacking, kept);
      } catch (error) {
        // Another runtime unpacked the same build first.
        if (!fs.existsSync(path.join(client, 'package.json'))) throw error;
      }
    } finally {
      fs.rmSync(unpacking, { recursive: true, force: true });
    }

    return { dir: client };
  } catch (error) {
    return {
      code: 'client_missing',
      message: `teamai-runtime-paseo could not unpack the Paseo client from the Paseo app at ${app}: ${error instanceof Error ? error.message : String(error)}. Reinstall the Paseo app, or install the Paseo CLI (npm install -g @getpaseo/cli) so \`paseo\` is on PATH.`,
    };
  }
}
