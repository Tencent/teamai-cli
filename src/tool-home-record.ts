import { withFileLock } from './update.js';
import { homeVariables, TOOL_ORDER, toolInstancesFor } from './tool-registry.js';
import { envInstanceHome, envToolHome, isSameDirOn, realHost, type EnvToolHome, recordedHomes, reloadToolHomes, rememberToolHome, saveToolHomes, toolHomesPath, type Host } from './tool-home.js';
import { log } from './utils/logger.js';
import { warnOnce } from './utils/warn-once.js';
import { errnoCode } from './utils/fs.js';

/** A record init or pull wrote: `dir`, or null for a cleared one, and `previous`, the home recorded before it, or the default home an instance leaves on the first move init records, which init releases. */
export type ToolHomeChange = { readonly tool: string; readonly variable: string; readonly dir: string | null; readonly previous?: string };

type RecordRule = { readonly replacesRecord: boolean; readonly needsExistingHome: boolean };

/**
 * What init records, by what moved the home. A tool's own variable is the
 * member's choice for that tool, so init records it before the home exists.
 * `XDG_CONFIG_HOME` moves every XDG tool at once, so it names a home only
 * where one exists. The Windows default is not a move, so it only fills a
 * missing record.
 */
const INIT_RECORDS: Readonly<Record<EnvToolHome['kind'], RecordRule>> = {
  own: { replacesRecord: true, needsExistingHome: false },
  xdg: { replacesRecord: true, needsExistingHome: true },
  'platform-default': { replacesRecord: false, needsExistingHome: true },
};

const PULL_RECORDS: RecordRule = { replacesRecord: false, needsExistingHome: true };

/**
 * Each shipped tool, and each instance that names a variable of its own, with where the host env moves its home and the
 * variables that move it. Init sees a refused instance too, so it can replace or clear its record; a pull sees only the
 * instances in use, since it can do neither and a record it wrote would pin the refusal in every shell.
 */
function envHomes(host: Host, by: 'init' | 'pull'): Array<{ readonly tool: string; readonly moved: EnvToolHome | null; readonly variables: readonly string[]; readonly unmoved?: string }> {
  const instances = toolInstancesFor(by === 'init' ? 'guard' : 'use').flatMap(({ name, home }) => home?.env === undefined ? [] : [{ tool: name, moved: envInstanceHome(home, host), variables: [home.env], unmoved: host.path.join(host.home, ...home.dir.split('/')) }]);

  return [...TOOL_ORDER.map((tool) => ({ tool, moved: envToolHome(tool, host), variables: homeVariables(tool) })), ...instances];
}

/**
 * The record after reading the host env (`INIT_RECORDS`, `PULL_RECORDS`), for
 * shipped tools and the instances their own variable moves alike.
 * Init also clears a record when one of the tool's variables is set but
 * blank, the explicit way to end a move, which the Windows default does not
 * override.
 */
export async function nextToolHomes(
  recorded: Readonly<Record<string, string>>,
  host: Host,
  by: 'init' | 'pull',
): Promise<{ readonly homes: Record<string, string>; readonly changes: readonly ToolHomeChange[] }> {
  const homes = { ...recorded };
  const changes: ToolHomeChange[] = [];

  for (const { tool, moved, variables, unmoved } of envHomes(host, by)) {
    const blank = by === 'init' && homes[tool] !== undefined && (moved === null || moved.kind === 'platform-default')
      && variables.find((name) => host.env[name] !== undefined && host.env[name]?.trim() === '');

    if (blank) {
      changes.push({ tool, variable: blank, dir: null, previous: homes[tool] });
      delete homes[tool];
      continue;
    }

    if (!moved) continue;
    const current = homes[tool];
    const rule = by === 'pull' ? PULL_RECORDS : INIT_RECORDS[moved.kind];

    if (current === moved.dir || (current !== undefined && !rule.replacesRecord) || (rule.needsExistingHome && !await host.exists(moved.dir))) continue;

    // The registry refuses an instance at your home directory, so a record there could never be used.
    if (unmoved !== undefined && isSameDirOn(host, moved.dir, host.home)) {
      warnOnce(`Did not record ${moved.variable} as the ${tool} home: ${moved.dir} is your home directory itself, where ${tool} would read and write every file in your home as its own. `
        + `Point ${moved.variable} at a directory of its own and re-run \`teamai init\`.`);
      continue;
    }

    homes[tool] = moved.dir;
    const previous = current ?? (by === 'init' && unmoved !== undefined && !isSameDirOn(host, unmoved, moved.dir) ? unmoved : undefined);

    changes.push(previous === undefined ? { tool, variable: moved.variable, dir: moved.dir } : { tool, variable: moved.variable, dir: moved.dir, previous });
  }

  return { homes, changes };
}

const TOOL_HOMES_LOCK_WAIT = { attempts: 20, delayMs: 100 };

/** Under the record's lock: write what `nextToolHomes` says over the record as it is now, and return what changed. */
async function writeToolHomes(file: string, by: 'init' | 'pull', host: Host): Promise<readonly ToolHomeChange[]> {
  const read = reloadToolHomes();

  if (read.kind === 'invalid') {
    log.warn(`Did not record the tool homes this shell moves: ${file} is not a tool-homes record (${read.error}). Fix or delete it.`);

    return [];
  }

  const before = read.kind === 'ok' ? read.homes : {};
  const next = await nextToolHomes(before, host, by);

  if (next.changes.length > 0) {
    for (const change of next.changes) {
      const previous = before[change.tool];

      if (previous !== undefined && previous !== change.dir) await rememberToolHome(change.tool, previous);
    }

    await saveToolHomes(next.homes);
  }

  return next.changes;
}

/** Whether `error` is the file system refusing a write, on its own or as the cause of a lock failure. */
function isWriteFailure(error: unknown): error is Error {
  return error instanceof Error && (errnoCode(error) !== undefined || isWriteFailure(error.cause));
}

/**
 * Record what `nextToolHomes` says for this machine, under the record's lock, and return what changed. A record it
 * cannot write is reported, not thrown: the caller's delivery goes on, to the homes the shell names.
 */
export async function recordToolHomes(by: 'init' | 'pull', host: Host = realHost()): Promise<readonly ToolHomeChange[]> {
  if ((await nextToolHomes(recordedHomes(host), host, by)).changes.length === 0) return [];
  const file = toolHomesPath();
  let recorded: Awaited<ReturnType<typeof withFileLock<readonly ToolHomeChange[]>>>;

  try {
    recorded = await withFileLock(`${file}.lock`, TOOL_HOMES_LOCK_WAIT, () => writeToolHomes(file, by, host));
  } catch (error) {
    if (!isWriteFailure(error)) throw error;
    log.warn(`Did not record the tool homes this shell moves: could not write ${file} (${error.message}). `
      + 'Until it is recorded, teamai syncs those tools to their default homes from a shell without their variable. '
      + `Fix the cause and ${by === 'init' ? 're-run `teamai init`' : 'run `teamai pull` again'}.`);

    return [];
  }

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
