import { isEnvShMarker } from './env-sh-exports.js';
import { WORKFLOW_DIR_ENV } from './launch-context.js';
import { PATH_VARIABLES } from './resources/delivered-folders.js';

/**
 * The paths teamai gives a workflow folder's steps, a hook folder's command, a rule or agent folder's text, and an MCP server folder's
 * command, args and env (#1787): a team value would point them at another folder.
 */
const FOLDER_DIR_NAMES = [WORKFLOW_DIR_ENV, ...Object.values(PATH_VARIABLES)] as const;

/**
 * Shell startup, hook, and loader names team env must not replace: every name
 * the loader reads or writes is one of these or starts with `__TEAMAI_`. The
 * `TEAMAI_ENV_SH_<hash>` markers env.sh exports are reserved too, as are the
 * names Bash makes read-only, whose `export` lines Bash rejects, and the folder paths above.
 */
export const TEAM_ENV_RESERVED_NAMES = [
  'BASH_ENV', 'ENV', 'ZDOTDIR', 'HOME', 'PWD', 'PROMPT_COMMAND', 'BASH_VERSION', 'BASH_VERSINFO', 'ZSH_VERSION', 'PIPESTATUS', 'IFS',
  'SHELLOPTS', 'BASHOPTS', 'UID', 'EUID', 'PPID',
  'chpwd_functions', 'precmd_functions', 'preexec_functions', 'periodic_functions',
  'zshaddhistory_functions', 'zshexit_functions', 'zsh_directory_name_functions',
  ...FOLDER_DIR_NAMES,
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

/** Why each reserved name in `keys` is reserved, one sentence per reason; null when none is. */
export function reservedTeamEnvWarning(keys: Iterable<string>): string | null {
  const reserved = reservedTeamEnvKeys(keys);
  const isFolderDir = (key: string): boolean => FOLDER_DIR_NAMES.some((name) => name === key.toUpperCase());
  const shell = reserved.filter((key) => !isFolderDir(key));
  const folder = reserved.filter(isFolderDir);

  const sentences = [
    shell.length === 1 ? `${shell.join(', ')} is reserved for TeamAI shell routing; those team env values are ignored.` : null,
    shell.length > 1 ? `${shell.join(', ')} are reserved for TeamAI shell routing; those team env values are ignored.` : null,
    folder.length === 1 ? `${folder.join(', ')} is reserved for the folder path teamai gives a workflow step, hook, rule, agent or MCP server; those team env values are ignored.` : null,
    folder.length > 1 ? `${folder.join(', ')} are reserved for the folder path teamai gives a workflow step, hook, rule, agent or MCP server; those team env values are ignored.` : null,
  ].filter((sentence) => sentence !== null);

  return sentences.length === 0 ? null : sentences.join(' ');
}
