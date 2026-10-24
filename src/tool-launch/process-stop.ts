import { execFile, execFileSync, type ChildProcess } from 'node:child_process';

/** Stops a detached process group or an attached process tree, with a five-second grace period before SIGKILL. */
export function stopProcess<T>(child: ChildProcess, exit: Promise<T>, detached: boolean): (signal?: NodeJS.Signals) => Promise<T> {
  let stopping: Promise<T> | undefined;
  const descendants: { pid: number; start: string }[] = [];
  /** Whether the signal reached any process in the group or tree. */
  const signal = (name: NodeJS.Signals | 0): boolean => {
    try {
      if (detached && child.pid !== undefined) return process.kill(-child.pid, name);
      let targets = descendants;
      if ((name === 0 || name === 'SIGKILL') && descendants.length > 0) {
        let stdout = '';
        try {
          stdout = execFileSync('ps', ['-A', '-o', 'pid=,lstart='], { encoding: 'utf8' });
        } catch {
          // Without current identities, stop only the shell.
        }
        const starts = new Map(stdout.trim().split('\n').map((line) => {
          const [pid, ...start] = line.trim().split(/\s+/);
          return [Number(pid), start.join(' ')];
        }));
        // lstart has one-second resolution and the check is not atomic with kill, so this narrows the window but does not close it.
        targets = descendants.filter(({ pid, start }) => starts.get(pid) === start);
      }
      let reached = false;
      for (const { pid } of targets) {
        try { reached = process.kill(pid, name) || reached; } catch { /* Already exited. */ }
      }
      return child.kill(name) || reached;
    } catch {
      return false;
    }
  };
  const stop = async (initial: NodeJS.Signals): Promise<T> => {
    if (process.platform === 'win32' && child.pid !== undefined) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      return exit;
    }
    if (!detached && child.pid !== undefined) {
      let stdout = '';
      try {
        stdout = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8' });
      } catch {
        // ps may be unavailable in minimal environments; fall back to stopping only the shell.
      }
      const children = new Map<number, typeof descendants>();
      for (const line of stdout.trim().split('\n')) {
        const [pid, parent, ...start] = line.trim().split(/\s+/);
        if (!pid || !parent || start.length === 0) continue;
        const siblings = children.get(Number(parent)) ?? [];
        siblings.push({ pid: Number(pid), start: start.join(' ') });
        children.set(Number(parent), siblings);
      }
      // A process that daemonizes away from this snapshot's tree is not reached.
      const pending = [...children.get(child.pid) ?? []];
      while (pending.length > 0) {
        const descendant = pending.pop()!;
        descendants.push(descendant);
        pending.push(...children.get(descendant.pid) ?? []);
      }
      descendants.reverse();
    }
    signal(initial);
    let timer: NodeJS.Timeout | undefined;
    let escalated = false;
    const killed = new Promise<void>((resolve) => {
      timer = setTimeout(() => { escalated = true; signal('SIGKILL'); resolve(); }, 5000);
    });
    const result = await exit;
    // A process with its own output can ignore SIGTERM and outlive the shell. Keep SIGKILL while any captured
    // descendant or process in the detached group remains.
    // Descendants may still be exiting when the shell closes. Recheck instead
    // of waiting the whole grace period after that first successful probe.
    while (!escalated && signal(0)) {
      await Promise.race([killed, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
    }
    clearTimeout(timer);
    return result;
  };
  return (initial = 'SIGTERM') => (stopping ??= stop(initial));
}
