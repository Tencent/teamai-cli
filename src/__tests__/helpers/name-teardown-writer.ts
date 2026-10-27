import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A recursive rmSync fails with ENOTEMPTY when something keeps writing into
// the directory while it is removed, and retries cannot outlast a writer the
// test started and never joined. The bare error named neither, so CI failures
// could not tell git's background upkeep from teamai's own detached work
// (#1413). Every teardown in the suite now reports what reappeared and which
// processes are still running in or on the directory.
const rmSync = fs.rmSync;
fs.rmSync = function rmSyncNamingWriter(target, options) {
  try {
    rmSync(target, options);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY') {
      error.message += describeWriters(target instanceof URL ? fileURLToPath(target) : target.toString());
    }
    throw error;
  }
};
syncBuiltinESMExports();

const LISTED = 10;

function describeWriters(dir: string): string {
  return `\nEntries that reappeared during removal:\n${lines(reappeared(dir))}`
    + `\nProcesses still running in or on ${dir}:\n${lines(processesIn(dir))}`;
}

function lines(entries: string[]): string {
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
  const listed = entries.slice(0, LISTED).map(({ name, mtime }) => `${name} (written ${Math.max(0, Math.round(now - mtime))}ms ago)`);
  return entries.length > LISTED ? [...listed, `and ${entries.length - LISTED} more`] : listed;
}

/** Each process whose working directory is in `dir` or whose command line names it, as `<pid> <command line>`. */
function processesIn(dir: string): string[] {
  let resolved = dir;
  try {
    resolved = fs.realpathSync(dir);
  } catch {
    // Gone already: match the spelling the caller passed.
  }
  const inDir = (candidate: string) => [dir, resolved].some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
  try {
    return runningProcesses()
      .filter(({ pid, cwd, args }) => pid !== process.pid && ((cwd !== undefined && inDir(cwd)) || args.includes(dir) || args.includes(resolved)))
      .map(({ pid, args }) => `${pid} ${args}`);
  } catch (error) {
    return [`could not list processes: ${String(error)}`];
  }
}

function runningProcesses(): Array<{ pid: number; cwd: string | undefined; args: string }> {
  if (process.platform === 'linux') {
    return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      try {
        const args = fs.readFileSync(`/proc/${name}/cmdline`, 'utf-8').split('\0').join(' ').trim();
        let cwd: string | undefined;
        try {
          cwd = fs.readlinkSync(`/proc/${name}/cwd`);
        } catch {
          // Another user's process, or one that just exited.
        }
        return [{ pid: Number(name), cwd, args }];
      } catch {
        return [];
      }
    });
  }
  // macOS and the other Unixes: ps for command lines, lsof for working directories.
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
    return match ? [{ pid: Number(match[1]), cwd: cwds.get(Number(match[1])), args: match[2] }] : [];
  });
}
