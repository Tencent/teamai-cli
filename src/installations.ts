import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getCurrentPackageName, getCurrentVersion } from './package-info.js';
import { isVoltaPackageImage, prefixFromEntryPath } from './install-prefix.js';
import { compareVersions } from './version.js';
import { getTeamaiHomeDir } from './types.js';
import { log } from './utils/logger.js';

/**
 * A TeamAI copy this machine has run. The record is local only: it never leaves
 * `~/.teamai` and never enters a team report. It exists so an update started by
 * one copy can find the other npm-global copies of the same package (#1753).
 */
const InstallationMethodSchema = z.enum(['npm-global', 'volta', 'vendored', 'local']);

export type InstallationMethod = z.infer<typeof InstallationMethodSchema>;

const InstallationRecordSchema = z.object({
  /** Stable for one package directory, so a later run refreshes the same row. */
  id: z.string(),
  /** The module file that ran; its package directory is two levels above. */
  entry: z.string(),
  version: z.string(),
  method: InstallationMethodSchema,
  /** The npm prefix for `npm-global`, null for the other methods. */
  prefix: z.string().nullable(),
  /** Whether npm can update this layout in place; Volta, vendored and local copies cannot. */
  autoUpdateSupported: z.boolean().default(false),
  lastSeenAt: z.string(),
  lastUpdateAt: z.string().nullable().default(null),
  lastUpdateOutcome: z.enum(['updated', 'failed', 'skipped']).nullable().default(null),
  lastUpdateMessage: z.string().nullable().default(null),
});

export type InstallationRecord = z.infer<typeof InstallationRecordSchema>;

/** Refresh a row at most this often; any command or hook may run many times a minute. */
const RESEEN_EVERY_MS = 60 * 60 * 1000;

export function installationsPath(): string {
  return path.join(getTeamaiHomeDir(), 'installations.json');
}

/** The package directory of an entry file, `<prefix>/[lib/]node_modules/teamai-cli`. */
export function packageDirFromEntry(entry: string): string {
  return path.dirname(path.dirname(entry));
}

