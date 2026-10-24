import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { z } from 'zod';
import YAML from 'yaml';
import { ResourceHandler } from './base.js';
import { placedCopy } from './repo-resource.js';
import { loadStateForScope } from '../config.js';
import type { ResourceItem, ResourceItemStatus, TeamaiConfig, LocalConfig } from '../types.js';
import { TEAMAI_ENV_START, TEAMAI_ENV_END, getDataHome, getEnvBackupPath, getTeamaiHome, isSelfMode } from '../types.js';
import { pathExists, readFileIfExists, readFileSafe, writeFile, ensureDir, fileContentEqual, remove, symlinkTarget } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { envShExportsPath, envShMarker, isEnvShMarker, recordEnvShExports } from '../env-sh-exports.js';
import { ENV_KEY_RE, envNamePattern, envNamePatternKey, envTable, sameEnvName } from './env-key.js';
import { SECRETS_LAYOUT } from './secrets.js';
import { envLoaderPath, hasEnvLoadingScope, markEnvScopePending, registerEnvScope, writeEnvLoader } from './env-loader.js';
import {
  listEntryFiles, readEntryFileText, reportEntryResolution, resolveEntriesFor,
  unknownEntryKeys, writtenList, type EntryFile, type EntryReader,
} from '../namespaced-entries.js';
import {
  SHELL_PROFILE_CANDIDATE_NAMES,
  envLoaderProfiles,
  resolveActiveShellProfile,
  shellQuoteValue,
  isWindowsFormPath,
  findEnvBlocks,
  envBlockReferencesDataHome,
  sameFile,
  type EnvBlock,
} from '../utils/shell-profile.js';
import { expandHome, getUserHome } from '../utils/home.js';
import { isReservedTeamEnvKey, reservedTeamEnvWarning } from '../env-reserved.js';

// ─── Schema for env.yaml ────────────────────────────────

const EnvVariableSchema = z.object({
  key: z.string(),
  value: z.string(),
  description: z.string().optional(),
  /**
   * Removed per-entry keys, kept in the schema so they are detected rather than
   * stripped: a variable carrying one reaches nobody (see namespaced-entries).
   */
  roles: z.array(z.string()).optional(),
  projects: z.array(z.string()).optional(),
});

const EnvYamlSchema = z.object({
  variables: z.array(EnvVariableSchema).default([]),
});

export type EnvVariable = z.infer<typeof EnvVariableSchema>;
export type EnvYaml = z.infer<typeof EnvYamlSchema>;

/** The keys `variable` was written with that env.yaml does not know: pull does not deliver it (#822). */
export function unknownEnvVariableKeys(variable: object): string[] {
  return Object.keys(variable).filter((key) => !Object.hasOwn(EnvVariableSchema.shape, key));
}

/** A parsed env.yaml, or the reason it declares nothing. See `readEnvYaml`. */
export type EnvYamlRead =
  | { ok: true; variables: EnvVariable[] }
  | { ok: false; reason: string };

/**
 * How `env/env.yaml` and `env/<ns>/env.yaml` are read for delivery. A file
 * without a top-level `variables:` key is broken, not empty (#662), so it keeps
 * the installed variables instead of clearing them.
 */
export const envEntryReader: EntryReader<EnvVariable> = {
  type: 'env',
  async read(absolutePath, relativePath) {
    const file = await readEntryFileText(absolutePath, relativePath);
    if (!file.ok) return file;
    const content = file.text;
    if (content === null) return null;
    let raw: unknown;
    try {
      raw = YAML.parse(content);
    } catch (e) {
      return { ok: false, reason: `${relativePath} is not valid YAML: ${e instanceof Error ? e.message : String(e)}` };
    }
    const shapeProblem = describeEnvYamlShapeProblem(raw);
    if (shapeProblem) return { ok: false, reason: `${relativePath} declares no variables: ${shapeProblem}` };
    const read = parseEnvYamlDocument(raw, relativePath);
    if (!read.ok) return read;
    return { ok: true, entries: read.variables, unknownKeys: unknownEntryKeys(raw, 'variables', read.variables, EnvVariableSchema) };
  },
  nameOf: (variable) => variable.key,
  scopeOf: (variable) => variable,
};

/**
 * Report the one env.yaml shape mistake zod cannot surface on its own: a
 * mapping that has no top-level `variables:` key but does have at least one
 * other top-level key. That is what a bare `FOO: bar` list looks like, and
 * also what a misspelling looks like.
 *
 * `variables` is declared with `.default([])`, and zod drops unknown keys
 * without a word, so such a file parses cleanly as "no variables": every env
 * variable silently stops being delivered, with nothing in the output
 * explaining why (#662).
 *
 * `envEntryReader` applies this to every env file, so such a file fails the
 * env resolution and keeps the exported variables, with this as the reason.
 *
 * Only this shape is reported. Every other shape stays permissive on purpose —
 * most importantly a valid `variables:` list that also carries an extra
 * top-level key, which must keep being delivered rather than start failing to
 * parse.
 *
 * @returns the warning to log, or `null` when there is nothing to report.
 */
