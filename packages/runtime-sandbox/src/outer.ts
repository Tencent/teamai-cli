import path from 'node:path';
import type { RuntimeFailure } from '@teamai/runtime-protocol';
import { listen, removeLeftSocket, type Answering, type AttemptSocket } from './attempt-socket.js';
import type { Journal } from './journal.js';
import { inSandbox } from './loopback.js';
import { sandboxOf } from './provider.js';
import { heldProbe, LAUNCHABLE } from './providers/cli.js';
import { isWithin, realOf } from './providers/native.js';
import type { Ready } from './runtime.js';

// ─── The sandbox as an outer ─────────────────────────────
//
//  A place whose tool an app's runtime launches through teamai's wrapper serves its attempt socket (attempt-socket.ts):
//  the wrapper asks there how to start the tool in the attempt's sandbox, and gets the step's credentials, held in this
//  process's memory only.
//

/**
 * The attempt sockets this runtime process serves, each answered with what `readyOf` gives for its place: what the last
 * `init` settled, on the provider the place was opened with.
 */
export function attemptSockets({ journal, readyOf }: { journal: Journal; readyOf: (place: string) => Ready }) {
  /**
   * The attempt sockets this process serves, by place, each with the step's credentials its grants carry and the names
   * they go without: those of the place's open, or of teamai's reattach, in memory only; undefined in a runtime that
   * restarted until a reattach brings them.
   */
  const sockets = new Map<string, { socket: AttemptSocket; credentials: Record<string, string> | undefined; unset: string[] }>();

  /**
   * Answers a wrapper's ask on `place`'s socket: how to start the tool it was called as in the attempt's sandbox, with
   * the step's credentials and the tool home variable at the attempt's tool home, or why not.
   */
  const answerOn = (place: string): Answering => async ({ tool, cwd }) => {
    const { provider, can, host, instances } = readyOf(place);
    const served = sockets.get(place);
    const credentials = served?.credentials;
    const unset = served?.unset ?? [];
    const record = journal.place(place);

    if (record?.outer === undefined || provider.client === undefined) return { ok: false, failure: { code: 'runtime_gone', message: `No sandbox is open for this attempt any more (${place}).` } };

    if (credentials === undefined) {
      return { ok: false, failure: { code: 'credentials_pending', message: 'The sandbox runtime restarted and has not got the step\'s credentials back yet: teamai sends them again when it reattaches the attempt. The step\'s app starts the tool again once it has.' } };
    }

    const worktree = realOf(record.outer.worktree);

    if (!isWithin(realOf(cwd), worktree)) {
      return { ok: false, failure: { code: 'isolation_unproven', message: `${cwd} is not in this attempt's worktree ${record.outer.worktree}, so its sandbox runs nothing for it.` } };
    }

    // The sandbox mounts the worktree at the path teamai named, which a symlink may lead to (/tmp on macOS).
    const at = path.join(record.outer.worktree, path.relative(worktree, realOf(cwd)));

    const instance = instances.get(tool);
    const base = instance?.tool ?? tool;
    const command = instance?.command ?? base;

    if (instance === undefined && !LAUNCHABLE.some((launchable) => launchable === tool)) {
      return { ok: false, failure: { code: 'tool_unsupported', message: `This sandbox runs ${LAUNCHABLE.join(', ')} and the instances teamai named at init, and not ${tool}.` } };
    }

    if (!(can.tools ?? []).includes(base)) {
      return { ok: false, failure: { code: 'tool_unsupported', message: `This sandbox does not offer ${base}: it cannot sign ${base} in there, or does not hold it. teamai said why when the run started.` } };
    }

    const found = await sandboxOf(record, provider);

    if (!found.ok) return found;

    if (found.id === undefined) return { ok: false, failure: { code: 'sandbox_failed', message: `The sandbox of attempt ${record.attempt} is not made yet, so it runs nothing for the tool.` } };
    const { id } = found;
    let held = '';

    const probed = await provider.exec(id, { argv: ['/bin/sh', ...heldProbe([command])], env: {}, unset: [], cwd: record.outer.worktree }, (stream, data) => {
      if (stream === 'stdout') held += data;
    });

    if (probed.kind === 'failed') return { ok: false, failure: probed.failure };

    if (!held.split('\n').includes(command)) {
      const { fields = {} } = provider.display(record);
      // A warm image is made from the base, so the base is where the command is to be added.
      const image = fields.base ?? fields.image;
      const where = image !== undefined ? `image ${image}` : fields.agent !== undefined ? `template ${fields.agent}` : provider.display(record).label;

      return { ok: false, failure: { code: 'tool_unsupported', message: `${command} is not installed in this sandbox (${where}). Add it to the image or template the sandbox starts from, or run the step with --driver local.` } };
    }

    // A credential the prompt goes without is not set, as an exec withholds it.
    const scoped = inSandbox(Object.fromEntries(Object.entries(credentials).filter(([name]) => !unset.includes(name))), host);
    const client = provider.client(id, { argv: [command], env: { ...scoped, ...record.outer.toolHome }, unset, cwd: at });

    return client.ok ? { ok: true, grant: { argv: client.argv, cwd: at, env: client.env, ...(client.signal && { signal: client.signal }) } } : client;
  };

  /**
   * Serves `place`'s socket at `socketPath` in this process, with `credentials` (undefined: not given yet) less the
   * names in `unset`, or gives it both when it serves it already.
   */
  const serveSocket = async ({ place, socketPath, credentials, unset }: { place: string; socketPath: string; credentials: Record<string, string> | undefined; unset: string[] }): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const served = sockets.get(place);

    if (served !== undefined) {
      if (credentials !== undefined) Object.assign(served, { credentials, unset });

      return { ok: true };
    }

    const listened = await listen(socketPath, answerOn(place));

    if (!listened.ok) return listened;
    sockets.set(place, { socket: listened.socket, credentials, unset });

    return { ok: true };
  };

  /**
   * Stops serving `place`'s socket and removes it, once the place is forgotten; or, when this process does not serve it,
   * removes the folder of `socketPath`, the one the place's record names, that a runtime which stopped left.
   */
  const unserveSocket = async (place: string, socketPath: string | undefined): Promise<void> => {
    const served = sockets.get(place);
    sockets.delete(place);

    if (served !== undefined) await served.socket.close();
    else if (socketPath !== undefined) await removeLeftSocket(socketPath);
  };

  return { serve: serveSocket, unserve: unserveSocket };
}
