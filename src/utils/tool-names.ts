// -*- coding: utf-8 -*-
/**
 * Normalize IDE-style tool names (CodeBuddy Craft Agent) to CLI-style names.
 *
 * CodeBuddy IDE passes tool names like `execute_command`, `search_content` etc.
 * while teamai hooks expect CLI-style names like `Bash`, `Grep`.
 */

const IDE_TO_CLI: Record<string, string> = {
  execute_command: 'Bash',
  search_content: 'Grep',
  write_to_file: 'Write',
  replace_in_file: 'Edit',
  list_dir: 'Glob',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  read_file: 'Read',
  task: 'Task',
};

export function normalizeToolName(name: string): string {
  return IDE_TO_CLI[name] ?? name;
}