export function describeEnvYamlShapeProblem(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length === 0 || keys.includes('variables')) return null;

  return [
    'env.yaml has no top-level `variables:` key, so no environment variable was delivered.',
    `Top-level keys found instead: ${keys.map(k => `\`${k}\``).join(', ')}.`,
    '`variables:` must be present and hold a list of `key`/`value` entries, e.g.',
    '',
    '  variables:',
    '    - key: FOO',
    '      value: bar',
  ].join('\n');
}

/**
 * Mask an env variable value for display.
 * Shows first 2 chars + "****", or "****" for very short values.
 */
export function maskEnvValue(value: string): string {
  if (value.length < 4) return '****';
  return `${value.slice(0, 2)}****`;
}

/**
 * Read back the assignments `generateEnvFile` writes, as key → value.
 *
 * The inverse of the generator, and it has to be: a YAML block scalar is a
 * legal env value, and single-quoting one spans several physical lines. A
 * reader that splits env.sh on newlines can never match such an export, so it
 * reports a correctly delivered value as stale (#624 review). Lines that are
 * not an `export KEY='...'` we wrote are skipped rather than guessed at.
 */
export function parseEnvFile(content: string): Map<string, string> {
  const PREFIX = 'export ';
  const assignments = new Map<string, string>();

  let i = 0;
  while (i < content.length) {
    const eq = content.startsWith(PREFIX, i) ? content.indexOf('=', i + PREFIX.length) : -1;
    const key = eq === -1 ? '' : content.slice(i + PREFIX.length, eq);
    // The marker is not a team variable (env-sh-exports.ts), and fits on its line.
    if (eq === -1 || !ENV_KEY_RE.test(key) || content[eq + 1] !== "'" || isEnvShMarker(key)) {
      const nl = content.indexOf('\n', i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }

    let j = eq + 2;
    let value = '';
    let closed = false;
    while (j < content.length) {
      if (content[j] !== "'") {
        value += content[j];
        j++;
      } else if (content.startsWith("'\\''", j)) {
        // The generator's encoding of a literal quote: close, escape, reopen.
        value += "'";
        j += 4;
      } else {
        closed = true;
        j++;
        break;
      }
    }
    // An unterminated quote means the rest of the file is not ours to read.
    if (!closed) break;

    assignments.set(key, value);
    i = content[j] === '\n' ? j + 1 : j;
  }

  return assignments;
}

/** Whether env.sh exports `key`: a shell identifier the loader does not reserve. The env backup and the export record hold the same keys. */
function isExportedEnvKey(key: string): boolean {
  return ENV_KEY_RE.test(key) && !isReservedTeamEnvKey(key);
}

/**
 * Put `file` back as it was before a write that failed: `before`, or not
 * there when null. A file that already holds `before` is left alone, as a
 * write refused at the start (a read-only file) changed nothing.
 */
async function putBack(file: string, before: string | null): Promise<void> {
  if (before === null) await remove(file);
  else if (await readFileIfExists(file) !== before) await writeFile(file, before);
}

const KEEP_PREFIX = 'case " ${__teamai_keys-} " in *" "';

/**
 * Read back the keys `generateEnvFile` keeps from the user scope's env.sh: the
 * lines before its first export, so a line inside a multiline value is not one.
 */
export function parseEnvFileKept(content: string): Set<string> {
  const lines = content.split('\n');
  const exports = lines.findIndex((line) => !line.startsWith(KEEP_PREFIX));
  return new Set(lines.slice(0, exports === -1 ? lines.length : exports).flatMap((line) => {
    const key = envNamePatternKey(line.slice(KEEP_PREFIX.length).split('"')[0]);
    return ENV_KEY_RE.test(key) ? [key] : [];
  }));
}

/**
 * What the last pull exported, from the env backup it wrote: a JSON object,
 * so a value with newlines or surrounding spaces reads back as env.sh exports
 * it. A backup an older version wrote, one `KEY=value` per line, is read as
 * before until the next pull rewrites it. Empty before a pull; one that cannot
 * be read, or starts as JSON and does not parse, throws.
 */
export async function readEnvBackup(localConfig: LocalConfig): Promise<Record<string, string>> {
  const table = envTable<string>();
  // Must use the same path the env channel wrote (getEnvBackupPath) — self mode
  // uses env.local, not env (which is a committed directory there).
  const backupPath = getEnvBackupPath(localConfig);
  let content: string;
  try {
    content = await readFile(backupPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return table;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Env backup is unreadable at ${backupPath}: ${reason}`);
  }
  if (content.trimStart().startsWith('{')) {
    const values = backupValues(content);
    if (typeof values === 'string') throw new Error(`Env backup is unreadable at ${backupPath}: ${values}`);
    for (const [key, value] of Object.entries(values)) table[key] = value;
    return table;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    table[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return table;
}

/** The values of a JSON env backup, or why it holds none. */
function backupValues(content: string): Record<string, string> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'not a JSON object';
  return Object.values(parsed).every((value) => typeof value === 'string') ? parsed as Record<string, string> : 'a value is not a string';
}

