import path from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import { ResourceHandler } from './base.js';
import type { ResourceItem, TeamaiConfig, LocalConfig } from '../types.js';
import { TEAMAI_ENV_START, TEAMAI_ENV_END, getDataHome, getEnvBackupPath, isSelfMode } from '../types.js';
import { pathExists, readFileSafe, writeFile, ensureDir, fileContentEqual } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { matchesMembership, resolveMembership, warnUnknownMembershipIds, type Membership } from '../membership.js';
import {
  resolveActiveShellProfile,
  shellQuoteValue,
  isWindowsFormPath,
} from '../utils/shell-profile.js';

// ─── Schema for env.yaml ────────────────────────────────

const EnvVariableSchema = z.object({
  key: z.string(),
  value: z.string(),
  description: z.string().optional(),
  /** Optional restriction to members holding one of these role ids (default = every member; [] = nobody). */
  roles: z.array(z.string()).optional(),
  /** Optional restriction to directories bound to one of these logical project ids (default = every directory; [] = nobody). */
  projects: z.array(z.string()).optional(),
});

const EnvYamlSchema = z.object({
  variables: z.array(EnvVariableSchema).default([]),
});

export type EnvVariable = z.infer<typeof EnvVariableSchema>;
export type EnvYaml = z.infer<typeof EnvYamlSchema>;

/**
 * The declared variables this member and directory are scoped to, in declaration
 * order. Omitted `roles:`/`projects:` = everyone, an empty list = nobody, and an
 * axis the member has not configured filters nothing (see `matchesMembership`).
 *
 * The one filter both delivery paths use: `pullItem` writes env.sh from it, and
 * `doctor` diffs env.sh against it. A second copy is how doctor ends up
 * reporting a project-scoped variable as undelivered on a pull that correctly
 * withheld it.
 *
 * Note this does NOT gate `countEnvVars`, which answers the different question
 * of how many variables the team declares — the probe `pull` uses to tell an
 * empty env.yaml from a malformed one (#662).
 */
export function resolveDeliverableEnvVariables(
  variables: EnvVariable[],
  membership: Membership,
): EnvVariable[] {
  return variables.filter((variable) => matchesMembership(variable, membership));
}

