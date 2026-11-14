import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runsCommand } from '@teamai/runtime-protocol';
import { isJsonObject, parseJson, type JsonValue } from '@teamai/shared/json';
import { mayBeRunning } from '@teamai/shared/process-group';
import { z } from 'zod';
import { DRIVERS, type Driver } from './sessions.js';
import { instanceToolHome, SettingsSchema } from './settings.js';
import { readRegularFileSync } from '@teamai/shared/regular-file';

// ─── Adding a T3 provider instance to the member's T3 settings ───
//
//  The `t3` command cannot add a provider instance, so the runtime writes it into T3's own settings file, which T3 Code
//  watches and reloads, as its Settings → Providers page would:
//
//    <T3 home>/userdata/settings.json
//    { …every other setting, kept…, "providerInstances": { …, "acme-claude": { "driver": "claudeAgent", "displayName":
//      "acme-claude", "enabled": true, "config": { "binaryPath": "/opt/acme/bin/acme-claude" } } } }
//
//  One runtime adds at a time on this machine (a lock file beside teamai's T3 sign-in), and each reads the settings
//  again under the lock, so parallel runs add an instance once: a later one finds it by its Binary path, and for an
//  instance with a home of its own, by its Home path too. T3 writes the file too: the runtime reads it again just
//  before it replaces it, and starts over when it changed, so only a write T3 makes in that last instant is lost.
//

/** A provider instance to add: its id, the T3 driver, its name in T3, the command it runs and where, and its home. */
export interface NewInstance {
  id: string;
  driver: Driver;
  displayName: string;
  /** The command the instance runs, which an instance already there is found by. */
  command: string;
  /** The absolute path of `command`. */
  binaryPath: string;
  /** The tool home T3 runs it in, an absolute path, for an instance with a home of its own; none: the tool's own. */
  homePath?: string;
}

export type AddedInstance =
  /** The runtime added it. */
  | { kind: 'added'; id: string }
  /** An instance of that driver already runs the command, such as one a parallel run added. */
  | { kind: 'found'; id: string }
  /** Nothing was added; `why` says why, in a few words. */
  | { kind: 'failed'; why: string };

/** How long a runtime waits for another to finish adding, and how old a lock may be before it counts as left behind. */
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

/** How many times the runtime writes: once, and once more when T3 wrote the file between its read and its write. */
const ATTEMPTS = 2;

/** T3's provider instance ids: a letter, then letters, digits, `_` or `-`, at most 64 (`PROVIDER_SLUG_PATTERN` in T3). */
const INSTANCE_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** Whether T3 takes `id` as the id of a provider instance. */
export function isInstanceId(id: string): boolean {
  return INSTANCE_ID.test(id);
}

/** A lock file's text: the pid of the runtime that holds it, when it took it, and a token of its own. */
const HolderSchema = z.string().regex(/^\d+ \d+ \S+$/).transform((text) => {
  const [pid = '', takenAt = ''] = text.split(' ');

  return { pid: Number(pid), takenAt: Number(takenAt) };
});

/**
 * Whether the provider instance `id` in `settings` is `instance` already: of its driver, running its command (one with
 * no Binary path runs the driver's own), and, for an instance with a home of its own, in that home as T3 resolves it.
 */
function isSame({ settings, id, instance, userHome }: { settings: z.infer<typeof SettingsSchema>; id: string; instance: NewInstance; userHome: string }): boolean {
  const kept = settings.providerInstances?.[id];
  const binaryPath = kept?.config?.binaryPath?.trim() || undefined;

  if (kept?.driver !== instance.driver) return false;

  if (!(binaryPath === undefined ? instance.command === DRIVERS[instance.driver].tool : runsCommand({ executable: binaryPath, command: instance.command, expandsHome: true }))) return false;

  return instance.homePath === undefined || instanceToolHome(settings, { instanceId: id, driver: instance.driver, userHome }) === instance.homePath;
}

