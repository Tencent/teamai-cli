import { by } from './deadline.js';
import type { Journal } from './journal.js';
import { ATTEMPT_ID, COMMAND_MS, handleOf, RUN_ID, type PlaceKey, type Provider } from './provider.js';
import { removeLeftScratch } from './warm.js';

// ─── What earlier runtimes left ──────────────────────────
//
//  A runtime killed while the engine created a sandbox can leave one its journal no longer records. Each open sweeps
//  this journal's sandboxes once it is accepted, and nothing waits for the sweep.
//

/**
 * How long a sweep of what earlier runs left may take before it says so on stderr. Nothing waits for it, so its bound is
 * its own: past its slowest sound run, the lists of containers and of networks, then a judge's container, filter and
 * network removed in turn, each within COMMAND_MS.
 */
const SWEEP_MS = 6 * COMMAND_MS;

/**
 * Removes what a runtime killed while the engine created a sandbox can leave: a sandbox of this journal whose attempt
 * it no longer records, because a close found nothing yet and forgot the place before the sandbox landed, and a judge's
 * filter and network with it, or such a network alone, which a runtime killed before its container left. The provider tells this journal's sandboxes by their `teamai.owner` label, or on sbx by
 * their name's prefix. A sandbox whose attempt has a record (a create in flight included, since a place is saved before
 * its create), one that names no attempt, and another journal's are left alone. A failed list or removal is one
 * warning, never the open's failure, and so is anything it throws. It starts once its open is accepted and nothing
 * waits for it: not that open, nor a cancel or a close.
 */
export async function sweep({ provider, journal, warn }: { provider: Provider; journal: Journal; warn: (line: string) => void }): Promise<void> {
  const { owned } = provider;

  if (owned === undefined) return;

  // Nothing awaits it, so a throw would end this process, and the execs it runs with it.
  const removeOrphans = async (): Promise<void> => {
    try {
      const listed = await owned();

      if (!listed.ok) {
        warn(`teamai-runtime-sandbox: warning: ${listed.failure.message}. Sandboxes an earlier run left stay until a later open.`);

        return;
      }

      const isOrphan = (key: PlaceKey): boolean => {
        if (!RUN_ID.test(key.run) || !ATTEMPT_ID.test(key.attempt)) return false;

        try {
          return journal.place(handleOf(key)) === undefined;
        } catch {
          // A record it cannot read may be this attempt's: its sandbox stays.
          return false;
        }
      };

      // An attempt's containers (its sandbox and its filter) go before its network, which is removed once. An attempt
      // with a network and no container left is released alone.
      const byAttempt = new Map<string, { key: PlaceKey; ids: string[] }>();

      for (const { id, run, attempt } of listed.sandboxes.filter(isOrphan)) {
        const handle = handleOf({ run, attempt });
        byAttempt.set(handle, { key: { run, attempt }, ids: [...(byAttempt.get(handle)?.ids ?? []), id] });
      }

      for (const { run, attempt } of (listed.released ?? []).filter(isOrphan)) {
        const handle = handleOf({ run, attempt });

        if (!byAttempt.has(handle)) byAttempt.set(handle, { key: { run, attempt }, ids: [] });
      }

      await Promise.all([...byAttempt.values()].map(async ({ key, ids }) => {
        const destroyed = await Promise.all(ids.map((id) => provider.destroy(id)));
        // A sandbox with no filter or network has nothing more to release, which succeeds.
        const removed = destroyed.find((done) => !done.ok) ?? (provider.release ? await provider.release(key) : { ok: true as const });

        if (!removed.ok) warn(`teamai-runtime-sandbox: warning: ${provider.display(key).label} was left by an earlier run, and ${removed.failure.message}`);
      }));

      await Promise.all((listed.leftWarm ?? []).map(async (id) => {
        const removed = await provider.destroy(id);

        if (!removed.ok) warn(`teamai-runtime-sandbox: warning: the scratch sandbox ${id} of a warm image was left by a runtime that stopped while it made it, and ${removed.failure.message}`);
      }));
      removeLeftScratch();
    } catch (error) {
      warn(`teamai-runtime-sandbox: warning: removing what an earlier run left failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if ((await by(Date.now() + SWEEP_MS, removeOrphans())).kind === 'late') {
    warn(`teamai-runtime-sandbox: warning: removing what an earlier run left took over ${SWEEP_MS / 1000} s; it goes on, and holds no step.`);
  }
}