export function readInstallations(): InstallationRecord[] {
  try {
    const file = z.object({ installations: z.array(z.unknown()).default([]) })
      .safeParse(JSON.parse(fs.readFileSync(installationsPath(), 'utf-8')));

    if (!file.success) return [];

    return file.data.installations.flatMap((record) => {
      const parsed = InstallationRecordSchema.safeParse(record);

      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Write the inventory atomically. Two commands may race; the later one wins,
 * and the next run of the other copy registers it again. Nothing here is
 * irreplaceable: a lost row costs one extra `lastSeenAt`, not a broken install.
 */
function writeInstallations(installations: InstallationRecord[]): void {
  const home = getTeamaiHomeDir();

  fs.mkdirSync(home, { recursive: true });

  const target = installationsPath();
  const temporary = `${target}.${process.pid}.tmp`;

  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, installations }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

/** Describe the copy currently running, without reading or writing the inventory. */
export function describeInstallation(entry: string, version: string, now = new Date().toISOString()): InstallationRecord {
  const prefix = prefixFromEntryPath(entry, process.platform !== 'win32');
  const managedByVolta = isVoltaPackageImage(entry) || (prefix ? isVoltaPackageImage(prefix.prefix) : false);

  const method: InstallationMethod = managedByVolta
    ? 'volta'
    : prefix
      ? (prefix.global ? 'npm-global' : 'vendored')
      : 'local';

  return {
    // Key on the package directory, not the module file: the updater and the
    // inventory may be bundled into different files (or run from source), and
    // both still describe the same installed copy.
    id: createHash('sha256').update(packageDirFromEntry(entry)).digest('hex').slice(0, 16),
    entry,
    version,
    method,
    prefix: prefix?.prefix ?? null,
    autoUpdateSupported: method === 'npm-global',
    lastSeenAt: now,
    lastUpdateAt: null,
    lastUpdateOutcome: null,
    lastUpdateMessage: null,
  };
}

/**
 * Whether a command line records which copy ran, so an update from one copy can
 * find the others. `--help`, `--version` and `--dry-run` skip it: asking what
 * the command does, or asking for no changes, must not create `~/.teamai` or a
 * file in it. `uninstall` skips it so it leaves no inventory behind. Root
 * options take no value, so the first other argument is the command.
 */
export function registersRunningInstallation(args: readonly string[]): boolean {
  if (args.length === 0 || args.includes('--dry-run')) return false;

  if (args.some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-V')) return false;

  return args.find((arg) => !arg.startsWith('-')) !== 'uninstall';
}

/**
 * Record the running copy when it runs, before the command does its work.
 * Doing this on `--help` / `--version` would create `~/.teamai` for a user who
 * only asked what the command does, so the caller skips those.
 */
export function registerRunningInstallation(now = Date.now()): InstallationRecord | null {
  // A preview, including a workflow child it starts, must not write the
  // diagnostic inventory (#1753 review).
  if (process.env.TEAMAI_DRY_RUN === '1') return null;

  try {
    const home = getTeamaiHomeDir();

    // `teamai --version` on a fresh machine must not create a home directory.
    if (!fs.existsSync(home)) return null;

    const entry = fileURLToPath(import.meta.url);
    const record = describeInstallation(entry, getCurrentVersion(), new Date(now).toISOString());
    const installations = readInstallations();
    const existing = installations.find((candidate) => candidate.id === record.id);

    if (existing) {
      if (existing.version === record.version && now - Date.parse(existing.lastSeenAt) < RESEEN_EVERY_MS) return existing;

      record.lastUpdateAt = existing.lastUpdateAt;
      record.lastUpdateOutcome = existing.lastUpdateOutcome;
      record.lastUpdateMessage = existing.lastUpdateMessage;
      installations[installations.indexOf(existing)] = record;
    } else {
      installations.push(record);
    }

    writeInstallations(installations);

    return record;
  } catch (e) {
    // The inventory is diagnostic: a read-only home must not stop a command
    // or a hook before its own work starts (#1753 review).
    log.debug(`Could not record this TeamAI installation: ${e instanceof Error ? e.message : String(e)}`);

    return null;
  }
}

/**
 * Other npm-global copies that are older than `latest`. The running copy is
 * excluded: its own update path already covers it. A copy that has never been
 * tried comes before one that failed, so a bad copy cannot hide the rest.
 */
export function selectOtherInstallation(latest: string, runningEntry: string): InstallationRecord | null {
  const running = describeInstallation(runningEntry, getCurrentVersion());

  const candidates = readInstallations().filter((record) => {
    if (record.id === running.id || record.method !== 'npm-global' || !record.prefix) return false;

    const version = readInstalledVersion(packageDirFromEntry(record.entry));

    return version !== null && compareVersions(version, latest) < 0;
  });

  // Never-tried copies first, then the one tried longest ago, so a copy that
  // cannot be updated does not hide the others on every run.
  const triedAt = (record: InstallationRecord): number => record.lastUpdateAt
    ? Date.parse(record.lastUpdateAt)
    : Number.NEGATIVE_INFINITY;

  candidates.sort((a, b) => triedAt(a) - triedAt(b) || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));

  return candidates[0] ?? null;
}

export function readInstalledVersion(pkgDir: string): string | null {
  try {
    const parsed = z.object({ version: z.string() }).safeParse(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')));

    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}

/** Record what an update of this copy did, without losing its registration. */
export function setInstallationUpdate(
  id: string,
  outcome: 'updated' | 'failed' | 'skipped',
  message: string,
  version?: string,
): void {
  try {
    const installations = readInstallations();
    const index = installations.findIndex((record) => record.id === id);

    if (index < 0) return;

    const record = installations[index]!;

    installations[index] = {
      ...record,
      version: version ?? record.version,
      lastUpdateAt: new Date().toISOString(),
      lastUpdateOutcome: outcome,
      lastUpdateMessage: message,
    };

    writeInstallations(installations);
  } catch (e) {
    log.debug(`Could not record the update result: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** `teamai doctor` notes: what this machine has run, with a remedy for each layout npm must not touch. */
export function installationNotes(): string[] {
  return readInstallations().map((record) => {
    if (!fs.existsSync(packageDirFromEntry(record.entry))) {
      return `TeamAI installation: ${record.entry} (v${record.version}, ${record.method}) is no longer on disk; it will not be updated.`;
    }

    const where = `${record.entry} (v${record.version}, ${record.method}${record.autoUpdateSupported ? ', automatic updates supported' : ''})`;

    switch (record.method) {
      case 'npm-global':
        return `TeamAI installation: ${where}.${record.prefix ? ` npm prefix ${record.prefix}.` : ''}`;
      case 'volta':
        return `TeamAI installation: ${where} is managed by Volta; upgrade it with "volta install ${getCurrentPackageName()}@latest".`;
      case 'vendored':
        return `TeamAI installation: ${where} is a vendored copy; update it manually.`;
      case 'local':
        return `TeamAI installation: ${where} is a local checkout; update it with "git pull" and rebuild.`;
      default: {
        const unhandled: never = record.method;

        return unhandled;
      }
    }
  });
}
