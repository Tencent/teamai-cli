/** Shell startup, hook, and loader state names team env must not replace. */
export const TEAM_ENV_RESERVED_NAMES = [
  'BASH_ENV', 'ENV', 'ZDOTDIR', 'HOME', 'PROMPT_COMMAND',
  'chpwd_functions', 'precmd_functions', 'preexec_functions', 'periodic_functions',
  'zshaddhistory_functions', 'zshexit_functions', 'zsh_directory_name_functions',
] as const;

export function isReservedTeamEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return TEAM_ENV_RESERVED_NAMES.some((reserved) => reserved.toUpperCase() === normalized)
    || normalized.startsWith('__TEAMAI_ENV_');
}

export function reservedTeamEnvKeys(keys: Iterable<string>): string[] {
  return [...new Set([...keys].filter(isReservedTeamEnvKey))];
}

export function reservedTeamEnvWarning(keys: Iterable<string>): string | null {
  const reserved = reservedTeamEnvKeys(keys);
  return reserved.length === 0 ? null
    : `${reserved.join(', ')} ${reserved.length === 1 ? 'is' : 'are'} reserved for TeamAI shell routing; those team env values are ignored.`;
}
