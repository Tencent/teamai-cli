import path from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import { ResourceHandler } from './base.js';
import type { ResourceItem, TeamaiConfig, LocalConfig, Scope } from '../types.js';
import { TEAMAI_ENV_START, TEAMAI_ENV_END, getDataHome, getEnvBackupPath, getTeamaiHome, getUserConfigPath, isSelfMode } from '../types.js';
import { loadLocalConfigForScope } from '../config.js';
import { pathExists, readFileSafe, writeFile, ensureDir, fileContentEqual } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { envShMarker, isEnvShMarker, recordEnvShExports } from '../env-sh-exports.js';
import { ENV_KEY_RE } from './env-key.js';
import { SECRETS_LAYOUT } from './secrets.js';
import {
  listEntryFiles, readEntryFileText, reportEntryResolution, resolveEntriesFor,
  unknownEntryKeys, writtenList, type EntryFile, type EntryReader,
} from '../namespaced-entries.js';
import {
  resolveActiveShellProfile,
  shellQuoteValue,
  isWindowsFormPath,
  findEnvBlocks,
  envBlockReferencesDataHome,
  type EnvBlock,
} from '../utils/shell-profile.js';

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

function envPushItem(relativePath: string, sourcePath: string): ResourceItem {
  return { name: relativePath.slice('env/'.length), type: 'env', sourcePath, relativePath };
}

/** A `source` or `.` command naming a file called env.sh. */
const SOURCES_ENV_SH = /(?:^|[\s;&|])(?:source|\.)\s[^\n;&|]*env\.sh/m;

/**
 * The env.sh a user-scope pull writes, or null when no user scope is
 * configured. How a project pull recognises the user scope's profile block,
 * which it must keep (#876).
 */