/** The id of the provider instance in `settings` that is `instance` already, such as one another run added. */
export function findProviderInstance({ settings, instance, userHome }: { settings: z.infer<typeof SettingsSchema>; instance: NewInstance; userHome: string }): string | undefined {
  return Object.keys(settings.providerInstances ?? {}).find((id) => isSame({ settings, id, instance, userHome }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A file's text, or none when there is no file. */
function readText(file: string): string | undefined {
  try {
    return readRegularFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Removes the lock at `file` when it is still the one whose text is `text`: one another runtime took since is put back.
 * It is moved aside first, so no lock is removed between the read and the removal.
 */
function release(file: string, text: string): void {
  const aside = path.join(path.dirname(file), `.${process.pid}.${randomUUID()}.aside`);

  try {
    fs.renameSync(file, aside);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }

  try {
    if (readRegularFileSync(aside, 'utf8') !== text) fs.linkSync(aside, file);
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

/**
 * Takes the lock at `file`, waiting for another runtime that holds it; a lock its holder left behind is taken over. The
 * lock is linked into place whole, so another runtime never reads it half written.
 */
async function locked<TValue>(file: string, work: () => TValue): Promise<{ ok: true; value: TValue } | { ok: false }> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = `${process.pid} ${Date.now()} ${randomUUID()}`;
  const mine = path.join(path.dirname(file), `.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(mine, text, { mode: 0o600 });

  try {
    for (;;) {
      try {
        fs.linkSync(mine, file);
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }

      const held = readText(file);

      // Released since the link failed: try again.
      if (held === undefined) continue;
      const holder = HolderSchema.safeParse(held);

      if (holder.success && mayBeRunning(holder.data.pid) && Date.now() - holder.data.takenAt < LOCK_STALE_MS) {
        if (Date.now() > deadline) return { ok: false };
        await sleep(50);
        continue;
      }

      // Its runtime is gone, or held it too long.
      release(file, held);
    }
  } finally {
    fs.rmSync(mine, { force: true });
  }

  try {
    return { ok: true, value: work() };
  } finally {
    release(file, text);
  }
}

/** Adds `instance` to the settings at `file` once, unless an instance of its driver already runs its command. */
function addTo(file: string, instance: NewInstance, userHome: string): AddedInstance {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const before = readText(file);
    let json: JsonValue;

    try {
      json = before === undefined ? {} : parseJson(before);
    } catch {
      return { kind: 'failed', why: `T3 Code's settings file ${file} is not valid JSON` };
    }

    // Read as JSON.parse built it, never through a schema copy, so every key teamai does not own is written back as
    // it was, a `__proto__` key too.
    if (!isJsonObject(json)) return { kind: 'failed', why: `T3 Code's settings file ${file} is not a JSON object` };
    const settings = json;
    const kept = Object.hasOwn(settings, 'providerInstances') ? settings['providerInstances'] : {};

    if (!isJsonObject(kept)) return { kind: 'failed', why: `T3 Code's settings file ${file} has a providerInstances that is not a JSON object` };
    const instances = kept;
    const found = findProviderInstance({ settings: SettingsSchema.catch({}).parse(settings), instance, userHome });

    if (found) return { kind: 'found', id: found };

    if (Object.hasOwn(instances, instance.id)) return { kind: 'failed', why: `T3 Code already has a provider instance "${instance.id}" that runs another command` };

    const added = {
      driver: instance.driver, displayName: instance.displayName, enabled: true,
      config: { binaryPath: instance.binaryPath, ...(instance.homePath !== undefined && { homePath: instance.homePath }) },
    };

    const next = `${JSON.stringify({ ...settings, providerInstances: { ...instances, [instance.id]: added } }, null, 2)}\n`;
    const temp = `${file}.teamai-${process.pid}.tmp`;
    const mode = before === undefined ? 0o600 : fs.statSync(file).mode & 0o777;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, next, { mode });

    // T3 writes this file too: read it again just before the rename, and start over on what T3 wrote since.
    if (readText(file) !== before) {
      fs.rmSync(temp, { force: true });
      continue;
    }

    fs.renameSync(temp, file);

    return { kind: 'added', id: instance.id };
  }

  return { kind: 'failed', why: `T3 Code kept changing its settings file ${file}` };
}

/**
 * Adds `instance` to the member's T3 settings in `t3Home`, keeping every other setting, unless an instance of its
 * driver already runs its command. `lockFile` keeps two runtimes on this machine from adding it twice.
 */
export async function addProviderInstance({ t3Home, lockFile, userHome, instance }: {
  t3Home: string; lockFile: string;
  /** The home of the user T3 Code runs as, which `~` in a kept instance's home stands for. */
  userHome: string;
  instance: NewInstance;
}): Promise<AddedInstance> {
  if (!isInstanceId(instance.id)) return { kind: 'failed', why: `"${instance.id}" is not a name T3 Code takes for a provider instance (a letter, then letters, digits, _ or -)` };
  const settingsFile = path.join(t3Home, 'userdata', 'settings.json');
  // T3 follows a settings file that is a link to its target, and so does this write.
  const file = fs.existsSync(settingsFile) ? fs.realpathSync(settingsFile) : settingsFile;

  try {
    const done = await locked(lockFile, () => addTo(file, instance, userHome));

    return done.ok ? done.value : { kind: 'failed', why: `another teamai run held ${lockFile} for over ${LOCK_WAIT_MS / 1_000} s` };
  } catch (error) {
    return { kind: 'failed', why: error instanceof Error ? error.message : String(error) };
  }
}
