/**
 * Processes whose working directory or arguments name a path of the world, on each machine the world runs on: `ps` and
 * `lsof` on macOS, /proc on Linux (inside a container member too). Never a process's environment.
 */
import { captureOn, machinesOf } from '../target.js';
import { attributeLeftover, type LeftoverKind, type Observed } from '../leftovers.js';

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
  readonly cwd: string | undefined;
}

/** `ps -axo pid=,ppid=,command=`: one process a line, its command as ps prints it. */
export function parsePs(stdout: string): Proc[] {
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);

    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '', cwd: undefined }] : [];
  });
}

/** `lsof -a -d cwd -Fpn`: `p<pid>` then `n<path>` for each process, as each pid's working directory. */
export function parseLsofCwd(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined) cwds.set(pid, line.slice(1));
  }

  return cwds;
}

/** What a command printed on a machine of the world (`captureOn`). */
type Captured = ReturnType<typeof captureOn>;

/**
 * The processes `ps` printed on macOS (`ps`, its stdout), each with the working directory `lsof` gives it, and what
 * of them could not be looked at: an lsof that did not end with 0, on a timeout too, or wrote a note on stderr,
 * listed only part of them.
 */
export function readDarwinTable({ label, ps, lsof }: { label: string; ps: string; lsof: Captured }) {
  const cwdOf = parseLsofCwd(lsof.stdout);
  const gap = lsofGap(lsof, cwdOf.size);
  const unseen: Observed[] = gap === undefined ? [] : [{ kind: 'not_observed', what: `working directories on ${label}`, why: gap }];

  return { procs: parsePs(ps).map((proc) => ({ ...proc, cwd: cwdOf.get(proc.pid) })), unseen };
}

/** Why `lsof`, which listed `count` working directories, may have missed some; undefined when it saw them all. */
function lsofGap(lsof: Captured, count: number): string | undefined {
  if (lsof.stdout === '') return `lsof listed none (${lsof.why})`;

  if (lsof.code !== 0) return `lsof ended with ${lsof.code ?? 'no exit code'} after listing ${count} (${lsof.why}), so a process it missed may be the world's`;

  // lsof that sees everything says nothing on stderr; a note there, such as a permission one, is a partial answer.
  return lsof.why === '' ? undefined : `lsof listed ${count} but said ${lsof.why}, so a process it missed may be the world's`;
}

/** One line per process from /proc: pid, ppid, cwd and the arguments joined by spaces, tab-separated. Reads no environ. */
const PROC_SCRIPT = `for d in /proc/[0-9]*; do p=\${d#/proc/}; pp=$(sed 's/.*) //' "$d/stat" 2>/dev/null | cut -d' ' -f2); [ -n "$pp" ] || continue; c=$(readlink "$d/cwd" 2>/dev/null); a=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null); printf '%s\\t%s\\t%s\\t%s\\n' "$p" "$pp" "$c" "$a"; done`;

export function parseProcLines(stdout: string): Proc[] {
  return stdout.split('\n').flatMap((line) => {
    const [pid = '', ppid = '', cwd = '', ...command] = line.split('\t');

    return /^\d+$/.test(pid) && /^\d+$/.test(ppid) ? [{ pid: Number(pid), ppid: Number(ppid), cwd: cwd || undefined, command: command.join('\t').trim() }] : [];
  });
}

/** The absolute paths a command line names, as arguments or option values. */
export function pathsNamed(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s=:'"])(\/[^\s'"]+)/g)].flatMap((match) => match[1] ?? []);
}

/** `pid` and every parent of it in `procs`: the harness's own chain, never a leftover. */
export function lineageOf(pid: number, procs: readonly Proc[]): Set<number> {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const chain = new Set<number>();

  for (let at: number | undefined = pid; at !== undefined && at > 1 && !chain.has(at); at = byPid.get(at)?.ppid) chain.add(at);

  return chain;
}

export const processes: LeftoverKind = {
  title: 'world process',
  onCleanup: {
    kind: 'refuse',
    found: 'a process of the world still runs. Stop each one, then run cleanup again',
    unseen: 'cleanup could not look for a process of the world, so one may still run. Fix what failed, then run cleanup again',
  },
  async observe({ world, self, others }) {
    return machinesOf(world).flatMap((machine): Observed[] => {
      let procs: Proc[];
      const notes: string[] = [];
      const unobserved: Observed[] = [];

      if (machine.platform === 'darwin') {
        const ps = captureOn(world, machine.target, ['ps', '-axo', 'pid=,ppid=,command=']);

        if (ps.code !== 0) return [{ kind: 'not_observed', what: `processes on ${machine.label}`, why: `ps failed: ${ps.why}` }];
        const table = readDarwinTable({ label: machine.label, ps: ps.stdout, lsof: captureOn(world, machine.target, ['lsof', '-a', '-d', 'cwd', '-Fpn']) });
        procs = table.procs;
        unobserved.push(...table.unseen);
      } else {
        const listed = captureOn(world, machine.target, ['sh', '-c', PROC_SCRIPT]);

        if (listed.code !== 0 || listed.stdout === '') return [{ kind: 'not_observed', what: `processes on ${machine.label}`, why: `/proc could not be read: ${listed.why}` }];
        procs = parseProcLines(listed.stdout);

        // A container's table is not this machine's: say it was read, so a clean section still shows it was looked at.
        if (machine.target.kind === 'member') notes.push(`${procs.length} processes read on ${machine.label} from /proc`);
      }

      const harness = machine.target.kind === 'world' ? lineageOf(process.pid, procs) : new Set<number>();

      const findings = procs.filter((proc) => !harness.has(proc.pid)).map((proc) => ({
        what: `process ${proc.pid} on ${machine.label} (${proc.command.slice(0, 160)})`,
        attribution: attributeLeftover({ paths: [...proc.cwd === undefined ? [] : [proc.cwd], ...pathsNamed(proc.command)], journals: [], runs: [], marked: false }, self, others),
      }));

      return [{ kind: 'observed', findings: findings.filter((finding) => finding.attribution.kind !== 'unrelated'), notes }, ...unobserved];
    });
  },
};