/** Validate a parsed env.yaml document; `label` names the file in the reason. */
function parseEnvYamlDocument(raw: unknown, label: string): EnvYamlRead {
  // An empty document is a file with nothing to deliver, not a broken one.
  if (raw === null || raw === undefined) return { ok: true, variables: [] };

  if (typeof raw !== 'object' || Array.isArray(raw) || !('variables' in raw)) {
    return {
      ok: false,
      reason: `${label} declares no variables. Its top-level key must be \`variables:\`, a list `
        + 'of `key`/`value` entries — a plain `KEY: value` mapping parses as an empty list',
    };
  }

  const parsed = EnvYamlSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `${label} does not match the env.yaml schema: ${parsed.error.message}` };
  }
  return { ok: true, variables: parsed.data.variables };
}

function envPushItem(relativePath: string, sourcePath: string, status: ResourceItemStatus = 'modified'): ResourceItem {
  return { name: relativePath.slice('env/'.length), type: 'env', sourcePath, relativePath, status };
}

/** A `source` or `.` command naming a file called env.sh. */
const SOURCES_ENV_SH = /(?:^|[\s;&|])(?:source|\.)\s[^\n;&|]*env\.sh/m;

/**
 * `content` without the per-scope blocks versions before #1018 wrote: a block
 * that sources an env.sh, or the inline-export format from before env.sh.
 * The loader's own block, an unclosed one, and anything else stay. With
 * `scopeEnvSh`, only that scope's blocks go: the ones that source its env.sh,
 * and for the user scope the inline-export one, which only it ever wrote
 * (project scopes came after env.sh).
 */
function withoutOldBlocks(content: string, loaderPath: string, scopeEnvSh?: string): { content: string; dropped: EnvBlock[] } {
  const userEnvSh = path.join(getTeamaiHome('user'), 'env.sh');
  const dropped = findEnvBlocks(content).filter((block): block is EnvBlock & { end: number } => {
    if (block.end === null || envBlockReferencesDataHome(block.text, loaderPath)) return false;
    if (SOURCES_ENV_SH.test(block.text)) return scopeEnvSh === undefined || envBlockReferencesDataHome(block.text, scopeEnvSh);
    const inline = block.text.split('\n').slice(1).every((line) => line === '' || line.startsWith('#') || line.startsWith('export '));
    return inline && (scopeEnvSh === undefined || scopeEnvSh === userEnvSh);
  });
  let kept = content;
  // One blank line stays between the text around a block, none at either end.
  for (const block of [...dropped].reverse()) {
    const head = kept.substring(0, block.start).replace(/\n+$/, '');
    const tail = kept.substring(block.end).replace(/^\n+/, '');
    kept = head && tail ? `${head}\n\n${tail}` : head ? `${head}\n` : tail;
  }
  return { content: kept, dropped };
}

// ─── Handler ─────────────────────────────────────────────

export class EnvHandler extends ResourceHandler {
  readonly type = 'env' as const;