/** A parsed env.yaml, or the reason it declares nothing. See `readEnvYaml`. */
export type EnvYamlRead =
  | { ok: true; variables: EnvVariable[] }
  | { ok: false; reason: string };

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
 * Reported from `pullForScope`, which is the only place that can — it skips
 * the env resource as soon as `countEnvVars` reports 0, so the check cannot
 * live in `pullItem`. `describeEnvYamlShapeProblemAt` reads the file and
 * applies this to it.
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
  const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const assignments = new Map<string, string>();

  let i = 0;
  while (i < content.length) {
    const eq = content.startsWith(PREFIX, i) ? content.indexOf('=', i + PREFIX.length) : -1;
    const key = eq === -1 ? '' : content.slice(i + PREFIX.length, eq);
    if (eq === -1 || !KEY.test(key) || content[eq + 1] !== "'") {
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

// ─── Handler ─────────────────────────────────────────────

export class EnvHandler extends ResourceHandler {
  readonly type = 'env' as const;

  /**
   * Scan for local env changes that need to be pushed.
   * Compares local env/env.yaml against the committed version.
   */
  async scanLocalForPush(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    // Single-repo mode: users edit team env directly at <repo>/.teamai/env/env.yaml
    // (it lives in their own repo). push runs in the knowledge worktree, so
    // localConfig.repo.localPath here is the origin/<default> checkout — diff the
    // ACTIVE tree's copy against it and surface genuine additions/edits. (Active
    // tree = projectRoot, which withKnowledgeWorktree deliberately leaves intact.)
    if (isSelfMode(localConfig) && localConfig.projectRoot) {
      const activeEnv = path.join(localConfig.projectRoot, '.teamai', 'env', 'env.yaml');
      if (!await pathExists(activeEnv)) return [];
      const baseEnv = path.join(localConfig.repo.localPath, 'env', 'env.yaml');
      // Not in the baseline → new; present but different → modified; equal → skip.
      if (await pathExists(baseEnv) && await fileContentEqual(activeEnv, baseEnv)) {
        return [];
      }
      return [{
        name: 'env.yaml',
        type: 'env',
        sourcePath: activeEnv,
        relativePath: 'env/env.yaml',
      }];
    }

    const envYamlPath = path.join(localConfig.repo.localPath, 'env', 'env.yaml');
    if (!await pathExists(envYamlPath)) return [];

    // Check if env.yaml has uncommitted changes via git diff
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    try {
      // git diff exits 0 if no changes, non-zero otherwise when used with --exit-code
      await execFileAsync('git', ['diff', '--exit-code', 'env/env.yaml'], {
        cwd: localConfig.repo.localPath,
      });
      // Also check if the file is untracked
      const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', 'env/env.yaml'], {
        cwd: localConfig.repo.localPath,
      });
      if (!stdout.trim()) return [];
    } catch {
      // git diff --exit-code returns 1 when there are changes — that's what we want
    }

    return [{
      name: 'env.yaml',
      type: 'env',
      sourcePath: envYamlPath,
      relativePath: 'env/env.yaml',
    }];
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
    // Non-self modes: env.yaml already lives in the repo dir; push.ts commits it
    // via the env/ sweeper — nothing to copy.
    //
    // Single-repo mode: the source is the ACTIVE tree's .teamai/env/env.yaml, but
    // the commit happens in the knowledge worktree (localConfig.repo.localPath).
    // Copy the active copy into the worktree so the PR actually carries the change;
    // otherwise the env/ sweeper would commit the stale baseline. (Guarded on the
    // paths differing so non-self stays a no-op.)
    if (isSelfMode(localConfig)) {
      const dest = path.join(localConfig.repo.localPath, 'env', 'env.yaml');
      if (item.sourcePath !== dest) {
        await ensureDir(path.dirname(dest));
        const content = await readFileSafe(item.sourcePath);
        if (content !== null) await writeFile(dest, content);
      }
    }
  }

  /**
   * Pull env variables: parse env.yaml, write env.sh, inject source line into shell profile.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const content = await readFileSafe(item.sourcePath);
    if (!content) return;

    let envConfig: EnvYaml;
    try {
      const raw = YAML.parse(content);
      envConfig = EnvYamlSchema.parse(raw);
    } catch (e) {
      log.warn(`Invalid env.yaml format: ${(e as Error).message}`);
      return;
    }

    if (envConfig.variables.length === 0) return;

    // Which of the declared variables this member and directory are scoped to.
    // Deliberately applied AFTER the "nothing declared" return above: a team that
    // declares variables none of which reach this member must still get an
    // env.sh written (an empty one), because that is what REMOVES the variables
    // an earlier pull had given them.
    //
    // The unknown-id warning belongs to `pullForScope`, not here, so that
    // `--dry-run` reports it as well (this method never runs on that path).
    const variables = resolveDeliverableEnvVariables(envConfig.variables, resolveMembership(localConfig));

    // Write the machine-local KEY=VALUE backup (for loadEnvFile / buildVarTable).
    // getEnvBackupPath returns <teamaiHome>/env normally, but <teamaiHome>/env.local
    // in self mode — where <teamaiHome>/env is a committed DIRECTORY (env/env.yaml)
    // and writing a file there would throw EISDIR.
    const teamaiHome = getDataHome(localConfig);
    const backupLines = variables.map(v => `${v.key}=${v.value}`);
    await ensureDir(teamaiHome);
    await writeFile(getEnvBackupPath(localConfig), backupLines.join('\n') + '\n');

    // Write <teamaiHome>/env.sh (sourceable export file)
    const envShContent = this.generateEnvFile(variables);
    await writeFile(path.join(teamaiHome, 'env.sh'), envShContent);

    // Inject source line into shell profile if enabled
    const inject = teamConfig.sharing.env.injectShellProfile !== false;

    if (inject) {
      const profilePath = teamConfig.sharing.env.shellProfilePath
        ? teamConfig.sharing.env.shellProfilePath
        : await this.detectShellProfile(path.join(teamaiHome, 'env.sh'));

      const shellBlock = this.generateShellBlock(teamaiHome);
      await this.injectShellProfile(profilePath, shellBlock);
    }
  }

  /**
   * Count the number of env variables in env.yaml.
   */
  async countEnvVars(sourcePath: string): Promise<number> {
    const content = await readFileSafe(sourcePath);
    if (!content) return 0;

    try {
      const raw = YAML.parse(content);
      const envConfig = EnvYamlSchema.parse(raw);
      return envConfig.variables.length;
    } catch {
      return 0;
    }
  }

  /**
   * Read an env.yaml and report the shape problem `describeEnvYamlShapeProblem`
   * detects, or `null` when the file yields a usable shape.
   *
   * `countEnvVars` answers the different question of "how many variables", and
   * a file with no `variables:` key answers 0 just like a genuinely empty one —
   * which is why the caller needs this separate probe before it skips the
   * resource.
   */
  async describeEnvYamlShapeProblemAt(sourcePath: string): Promise<string | null> {
    const content = await readFileSafe(sourcePath);
    if (!content) return null;

    try {
      return describeEnvYamlShapeProblem(YAML.parse(content));
    } catch {
      // Malformed YAML never yields a mapping to inspect; it is a separate
      // failure, left to the caller's own handling.
      return null;
    }
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
    // An empty document is a file with nothing to deliver, not a broken one.
    if (raw === null || raw === undefined) return { ok: true, variables: [] };

    if (typeof raw !== 'object' || Array.isArray(raw) || !('variables' in raw)) {
      return {
        ok: false,
        reason: `${filePath} declares no variables. Its top-level key must be \`variables:\`, a list `
          + 'of `key`/`value` entries — a plain `KEY: value` mapping parses as an empty list',
      };
    }

    const parsed = EnvYamlSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, reason: `${filePath} does not match the env.yaml schema: ${parsed.error.message}` };
    }
    return { ok: true, variables: parsed.data.variables };
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
   */
  generateEnvFile(variables: EnvVariable[]): string {
    const lines = variables.map(v => `export ${v.key}=${shellQuoteValue(v.value)}`);
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
   * Inject the shell block into the profile file (idempotent).
   */
  private async injectShellProfile(profilePath: string, block: string): Promise<void> {
    const original = await readFileSafe(profilePath) ?? '';
    let content = original;

    const startIdx = content.indexOf(TEAMAI_ENV_START);
    const endIdx = content.indexOf(TEAMAI_ENV_END);

    if (startIdx !== -1 && endIdx !== -1) {
      // Replace existing block
      const before = content.substring(0, startIdx);
      const after = content.substring(endIdx + TEAMAI_ENV_END.length);
      content = before + block + after;
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