async function userScopeEnvShPath(): Promise<string | null> {
  const userConfig = await loadLocalConfigForScope('user');
  if (userConfig) return path.join(getDataHome(userConfig), 'env.sh');
  // A config that exists but does not parse is still a configured user scope:
  // keep the block at its default env.sh rather than taking it over.
  return await pathExists(getUserConfigPath()) ? path.join(getTeamaiHome('user'), 'env.sh') : null;
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
      for (const { relativePath, absolutePath: activeEnv } of await listEnvFiles(activeRoot)) {
        const baseEnv = path.join(localConfig.repo.localPath, ...relativePath.split('/'));
        // Not in the baseline → new; present but different → modified; equal → skip.
        if (await pathExists(baseEnv) && await fileContentEqual(activeEnv, baseEnv)) continue;
        items.push(envPushItem(relativePath, activeEnv));
      }
      return items;
    }

    const repoPath = localConfig.repo.localPath;
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    // Modified and untracked files under env/, in one call. A file git cannot
    // report on (no repository) is treated as changed, as before. `-z` keeps a
    // non-ASCII path unquoted, so it matches the name on disk.
    let changed: Set<string> | null = null;
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['ls-files', '-z', '--modified', '--others', '--exclude-standard', '--', 'env'],
        { cwd: repoPath },
      );
      changed = new Set(stdout.split('\0').filter(Boolean));
    } catch {
      changed = null;
    }

    const items: ResourceItem[] = [];
    for (const { relativePath, absolutePath } of await listEnvFiles(repoPath)) {
      if (changed && !changed.has(relativePath)) continue;
      items.push(envPushItem(relativePath, absolutePath));
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
    // Non-self modes: env files already live in the repo dir; push.ts stages
    // each selected one by its path — nothing to copy.
    //
    // Single-repo mode: the source is the ACTIVE tree's .teamai/env/ file, but
    // the commit happens in the knowledge worktree (localConfig.repo.localPath).
    // Copy the active copy into the worktree so the PR actually carries the change;
    // otherwise staging that path would commit the stale baseline. (Guarded on the
    // paths differing so non-self stays a no-op.)
    if (isSelfMode(localConfig)) {
      const dest = path.join(localConfig.repo.localPath, ...item.relativePath.split('/'));
      if (item.sourcePath !== dest) {
        await ensureDir(path.dirname(dest));
        const content = await readFileSafe(item.sourcePath);
        if (content !== null) await writeFile(dest, content);
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
   * Write env.sh, its KEY=VALUE backup and the shell profile block from the
   * resolved variables. Runs with an empty set too, which is what removes the
   * variables of a namespace that deactivated or a file that was emptied; only
   * a machine that never had env delivered is left alone (returns false), so
   * a team without env does not get a profile block for nothing.
   */
  async writeResolvedEnv(variables: EnvVariable[], teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<boolean> {
    // getEnvBackupPath returns <teamaiHome>/env normally, but <teamaiHome>/env.local
    // in self mode — where <teamaiHome>/env is a committed DIRECTORY (env/env.yaml)
    // and writing a file there would throw EISDIR.
    const teamaiHome = getDataHome(localConfig);
    const envShPath = path.join(teamaiHome, 'env.sh');
    if (variables.length === 0 && !await pathExists(envShPath)) return false;

    // The machine-local KEY=VALUE backup (for loadEnvFile).
    const backupLines = variables.map(v => `${v.key}=${v.value}`);
    await ensureDir(teamaiHome);
    await writeFile(getEnvBackupPath(localConfig), backupLines.join('\n') + '\n');

    // <teamaiHome>/env.sh (sourceable export file). What it exported before
    // and after is recorded first: a shell opened before this rewrite still
    // carries those values, and they are the team's, not the member's (#879
    // Conflict 10). The old ones are there too for an env.sh an older CLI wrote.
    const previous = parseEnvFile(await readFileSafe(envShPath) ?? '');
    const recorded = await recordEnvShExports(envShPath, [...previous, ...variables.map((v): [string, string] => [v.key, v.value])]);
    const envSh = this.generateEnvFile(variables);
    const marker = envShMarker(teamaiHome, parseEnvFile(envSh), recorded);
    await writeFile(envShPath, marker ? `${envSh}export ${marker[0]}='${marker[1]}'\n` : envSh);

    // Inject source line into shell profile if enabled
    const inject = teamConfig.sharing.env.injectShellProfile !== false;

    if (inject) {
      const profilePath = teamConfig.sharing.env.shellProfilePath
        ? teamConfig.sharing.env.shellProfilePath
        : await this.detectShellProfile(envShPath);

      const shellBlock = this.generateShellBlock(teamaiHome);
      await this.injectShellProfile(profilePath, shellBlock, envShPath, localConfig.scope);
    }
    return true;
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
   * Generate the shell block with a source line (instead of inline exports).
   *
   * The block is read back by a POSIX shell (bash/zsh/sh) even on Windows,
   * where `teamaiHome` is a native path such as `C:\Users\me\.teamai`. The
   * block used to interpolate that path as-is, so on Windows `[ -f ... ]`
   * tested a backslash path the shell treats as an escape sequence, and
   * `source` never ran — while nothing reported a failure (#661).
   *
   * A Windows-form home is rewritten to forward slashes, which Git Bash, WSL
   * and MSYS all accept, so one block loads on every shell the CLI supports.
   * The rewrite keys off the path's own shape, never `path.sep`, so the output
   * is byte-identical across platforms and the Windows form stays assertable
   * from the Linux/macOS CI runners. A POSIX home is passed through untouched:
   * its backslashes are filename characters, not separators.
   *
   * The path is quoted unconditionally (`shellQuoteValue`). It sits inside a
   * `[ -f ... ]` test, so an unquoted space or glob metacharacter in a home
   * directory would break that test and split the `source` builtin. Quoting
   * only "when needed" would put the quoted form out of reach of the runner.
   */
  generateShellBlock(teamaiHome: string): string {
    const shellHome = isWindowsFormPath(teamaiHome) ? teamaiHome.replace(/\\/g, '/') : teamaiHome;
    const envShPath = shellQuoteValue(`${shellHome}/env.sh`);
    const lines = [
      TEAMAI_ENV_START,
      '# DO NOT EDIT: This section is auto-managed by teamai',
      `[ -f ${envShPath} ] && source ${envShPath}`,
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
   */
  generateEnvFile(variables: EnvVariable[]): string {
    const lines = variables
      .filter(v => ENV_KEY_RE.test(v.key))
      .map(v => `export ${v.key}=${shellQuoteValue(v.value)}`);
    return lines.join('\n') + '\n';
  }

  /**
   * Detect the user's shell profile path.
   *
   * Public because `doctor` has to check the same file the injection writes:
   * a second spelling of this choice would check `.bashrc` while the pull
   * wrote `.zshrc`, and report a correct install as broken. Delegates to the
   * shared `utils/shell-profile.js` so `teamai uninstall` resolves the same
   * file too (#682), and follows the chain of files the order-based pick
   * actually `source`s to reuse a candidate that already carries this
   * scope's block, rather than injecting a duplicate every time a new file
   * enters that chain (#693 review rounds 7-9).
   */
  detectShellProfile(envShPath: string, platform: NodeJS.Platform = process.platform): Promise<string> {
    return resolveActiveShellProfile(envShPath, platform);
  }

  /**
   * Inject this scope's shell block into the profile file (idempotent).
   *
   * The profile keeps the user scope's block plus at most one project block,
   * the user's first so a project value wins on a key both define (#876). A
   * scope replaces its own block. Otherwise a project takes over another
   * project's block, never the user scope's, which keeps the project block
   * last-wins; a user scope goes in right before the project block. Any other
   * blocks (a hand-edited profile) are left alone.
   */
  private async injectShellProfile(profilePath: string, block: string, envShPath: string, scope: Scope): Promise<void> {
    const original = await readFileSafe(profilePath) ?? '';
    let content = original;

    // An unclosed block has no end to replace up to, so it is left as it is.
    const blocks = findEnvBlocks(content).filter((b): b is EnvBlock & { end: number } => b.end !== null);
    let target = blocks.find((b) => envBlockReferencesDataHome(b.text, envShPath));
    if (!target) {
      // Only now does a project pull need the user config, so a steady-state
      // pull never reads it.
      const userEnvShPath = scope === 'user' ? envShPath : await userScopeEnvShPath();
      // A block that sources no env.sh is the inline-export format from before
      // env.sh and project scopes existed: the user scope's too.
      const isUserBlock = (b: EnvBlock): boolean => !SOURCES_ENV_SH.test(b.text)
        || (userEnvShPath !== null && envBlockReferencesDataHome(b.text, userEnvShPath));
      target = blocks.find((b) => (scope === 'user' ? isUserBlock(b) : !isUserBlock(b)));
    }

    if (target) {
      // Replace existing block
      content = content.substring(0, target.start) + block + content.substring(target.end);
    } else if (scope === 'user' && blocks.length > 0) {
      // Every block left is a project's: go in before it
      content = content.substring(0, blocks[0].start) + block + '\n\n' + content.substring(blocks[0].start);
    } else {
      // Append block
      if (content.length > 0 && !content.endsWith('\n')) {
        content += '\n';
      }
      content += '\n' + block + '\n';
    }

    // Skip the write when nothing changed: this runs on every pull, including
    // the revision fast path a SessionStart hook takes each session, and the
    // member's shell profile should not churn for it.
    if (content === original) return;
    await writeFile(profilePath, content);
  }

  async removeItem(_name: string, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<string[]> {
    log.warn('Use `teamai env remove <key>` to manage env variables.');
    return [];
  }
}
