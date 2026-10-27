/**
 * Team env by directory (#1018): a process started in a directory gets the
 * env of the scope that governs that directory, the way `resolveConfigForDir`
 * resolves it, and nothing records a machine-wide "active project".
 *
 * Each project pull records its scope in a registry under `~/.teamai`, keyed
 * the way detection keys it: the git common directory, shared by a checkout
 * and all of its worktrees, or the directory itself outside git. A shell
 * profile block sources one loader script, which looks the shell's directory
 * up in that registry and loads the matching env.sh. Several projects open at
 * once each get their own env, and a pull never rewrites the profile to switch
 * between them.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { hasUserScopeInstall, loadLocalConfig, loadTeamConfig } from '../config.js';
import { acquireLock, releaseLock } from '../update.js';
import { getDataHome, getTeamaiHome, getTeamaiHomeDir, type LocalConfig } from '../types.js';
import { pathExists, readFileIfExists, readFileSafe, writeFileAtomic } from '../utils/fs.js';
import { gitCommonDir, nearestGitEntry } from '../utils/git.js';
import { log } from '../utils/logger.js';
import { projectsRootDir } from '../utils/partition.js';
import { isWindowsFormPath, shellQuoteValue } from '../utils/shell-profile.js';

/** The script the shell profile block sources. */
export function envLoaderPath(): string {
  return path.join(getTeamaiHomeDir(), 'env-loader.sh');
}

/** The BASH_ENV `teamai env exec` gives a command when the member has their own (env-exec.ts). */
export function envExecBashEnvPath(): string {
  return path.join(getTeamaiHomeDir(), 'env-exec-bash-env.sh');
}

/**
 * bash sources BASH_ENV after `teamai env exec` set the team env, so this one
 * sources the member's own, then puts back each team key as the command
 * started with it, its value or its absence: the team env wins a key both set,
 * as in the loader. A nested bash does the same with what it started with.
 */
/** On Windows, the member's file may set another spelling of a team key: only the team's stays (`__teamai_env_spellings`). */
const ENV_EXEC_WINDOWS_SPELLINGS = `IFS='
'
for __teamai_k in $(compgen -v | command -p awk -v __teamai_exec_keys="\${__TEAMAI_ENV_EXEC_KEYS-}" '
  BEGIN { n = split(__teamai_exec_keys, team, " "); for (i = 1; i <= n; i++) { wanted[toupper(team[i])] = 1; kept[team[i]] = 1 } }
  (toupper($0) in wanted) && !($0 in kept)'); do unset "$__teamai_k"; done`;

/** Shared by the loader and the env exec BASH_ENV: clears the attributes that would change a team value. */
const ENV_PLAIN = `# Clear the attributes of $1 that change a value assigned to it (integer,
# lowercase, uppercase), so a loaded file's value arrives as written, and save
# them for \`__teamai_env_restore\`. bash before 4.2 cannot change a global's
# attributes from a function, so the variable goes: its value and export are saved.
__teamai_env_plain() {
  if [ -n "\${ZSH_VERSION-}" ]; then
    __teamai_decl=$(typeset -p "$1" 2>/dev/null)
  else
    __teamai_decl=$(declare -p "$1" 2>/dev/null)
  fi
  __teamai_decl=\${__teamai_decl%% "$1"*} __teamai_attrs=
  for __teamai_a in i l u; do
    case $__teamai_decl in *" -"*"$__teamai_a"*) __teamai_attrs=$__teamai_attrs$__teamai_a ;; esac
  done
  [ -n "$__teamai_attrs" ] || return 0
  eval "__TEAMAI_ENV_ATTR_$1=$__teamai_attrs"
  if [ -n "\${ZSH_VERSION-}" ]; then typeset -g +i +l +u "$1"
  elif __teamai_env_global_attrs; then declare -g +i +l +u "$1"
  else unset "$1"; fi
}

__teamai_env_global_attrs() {
  [ "\${BASH_VERSINFO[0]}" -gt 4 ] || { [ "\${BASH_VERSINFO[0]}" = 4 ] && [ "\${BASH_VERSINFO[1]}" -ge 2 ]; }
}`;

function envExecBashEnvScript(windows: boolean): string {
  return `# DO NOT EDIT: written by teamai. The BASH_ENV of a command run with
# \`teamai env exec\`: sources the member's own, the team env winning a key both set.
__teamai_exec_ifs_set=\${IFS+1} __teamai_exec_ifs=\${IFS-}
IFS=' '
for __teamai_k in \${__TEAMAI_ENV_EXEC_KEYS-}; do eval "__teamai_exec_$__teamai_k=\\\${$__teamai_k-} __teamai_exec_set_$__teamai_k=\\\${$__teamai_k+1}"; done
if [ -n "$__teamai_exec_ifs_set" ]; then IFS=$__teamai_exec_ifs; else unset IFS; fi
# The member's file runs with BASH_ENV naming it, as bash would run it.
if [ -n "\${__TEAMAI_ENV_EXEC_BASH_ENV-}" ] && [ -f "$__TEAMAI_ENV_EXEC_BASH_ENV" ]; then
  __teamai_exec_self=\${BASH_ENV-} __teamai_exec_member=$__TEAMAI_ENV_EXEC_BASH_ENV
  BASH_ENV=$__teamai_exec_member
  . "$__teamai_exec_member"
  # A BASH_ENV the member's file sets is theirs to chain: a nested bash still runs this first.
  if [ "\${BASH_ENV-}" != "$__teamai_exec_member" ]; then export __TEAMAI_ENV_EXEC_BASH_ENV="\${BASH_ENV-}"; fi
  export BASH_ENV="$__teamai_exec_self"
  unset __teamai_exec_self __teamai_exec_member
fi
${ENV_PLAIN}
__teamai_exec_ifs_set=\${IFS+1} __teamai_exec_ifs=\${IFS-}
IFS=' '
for __teamai_k in \${__TEAMAI_ENV_EXEC_KEYS-}; do
  if eval "[ -n \\"\\$__teamai_exec_set_$__teamai_k\\" ]"; then
    __teamai_env_plain "$__teamai_k"
    unset "__TEAMAI_ENV_ATTR_$__teamai_k"
    eval "export $__teamai_k=\\"\\$__teamai_exec_$__teamai_k\\""
  else unset "$__teamai_k"; fi
  unset "__teamai_exec_$__teamai_k" "__teamai_exec_set_$__teamai_k"
done
${windows ? `${ENV_EXEC_WINDOWS_SPELLINGS}\n` : ''}if [ -n "$__teamai_exec_ifs_set" ]; then IFS=$__teamai_exec_ifs; else unset IFS; fi
:
`;
}

/** Write it, unless it already says the same; answers its path in the form bash reads it. */
export async function writeEnvExecBashEnv(): Promise<string> {
  const script = envExecBashEnvScript(process.platform === 'win32');
  if (await readFileSafe(envExecBashEnvPath()) !== script) await writeFileAtomic(envExecBashEnvPath(), script);
  return shellForm(envExecBashEnvPath());
}

/**
 * One line per project scope: `git|dir <TAB> key <TAB> env.sh <TAB> 0|1 (inherits the user scope) <TAB> partition`,
 * after one for the user scope, `user <TAB> - <TAB> env.sh <TAB> 0 <TAB> -`, when it is set up.
 * The env.sh field is `-` for a team that keeps its env out of shells. The
 * first line, `stamp <TAB> token`, changes with every change to the registry
 * or to an env.sh: a shell that inherited its env from one started in the
 * same directory loads again when the stamp it carries is not this one.
 */
function envScopesPath(): string {
  return path.join(getTeamaiHomeDir(), 'env-scopes');
}

/** Registry rows have five fields; project rows must name their partition, by an absolute path. */
function validScopeLine(line: string): boolean {
  const [kind, key, envSh, inherits, partition, ...extra] = line.split('\t');
  if (extra.length > 0 || !envSh || (envSh !== '-' && !path.isAbsolute(envSh))) return false;
  if (kind === 'user') return key === '-' && inherits === '0' && partition === '-';
  return (kind === 'git' || kind === 'dir') && Boolean(key) && (inherits === '0' || inherits === '1')
    && Boolean(partition) && path.isAbsolute(partition);
}

/** A path in the form the loader's `pwd` prints: forward slashes for a Windows path (Git Bash `pwd -W`). */
function shellForm(p: string): string {
  return isWindowsFormPath(p) ? p.replace(/\\/g, '/') : p;
}

