import { withFileLock } from './update.js';
import { homeVariables, isToolId, TOOLS } from './tools.js';
import { envToolHome, realHost, type EnvToolHome, recordedHomes, reloadToolHomes, saveToolHomes, toolHomesPath, type Host } from './tool-home.js';
import type { ToolId } from './types.js';
import { log } from './utils/logger.js';

/** A change to the record: `dir` null when it was cleared. */
export type ToolHomeChange = { readonly tool: ToolId; readonly variable: string; readonly dir: string | null };

type RecordRule = { readonly replacesRecord: boolean; readonly needsExistingHome: boolean };

/**
 * What init records, by what moved the home; null records nothing. A tool's
 * own variable is the member's choice for that tool, so init records it
 * before the home exists. `XDG_CONFIG_HOME` moves every XDG tool at once, so
 * it names a home only where one exists. The Windows default is not a move,
 * so it only fills a missing record. A home from the tool's own state file
 * changes outside any shell, so recording it would pin a home the tool has
 * left.
 */
const INIT_RECORDS: Readonly<Record<EnvToolHome['kind'], RecordRule | null>> = {
  own: { replacesRecord: true, needsExistingHome: false },
  xdg: { replacesRecord: true, needsExistingHome: true },
  'platform-default': { replacesRecord: false, needsExistingHome: true },
  'tool-state': null,
};

const PULL_FILLS: RecordRule = { replacesRecord: false, needsExistingHome: true };
const PULL_RECORDS: Readonly<Record<EnvToolHome['kind'], RecordRule | null>> = {
  own: PULL_FILLS,
  xdg: PULL_FILLS,
  'platform-default': PULL_FILLS,
  'tool-state': null,
};

/**
 * The record after reading the host env (`INIT_RECORDS`, `PULL_RECORDS`).
 * Init also clears a record when one of the tool's variables is set but
 * blank, the explicit way to end a move, which a home that would not replace
 * the record does not override.
 */
export async function nextToolHomes(
  recorded: Readonly<Record<string, string>>,
  host: Host,
  by: 'init' | 'pull',
): Promise<{ readonly homes: Record<string, string>; readonly changes: readonly ToolHomeChange[] }> {
  const homes: Record<string, string> = { ...recorded };
  const changes: ToolHomeChange[] = [];
  for (const tool of Object.keys(TOOLS).filter(isToolId)) {
    const moved = envToolHome(tool, host);
    const blank = by === 'init' && homes[tool] !== undefined && (moved === null || INIT_RECORDS[moved.kind]?.replacesRecord !== true)
      && homeVariables(tool).find((name) => host.env[name] !== undefined && host.env[name]?.trim() === '');
    if (blank) {
      delete homes[tool];
      changes.push({ tool, variable: blank, dir: null });
      continue;
    }
    if (!moved) continue;
    const current = homes[tool];
    const rule = (by === 'pull' ? PULL_RECORDS : INIT_RECORDS)[moved.kind];
    if (rule === null || current === moved.dir || (current !== undefined && !rule.replacesRecord) || (rule.needsExistingHome && !await host.exists(moved.dir))) continue;
    homes[tool] = moved.dir;
    changes.push({ tool, variable: moved.variable, dir: moved.dir });
  }
  return { homes, changes };
}

const TOOL_HOMES_LOCK_WAIT = { attempts: 20, delayMs: 100 };

/** Record what `nextToolHomes` says for this machine, under the record's lock, and return what changed. */
export async function recordToolHomes(by: 'init' | 'pull', host: Host = realHost()): Promise<readonly ToolHomeChange[]> {
  if ((await nextToolHomes(recordedHomes(host), host, by)).changes.length === 0) return [];
  const file = toolHomesPath();
  const recorded = await withFileLock(`${file}.lock`, TOOL_HOMES_LOCK_WAIT, async () => {
    const read = reloadToolHomes();
    if (read.kind === 'invalid') {
      log.warn(`Did not record the tool homes this shell moves: ${file} is not a tool-homes record (${read.error}). Fix or delete it.`);
      return [];
    }
    const next = await nextToolHomes(read.kind === 'ok' ? read.homes : {}, host, by);
    if (next.changes.length > 0) await saveToolHomes(next.homes);
    return next.changes;
  });
  if (recorded.held) return recorded.value;
  log.warn(`Did not record the tool homes this shell moves: another teamai process holds ${file}.lock. ${by === 'init' ? 'Re-run `teamai init`' : 'The next pull records them'}.`);
  return [];
}

/** What a member reads when a pull or init records or clears a tool home. */
export function describeToolHomeChange({ tool, variable, dir }: ToolHomeChange): string {
  return dir === null
    ? `Cleared the recorded ${tool} home (${variable} is blank); teamai syncs ${tool} to its default home again`
    : `Recorded ${variable} as the ${tool} home: ${dir}. teamai syncs ${tool} there from any shell until \`teamai init\` records another`;
}
