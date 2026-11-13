import { describe, expect, it } from 'vitest';
import type { ToolClosed, ToolLauncher } from '../run-step-launch.js';

/** What a launch saw of one process: the order of its events, and the chunks `onStdout` got. */
interface Watched {
  closed: ToolClosed;
  started: boolean;
  events: string[];
  chunks: string[];
  /** Stops the process again, once it closed. */
  stop: () => Promise<void>;
}

/** Starts `script` under node through `start`, as a launch does, and watches every call the adapter makes back. */
async function watch(start: ToolLauncher, { executable = process.execPath, script, cwd, onStarted }: { executable?: string; script: string; cwd: string; onStarted?: (stop: () => Promise<void>) => void }): Promise<Watched> {
  const events: string[] = [];
  const chunks: string[] = [];
  let returned = false;
  let stopNow: () => Promise<void> = async () => {};

  const launched = start({
    executable, args: ['-e', script], cwd, env: { ...process.env }, interactive: false,
    onStart: () => {
      events.push(returned ? 'start' : 'start before return');
      onStarted?.(stopNow);
    },
    onStdout: (text) => {
      events.push(returned ? 'stdout' : 'stdout before return');
      chunks.push(text);
    },
  });

  returned = true;
  stopNow = () => launched.stop();

  return { closed: await launched.closed, started: launched.started(), events, chunks, stop: () => launched.stop() };
}

/**
 * The contract every `ToolLauncher` adapter keeps, which `runStepLaunch` relies on: it calls `onStart` once, when the
 * process started and before any of its output; it never calls `onStdout` before `start` returns, so the launch holds
 * the process before a limit stops it; `closed` carries the exit status and the stdout `onStdout` got, in order; `stop`
 * ends a process that runs until stopped; every `stop` settles and never rejects, whenever it is called; and a process
 * that cannot start still closes, with no success.
 * `adapter` builds the launcher under test in `cwd`, a directory of its own for each case.
 */
export function toolLauncherConformance(name: string, adapter: () => Promise<{ start: ToolLauncher; cwd: string }>): void {
  describe(`the ToolLauncher port: ${name}`, () => {
    it('starts once before any output, gives its stdout in order and its exit status, and never calls back before it returns', async () => {
      const { start, cwd } = await adapter();
      const watched = await watch(start, { cwd, script: 'process.stdout.write("one\\n"); setTimeout(() => { process.stdout.write("two\\n"); process.exitCode = 3; }, 50);' });

      expect(watched.events[0]).toBe('start');
      expect(watched.events.filter((event) => event.startsWith('start'))).toEqual(['start']);
      expect(watched.events.filter((event) => event.endsWith('before return'))).toEqual([]);
      expect(watched.chunks.join('')).toBe('one\ntwo\n');
      expect(watched.closed).toMatchObject({ exitCode: 3, stdout: 'one\ntwo\n' });
      expect(watched.started).toBe(true);
    }, 30_000);

    it('ends a process that runs until stopped', async () => {
      const { start, cwd } = await adapter();
      const watched = await watch(start, { cwd, script: 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);', onStarted: (stop) => { setTimeout(() => { void stop(); }, 200); } });

      expect(watched.started).toBe(true);
      expect('failure' in watched.closed || watched.closed.exitCode !== 0, `closed as ${JSON.stringify(watched.closed)}`).toBe(true);
    }, 30_000);

    it('closes a process that cannot start, with no success, and stops it after without rejecting', async () => {
      const { start, cwd } = await adapter();
      const watched = await watch(start, { cwd, executable: '/nonexistent/teamai-no-such-tool', script: '' });

      expect('failure' in watched.closed || watched.closed.exitCode !== 0 || watched.closed.error !== undefined, `closed as ${JSON.stringify(watched.closed)}`).toBe(true);
      await expect(watched.stop()).resolves.toBeUndefined();
    }, 30_000);

    it('settles a stop sent before its process started, and one sent once it ended, without rejecting', async () => {
      const { start, cwd } = await adapter();
      // A stop this early may keep the process from ever running, so it ends on its own either way.
      const launched = start({ executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 100);'], cwd, env: { ...process.env }, interactive: false, onStart: () => {}, onStdout: () => {} });
      const stops = [launched.stop()];

      await launched.closed;
      stops.push(launched.stop());

      expect((await Promise.allSettled(stops)).map((stop) => stop.status)).toEqual(['fulfilled', 'fulfilled']);
    }, 30_000);

    it('settles two stops sent at once while its process runs, and one sent once it ended, without rejecting', async () => {
      const { start, cwd } = await adapter();
      const stops: Array<Promise<void>> = [];

      const launched = start({
        executable: process.execPath, args: ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'], cwd, env: { ...process.env }, interactive: false,
        onStart: () => {},
        onStdout: () => { if (stops.length === 0) stops.push(launched.stop(), launched.stop()); },
      });

      await launched.closed;
      stops.push(launched.stop());

      expect(stops, 'two stops while it ran, then one after its end').toHaveLength(3);
      expect((await Promise.allSettled(stops)).map((stop) => stop.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    }, 30_000);
  });
}
