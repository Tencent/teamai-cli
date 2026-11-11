/**
 * Marker file names reserved for resources kept as folders (#1791, #1787).
 *
 * A directory under a type's directory that holds that type's marker, at any
 * depth, is a folder resource, never a namespace: `rules/api-style/RULE.md`
 * is the rule `api-style`, not `api-style/RULE`. Every type here is read; a
 * teamai before a type was read skipped its folders whole.
 *
 * The marker is matched against the names `readdir` returns, so a lower-case
 * `rule.md` stays an ordinary rule on a file system that ignores case.
 */
import fs from 'node:fs/promises';
import { errnoCode } from './utils/fs.js';
import { log } from './utils/logger.js';

type MarkedType = 'workflows' | 'hooks' | 'rules' | 'mcp' | 'benchmarks' | 'skills' | 'scorers' | 'agents';

/** Each type keeps its resources in the team repo directory of the same name. */
export const FOLDER_MARKERS = {
  workflows: { marker: 'WORKFLOW.yaml' },
  hooks: { marker: 'HOOK.yaml' },
  rules: { marker: 'RULE.md' },
  mcp: { marker: 'MCP.yaml' },
  benchmarks: { marker: 'SUITE.yaml' },
  skills: { marker: 'SKILL.md' },
  scorers: { marker: 'SCORER.md' },
  agents: { marker: 'AGENT.md' },
} as const satisfies Readonly<Record<MarkedType, { readonly marker: string }>>;

/**
 * Whether `dir` holds `marker`, by the names `readdir` returns: on a file
 * system that ignores case, `MCP.yaml` would otherwise answer for `mcp.yaml`.
 */
export async function holdsMarker(dir: string, marker: string | null): Promise<boolean> {
  if (marker === null) return false;

  try {
    return (await fs.readdir(dir)).includes(marker);
  } catch (error) {
    // Read as empty, as the scans that call this read such a directory: an
    // unreadable one fails no pull here that it did not fail before.
    const code = errnoCode(error);

    if (code !== 'ENOENT' && code !== 'ENOTDIR') log.debug(`Could not read ${dir} for folder markers: ${error instanceof Error ? error.message : String(error)}`);

    return false;
  }
}