  /**
   * Scan for local env changes that need to be pushed: `env/env.yaml`, every
   * `env/<ns>/env.yaml`, and the same for `secrets.yaml`, one item per changed file.
   */
  async scanLocalForPush(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const listEnvFiles = async (root: string): Promise<EntryFile[]> =>
      [...await listEntryFiles(root, 'env'), ...await listEntryFiles(root, SECRETS_LAYOUT)];

    // Single-repo mode: users edit team env directly at <repo>/.teamai/env/
    // (it lives in their own repo). push runs in the knowledge worktree, so
    // localConfig.repo.localPath here is the origin/<default> checkout — diff the
    // ACTIVE tree's copies against it and surface genuine additions/edits. (Active
    // tree = projectRoot, which withKnowledgeWorktree deliberately leaves intact.)
    if (isSelfMode(localConfig) && localConfig.projectRoot) {
      const activeRoot = path.join(localConfig.projectRoot, '.teamai');
      const items: ResourceItem[] = [];
      // Where an earlier push placed a file this machine still edits at
      // .teamai/env/, recorded once that placement landed (`state.placements`).
      // Without it the unchanged original reads as new on every run and the
      // placement collides with the copy it already wrote.
      const placements = (await loadStateForScope(localConfig)).placements ?? {};
      for (const { relativePath, absolutePath: activeEnv } of await listEnvFiles(activeRoot)) {
        const baseEnv = path.join(localConfig.repo.localPath, ...relativePath.split('/'));
        // Not in the baseline → new; present but different → modified; equal → skip.
        const baseExists = await pathExists(baseEnv);
        if (baseExists && await fileContentEqual(activeEnv, baseEnv)) continue;
        if (!baseExists) {
          // An earlier push may have placed this file under a namespace.
          const placed = await placedCopy('env', relativePath.slice('env/'.length), relativePath, activeEnv, localConfig, placements);
          if (placed === 'delivered') continue;
          if (placed) {
            items.push(placed);
            continue;
          }
        }
        items.push(envPushItem(relativePath, activeEnv, baseExists ? 'modified' : 'new'));
      }
      return items;
    }

    const repoPath = localConfig.repo.localPath;
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    // Modified and untracked files under env/. A file git cannot report on
    // (no repository) is treated as changed, as before. `-z` keeps a
    // non-ASCII path unquoted, so it matches the name on disk.
    let changed: Set<string> | null = null;
    let untracked: Set<string> = new Set();
    try {
      const [changedRes, untrackedRes] = await Promise.all([
        execFileAsync(
          'git',
          ['ls-files', '-z', '--modified', '--others', '--exclude-standard', '--', 'env'],
          { cwd: repoPath },
        ),
        execFileAsync(
          'git',
          ['ls-files', '-z', '--others', '--exclude-standard', '--', 'env'],
          { cwd: repoPath },
        ),
      ]);
      changed = new Set(changedRes.stdout.split('\0').filter(Boolean));
      untracked = new Set(untrackedRes.stdout.split('\0').filter(Boolean));
    } catch {
      changed = null;
    }

    const items: ResourceItem[] = [];
    for (const { relativePath, absolutePath } of await listEnvFiles(repoPath)) {
      if (changed && !changed.has(relativePath)) continue;
      const status = untracked.has(relativePath) || !changed ? 'new' : 'modified';
      items.push(envPushItem(relativePath, absolutePath, status));
    }
    return items;
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const envYamlPath = path.join(localConfig.repo.localPath, 'env', 'env.yaml');
    if (!await pathExists(envYamlPath)) return [];

    return [{
      name: 'env.yaml',
      type: 'env',
      sourcePath: envYamlPath,
      relativePath: 'env/env.yaml',
    }];
  }

  async pushItem(item: ResourceItem, _teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    // The source path may differ from the destination when placement rewrote
    // `relativePath` (e.g. env/env.yaml → env/<ns>/env.yaml). Copy the bytes so
    // the staged path actually exists in the clone before push.ts commits it.
    //
    // Self mode: the source is the ACTIVE tree's .teamai/env/ file, but the
    // commit happens in the knowledge worktree (localConfig.repo.localPath).
    // Non-self: the source is the clone, but placement may have moved the path.
    const repoRoot = path.resolve(localConfig.repo.localPath);
    const dest = path.resolve(repoRoot, ...item.relativePath.split('/'));
    const original = path.resolve(item.sourcePath);
    if (original !== dest) {
      await ensureDir(path.dirname(dest));
      const content = await readFileSafe(original);
      if (content !== null) {
        await writeFile(dest, content);
        // Retire the clone-local original, as pushRepoResourceItem does: the
        // placement moved the file, and a leftover env/env.yaml stays untracked
        // and is rediscovered as new by the next push, which then aborts
        // because the placed env/<ns>/env.yaml already exists. In self mode the
        // source is the ACTIVE tree's .teamai/env file, outside the clone, and
        // must stay: that is the copy the author keeps editing.
        if (original.startsWith(repoRoot + path.sep)) await remove(original);
      }
    }
  }

  /**
   * Pull env variables for this member: resolve the root and active namespace
   * files, then write env.sh. A failed resolution is reported and leaves the
   * exported variables as they are.
   */
  async pullItem(_item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const resolution = await resolveEntriesFor(envEntryReader, localConfig);
    reportEntryResolution(resolution);
    if (resolution.kind === 'failed') return;
    await this.writeResolvedEnv(resolution.entries.map((entry) => entry.entry), teamConfig, localConfig);
  }