/**
 * A directory the way the registry keys it and the loader's `__teamai_env_pwd`
 * prints it: a Windows path in its shell form, ASCII letters in lower case, as
 * Windows does not tell them apart and the loader's `tr A-Z a-z` folds them.
 */
function registryKey(p: string): string {
  return isWindowsFormPath(p) ? shellForm(p).replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : p;
}

/**
 * The registry entry that routes `localConfig`'s directories to its env.sh, or
 * says whether the user scope's loads in shells. Null when its path cannot be
 * stored; `repository-unreadable` when git cannot read the project's
 * repository, so the key the loader looks it up by is unknown.
 */
async function scopeEntry(localConfig: LocalConfig, inShells = true): Promise<{ id: string; line: string } | 'repository-unreadable' | null> {
  let [kind, key] = ['user', '-'];
  if (localConfig.scope === 'project') {
    if (!localConfig.projectRoot) return null;
    const common = await gitCommonDir(localConfig.projectRoot);
    if (!common && await nearestGitEntry(localConfig.projectRoot)) return 'repository-unreadable';
    [kind, key] = common
      ? ['git', common]
      : ['dir', await fs.promises.realpath(localConfig.projectRoot).catch(() => localConfig.projectRoot as string)];
  }
  const envSh = path.join(getDataHome(localConfig), 'env.sh');
  const partition = localConfig.scope === 'project' ? shellForm(getDataHome(localConfig)) : '-';
  const fields = [kind, registryKey(key), inShells ? shellForm(envSh) : '-', localConfig.inheritUserScope === true ? '1' : '0', partition];
  // A field holding a tab or a newline cannot be stored in the line format.
  if (localConfig.scope === 'project' && /[\t\n]/.test(localConfig.projectRoot ?? '')) {
    throw new Error('This project path contains a tab or newline and cannot be registered for team env routing. Rename the project directory, then run `teamai pull` again.');
  }
  if (fields.some((field) => /[\t\n]/.test(field))) return null;
  const id = `${kind}\t${fields[1]}\t`;
  return { id, line: fields.join('\t') };
}

/**
 * Record this scope in the registry, under its lock so two projects pulling
 * at once both land. A directory no project governs gets the user scope's
 * env.sh, and a project that inherits the user scope gets it too, unless the
 * user scope's team keeps its env out of shells (`injectShellProfile: false`):
 * its line, first so the loader reads it before any project's, says so. A
 * project team that does still governs its directories, so they load none of
 * its env and none of the user scope's. `envChanged` (its env.sh was just
 * rewritten) gives the registry a new stamp in the same change, so a shell that
 * inherited the old env.sh loads it again.
 */
export async function registerEnvScope(localConfig: LocalConfig, inShells: boolean, { envChanged = false }: { envChanged?: boolean } = {}): Promise<void> {
  let entry: Awaited<ReturnType<typeof scopeEntry>>;
  try {
    entry = await scopeEntry(localConfig, inShells);
  } catch (error) {
    const owner = localConfig.scope === 'project' ? localConfig.projectRoot : 'the user scope';
    const message = `Could not register team env for ${owner}: ${error instanceof Error ? error.message : String(error)}`;
    log.warn(message);
    throw new Error(message, { cause: error });
  }
  if (entry === 'repository-unreadable') {
    const message = `Could not register team env for ${localConfig.projectRoot}: git could not read the repository there, so its directories cannot be routed to this project's env. Run \`git status\` there to see why, then run \`teamai pull\` again.`;
    log.warn(message);
    throw new Error(message);
  }
  if (!entry) {
    const owner = localConfig.scope === 'project' ? localConfig.projectRoot : 'the user scope';
    const message = `Could not register team env for ${owner}: its path cannot be represented in the env routing registry.`;
    log.warn(message);
    throw new Error(message);
  }
  const update = await updateEnvScopes((lines) => {
    const others = lines.filter((line) => !line.startsWith(entry.id));
    return localConfig.scope === 'user' ? [entry.line, ...others] : [...others, entry.line];
  }, { changed: envChanged, fillUserLine: localConfig.scope !== 'user' });
  if (update.kind === 'unreadable') {
    const owner = localConfig.scope === 'project' ? localConfig.projectRoot : 'the user scope';
    log.warn(`Could not register team env for ${owner}: ${update.reason}`);
    throw new EnvScopesUnreadableError(update.reason);
  }
  if (update.kind === 'busy') {
    const owner = localConfig.scope === 'project' ? localConfig.projectRoot : 'the user scope';
    const message = `Could not register team env for ${owner}: the env routing registry lock stayed busy for five seconds. Run \`teamai pull\` again.`;
    log.warn(message);
    throw new Error(message);
  }
  if (localConfig.scope === 'project' && localConfig.projectRoot) await clearEnvScopePending(localConfig.projectRoot);
}

/**
 * The file in a checkout's git common directory that says a project whose
 * data lives in `~/.teamai/projects` governs it before a registry row does:
 * the loader then loads no user env there, as for a project set up in its
 * checkout. Outside git the data home is `<dir>/.teamai`, which says so already.
 */
const ENV_PENDING = 'teamai-env-pending';

/** Mark `projectRoot`'s checkout as a project's, until a registry row routes it (`registerEnvScope`). */
export async function markEnvScopePending(projectRoot: string): Promise<void> {
  const common = await gitCommonDir(projectRoot);
  if (!common) return;
  const registry = await readEnvScopes();
  if (registry.kind === 'read' && registry.lines.some((line) => validScopeLine(line) && line.startsWith(`git\t${registryKey(common)}\t`))) return;
  await fs.promises.writeFile(path.join(common, ENV_PENDING), '');
}

async function clearEnvScopePending(projectRoot: string): Promise<void> {
  const common = await gitCommonDir(projectRoot);
  if (common) await fs.promises.rm(path.join(common, ENV_PENDING), { force: true });
}

/** A pull's error for a registry it cannot read, and so must not rewrite: the pull fails. */
export class EnvScopesUnreadableError extends Error {
  constructor(reason: string) {
    super(`Could not read ${envScopesPath()} (${reason}), the registry that routes each directory to its scope's env. `
      + 'It was left as it is, so no project registered in it is lost, and shells load no team env while it cannot be read. '
      + 'Fix its permissions, then run `teamai pull` again.');
    this.name = 'EnvScopesUnreadableError';
  }
}

/**
 * The user scope's line for a registry that has none (an earlier version
 * pulled it), as its own pull would write it: from its config and its team's
 * `injectShellProfile`. Opted out when either cannot be read, so its env.sh
 * stays out of shells until it is pulled. Null when there is no user scope.
 */
async function userScopeLine(): Promise<string | null> {
  if (!await hasUserScopeInstall()) return null;
  const user = await loadLocalConfig({ dryRun: true, suppressMigrationNotice: true });
  const team = user ? await loadTeamConfig(user.repo.localPath) : null;
  if (!user || !team) {
    log.warn('Could not read the user scope\'s config or its team\'s teamai.yaml, so its env stays out of shells. Fix that config, then run `teamai pull` outside any project.');
    return `${USER_LINE}-\t0\t-`;
  }
  const entry = await scopeEntry(user, team.sharing.env.injectShellProfile !== false);
  return typeof entry === 'object' ? entry?.line ?? null : null;
}

/** Whether the registry lets the user scope's env.sh load in shells. */
export async function userEnvInShells(): Promise<boolean> {
  if (!await pathExists(envScopesPath())) return true;
  const registry = await readEnvScopes();
  if (registry.kind === 'unreadable') return false;
  return registry.lines.some((line) => validScopeLine(line)
    && line.startsWith(USER_LINE) && line.split('\t')[2] !== '-');
}

/** Take this scope out of the registry, so a project's directories get the user scope's env again. */
export async function unregisterEnvScope(localConfig: LocalConfig): Promise<void> {
  const entry = await scopeEntry(localConfig);
  // Its row cannot be found: it stays, and routes no shell while git cannot read the repository.
  if (!entry || entry === 'repository-unreadable') return;
  const update = await updateEnvScopes((lines) => lines.filter((line) => !line.startsWith(entry.id)), { fillUserLine: localConfig.scope !== 'user' });
  if (update.kind === 'unreadable') {
    log.warn(`Could not read ${envScopesPath()} (${update.reason}), so this scope's entry stays in it and the env loader stays installed. `
      + 'Fix its permissions, then run `teamai uninstall` again.');
  }
  if (localConfig.scope === 'project' && localConfig.projectRoot) await clearEnvScopePending(localConfig.projectRoot);
}

