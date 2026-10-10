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
import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { acquireLock, releaseLock } from '../update.js';
import { getDataHome, getTeamaiHome, getTeamaiHomeDir, getUserConfigPath, type LocalConfig } from '../types.js';
import { pathExists, readFileSafe, writeFileAtomic } from '../utils/fs.js';
import { gitCommonDir } from '../utils/git.js';
import { log } from '../utils/logger.js';
import { isWindowsFormPath, shellQuoteValue } from '../utils/shell-profile.js';

/** The script the shell profile block sources. */
export function envLoaderPath(): string {
  return path.join(getTeamaiHomeDir(), 'env-loader.sh');
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

/** Registry rows have five fields; project rows must name their partition. */
function validScopeLine(line: string): boolean {
  const [kind, key, envSh, inherits, partition, ...extra] = line.split('\t');
  if (extra.length > 0 || !envSh || (envSh !== '-' && !path.isAbsolute(envSh))) return false;
  if (kind === 'user') return key === '-' && inherits === '0' && partition === '-';
  return (kind === 'git' || kind === 'dir') && Boolean(key) && (inherits === '0' || inherits === '1')
    && Boolean(partition) && partition !== '-';
}

/** A path in the form the loader's `pwd` prints: forward slashes for a Windows path (Git Bash `pwd -W`). */
function shellForm(p: string): string {
  return isWindowsFormPath(p) ? p.replace(/\\/g, '/') : p;
}

/** The registry entry that routes `localConfig`'s directories to its env.sh, or says whether the user scope's loads in shells. */
async function scopeEntry(localConfig: LocalConfig, inShells = true): Promise<{ id: string; line: string } | null> {
  let [kind, key] = ['user', '-'];
  if (localConfig.scope === 'project') {
    if (!localConfig.projectRoot) return null;
    const common = await gitCommonDir(localConfig.projectRoot);
    [kind, key] = common
      ? ['git', common]
      : ['dir', await fs.promises.realpath(localConfig.projectRoot).catch(() => localConfig.projectRoot as string)];
  }
  const envSh = path.join(getDataHome(localConfig), 'env.sh');
  const partition = localConfig.scope === 'project' ? shellForm(getDataHome(localConfig)) : '-';
  const fields = [kind, shellForm(key), inShells ? shellForm(envSh) : '-', localConfig.inheritUserScope === true ? '1' : '0', partition];
  // A field holding a tab or a newline cannot be stored in the line format.
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
 * its env and none of the user scope's.
 */
export async function registerEnvScope(localConfig: LocalConfig, inShells: boolean): Promise<void> {
  const entry = await scopeEntry(localConfig, inShells);
  if (!entry) return;
  await updateEnvScopes((lines) => {
    const others = lines.filter((line) => !line.startsWith(entry.id));
    return localConfig.scope === 'user' ? [entry.line, ...others] : [...others, entry.line];
  }, { fillUserLine: localConfig.scope !== 'user' });
}

/**
 * The user scope's line for a registry that has none (an earlier version
 * pulled it), as its own pull would write it: from its config and its team's
 * `injectShellProfile`. Opted out when either cannot be read, so its env.sh
 * stays out of shells until it is pulled. Null when there is no user scope.
 */
async function userScopeLine(): Promise<string | null> {
  if (!await pathExists(getUserConfigPath())) return null;
  const user = await loadLocalConfig({ dryRun: true, suppressMigrationNotice: true });
  const team = user ? await loadTeamConfig(user.repo.localPath) : null;
  if (!user || !team) {
    log.warn('Could not read the user scope\'s config or its team\'s teamai.yaml, so its env stays out of shells. Fix that config, then run `teamai pull` outside any project.');
    return `${USER_LINE}-\t0\t-`;
  }
  return (await scopeEntry(user, team.sharing.env.injectShellProfile !== false))?.line ?? null;
}

/** Whether the registry lets the user scope's env.sh load in shells. */
async function userEnvInShells(): Promise<boolean> {
  return !(await readFileSafe(envScopesPath()) ?? '').split('\n').some((line) => line.startsWith(`${USER_LINE}-\t`));
}

/** Take this scope out of the registry, so a project's directories get the user scope's env again. */
export async function unregisterEnvScope(localConfig: LocalConfig): Promise<void> {
  const entry = await scopeEntry(localConfig);
  if (!entry) return;
  await updateEnvScopes((lines) => lines.filter((line) => !line.startsWith(entry.id)), { fillUserLine: localConfig.scope !== 'user' });
}

/**
 * Whether no remaining scope loads env through the loader. A registered scope
 * with `-` in its env path keeps its data but does not need the shell loader.
 */
export async function isLastEnvScope(localConfig: LocalConfig): Promise<boolean> {
  const entry = await scopeEntry(localConfig);
  const hasUserConfig = await pathExists(getUserConfigPath());
  const others = (await readFileSafe(envScopesPath()) ?? '').split('\n')
    .filter((line) => validScopeLine(line) && (entry === null || !line.startsWith(entry.id)));
  if (others.some((line) => (!line.startsWith(USER_LINE) || hasUserConfig)
    && Boolean(line.split('\t')[2]) && line.split('\t')[2] !== '-')) return false;
  // An older user install has no registry line, so the loader still uses its
  // fallback env.sh until a pull records the user's shell-loading preference.
  return localConfig.scope === 'user' || Boolean(others.some((line) => line.startsWith(USER_LINE))) || !hasUserConfig;
}

/** Whether any registered scope still asks shells to load an env file. */
export async function hasEnvLoadingScope(): Promise<boolean> {
  return (await readFileSafe(envScopesPath()) ?? '').split('\n').some((line) => {
    if (!validScopeLine(line)) return false;
    const envSh = line.split('\t')[2];
    return Boolean(envSh) && envSh !== '-';
  });
}

/** Remove the shell loader when no scope loads env; keep registry entries for opted-out scopes. */
export async function removeEnvLoader(): Promise<void> {
  if (!await pathExists(getUserConfigPath())) {
    await updateEnvScopes((lines) => lines.filter((line) => !line.startsWith(USER_LINE)));
  }
  await fs.promises.rm(envLoaderPath(), { force: true });
  const scopes = (await readFileSafe(envScopesPath()) ?? '').split('\n')
    .filter((line) => line !== '' && !line.startsWith(STAMP));
  if (scopes.length === 0) await fs.promises.rm(envScopesPath(), { force: true });
}

/**
 * The files a removal of `~/.teamai` keeps for registered projects: the loader
 * only when some project env loads, the registry, and each project's data
 * directory (which holds its env.sh and config). Empty when none remain.
 */
export async function envLoaderFilesForProjects(): Promise<string[]> {
  await updateEnvScopes((lines) => lines.filter((line) => !line.startsWith(USER_LINE)));
  const projectEntries = (await readFileSafe(envScopesPath()) ?? '').split('\n')
    .filter((line) => validScopeLine(line) && !line.startsWith(USER_LINE));
  const homes = [...new Set(await registeredProjectDataHomes(projectEntries))];
  return [
    ...projectEntries.some((line) => {
      const envSh = line.split('\t')[2];
      return Boolean(envSh) && envSh !== '-';
    }) ? [envLoaderPath()] : [],
    ...projectEntries.length > 0 ? [envScopesPath()] : [],
    ...homes,
  ];
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

/** Tell shells that inherited their env that an env.sh changed, so they load it again. */
export async function markEnvChanged(): Promise<void> {
  await updateEnvScopes((lines) => lines, { changed: true, fillUserLine: true });
}

const STAMP = 'stamp\t';
const USER_LINE = 'user\t-\t';

/**
 * Change the registry under its lock. A pull (`fillUserLine`) also writes the
 * user scope's line when it is missing, so no shell loads the user env.sh on
 * the fallback alone once any pull has run.
 */
async function updateEnvScopes(
  change: (lines: string[]) => string[],
  { changed = false, fillUserLine = false }: { changed?: boolean; fillUserLine?: boolean } = {},
): Promise<void> {
  const file = envScopesPath();
  const lock = `${file}.lock`;
  let held = false;
  for (let attempt = 0; attempt < 100 && !held; attempt++) {
    held = await acquireLock(lock);
    if (!held) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!held) {
    log.warn(`Another teamai command is changing ${file}; this project's env reaches new shells after the next pull.`);
    return;
  }
  try {
    const before = (await readFileSafe(file) ?? '').split('\n').filter((line) => line !== '' && !line.startsWith(STAMP));
    const userLine = fillUserLine && !before.some((line) => line.startsWith(USER_LINE)) ? await userScopeLine() : null;
    const after = change(userLine ? [userLine, ...before] : before);
    if (changed || after.join('\n') !== before.join('\n')) {
      await writeFileAtomic(file, `${[`${STAMP}${crypto.randomUUID()}`, ...after].join('\n')}\n`);
    }
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

/**
 * Start the member's shell in `dir`, run the loader there, and compare the
 * env files it loaded with the ones `localConfig` (the scope governing `dir`)
 * should: the check runs the loader the way every shell does, so a broken
 * loader or a stale registry shows up here. Only zsh and bash run the loader.
 */
export async function directoryEnv(localConfig: LocalConfig, dir: string, shell = process.env.SHELL ?? ''): Promise<DirectoryEnv> {
  if (!loaderShell(shell)) return { kind: 'shell-without-loader', shell: path.basename(shell) || 'no SHELL' };
  const userEnvSh = path.join(getTeamaiHome('user'), 'env.sh');
  const expected = (localConfig.scope === 'project'
    ? [...(localConfig.inheritUserScope === true && await userEnvInShells() ? [userEnvSh] : []), path.join(getDataHome(localConfig), 'env.sh')]
    : [userEnvSh]).map(shellForm);
  // A fresh resolution: none of what this process's shell already loaded.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('__TEAMAI_ENV_') && key !== 'BASH_ENV'));
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

/** Write the loader script, unless it already says the same. */
export async function writeEnvLoader(): Promise<void> {
  const script = envLoaderScript({
    loaderFile: shellForm(envLoaderPath()),
    scopesFile: shellForm(envScopesPath()),
    userEnvSh: shellForm(path.join(getTeamaiHomeDir(), 'env.sh')),
  });
  if (await readFileSafe(envLoaderPath()) === script) return;
  await writeFileAtomic(envLoaderPath(), script);
}

/**
 * The loader. POSIX sh that zsh (in sh emulation) and bash both run, sourced
 * by every shell the profile block reaches, so it prints nothing, fails
 * nothing, and does no work when neither the directory nor the registry's
 * stamp has changed: the directory, the stamp and the files it loaded are
 * exported, so a child shell started in the same directory returns at once.
 *
 * Every variable it sets for its own bookkeeping starts with `__teamai_` (the
 * shell's) or `__TEAMAI_ENV_` (exported, so a child shell started elsewhere
 * can put back what the member had before).
 */
function envLoaderScript({ loaderFile, scopesFile, userEnvSh }: { loaderFile: string; scopesFile: string; userEnvSh: string }): string {
  return `# DO NOT EDIT: written by teamai. Loads the team env of the scope that governs
# the shell's directory (#1018).
__teamai_env_scopes=${shellQuoteValue(scopesFile)}
__teamai_env_user=${shellQuoteValue(userEnvSh)}
__teamai_env_loader=${shellQuoteValue(loaderFile)}

__teamai_env_pwd() { pwd -W 2>/dev/null || pwd -P; }

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
  if __teamai_common=$(git -C "$1" rev-parse --git-common-dir 2>/dev/null); then
    case $__teamai_common in /* | ?:/*) ;; *) __teamai_common=$1/$__teamai_common ;; esac
    __teamai_key=$(__teamai_env_realdir "$__teamai_common") && __teamai_kind=git
  fi
  if [ -f "$__teamai_env_scopes" ]; then
    while IFS='	' read -r __teamai_k __teamai_p __teamai_f __teamai_i __teamai_h; do
      if [ "$__teamai_k" = user ]; then
        [ "$__teamai_p" = - ] && [ "$__teamai_i" = 0 ] && [ "$__teamai_h" = - ] && [ -n "$__teamai_f" ] && [ "$__teamai_f" = - ] && __teamai_user=
      elif [ -n "$__teamai_h" ] && [ "$__teamai_h" != - ] && [ "$__teamai_k" = "$__teamai_kind" ] && [ "$__teamai_p" = "$__teamai_key" ]; then
        case $__teamai_i in 0 | 1) ;; *) continue ;; esac
        [ -n "$__teamai_f" ] || continue
        __teamai_found=1
        [ "$__teamai_f" != - ] && [ "$__teamai_i" = 1 ] && [ -n "$__teamai_user" ] && printf '%s\\n' "$__teamai_user"
        [ "$__teamai_f" = - ] || printf '%s\\n' "$__teamai_f"
        break
      fi
    done < "$__teamai_env_scopes"
  fi
  if [ -z "$__teamai_found" ] && [ -n "$__teamai_user" ]; then printf '%s\\n' "$__teamai_user"; fi
}

# Put back what the member had before the loaded files set it.
__teamai_env_unhook() {
  if [ -n "\${BASH_VERSION-}" ]; then
    case $(declare -p PROMPT_COMMAND 2>/dev/null) in
      'declare -a'*)
        __teamai_prompts=()
        for __teamai_prompt in "\${PROMPT_COMMAND[@]}"; do
          [ "$__teamai_prompt" = __teamai_env_apply ] || __teamai_prompts+=("$__teamai_prompt")
        done
        PROMPT_COMMAND=("\${__teamai_prompts[@]}")
        ;;
      *)
        __teamai_prompt_rest=\${PROMPT_COMMAND-} __teamai_prompt_clean= __teamai_prompt_sep=
        while :; do
          case $__teamai_prompt_rest in
            *';'*) __teamai_prompt=\${__teamai_prompt_rest%%;*}; __teamai_prompt_rest=\${__teamai_prompt_rest#*;} ;;
            *) __teamai_prompt=$__teamai_prompt_rest; __teamai_prompt_rest= ;;
          esac
          if [ "$__teamai_prompt" != __teamai_env_apply ]; then
            __teamai_prompt_clean="$__teamai_prompt_clean$__teamai_prompt_sep$__teamai_prompt"
            __teamai_prompt_sep=';'
          fi
          [ -n "$__teamai_prompt_rest" ] || break
        done
        if [ -n "$__teamai_prompt_clean" ]; then PROMPT_COMMAND=$__teamai_prompt_clean; else unset PROMPT_COMMAND; fi
        ;;
    esac
  elif [ -n "\${ZSH_VERSION-}" ]; then
    eval 'typeset -ga chpwd_functions; __teamai_prompts=(); for __teamai_prompt in "\${chpwd_functions[@]}"; do [[ "$__teamai_prompt" == __teamai_env_apply ]] || __teamai_prompts+=("$__teamai_prompt"); done; chpwd_functions=("\${__teamai_prompts[@]}")'
  fi
}

__teamai_env_hook() {
  case $- in *i*)
    if [ -n "\${ZSH_VERSION-}" ]; then
      eval 'typeset -ga chpwd_functions; case " \${chpwd_functions[*]} " in *" __teamai_env_apply "*) ;; *) chpwd_functions+=(__teamai_env_apply) ;; esac'
    elif [ -n "\${BASH_VERSION-}" ]; then
      case $(declare -p PROMPT_COMMAND 2>/dev/null) in
        'declare -a'*)
          case " \${PROMPT_COMMAND[*]} " in *" __teamai_env_apply "*) ;; *) PROMPT_COMMAND+=(__teamai_env_apply) ;; esac
          ;;
        *) case ";\${PROMPT_COMMAND-};" in
          *";__teamai_env_apply;"*) ;;
          *) PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND;}__teamai_env_apply" ;;
        esac ;;
      esac
    fi
  esac
}

__teamai_env_unapply() {
  __teamai_env_unhook
  for __teamai_k in \${__TEAMAI_ENV_KEYS-}; do
    eval "__teamai_set=\\\${__TEAMAI_ENV_SET_$__teamai_k-}"
    if [ "$__teamai_set" = 1 ] || [ "$__teamai_set" = 2 ]; then
      unset "$__teamai_k"
      eval "$__teamai_k=\\\${__TEAMAI_ENV_PREV_$__teamai_k}"
      [ "$__teamai_set" = 2 ] && export "$__teamai_k"
    else
      unset "$__teamai_k"
    fi
    unset "__TEAMAI_ENV_SET_$__teamai_k" "__TEAMAI_ENV_PREV_$__teamai_k"
  done
  unset __TEAMAI_ENV_KEYS
}

# One file per line. No here-document: a sandboxed tool may not let the shell
# create the temp file one needs. Read every file's keys before sourcing any;
# env files can change PATH, and the loader runs no external command afterwards.
__teamai_env_load() {
  __teamai_keys=
  __teamai_ifs_set=\${IFS+1} __teamai_ifs=\${IFS-}
  IFS='
'
  for __teamai_f in $__TEAMAI_ENV_FILES; do
    [ -f "$__teamai_f" ] || continue
    for __teamai_k in $(sed -n 's/^export \\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' "$__teamai_f"); do
      case " $__teamai_keys " in *" $__teamai_k "*) continue ;; esac
      __teamai_keys="$__teamai_keys $__teamai_k"
    done
  done
  __teamai_key_ifs=$IFS
  IFS=' \n'
  for __teamai_k in $__teamai_keys; do
    eval "__teamai_set=\\\${$__teamai_k+1}"
    if [ "$__teamai_set" = 1 ]; then
      # Remove inherited export attributes from bookkeeping before writing it.
      unset "__TEAMAI_ENV_SET_$__teamai_k" "__TEAMAI_ENV_PREV_$__teamai_k"
      __teamai_exported=
      if [ -n "\${ZSH_VERSION-}" ]; then
        case $(typeset -p "$__teamai_k" 2>/dev/null) in *"export $__teamai_k="*) __teamai_exported=1 ;; esac
      else
        case $(declare -p "$__teamai_k" 2>/dev/null) in *"declare -x $__teamai_k="*) __teamai_exported=1 ;; esac
      fi
      if [ "$__teamai_exported" = 1 ]; then
        eval "export __TEAMAI_ENV_SET_$__teamai_k=2 __TEAMAI_ENV_PREV_$__teamai_k=\\"\\$$__teamai_k\\""
      else
        eval "__TEAMAI_ENV_SET_$__teamai_k=1 __TEAMAI_ENV_PREV_$__teamai_k=\\"\\$$__teamai_k\\""
      fi
    fi
  done
  IFS=$__teamai_key_ifs
  for __teamai_f in $__TEAMAI_ENV_FILES; do
    [ -f "$__teamai_f" ] && . "$__teamai_f"
  done
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
    __teamai_bash_env_exported=
    if [ -n "\${ZSH_VERSION-}" ]; then
      case $(typeset -p BASH_ENV 2>/dev/null) in *'export BASH_ENV='*) __teamai_bash_env_exported=1 ;; esac
    else
      case $(declare -p BASH_ENV 2>/dev/null) in *'declare -x BASH_ENV='*) __teamai_bash_env_exported=1 ;; esac
    fi
    if [ "$__teamai_bash_env_exported" = 1 ]; then
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
    unset __TEAMAI_ENV_BASH_ENV __TEAMAI_ENV_BASH_ENV_SET __TEAMAI_ENV_DIR __TEAMAI_ENV_STAMP __TEAMAI_ENV_FILES
    return 0
  fi
  # Again on each cd: a startup file the member's runs after this one may set its own.
  __teamai_env_bash_env
  __teamai_d=$(__teamai_env_pwd) || { unset __TEAMAI_ENV_DIR __TEAMAI_ENV_FILES; return 0; }
  # Changes with the registry and with every env.sh a pull rewrites.
  __teamai_stamp=
  if [ -f "$__teamai_env_scopes" ]; then { IFS= read -r __teamai_stamp < "$__teamai_env_scopes"; } 2>/dev/null || :; fi
  if [ "$__teamai_stamp" = "\${__TEAMAI_ENV_STAMP-}" ] && [ "$__teamai_d" = "\${__TEAMAI_ENV_DIR-}" ]; then
    __teamai_files=\${__TEAMAI_ENV_FILES-}
  else
    __teamai_files=$(__teamai_env_files "$__teamai_d")
  fi
  export __TEAMAI_ENV_DIR="$__teamai_d" __TEAMAI_ENV_STAMP="$__teamai_stamp"
  export __TEAMAI_ENV_FILES="$__teamai_files"
  __teamai_env_load
  # Team files may set names that control loader routing. Keep the original
  # member BASH_ENV for chaining, and reassert the loader's exported state.
  export BASH_ENV="$__teamai_env_loader" __TEAMAI_ENV_DIR="$__teamai_d" __TEAMAI_ENV_STAMP="$__teamai_stamp" __TEAMAI_ENV_FILES="$__teamai_files"
  __teamai_env_hook
  return 0
}

# A bash that runs this as its BASH_ENV sources the member's own after it, once.
__teamai_env_chain=
if [ -n "\${BASH_VERSION-}" ] && [ "\${BASH_ENV-}" = "$__teamai_env_loader" ] && [ -z "\${__teamai_env_chained-}" ]; then
  case $- in *i*) ;; *) __teamai_env_chain=1 ;; esac
fi
__teamai_env_apply
if [ -n "$__teamai_env_chain" ]; then
  __teamai_env_chained=1
  if [ -n "\${__TEAMAI_ENV_BASH_ENV-}" ] && [ -f "$__TEAMAI_ENV_BASH_ENV" ]; then . "$__TEAMAI_ENV_BASH_ENV"; fi
fi
:
`;
}