  /**
   * Write env.sh, its env backup and the shell profile block from the
   * resolved variables. Runs with an empty set too, which is what removes the
   * variables of a namespace that deactivated or a file that was emptied; only
   * a scope that never had env delivered writes no env.sh (returns false). It
   * installs the loader whenever this pull leaves any registered scope loading
   * env, including an inherited user scope under an env-less project.
   */
  async writeResolvedEnv(variables: EnvVariable[], teamConfig: TeamaiConfig, localConfig: LocalConfig, kept: readonly string[] = []): Promise<boolean> {
    const warning = reservedTeamEnvWarning(variables.map(({ key }) => key));
    if (warning) log.warn(warning);
    // getEnvBackupPath returns <teamaiHome>/env normally, but <teamaiHome>/env.local
    // in self mode — where <teamaiHome>/env is a committed DIRECTORY (env/env.yaml)
    // and writing a file there would throw EISDIR.
    const teamaiHome = getDataHome(localConfig);
    const envShPath = path.join(teamaiHome, 'env.sh');
    const inject = teamConfig.sharing.env.injectShellProfile !== false;
    const needsEnvGate = localConfig.scope === 'project' && localConfig.inheritUserScope === true;
    // Until its row is written, nothing else tells the loader this checkout is a project's.
    if (localConfig.scope === 'project' && localConfig.projectRoot) await markEnvScopePending(localConfig.projectRoot);
    if (variables.length === 0 && kept.length === 0 && !await pathExists(envShPath) && !needsEnvGate) {
      await this.updateShellProfile(teamConfig, envShPath, inject, localConfig);
      await registerEnvScope(localConfig, inject);
      return false;
    }

    await ensureDir(teamaiHome);

    // <teamaiHome>/env.sh (sourceable export file). What it exported before
    // and after is recorded first: a shell opened before this rewrite still
    // carries those values, and they are the team's, not the member's (#879
    // Conflict 10). The old ones are there too for an env.sh an older CLI wrote.
    const before = await readFileIfExists(envShPath);
    const recordFile = envShExportsPath(envShPath);
    const recordBefore = await readFileIfExists(recordFile);
    const backupPath = getEnvBackupPath(localConfig);
    const backupBefore = await readFileIfExists(backupPath);
    const exported = variables.filter(({ key }) => isExportedEnvKey(key));
    const previous = parseEnvFile(before ?? '');
    const recorded = await recordEnvShExports(envShPath, [
      ...previous,
      ...exported.map((v): [string, string] => [v.key, v.value]),
    ]);
    const envSh = this.generateEnvFile(variables, kept);
    const marker = envShMarker(teamaiHome, parseEnvFile(envSh), recorded);
    const content = marker ? `${envSh}export ${marker[0]}='${marker[1]}'\n` : envSh;
    // The machine-local backup of what this pull exports (readEnvBackup), which
    // env exec and MCP read: it changes only with env.sh, so they never get
    // values the shells do not. The record goes back with them: an export that
    // never happened must not count as the team's. A file counts as changed
    // once its write starts, as one that fails part way has emptied it.
    const writes: [file: string, before: string | null, content: string][] = [
      [envShPath, before, content],
      [backupPath, backupBefore, `${JSON.stringify(Object.fromEntries(exported.map((v) => [v.key, v.value])), null, 2)}\n`],
    ];
    const started: [file: string, before: string | null][] = [[recordFile, recordBefore]];
    try {
      for (const [file, previousContent, next] of writes) {
        started.push([file, previousContent]);
        await writeFile(file, next);
      }
    } catch (error) {
      try {
        for (const [file, previousContent] of started) await putBack(file, previousContent);
      } catch (restoreError) {
        // env.sh is neither the old one nor the new one: no shell loads it.
        const closed = await registerEnvScope(localConfig, false).then(() => true, () => false);
        throw new Error(`Could not write ${envShPath} and the env backup (${String(error)}), nor put them and ${recordFile} back as they were (${String(restoreError)}). `
          + `${closed ? 'Shells load no team env from it' : 'Shells may load what was written of it'} until teamai pull runs again once all are writable.`, { cause: error });
      }
      throw error;
    }

    // Migrate profile blocks before changing an existing row to opted out.
    // If a profile write fails, the old route remains active and visible.
    await this.updateShellProfile(teamConfig, envShPath, inject, localConfig);
    await registerEnvScope(localConfig, inject, { envChanged: content !== before });
    return true;
  }

