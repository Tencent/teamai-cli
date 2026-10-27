import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A recursive removal fails with ENOTEMPTY when something keeps writing into
// the directory while it is removed, and retries cannot outlast a writer the
// test started and never joined. The bare error named neither, so CI failures
// could not tell git's background upkeep from teamai's own detached work
// (#1413). Every rmSync and fs.promises.rm in the suite now reports what
// reappeared and which processes are still running in or on the directory.
const rmSync = fs.rmSync;
fs.rmSync = function rmSyncNamingWriter(target, options) {
  try {
    rmSync(target, options);
  } catch (error) {
    throw withWriters(error, target);
  }
};
const rm = fs.promises.rm;
fs.promises.rm = async function rmNamingWriter(target, options) {
  try {
    await rm(target, options);
  } catch (error) {
    throw withWriters(error, target);
  }
};
syncBuiltinESMExports();

const MAX_LISTED = 10;

function withWriters(error: unknown, target: fs.PathLike): unknown {
  if (error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY') {
    error.message += describeWriters(target instanceof URL ? fileURLToPath(target) : target.toString());
  }
  return error;
}

function describeWriters(dir: string): string {
  return `\nEntries that reappeared during removal:\n${indentedList(reappeared(dir))}`
    + `\nProcesses still running in or on ${dir}:\n${indentedList(processesIn(dir))}`;
}

function indentedList(entries: string[]): string {
  return entries.length > 0 ? entries.map((entry) => `  ${entry}`).join('\n') : '  none found';
}

/** The newest entries under `dir`, with how long ago each was last written. */
function reappeared(dir: string): string[] {
  const now = Date.now();
  let names: string[];
  try {
    names = fs.readdirSync(dir, { recursive: true, encoding: 'utf-8' });
  } catch (error) {
    return [`could not list ${dir}: ${String(error)}`];
  }
  const entries = names.flatMap((name) => {
    try {
      return [{ name, mtime: fs.lstatSync(path.join(dir, name)).mtimeMs }];
    } catch {
      return [];
    }
  });
  entries.sort((a, b) => b.mtime - a.mtime);
  const listed = entries.slice(0, MAX_LISTED).map(({ name, mtime }) => `${name} (written ${Math.max(0, Math.round(now - mtime))}ms ago)`);
  return entries.length > MAX_LISTED ? [...listed, `and ${entries.length - MAX_LISTED} more`] : listed;
}

/**
 * Each process whose working directory is in `dir`, or whose command line or
 * environment names it, as `<pid> <command line>`. The environment is matched,
 * never printed: CI logs must not carry it.
 */
function processesIn(dir: string): string[] {
  let resolved = dir;
  try {
    resolved = fs.realpathSync(dir);
  } catch {
    // Gone already: match the spelling the caller passed.
  }
  const isInside = (candidate: string) => [dir, resolved].some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
  const names = (text: string) => text.includes(dir) || text.includes(resolved);
  try {
    return runningProcesses()
      .filter(({ pid, cwd, args, env }) => pid !== process.pid && ((cwd !== undefined && isInside(cwd)) || names(args) || names(env)))
      .map(({ pid, args }) => `${pid} ${args}`);
  } catch (error) {
    return [`could not list processes: ${String(error)}`];
  }
}

function runningProcesses(): Array<{ pid: number; cwd: string | undefined; args: string; env: string }> {
  if (process.platform === 'linux') {
    return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      try {
        const args = fs.readFileSync(`/proc/${name}/cmdline`, 'utf-8').split('\0').join(' ').trim();
        let cwd: string | undefined;
        let env = '';
        try {
          cwd = fs.readlinkSync(`/proc/${name}/cwd`);
          env = fs.readFileSync(`/proc/${name}/environ`, 'utf-8');
        } catch {
          // Another user's process, or one that just exited.
        }
        return [{ pid: Number(name), cwd, args, env }];
      } catch {
        return [];
      }
    });
  }
  // macOS and the other Unixes: ps for command lines, lsof for working
  // directories. macOS keeps other processes' environments from ps, so a
  // writer that reaches the directory only through its environment (teamai's
  // detached children find ~/.teamai through HOME) is named on Linux alone.
  // lsof exits non-zero when it cannot read some process, with the rest still
  // listed; without lsof, command lines still name a writer passed the path.
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const field of (spawnSync('lsof', ['-d', 'cwd', '-F', 'pn'], { encoding: 'utf-8' }).stdout ?? '').split('\n')) {
    if (field.startsWith('p')) pid = Number(field.slice(1));
    else if (field.startsWith('n')) cwds.set(pid, field.slice(1));
  }
  return execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf-8' }).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), cwd: cwds.get(Number(match[1])), args: match[2], env: '' }] : [];
  });
}