/**
 * Whether no remaining scope loads env through the loader. A registered scope
 * with `-` in its env path keeps its data but does not need the shell loader.
 */
export async function isLastEnvScope(localConfig: LocalConfig): Promise<boolean> {
  const found = await scopeEntry(localConfig);
  // A row that cannot be found counts as another scope's: the loader stays.
  const entry = found === 'repository-unreadable' ? null : found;
  const hasUserConfig = await hasUserScopeInstall();
  const registry = await readEnvScopes();
  // Which scopes it still routes is unknown, so the loader stays.
  if (registry.kind === 'unreadable') return false;
  const others = registry.lines
    .filter((line) => validScopeLine(line) && (entry === null || !line.startsWith(entry.id)));
  if (others.some((line) => (!line.startsWith(USER_LINE) || hasUserConfig)
    && Boolean(line.split('\t')[2]) && line.split('\t')[2] !== '-')) return false;
  // An older user install has no registry line, so the loader still uses its
  // fallback env.sh until a pull records the user's shell-loading preference.
  return localConfig.scope === 'user' || Boolean(others.some((line) => line.startsWith(USER_LINE))) || !hasUserConfig;
}

/** Whether any registered scope still asks shells to load an env file. */
export async function hasEnvLoadingScope(except?: LocalConfig): Promise<boolean> {
  const registry = await readEnvScopes();
  if (registry.kind === 'unreadable') return true;
  const found = except ? await scopeEntry(except) : null;
  const excluded = found === 'repository-unreadable' ? null : found;
  return registry.lines.some((line) => {
    if (!validScopeLine(line) || (excluded && line.startsWith(excluded.id))) return false;
    const envSh = line.split('\t')[2];
    return Boolean(envSh) && envSh !== '-';
  });
}

/** Remove the shell loader when no scope loads env; keep registry entries for opted-out scopes. */
export async function removeEnvLoader(): Promise<void> {
  // A registry that cannot be read keeps everything (`unregisterEnvScope` warned).
  if ((await readEnvScopes()).kind === 'unreadable') return;
  if (!await hasUserScopeInstall()) {
    await updateEnvScopes((lines) => lines.filter((line) => !line.startsWith(USER_LINE)));
  }
  await fs.promises.rm(envLoaderPath(), { force: true });
  await fs.promises.rm(envExecBashEnvPath(), { force: true });
  const registry = await readEnvScopes();
  if (registry.kind === 'unreadable') return;
  const scopes = registry.lines.filter((line) => line !== '' && !line.startsWith(STAMP));
  if (scopes.length === 0) await fs.promises.rm(envScopesPath(), { force: true });
}

/**
 * What a removal of `~/.teamai` keeps for registered projects: the loader
 * only when some project env loads and the registry (`files`), and each
 * project's data directory, which holds its env.sh (`partitions`). Empty when
 * none remain. A registry that cannot be read keeps the loader, itself and
 * every partition. Reads only: `forgetUserEnvScope` drops the user line.
 */
export async function envLoaderFilesForProjects(): Promise<{ files: string[]; partitions: string[] }> {
  const registry = await readEnvScopes();
  if (registry.kind === 'unreadable') {
    log.warn(`Could not read ${envScopesPath()} (${registry.reason}), so which projects still load their env through it is unknown: `
      + `kept it, ${envLoaderPath()} and every project's data in ${projectsRootDir()}. Fix its permissions, then run \`teamai uninstall\` again.`);
    return { files: [envLoaderPath(), envScopesPath(), projectsRootDir()], partitions: [] };
  }
  const projectEntries = registry.lines
    .filter((line) => validScopeLine(line) && !line.startsWith(USER_LINE));
  return {
    files: [
      ...projectEntries.some((line) => {
        const envSh = line.split('\t')[2];
        return Boolean(envSh) && envSh !== '-';
      }) ? [envLoaderPath()] : [],
      ...projectEntries.length > 0 ? [envScopesPath()] : [],
    ],
    partitions: [...new Set(await registeredProjectDataHomes(projectEntries))],
  };
}

/** Take the user scope's line out of a registry kept for projects, once the user scope is gone. */
export async function forgetUserEnvScope(): Promise<void> {
  await updateEnvScopes((lines) => lines.filter((line) => !line.startsWith(USER_LINE)));
}

/** Keep the partition recorded by each project registration, even without a live checkout. */
async function registeredProjectDataHomes(projectEntries: string[]): Promise<string[]> {
  return projectEntries.flatMap((line) => {
    const [kind, , , , partition] = line.split('\t');
    // Rows without an explicit partition are malformed. The shell loader also
    // skips them, so they cannot preserve an unrelated machine partition.
    if ((kind !== 'git' && kind !== 'dir') || !partition || partition === '-') return [];
    return [path.normalize(process.platform === 'win32' ? partition.replace(/[\\/]/g, path.sep) : partition)];
  });
}

const STAMP = 'stamp\t';
const USER_LINE = 'user\t-\t';

/**
 * The registry's lines, or why one that exists could not be read. Missing
 * reads as empty; unreadable never does: rewriting it, or concluding from it
 * that no project remains, would drop every project it routes.
 */
type EnvScopes =
  | { readonly kind: 'read'; readonly lines: readonly string[] }
  | { readonly kind: 'unreadable'; readonly reason: string };