  /**
   * Register a scope whose current env could not resolve, after its profile is
   * ready. Its last env.sh and backup stay, so shells keep loading what env
   * exec and MCP keep; a scope never delivered loads none. A key it now
   * declares a secret (`secretKeys`) leaves them, as it leaves what env exec and
   * MCP keep, and an inheriting project keeps the member's own value of it.
   */
  async registerUnresolvedScope(teamConfig: TeamaiConfig, localConfig: LocalConfig, secretKeys: readonly string[]): Promise<void> {
    const envShPath = path.join(getDataHome(localConfig), 'env.sh');
    const last = await readFileIfExists(envShPath);
    if (last !== null && secretKeys.length > 0) {
      const exports = [...parseEnvFile(last)];
      const keeps = [...parseEnvFileKept(last)];
      const kept = exports.filter(([key]) => sameEnvName(secretKeys, key) === undefined);
      const inherits = localConfig.scope === 'project' && localConfig.inheritUserScope === true;
      const newKeeps = inherits ? secretKeys.filter((key) => sameEnvName(keeps, key) === undefined && !isReservedTeamEnvKey(key)) : [];
      if (kept.length < exports.length || newKeeps.length > 0) {
        await this.writeResolvedEnv(kept.map(([key, value]) => ({ key, value })), teamConfig, localConfig, [...keeps, ...newKeeps]);
        return;
      }
    }
    const inject = teamConfig.sharing.env.injectShellProfile !== false;
    if (localConfig.scope === 'project' && localConfig.projectRoot) await markEnvScopePending(localConfig.projectRoot);
    await this.updateShellProfile(teamConfig, envShPath, inject, localConfig);
    await registerEnvScope(localConfig, inject && await pathExists(envShPath));
  }

  /**
   * Install the loader while any registered scope loads env. Otherwise no
   * shell loads this scope's env through it, so the blocks an older version
   * wrote to source this scope's env.sh are the only way left, and they go;
   * another scope's stay for its own pull to move.
   */
  private async updateShellProfile(teamConfig: TeamaiConfig, envShPath: string, inject: boolean, localConfig?: LocalConfig): Promise<void> {
    if (inject || await hasEnvLoadingScope(localConfig)) return this.installEnvLoader(teamConfig);
    const override = teamConfig.sharing.env.shellProfilePath;
    await this.injectShellProfile(null, envLoaderPath(), override ? [expandHome(override)] : [], envShPath);
  }

  /**
   * Write the loader and put its block into each profile it goes in (`envLoaderProfiles`).
   */
  private async installEnvLoader(teamConfig: TeamaiConfig): Promise<void> {
    const loaderPath = envLoaderPath();
    const override = teamConfig.sharing.env.shellProfilePath;
    const { paths: profilePaths, ignoredOverride } = await envLoaderProfiles(override, loaderPath);
    // An older version wrote its block to the override whatever the shell.
    const overridden = override ? [expandHome(override)] : [];
    if (ignoredOverride) {
      log.warn(`teamai.yaml sets sharing.env.shellProfilePath to ${ignoredOverride}, which not every zsh reads: `
        + `the team env loader goes in ${profilePaths[0]} instead.`);
    }
    await writeEnvLoader();
    const shellBlock = this.generateShellBlock(loaderPath);
    await this.injectShellProfile({ files: profilePaths, block: shellBlock }, loaderPath, overridden);
  }

  /**
   * Parse the env.yaml file and return variables.
   */
  async parseEnvYaml(filePath: string): Promise<EnvYaml> {
    const read = await this.readEnvYaml(filePath);
    return { variables: read.ok ? read.variables : [] };
  }

  /**
   * Parse env/env.yaml, keeping the reason a file yielded no variables.
   *
   * `parseEnvYaml` answers `[]` to four different files: absent, empty,
   * `variables: []`, and a shorthand `KEY: value` mapping whose unknown
   * top-level key zod drops (#662). Only the last is broken, so a caller that
   * reports on the count alone either misses the bug or calls a deliberately
   * empty configuration malformed (#624 review).
   */
  async readEnvYaml(filePath: string): Promise<EnvYamlRead> {
    const content = await readFileSafe(filePath);
    if (content === null) return { ok: true, variables: [] };

    let raw: unknown;
    try {
      raw = YAML.parse(content);
    } catch (e) {
      return { ok: false, reason: `${filePath} is not valid YAML: ${(e as Error).message}` };
    }
    const read = parseEnvYamlDocument(raw, filePath);
    if (!read.ok) return read;
    // A rewrite keeps every key a variable was written with: dropping a
    // misspelled `roles:` would deliver the variable to every member (#822).
    const written = writtenList(raw, 'variables');
    return {
      ok: true,
      variables: read.variables.map((variable, index) => {
        const entry: unknown = Array.isArray(written) ? written[index] : undefined;
        return entry !== null && typeof entry === 'object' ? { ...entry, ...variable } : variable;
      }),
    };
  }

