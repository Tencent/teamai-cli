import { isEnvShMarker } from './env-sh-exports.js';

/**
 * Shell startup, hook, and loader names team env must not replace: every name
 * the loader reads or writes is one of these or starts with `__TEAMAI_`. The
 * `TEAMAI_ENV_SH_<hash>` markers env.sh exports are reserved too, as are the
 * names Bash makes read-only, whose `export` lines Bash rejects.
 */
export const TEAM_ENV_RESERVED_NAMES = [
  'BASH_ENV', 'ENV', 'ZDOTDIR', 'HOME', 'PWD', 'PROMPT_COMMAND', 'BASH_VERSION', 'BASH_VERSINFO', 'ZSH_VERSION', 'PIPESTATUS', 'IFS',
  'SHELLOPTS', 'BASHOPTS', 'UID', 'EUID', 'PPID',
  'chpwd_functions', 'precmd_functions', 'preexec_functions', 'periodic_functions',
  'zshaddhistory_functions', 'zshexit_functions', 'zsh_directory_name_functions',
] as const;

export function isReservedTeamEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return TEAM_ENV_RESERVED_NAMES.some((reserved) => reserved.toUpperCase() === normalized)
    || normalized.startsWith('__TEAMAI_')
    || isEnvShMarker(key);
}

export function reservedTeamEnvKeys(keys: Iterable<string>): string[] {
  return [...new Set([...keys].filter(isReservedTeamEnvKey))];
}

export function reservedTeamEnvWarning(keys: Iterable<string>): string | null {
  const reserved = reservedTeamEnvKeys(keys);
  return reserved.length === 0 ? null
    : `${reserved.join(', ')} ${reserved.length === 1 ? 'is' : 'are'} reserved for TeamAI shell routing; those team env values are ignored.`;
}