async function readEnvScopes(): Promise<EnvScopes> {
  try {
    return { kind: 'read', lines: (await readFileIfExists(envScopesPath()) ?? '').split('\n') };
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** What became of a registry change: `busy` when another command held its lock (already warned). */
type EnvScopesUpdate =
  | { readonly kind: 'applied' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * Change the registry under its lock. A pull (`fillUserLine`) also writes the
 * user scope's line when it is missing, so no shell loads the user env.sh on
 * the fallback alone once any pull has run. A registry that cannot be read is
 * left as it is.
 */
async function updateEnvScopes(
  change: (lines: string[]) => string[],
  { changed = false, fillUserLine = false }: { changed?: boolean; fillUserLine?: boolean } = {},
): Promise<EnvScopesUpdate> {
  const file = envScopesPath();
  const lock = `${file}.lock`;
  let held = false;
  for (let attempt = 0; attempt < 100 && !held; attempt++) {
    held = await acquireLock(lock);
    if (!held) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!held) {
    log.warn(`Another teamai command is changing ${file}; this project's env reaches new shells after the next pull.`);
    return { kind: 'busy' };
  }
  try {
    const registry = await readEnvScopes();
    if (registry.kind === 'unreadable') return registry;
    const before = registry.lines.filter((line) => line !== '' && !line.startsWith(STAMP));
    const userLine = fillUserLine && !before.some((line) => line.startsWith(USER_LINE)) ? await userScopeLine() : null;
    const after = change(userLine ? [userLine, ...before] : before);
    if (changed || after.join('\n') !== before.join('\n')) {
      await writeFileAtomic(file, `${[`${STAMP}${crypto.randomUUID()}`, ...after].join('\n')}\n`);
    }
    return { kind: 'applied' };
  } finally {
    await releaseLock(lock);
  }
}

/** What a shell started in a directory loads, against what the scope governing it should. */
export type DirectoryEnv =
  | { readonly kind: 'loads-scope' }
  | { readonly kind: 'loads-other'; readonly loaded: readonly string[]; readonly expected: readonly string[] }
  | { readonly kind: 'shell-without-loader'; readonly shell: string }
  | { readonly kind: 'shell-failed'; readonly shell: string; readonly reason: string };

/** The name of `shell` when it runs the loader (zsh and bash do), else null. */
export function loaderShell(shell: string): 'zsh' | 'bash' | null {
  const name = path.basename(shell).replace(/\.exe$/i, '');
  return name === 'zsh' || name === 'bash' ? name : null;
}

/** The env files a loader shell in `localConfig`'s directories loads, in order, when they exist. */
export async function scopeEnvFiles(localConfig: LocalConfig): Promise<string[]> {
  const userEnvSh = path.join(getTeamaiHome('user'), 'env.sh');
  return localConfig.scope === 'project'
    ? [...(localConfig.inheritUserScope === true && await userEnvInShells() ? [userEnvSh] : []), path.join(getDataHome(localConfig), 'env.sh')]
    : [userEnvSh];
}

/**
 * Start the member's shell in `dir`, run the loader there, and compare the
 * env files it loaded with the ones `localConfig` (the scope governing `dir`)
 * should: the check runs the loader the way every shell does, so a broken
 * loader or a stale registry shows up here. Only zsh and bash run the loader.
 */
export async function directoryEnv(localConfig: LocalConfig, dir: string, shell = process.env.SHELL ?? ''): Promise<DirectoryEnv> {
  if (!loaderShell(shell)) return { kind: 'shell-without-loader', shell: path.basename(shell) || 'no SHELL' };
  const expected = (await scopeEnvFiles(localConfig)).map(shellForm);
  // A fresh resolution: none of what this process's shell already loaded. The
  // member's own value of each key it loaded comes back first, as
  // `__teamai_env_restore` puts it back, so a project's PATH cannot hide git.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of (process.env.__TEAMAI_ENV_KEYS ?? '').split(' ').filter(Boolean)) {
    if (process.env[`__TEAMAI_ENV_SET_${key}`] === '2') env[key] = process.env[`__TEAMAI_ENV_PREV_${key}`];
    else delete env[key];
  }
  for (const key of Object.keys(env)) if (key.startsWith('__TEAMAI_ENV_') || key === 'BASH_ENV') delete env[key];
  let loaded: string[];
  try {
    const { stdout } = await promisify(execFile)(shell, [
      '-c', '. "$1" >/dev/null 2>&1; printf \'\\n%s%s\' "$2" "${__TEAMAI_ENV_FILES-}"', 'teamai', envLoaderPath(), LOADED_MARK,
    ], { cwd: dir, env, timeout: 10_000 });
    const at = stdout.lastIndexOf(LOADED_MARK);
    loaded = at === -1 ? [] : stdout.slice(at + LOADED_MARK.length).split('\n').filter(Boolean);
  } catch (error) {
    return { kind: 'shell-failed', shell, reason: error instanceof Error ? error.message : String(error) };
  }
  return loaded.join('\n') === expected.join('\n') ? { kind: 'loads-scope' } : { kind: 'loads-other', loaded, expected };
}

/** Where the loaded file list starts in the shell's output, after anything the member's own startup files print. */
const LOADED_MARK = '__TEAMAI_ENV_FILES__';

/**
 * The directory in the form the registry keys it (`registryKey`) on
 * Windows, whichever shell asks: Git Bash `pwd -W` prints the native form;
 * MSYS zsh and Cygwin print `/c/...`, `/cygdrive/c/...`, or a path under
 * their own root that only `cygpath -m` maps, which they ship. Then a
 * Windows path's ASCII letters in lower case, as `registryKey` folds them.
 */
const WINDOWS_PWD = `__teamai_env_pwd() {
  __teamai_cwd=$(builtin pwd -W 2>/dev/null) || __teamai_cwd=$(command cygpath -m "$(builtin pwd -P)" 2>/dev/null) || __teamai_cwd=$(builtin pwd -P) || return 1
  case $__teamai_cwd in /cygdrive/[A-Za-z] | /cygdrive/[A-Za-z]/*) __teamai_cwd=\${__teamai_cwd#/cygdrive} ;; esac
  case $__teamai_cwd in
    /[A-Za-z] | /[A-Za-z]/*)
      __teamai_rest=\${__teamai_cwd#/?}
      __teamai_cwd=\${__teamai_cwd#/}
      __teamai_cwd=\${__teamai_cwd%"$__teamai_rest"}:\${__teamai_rest:-/}
      ;;
  esac
  case $__teamai_cwd in [A-Za-z]:/* | //*) __teamai_cwd=$(printf '%s\\n' "$__teamai_cwd" | command tr A-Z a-z) || return 1 ;; esac
  printf '%s\\n' "$__teamai_cwd"
}`;

/**
 * Windows reads `token` and `TOKEN` as one variable, as resolution compares
 * them (env-key.ts), while the shell keeps both. One line per name to record
 * and per name to unset: `K <name>` for a variable the shell has in another
 * spelling of a key the files export, so leaving puts it back; `<n> <name>`
 * for every other spelling of a key file n exports, unset before it is
 * sourced, so the one spelling that remains holds the file's value.
 */
const WINDOWS_SPELLINGS = `__teamai_env_spellings() {
  {
    __teamai_i=0
    for __teamai_f in $__TEAMAI_ENV_FILES; do
      __teamai_i=$((__teamai_i + 1))
      [ -f "$__teamai_f" ] && __teamai_env_keys_of "$__teamai_f" "F $__teamai_i "
    done
    if [ -n "\${ZSH_VERSION-}" ]; then eval 'print -rl -- "\${(k)parameters[@]}"'; else compgen -v; fi
  } 2>/dev/null | command -p awk '
    NF == 3 && $1 == "F" { key[$2, ++count[$2]] = $3; if ($2 + 0 > files) files = $2 + 0; exported[$3] = 1; names[$3] = 1; next }
    NF == 1 && $1 ~ /^[A-Za-z_][A-Za-z0-9_]*$/ { names[$1] = 1 }
    END {
      for (i = 1; i <= files; i++) for (j = 1; j <= count[i]; j++) wanted[toupper(key[i, j])] = 1
      for (name in names) if (!(name in exported) && (toupper(name) in wanted)) print "K " name
      for (i = 1; i <= files; i++) for (j = 1; j <= count[i]; j++) for (name in names) {
        if (name != key[i, j] && toupper(name) == toupper(key[i, j])) print i " " name
      }
    }'
}`;

/** Write the loader script, unless it already says the same. */
export async function writeEnvLoader(): Promise<void> {
  const script = envLoaderScript({
    loaderFile: shellForm(envLoaderPath()),
    scopesFile: shellForm(envScopesPath()),
    userEnvSh: shellForm(path.join(getTeamaiHomeDir(), 'env.sh')),
    windows: process.platform === 'win32',
  });
  if (await readFileSafe(envLoaderPath()) === script) return;
  await writeFileAtomic(envLoaderPath(), script);
}

/**
 * The loader. POSIX sh that zsh (in sh emulation) and bash both run, sourced
 * by every shell the profile block reaches, so it prints nothing, fails
 * nothing, and outside git does no work when neither the directory nor the
 * registry's stamp has changed: the directory, the stamp and the files it
 * loaded are exported, so a child shell started in the same directory reuses
 * them. In a checkout it routes again, as a cd does.
 *
 * Every variable it sets for its own bookkeeping starts with `__teamai_` (the
 * shell's) or `__TEAMAI_ENV_` (exported, so a child shell started elsewhere
 * can put back what the member had before).
 */
function envLoaderScript({ loaderFile, scopesFile, userEnvSh, windows }: { loaderFile: string; scopesFile: string; userEnvSh: string; windows: boolean }): string {
  return `# DO NOT EDIT: written by teamai. Loads the team env of the scope that governs
# the shell's directory (#1018).
# Only bash and zsh run it. The block can sit in ~/.profile, which a POSIX sh
# login shell reads too: that shell returns here, before anything it cannot parse.
[ -n "\${BASH_VERSION-}\${ZSH_VERSION-}" ] || return 0
# A git that is a bash or zsh script starts a shell that reads this file
# again: one the loader's own git call started routes nothing, or it recurses.
[ -z "\${__TEAMAI_ENV_ROUTING-}" ] || return 0
__teamai_env_start() {
  # Keep ambient shell options out of loader assignments and pattern matching.
  # In bash the positional args remember allexport and nocasematch; zsh's
  # emulate -L sh scopes and restores its option set for this function.
  if [ -n "\${ZSH_VERSION-}" ]; then
    emulate -L sh
  else
    case $1 in *a*) set +a ;; esac
    [ "$2" = 1 ] && shopt -u nocasematch
  fi
__teamai_env_scopes=${shellQuoteValue(scopesFile)}
__teamai_env_user=${shellQuoteValue(userEnvSh)}
__teamai_env_loader=${shellQuoteValue(loaderFile)}

# A member's startup file may define a function by any command's name: the
# ones that decide the directory and its scope run as the shell or PATH has them.
${windows ? WINDOWS_PWD : '__teamai_env_pwd() { builtin pwd -W 2>/dev/null || builtin pwd -P; }'}
${windows ? `\n${WINDOWS_SPELLINGS}\n` : ''}
# The real path of directory $1. Never the member's cd: no CDPATH, no cd
# function, and in zsh no chpwd hooks (-q), any of which could print into it.
__teamai_env_realdir() {
  if [ -n "\${ZSH_VERSION-}" ]; then CDPATH= builtin cd -q -- "$1" 2>/dev/null; else CDPATH= builtin cd -- "$1" 2>/dev/null; fi \\
    && __teamai_env_pwd
}

# The env files the scope governing directory $1 loads, one per line. The
# user scope's line, before any project's, says whether its env.sh loads.
__teamai_env_files() {
  __teamai_kind=dir __teamai_key=$1 __teamai_found= __teamai_user=$__teamai_env_user
  # Registry rows cannot represent these paths. Return a no-op file so an
  # unregistered project never falls through to the user env.
  __teamai_env_bad_path "$1" && { printf '%s\\n' /dev/null; return 0; }
  # While a registry write is in flight, its current rows may not be complete.
  [ ! -e "$__teamai_env_scopes.lock" ] || return 0
  # Git names the repository, else the directory is in none: a .git entry in
  # it or above means git could not read one (not installed, failing, refused
  # or unreadable), so no scope is known and none loads.
  if __teamai_common=$(export __TEAMAI_ENV_ROUTING=1; command git -C "$1" rev-parse --git-common-dir 2>/dev/null); then
    case $__teamai_common in /* | ?:/*) ;; *) __teamai_common=$1/$__teamai_common ;; esac
    __teamai_key=$(__teamai_env_realdir "$__teamai_common") || return 0
    __teamai_kind=git
  elif __teamai_env_in_git "$1"; then
    return 0
  fi
  if [ -e "$__teamai_env_scopes" ]; then
    # One that cannot be read may route this directory to any scope: load none.
    [ -f "$__teamai_env_scopes" ] && [ -r "$__teamai_env_scopes" ] || return 0
    # Once a registry exists, user env is opted in only by a valid user row.
    __teamai_user=
    while IFS= read -r __teamai_row; do
      __teamai_candidate_kind=\${__teamai_row%%'	'*}
      __teamai_candidate_rest=\${__teamai_row#*'	'}
      case $__teamai_candidate_rest in '	'*) __teamai_candidate_rest=\${__teamai_candidate_rest#*'	'} ;; esac
      __teamai_candidate_key=\${__teamai_candidate_rest%%'	'*}
      # As the CLI reads the registry: a row is exactly five non-empty fields.
      case $__teamai_row in
        '	'* | *'	' | *'		'* | *'	'*'	'*'	'*'	'*'	'*)
          if [ "$__teamai_candidate_kind" = "$__teamai_kind" ] && [ "$__teamai_candidate_key" = "$__teamai_key" ]; then __teamai_found=1; return 0; fi
          if [ "$__teamai_candidate_kind" = user ]; then __teamai_user=; fi
          continue
          ;;
        *'	'*'	'*'	'*'	'*) ;;
        *) continue ;;
      esac
      __teamai_k=\${__teamai_row%%'	'*} __teamai_row=\${__teamai_row#*'	'}
      __teamai_p=\${__teamai_row%%'	'*} __teamai_row=\${__teamai_row#*'	'}
      __teamai_f=\${__teamai_row%%'	'*} __teamai_row=\${__teamai_row#*'	'}
      __teamai_i=\${__teamai_row%%'	'*} __teamai_h=\${__teamai_row#*'	'}
      if [ "$__teamai_k" = user ]; then
        __teamai_user=
        if [ "$__teamai_p" = - ] && [ "$__teamai_i" = 0 ] && [ "$__teamai_h" = - ]; then
          case $__teamai_f in - | /* | ?:/*) [ "$__teamai_f" = - ] || __teamai_user=$__teamai_f ;; esac
        fi
      elif [ "$__teamai_k" = "$__teamai_kind" ] && [ "$__teamai_p" = "$__teamai_key" ]; then
        __teamai_found=1
        [ -n "$__teamai_h" ] && [ "$__teamai_h" != - ] || return 0
        case $__teamai_i in 0 | 1) ;; *) __teamai_found=1; return 0 ;; esac
        # As the CLI reads the registry: a relative path makes the row malformed.
        case $__teamai_f in - | /* | ?:/*) ;; *) __teamai_found=1; return 0 ;; esac
        case $__teamai_h in /* | ?:/*) ;; *) __teamai_found=1; return 0 ;; esac
        # An inherited user env is safe only while the project's own file can
        # be selected too. A missing or unreadable project file disables both.
        [ "$__teamai_f" = - ] || { [ -f "$__teamai_f" ] && [ -r "$__teamai_f" ]; } || return 0
        [ "$__teamai_f" != - ] && [ "$__teamai_i" = 1 ] && [ -n "$__teamai_user" ] && printf '%s\\n' "$__teamai_user"
        [ "$__teamai_f" = - ] || printf '%s\\n' "$__teamai_f"
        break
      fi
    done < "$__teamai_env_scopes"
  fi
  # A project set up in its checkout, or marked pending, loads no user env before it is registered.
  # The first line, \`?kind<TAB>key\`, tells the caller this user env came from
  # no registry row, so it checks the project markers again before reusing it.
  if [ -z "$__teamai_found" ] && [ -n "$__teamai_user" ] && ! __teamai_env_project "$1"; then printf '?%s\\t%s\\n%s\\n' "$__teamai_kind" "$__teamai_key" "$__teamai_user"; fi
}

# Whether directory $1 is in a project set up in its checkout, as
# \`detectProjectConfig\` reads one there: a \`.teamai/config.yaml\`, or a
# single-repo project's \`.teamai/teamai.yaml\`, at the top of its checkout
# (the nearest directory holding .git), or in $1 itself outside git. The
# member's own ~/.teamai is the user scope's. A checkout whose project keeps
# its data in ~/.teamai/projects says so in its git common directory instead.
__teamai_env_project() {
  __teamai_dir=$1
  if [ "$__teamai_kind" = git ]; then
    [ -e "$__teamai_key/${ENV_PENDING}" ] && return 0
    until [ -e "$__teamai_dir/.git" ] || [ -L "$__teamai_dir/.git" ]; do
      __teamai_parent=\${__teamai_dir%/*}
      [ -n "$__teamai_parent" ] && [ "$__teamai_parent" != "$__teamai_dir" ] || return 1
      __teamai_dir=$__teamai_parent
    done
  fi
  [ -e "$__teamai_dir/.teamai/config.yaml" ] || [ -e "$__teamai_dir/.teamai/teamai.yaml" ] || return 1
  [ "$(__teamai_env_realdir "$__teamai_dir/.teamai")" != "$(__teamai_env_realdir "\${__teamai_env_scopes%/*}")" ]
}

# Whether directory $1 or one above it holds a .git entry.
__teamai_env_in_git() {
  __teamai_dir=$1
  while :; do
    [ -e "$__teamai_dir/.git" ] || [ -L "$__teamai_dir/.git" ] && return 0
    __teamai_parent=\${__teamai_dir%/*}
    [ -n "$__teamai_parent" ] && [ "$__teamai_parent" != "$__teamai_dir" ] || break
    __teamai_dir=$__teamai_parent
  done
  [ -e /.git ] || [ -L /.git ]
}

__teamai_env_bad_path() {
  __teamai_env_bad_tab=$(printf '\\tX'); __teamai_env_bad_tab=\${__teamai_env_bad_tab%X}
  __teamai_env_bad_nl=$(printf 'X\\nY'); __teamai_env_bad_nl=\${__teamai_env_bad_nl#X}; __teamai_env_bad_nl=\${__teamai_env_bad_nl%Y}
  case $1 in *"$__teamai_env_bad_tab"* | *"$__teamai_env_bad_nl"*) return 0 ;; *) return 1 ;; esac
}

# Bash runs every PROMPT_COMMAND array entry from 5.1 on; older ones run only the first.
__teamai_env_prompt_array() {
  case $(declare -p PROMPT_COMMAND 2>/dev/null) in 'declare -a'*) ;; *) return 1 ;; esac
  [ "\${BASH_VERSINFO[0]}" -gt 5 ] || { [ "\${BASH_VERSINFO[0]}" -eq 5 ] && [ "\${BASH_VERSINFO[1]}" -ge 1 ]; }
}

# Drop the routing hook from one PROMPT_COMMAND string, wherever the member's
# later edits moved it. The prompt wrapper stands for the string it saved.
# Commands split on \`;\` and newlines, each kept with the separator it had.
__teamai_env_prompt_strip() {
  __teamai_prompt_rest=$1 __teamai_prompt_clean= __teamai_prompt_sep= __teamai_prompt_found=
  __teamai_prompt_seps=';
'
  while :; do
    __teamai_prompt=\${__teamai_prompt_rest%%[$__teamai_prompt_seps]*}
    __teamai_prompt_rest=\${__teamai_prompt_rest#"$__teamai_prompt"}
    __teamai_prompt_next=\${__teamai_prompt_rest%"\${__teamai_prompt_rest#?}"}
    __teamai_prompt_rest=\${__teamai_prompt_rest#?}
    __teamai_prompt_word=\${__teamai_prompt#"\${__teamai_prompt%%[![:space:]]*}"}
    __teamai_prompt_word=\${__teamai_prompt_word%"\${__teamai_prompt_word##*[![:space:]]}"}
    case $__teamai_prompt_word in
      __teamai_env_apply) __teamai_prompt_found=1 ;;
      '__teamai_env_prompt "$?" "\${PIPESTATUS[@]}"')
        __teamai_prompt_found=1
        if [ -n "\${__TEAMAI_ENV_PROMPT_COMMAND-}" ]; then
          __teamai_prompt_clean="$__teamai_prompt_clean$__teamai_prompt_sep$__TEAMAI_ENV_PROMPT_COMMAND"
        fi
        ;;
      *) __teamai_prompt_clean="$__teamai_prompt_clean$__teamai_prompt_sep$__teamai_prompt" ;;
    esac
    [ -n "$__teamai_prompt_clean" ] && __teamai_prompt_sep=$__teamai_prompt_next
    [ -n "$__teamai_prompt_rest" ] || break
  done
}

# Put back what the member had before the loaded files set it.
__teamai_env_unhook() {
  if [ -n "\${BASH_VERSION-}" ]; then
    if __teamai_env_prompt_array; then
      __teamai_prompts=()
      # Not __teamai_prompt: the strip overwrites that with each command it splits off.
      for __teamai_prompt_entry in "\${PROMPT_COMMAND[@]}"; do
        __teamai_env_prompt_strip "$__teamai_prompt_entry"
        if [ -z "$__teamai_prompt_found" ]; then __teamai_prompts+=("$__teamai_prompt_entry")
        elif [ -n "$__teamai_prompt_clean" ]; then __teamai_prompts+=("$__teamai_prompt_clean"); fi
      done
      PROMPT_COMMAND=("\${__teamai_prompts[@]}")
    else
      __teamai_env_prompt_strip "\${PROMPT_COMMAND-}"
      if [ -z "$__teamai_prompt_found" ]; then
        :
      elif [ -n "$__teamai_prompt_clean" ]; then
        PROMPT_COMMAND=$__teamai_prompt_clean
      elif [ "\${PROMPT_COMMAND-}" = '__teamai_env_prompt "$?" "\${PIPESTATUS[@]}"' ] && [ "\${__TEAMAI_ENV_PROMPT_COMMAND_SET-}" = 1 ]; then
        PROMPT_COMMAND=
      else
        unset PROMPT_COMMAND
      fi
    fi
    unset __TEAMAI_ENV_PROMPT_COMMAND __TEAMAI_ENV_PROMPT_COMMAND_SET
  elif [ -n "\${ZSH_VERSION-}" ]; then
    setopt localoptions no_ksh_arrays
    eval 'typeset -ga chpwd_functions; __teamai_prompts=(); for __teamai_prompt in "\${chpwd_functions[@]}"; do [[ "$__teamai_prompt" == __teamai_env_apply ]] || __teamai_prompts+=("$__teamai_prompt"); done; chpwd_functions=("\${__teamai_prompts[@]}")'
    eval 'typeset -ga precmd_functions; __teamai_prompts=(); for __teamai_prompt in "\${precmd_functions[@]}"; do [[ "$__teamai_prompt" == __teamai_env_precmd ]] || __teamai_prompts+=("$__teamai_prompt"); done; precmd_functions=("\${__teamai_prompts[@]}")'
  fi
}

# zsh runs chpwd only on a cd: each prompt takes BASH_ENV back, as bash's
# PROMPT_COMMAND does, from a startup file or command that set the member's own.
# A startup file after the block (.zshrc) may replace chpwd_functions: the
# prompt then routes a directory chpwd missed, and puts the cd hook back.
__teamai_env_precmd() {
  emulate -L sh
  if [ ! -f "$__teamai_env_loader" ] || [ "$PWD" != "\${__teamai_env_routed-}" ]; then __teamai_env_apply; return; fi
  __teamai_env_bash_env
  setopt localoptions no_ksh_arrays
  eval '(( \${chpwd_functions[(Ie)__teamai_env_apply]} )) || __teamai_env_hook'
}

# A scalar PROMPT_COMMAND keeps its form and export: the wrapper routes, recreates
# the preceding pipeline's $? and PIPESTATUS, then evaluates the member's string.
__teamai_env_prompt_status() { return "$1"; }
# A hook that saved this wrapper and became PROMPT_COMMAND after it, as VS Code's
# shell integration does, runs it again from inside the string it evaluates: that
# call has already routed, so it returns, and the hook goes on to its own work.
__teamai_env_prompt() {
  [ -z "\${__teamai_prompt_active-}" ] || return "$1"
  case $- in *a*) set +a; __teamai_prompt_allexport=1 ;; *) __teamai_prompt_allexport=0 ;; esac
  local __teamai_prompt_active=1
  local __teamai_prompt_saved_command=\${__TEAMAI_ENV_PROMPT_COMMAND-} __teamai_prompt_pipeline= __teamai_prompt_sep= __teamai_prompt_pipe
  local __teamai_prompt_status=$1 __teamai_prompt_natural=0
  shift
  for __teamai_prompt_pipe do
    __teamai_prompt_pipeline="$__teamai_prompt_pipeline$__teamai_prompt_sep __teamai_env_prompt_status $__teamai_prompt_pipe"
    __teamai_prompt_sep=' |'
    if [ "$__teamai_prompt_pipe" != 0 ] || ! shopt -qo pipefail; then __teamai_prompt_natural=$__teamai_prompt_pipe; fi
  done
  # A \`!\` pipeline leaves $? negated and PIPESTATUS as is: negate it again. A $?
  # PIPESTATUS cannot give is the command's own; it wins.
  if [ -n "$__teamai_prompt_pipeline" ] && [ "$__teamai_prompt_natural" != "$__teamai_prompt_status" ]; then
    if { [ "$__teamai_prompt_natural" = 0 ] && [ "$__teamai_prompt_status" = 1 ]; } || { [ "$__teamai_prompt_natural" != 0 ] && [ "$__teamai_prompt_status" = 0 ]; }; then
      __teamai_prompt_pipeline="!$__teamai_prompt_pipeline"
    else
      __teamai_prompt_pipeline=" __teamai_env_prompt_status $__teamai_prompt_status"
    fi
  elif [ -z "$__teamai_prompt_pipeline" ]; then
    __teamai_prompt_pipeline=" __teamai_env_prompt_status $__teamai_prompt_status"
  fi
  __teamai_env_apply
  [ "$__teamai_prompt_allexport" = 1 ] && set -a
  if [ -n "$__teamai_prompt_saved_command" ]; then
    eval "$__teamai_prompt_pipeline; $__teamai_prompt_saved_command"
  else
    eval "$__teamai_prompt_pipeline"
  fi
}

# \${array[*]} joins with IFS's first character: a space, whatever the member set.
__teamai_env_hook() {
  __teamai_hook_ifs_set=\${IFS+1} __teamai_hook_ifs=\${IFS-}
  IFS=' '
  case $- in *i*)
    if [ -n "\${ZSH_VERSION-}" ]; then
      setopt localoptions no_ksh_arrays
      __teamai_env_unhook
      eval 'typeset -ga chpwd_functions; __teamai_prompts=(__teamai_env_apply); for __teamai_prompt in "\${chpwd_functions[@]}"; do [[ "$__teamai_prompt" == __teamai_env_apply ]] || __teamai_prompts+=("$__teamai_prompt"); done; chpwd_functions=("\${__teamai_prompts[@]}")'
      eval 'typeset -ga precmd_functions; __teamai_prompts=(__teamai_env_precmd); for __teamai_prompt in "\${precmd_functions[@]}"; do [[ "$__teamai_prompt" == __teamai_env_precmd ]] || __teamai_prompts+=("$__teamai_prompt"); done; precmd_functions=("\${__teamai_prompts[@]}")'
    elif [ -n "\${BASH_VERSION-}" ]; then
      __teamai_env_unhook
      if __teamai_env_prompt_array; then
        PROMPT_COMMAND=(__teamai_env_apply "\${PROMPT_COMMAND[@]}")
      else
        __TEAMAI_ENV_PROMPT_COMMAND=\${PROMPT_COMMAND-}
        __TEAMAI_ENV_PROMPT_COMMAND_SET=\${PROMPT_COMMAND+1}
        # A child shell that inherits the wrapper restores the member's string from these.
        __teamai_prompt_decl=$(declare -p PROMPT_COMMAND 2>/dev/null) && __teamai_prompt_decl=\${__teamai_prompt_decl#declare -}
        case \${__teamai_prompt_decl%% *} in *x*) export __TEAMAI_ENV_PROMPT_COMMAND __TEAMAI_ENV_PROMPT_COMMAND_SET ;; esac
        PROMPT_COMMAND='__teamai_env_prompt "$?" "\${PIPESTATUS[@]}"'
      fi
    fi
  esac
  if [ -n "$__teamai_hook_ifs_set" ]; then IFS=$__teamai_hook_ifs; else unset IFS; fi
}

# Whether the shell exports $1, whatever other attributes it has: bash prints
# \`declare -ix\`, zsh \`export -i\`.
__teamai_env_exported() {
  if [ -n "\${ZSH_VERSION-}" ]; then
    __teamai_decl=$(typeset -p "$1" 2>/dev/null)
  else
    __teamai_decl=$(declare -p "$1" 2>/dev/null)
  fi
  case \${__teamai_decl%% "$1="*} in export | "export "* | *" -"*x*) return 0 ;; esac
  return 1
}

${ENV_PLAIN}

# Put back the member's own value of $1, which a loaded file set. A project's
# env.sh also calls it for a key it declares and the user scope's env.sh set.
# Assigned over, not unset, so its other attributes stay, and those
# \`__teamai_env_plain\` cleared come back after the value.
__teamai_env_restore() {
  eval "__teamai_set=\\\${__TEAMAI_ENV_SET_$1-}"
  if [ "$__teamai_set" = 1 ] || [ "$__teamai_set" = 2 ]; then
    eval "$1=\\\${__TEAMAI_ENV_PREV_$1}"
    if [ "$__teamai_set" = 2 ]; then export "$1"
    elif [ -n "\${ZSH_VERSION-}" ]; then typeset -g +x "$1"
    else export -n "$1"; fi
    eval "__teamai_attrs=\\\${__TEAMAI_ENV_ATTR_$1-}"
    if [ -z "$__teamai_attrs" ]; then :
    elif [ -n "\${ZSH_VERSION-}" ]; then typeset -g "-$__teamai_attrs" "$1"
    elif __teamai_env_global_attrs; then declare -g "-$__teamai_attrs" "$1"; fi
  else
    unset "$1"
  fi
}

# Put back every name the loaded files set that pattern $1 matches: a
# project's env.sh passes one per key it declares, every spelling of it on
# Windows. Its IFS is the loader's newline while it is sourced.
__teamai_env_keep() {
  __teamai_keep_ifs_set=\${IFS+1} __teamai_keep_ifs=\${IFS-}
  IFS=' '
  for __teamai_k in $__teamai_keys; do
    case $__teamai_k in $1) __teamai_env_restore "$__teamai_k" ;; esac
  done
  if [ -n "$__teamai_keep_ifs_set" ]; then IFS=$__teamai_keep_ifs; else unset IFS; fi
}

# The key list is space-separated, whatever IFS the member set.
__teamai_env_unapply() {
  __teamai_env_unhook
  __teamai_unapply_ifs_set=\${IFS+1} __teamai_unapply_ifs=\${IFS-}
  IFS=' '
  for __teamai_k in \${__TEAMAI_ENV_KEYS-}; do
    __teamai_env_restore "$__teamai_k"
    unset "__TEAMAI_ENV_SET_$__teamai_k" "__TEAMAI_ENV_PREV_$__teamai_k" "__TEAMAI_ENV_ATTR_$__teamai_k"
  done
  if [ -n "$__teamai_unapply_ifs_set" ]; then IFS=$__teamai_unapply_ifs; else unset IFS; fi
  unset __TEAMAI_ENV_KEYS
}

# The keys file $1 assigns, one per line after prefix $2: each line that starts
# \`export KEY=\` outside a quoted value. env.sh single-quotes every value and
# writes a quote inside one as '\\'', so no line of a multiline value counts.
# awk comes from the system's default path, whatever PATH the member set.
__teamai_env_keys_of() {
  command -p awk -v __teamai_prefix="\${2-}" 'BEGIN { q = sprintf("%c", 39); t = q "\\\\" q q }
    !open && /^export [A-Za-z_][A-Za-z0-9_]*=/ { k = substr($0, 8); sub(/=.*/, "", k); print __teamai_prefix k }
    { s = $0; while ((i = index(s, t)) > 0) s = substr(s, 1, i - 1) substr(s, i + 4); open = (open + gsub(q, "", s)) % 2 }' "$1"
}

# One file per line. No here-document: a sandboxed tool may not let the shell
# create the temp file one needs. Read every file's keys before sourcing any;
# env files can change PATH, and the loader runs no external command afterwards.
# A file whose keys cannot be read is not sourced: nothing could unapply it.
__teamai_env_load() {
  __teamai_keys=
  __teamai_unscanned=
  __teamai_ifs_set=\${IFS+1} __teamai_ifs=\${IFS-}
  IFS='
'
  for __teamai_f in $__TEAMAI_ENV_FILES; do
    [ -f "$__teamai_f" ] || continue
    [ -r "$__teamai_f" ] || { __teamai_unscanned="$__teamai_unscanned
$__teamai_f"; continue; }
    if ! __teamai_file_keys=$(__teamai_env_keys_of "$__teamai_f"); then
      __teamai_unscanned="$__teamai_unscanned
$__teamai_f"
      continue
    fi
    for __teamai_k in $__teamai_file_keys; do
      case " $__teamai_keys " in *" $__teamai_k "*) continue ;; esac
      __teamai_keys="$__teamai_keys $__teamai_k"
    done
  done
  # The selected files form one routing decision. If a file could not be
  # scanned, source none of them so an inherited user file cannot leak alone.
  if [ -n "$__teamai_unscanned" ]; then __teamai_keys=; fi
  __teamai_plan=${windows ? '$(__teamai_env_spellings) || __teamai_unscanned=$__TEAMAI_ENV_FILES' : ''}
  for __teamai_k in $__teamai_plan; do
    case $__teamai_k in
      'K '*)
        __teamai_k=\${__teamai_k#K }
        case " $__teamai_keys " in *" $__teamai_k "*) ;; *) __teamai_keys="$__teamai_keys $__teamai_k" ;; esac
        ;;
    esac
  done
  __teamai_key_ifs=$IFS
  IFS=' \n'
  for __teamai_k in $__teamai_keys; do
    eval "__teamai_set=\\\${$__teamai_k+1}"
    if [ "$__teamai_set" = 1 ]; then
      # Remove inherited export attributes from bookkeeping before writing it.
      unset "__TEAMAI_ENV_SET_$__teamai_k" "__TEAMAI_ENV_PREV_$__teamai_k" "__TEAMAI_ENV_ATTR_$__teamai_k"
      if __teamai_env_exported "$__teamai_k"; then
        eval "export __TEAMAI_ENV_SET_$__teamai_k=2 __TEAMAI_ENV_PREV_$__teamai_k=\\"\\$$__teamai_k\\""
      else
        eval "__TEAMAI_ENV_SET_$__teamai_k=1 __TEAMAI_ENV_PREV_$__teamai_k=\\"\\$$__teamai_k\\""
      fi
      __teamai_env_plain "$__teamai_k"
    fi
  done
  IFS=$__teamai_key_ifs
  if [ -z "$__teamai_unscanned" ]; then
    __teamai_i=0
    for __teamai_f in $__TEAMAI_ENV_FILES; do
      __teamai_i=$((__teamai_i + 1))
      [ -f "$__teamai_f" ] && [ -r "$__teamai_f" ] || { __teamai_unscanned=1; break; }
    done
  fi
  if [ -z "$__teamai_unscanned" ]; then
    __teamai_i=0
    for __teamai_f in $__TEAMAI_ENV_FILES; do
      __teamai_i=$((__teamai_i + 1))
      [ -f "$__teamai_f" ] || continue
      case "
$__teamai_unscanned
" in *"
$__teamai_f
"*) continue ;; esac
      for __teamai_k in $__teamai_plan; do
        case $__teamai_k in "$__teamai_i "*) unset "\${__teamai_k#* }" ;; esac
      done
      . "$__teamai_f"
    done
  fi
  if [ -n "$__teamai_ifs_set" ]; then IFS=$__teamai_ifs; else unset IFS; fi
  export __TEAMAI_ENV_KEYS="$__teamai_keys"
}

# bash reads no startup file for \`bash -c\`, except the one BASH_ENV names:
# point it here, so a bash this shell starts, a zsh's too, gets the env of its
# own directory. The member's own BASH_ENV is kept, to source after.
__teamai_env_bash_env() {
  [ "\${BASH_ENV-}" = "$__teamai_env_loader" ] && return 0
  if [ "\${BASH_ENV+x}" = x ]; then
    unset __TEAMAI_ENV_BASH_ENV __TEAMAI_ENV_BASH_ENV_SET
    if __teamai_env_exported BASH_ENV; then
      export __TEAMAI_ENV_BASH_ENV="$BASH_ENV" __TEAMAI_ENV_BASH_ENV_SET=2
    else
      __TEAMAI_ENV_BASH_ENV="$BASH_ENV" __TEAMAI_ENV_BASH_ENV_SET=1
    fi
  else
    unset __TEAMAI_ENV_BASH_ENV __TEAMAI_ENV_BASH_ENV_SET
  fi
  export BASH_ENV="$__teamai_env_loader"
}

__teamai_env_apply() {
  __teamai_env_routed=$PWD
  if [ -n "\${ZSH_VERSION-}" ]; then
    emulate -L sh
  else
    case $- in *a*) set +a; __teamai_env_apply_allexport=1 ;; *) __teamai_env_apply_allexport=0 ;; esac
    if shopt -q nocasematch; then __teamai_env_apply_nocasematch=1; shopt -u nocasematch; else __teamai_env_apply_nocasematch=0; fi
  fi
  __teamai_env_apply_body
  __teamai_env_apply_status=$?
  if [ -n "\${BASH_VERSION-}" ]; then
    [ "$__teamai_env_apply_nocasematch" = 1 ] && shopt -s nocasematch
    [ "$__teamai_env_apply_allexport" = 1 ] && set -a
    unset __teamai_env_apply_nocasematch __teamai_env_apply_allexport
  fi
  return "$__teamai_env_apply_status"
}

__teamai_env_apply_body() {
  [ -n "\${ZSH_VERSION-}" ] && emulate -L sh
  # Resolution runs in the member's environment so PATH and GIT_* from the
  # previous directory cannot redirect git or prevent it from being found.
  __teamai_env_unapply
  # An already-open shell may still hold this function after uninstall removes
  # the loader file. Unapply its values and hook, then leave it clean.
  if [ ! -f "$__teamai_env_loader" ]; then
    case \${__TEAMAI_ENV_BASH_ENV_SET-} in
      1 | 2)
        unset BASH_ENV
        BASH_ENV=$__TEAMAI_ENV_BASH_ENV
        [ "$__TEAMAI_ENV_BASH_ENV_SET" = 2 ] && export BASH_ENV
        ;;
      *) unset BASH_ENV ;;
    esac
    unset __TEAMAI_ENV_BASH_ENV __TEAMAI_ENV_BASH_ENV_SET __TEAMAI_ENV_DIR __TEAMAI_ENV_STAMP __TEAMAI_ENV_FILES __TEAMAI_ENV_ROUTE
    return 0
  fi
  # Again on each cd: a startup file the member's runs after this one may set its own.
  __teamai_env_bash_env
  __teamai_d=$(__teamai_env_pwd) || { unset __TEAMAI_ENV_DIR __TEAMAI_ENV_FILES __TEAMAI_ENV_ROUTE; return 0; }
  # Changes with the registry and with every env.sh a pull rewrites.
  __teamai_stamp=
  if [ -e "$__teamai_env_scopes.lock" ]; then
    __teamai_stamp=registry-locked
  elif [ -f "$__teamai_env_scopes" ] && [ -r "$__teamai_env_scopes" ]; then
    { IFS= read -r __teamai_stamp < "$__teamai_env_scopes"; } 2>/dev/null || :
  elif [ -e "$__teamai_env_scopes" ]; then
    __teamai_stamp=registry-unreadable
  fi
  # A child in the same directory reuses its parent's files only where the
  # whole decision can be checked again without git: outside a checkout, with
  # the same stamp, and for a user env no registry row chose, no project
  # marker. In a checkout only git can tell, so it routes again, as a cd does.
  __teamai_cached=
  if [ "$__teamai_stamp" = "\${__TEAMAI_ENV_STAMP-}" ] && [ "$__teamai_d" = "\${__TEAMAI_ENV_DIR-}" ] && ! __teamai_env_in_git "$__teamai_d"; then
    __teamai_cached=1 __teamai_files=\${__TEAMAI_ENV_FILES-} __teamai_route=\${__TEAMAI_ENV_ROUTE-}
    if [ -n "$__teamai_route" ]; then
      __teamai_kind=dir
      { [ "\${__teamai_route%%'	'*}" = dir ] && ! __teamai_env_project "$__teamai_d"; } || __teamai_cached=
    fi
  fi
  if [ -z "$__teamai_cached" ]; then
    __teamai_files=$(__teamai_env_files "$__teamai_d") __teamai_route=
    case $__teamai_files in
      '?'*)
        __teamai_route=\${__teamai_files%%'
'*}
        __teamai_route=\${__teamai_route#?} __teamai_files=\${__teamai_files#*'
'}
        ;;
    esac
  fi
  export __TEAMAI_ENV_DIR="$__teamai_d" __TEAMAI_ENV_STAMP="$__teamai_stamp"
  export __TEAMAI_ENV_FILES="$__teamai_files" __TEAMAI_ENV_ROUTE="$__teamai_route"
  __teamai_env_load
  # Team files may set names that control loader routing. Keep the original
  # member BASH_ENV for chaining, and reassert the loader's exported state.
  export BASH_ENV="$__teamai_env_loader" __TEAMAI_ENV_DIR="$__teamai_d" __TEAMAI_ENV_STAMP="$__teamai_stamp" __TEAMAI_ENV_FILES="$__teamai_files" __TEAMAI_ENV_ROUTE="$__teamai_route"
  __teamai_env_hook
  return 0
}

# A bash that runs this as its BASH_ENV sources the member's own, once, before
# the team env: with the previous directory's env unapplied first, so the
# member's file sees their own environment, and the team env wins a key both set.
if [ -n "\${BASH_VERSION-}" ] && [ "\${BASH_ENV-}" = "$__teamai_env_loader" ] && [ -z "\${__teamai_env_chained-}" ]; then
  case $- in
    *i*) ;;
    *)
      __teamai_env_chained=1
      __teamai_env_unapply
      # The member's file runs with BASH_ENV naming it, as bash would run it. If
      # it sets another, \`__teamai_env_bash_env\` keeps that one for chaining.
      if [ -n "\${__TEAMAI_ENV_BASH_ENV-}" ] && [ -f "$__TEAMAI_ENV_BASH_ENV" ]; then
        __teamai_env_member_bash_env=$__TEAMAI_ENV_BASH_ENV
        BASH_ENV=$__teamai_env_member_bash_env
        . "$__teamai_env_member_bash_env"
        [ "\${BASH_ENV-}" = "$__teamai_env_member_bash_env" ] && BASH_ENV=$__teamai_env_loader
        unset __teamai_env_member_bash_env
      fi
      ;;
  esac
fi
__teamai_env_apply
:
  if [ -n "\${BASH_VERSION-}" ]; then
    [ "$2" = 1 ] && shopt -s nocasematch
    case $1 in *a*) set -a ;; esac
  fi
}
if [ -n "\${BASH_VERSION-}" ] && shopt -q nocasematch; then
  __teamai_env_start "$-" 1
else
  __teamai_env_start "$-" 0
fi
`;
}