  /**
   * Write env.yaml with the given variables.
   */
  async writeEnvYaml(filePath: string, envConfig: EnvYaml): Promise<void> {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, YAML.stringify(envConfig));
  }

  /**
   * Generate the shell block: one line that sources the env loader (#1018),
   * the same block for every scope.
   *
   * The block is read back by a POSIX shell (bash/zsh/sh) even on Windows,
   * where `loaderPath` is a native path such as `C:\Users\me\.teamai\env-loader.sh`.
   * The block used to interpolate such a path as-is, so on Windows `[ -f ... ]`
   * tested a backslash path the shell treats as an escape sequence, and
   * `source` never ran — while nothing reported a failure (#661).
   *
   * A Windows-form path is rewritten to forward slashes, which Git Bash, WSL
   * and MSYS all accept, so one block loads on every shell the CLI supports.
   * The rewrite keys off the path's own shape, never `path.sep`, so the output
   * is byte-identical across platforms and the Windows form stays assertable
   * from the Linux/macOS CI runners. A POSIX path is passed through untouched:
   * its backslashes are filename characters, not separators.
   *
   * The path is quoted unconditionally (`shellQuoteValue`). It sits inside a
   * `[ -f ... ]` test, so an unquoted space or glob metacharacter in a home
   * directory would break that test and split the `source` builtin. Quoting
   * only "when needed" would put the quoted form out of reach of the runner.
   */
  generateShellBlock(loaderPath: string): string {
    const quoted = shellQuoteValue(isWindowsFormPath(loaderPath) ? loaderPath.replace(/\\/g, '/') : loaderPath);
    const lines = [
      TEAMAI_ENV_START,
      '# DO NOT EDIT: This section is auto-managed by teamai',
      `[ -f ${quoted} ] && . ${quoted}`,
      TEAMAI_ENV_END,
    ];
    return lines.join('\n');
  }

  /**
   * Generate the content of ~/.teamai/env.sh with export statements.
   *
   * Values are single-quoted so shell metacharacters in an env value (quotes,
   * `$`, backticks, `\`, …) are taken literally and cannot break or inject into
   * the sourced script. An embedded single quote is encoded with the standard
   * `'\''` sequence. env.sh is sourced from every team member's shell profile,
   * so values (which originate from the team repo's env/env.yaml) must be safe.
   *
   * Keys are interpolated raw into the export statement, so they are held to
   * the same identifier rule `parseEnvFile` applies when reading env.sh back. A
   * key that fails it is dropped rather than emitted: `export bad key='x'` is
   * not valid shell, and `export FOO;cmd='x'` would run `cmd` in every member's
   * shell. Dropping keeps the write and read sides in agreement — a line
   * `parseEnvFile` must skip anyway is better left unwritten. One member's bad
   * key must not take the whole file down with it, so the rest still ship.
   *
   * `kept` are keys a project that inherits the user scope declares and its
   * exports may not overwrite (`keptFromUserScope`): the loader sources the
   * user scope's env.sh first, and these lines, before the exports, put back
   * the member's own value of each name it set that is the same environment
   * variable, in any spelling on Windows (`__teamai_env_keep`, env-loader.ts).
   */
  generateEnvFile(variables: EnvVariable[], kept: readonly string[] = []): string {
    const lines = variables
      .filter(v => isExportedEnvKey(v.key))
      .map(v => `export ${v.key}=${shellQuoteValue(v.value)}`);
    const keeps = kept
      .filter(isExportedEnvKey)
      .map(key => `${KEEP_PREFIX}${envNamePattern(key)}" "*) __teamai_env_keep '${envNamePattern(key)}' ;; esac`);
    return [...keeps, ...lines].join('\n') + '\n';
  }

  /**
   * Detect the user's shell profile path.
   *
   * Public because `doctor` has to check the same file the injection writes:
   * a second spelling of this choice would check `.bashrc` while the pull
   * wrote `.zshrc`, and report a correct install as broken. Delegates to the
   * shared `utils/shell-profile.js` so `teamai uninstall` resolves the same
   * file too (#682), and follows the chain of files the order-based pick
   * actually `source`s to reuse a candidate that already carries the block
   * sourcing `sourcedPath`, rather than injecting a duplicate every time a new
   * file enters that chain (#693 review rounds 7-9).
   */
  detectShellProfile(sourcedPath: string, platform: NodeJS.Platform = process.platform): Promise<string> {
    return resolveActiveShellProfile(sourcedPath, platform);
  }

  /**
   * Put the loader block into the profile file (idempotent), and take out
   * every per-scope block an older version wrote (#1018), from this file and
   * from every other profile file a version could have written to: one left
   * in `.zshrc` would load its scope's env in every interactive shell, on top
   * of what the loader picked for the directory. An unclosed block has no end
   * to cut up to, so it is left as it is. All or nothing: the older blocks
   * still load the team env without the loader block, and one left beside it
   * loads its scope's env on top of the directory's, so a failed write puts
   * back every file this one changed, and the failure propagates.
   *
   * With no `loader`, only the older blocks that source `scopeEnvSh` go.
   *
   * Each file is planned and written once, by the file its links end at: a
   * `.zshrc` linked to `.zshenv` is one file, and a second write through the
   * other name would put back what the first took out, or erase the loader
   * block. It is written through the name the member uses, so a link stays,
   * and a failed pull puts back the file the link ends at: one it created,
   * even behind a link that pointed nowhere yet, is removed, never the link.
   */
  private async injectShellProfile(loader: { files: string[]; block: string } | null, loaderPath: string, overridden: string[], scopeEnvSh?: string): Promise<void> {
    const removed: EnvBlock[] = [];
    const home = getUserHome();
    // The loader's files first: if its block cannot go in, no older block is touched.
    const files = new Map<string, string>();
    for (const file of [...loader?.files ?? [], ...overridden, ...SHELL_PROFILE_CANDIDATE_NAMES.map((name) => path.join(home, name))]) {
      const target = await realpath(file).catch(() => symlinkTarget(file));
      if (![...files.keys()].some((known) => sameFile(known, target))) files.set(target, file);
    }
    // `created` is the first directory a write makes on the way to a new
    // file, as when a link points into a dotfiles directory not there yet.
    const writes: { file: string; target: string; before: string | null; created: string | null; content: string }[] = [];
    for (const [target, file] of files) {
      const original = await readFileIfExists(file);
      const stripped = withoutOldBlocks(original ?? '', loaderPath, scopeEnvSh);
      removed.push(...stripped.dropped);
      let content = stripped.content;
      if (loader?.files.includes(file)) {
        const own = findEnvBlocks(content).find((b) => b.end !== null && envBlockReferencesDataHome(b.text, loaderPath));
        if (own?.end != null) {
          content = content.substring(0, own.start) + loader.block + content.substring(own.end);
        } else {
          if (content.length > 0 && !content.endsWith('\n')) content += '\n';
          content += '\n' + loader.block + '\n';
        }
      }
      // Skip the write when nothing changed: this runs on every pull,
      // including the one a SessionStart hook runs each session.
      if (content === (original ?? '')) continue;
      const exists = await pathExists(target);
      let created: string | null = null;
      for (let dir = path.dirname(target); !exists && !await pathExists(dir); dir = path.dirname(dir)) created = dir;
      writes.push({ file, target, before: exists ? original ?? '' : null, created, content });
    }
    const written: typeof writes = [];
    try {
      for (const write of writes) {
        // Before the write: one that fails part way has emptied the file.
        written.push(write);
        // Through the end of the link, so its directory is made too.
        await writeFile(write.target, write.content);
      }
    } catch (error) {
      const unrestored: string[] = [];
      for (const { file, target, before, created } of written.reverse()) {
        try {
          await putBack(before === null ? created ?? target : file, before);
        } catch (restoreError) {
          unrestored.push(`${file} (${String(restoreError)})`);
        }
      }
      if (unrestored.length > 0) {
        throw new Error(`Could not update the shell profile (${String(error)}), nor put back as they were: ${unrestored.join(', ')}. Check the teamai env blocks in those files.`, { cause: error });
      }
      throw error;
    }

    // A shell in a project loaded the user scope's block too; now only a
    // project that inherits the user scope does.
    const userEnvSh = path.join(getTeamaiHome('user'), 'env.sh');
    // A removed block that sources no env.sh is the inline-export one, the user scope's.
    const hadUserBlock = removed.some((b) => !SOURCES_ENV_SH.test(b.text) || envBlockReferencesDataHome(b.text, userEnvSh));
    const hadProjectBlock = removed.some((b) => SOURCES_ENV_SH.test(b.text) && !envBlockReferencesDataHome(b.text, userEnvSh));
    if (hadUserBlock && hadProjectBlock) {
      const notice = 'User-scope env no longer loads inside project directories: each directory now gets its own scope\'s env. '
        + 'To keep user env variables in a project, set `inheritUserScope: true` there (`teamai init <repo> --inherit-user-scope`).';
      log.info(notice);
      // The session-start pull is silent: debug.log keeps it.
      log.persist(notice);
    }
  }

  async removeItem(_name: string, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<string[]> {
    log.warn('Use `teamai env remove <key>` to manage env variables.');
    return [];
  }
}
