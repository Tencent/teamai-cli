/** Remote sandboxes (Vercel): the ledger never asks a remote service; `reap` does, with the member's key. */
import type { LeftoverKind } from '../leftovers.js';

export const remoteSandboxes: LeftoverKind = {
  title: 'remote sandbox',
  onCleanup: { kind: 'keep' },
  observe() {
    return Promise.resolve([{ kind: 'not_observed', what: 'remote sandboxes (vercel)', why: 'the ledger asks no remote service; run `npm run -s verify -- reap` with the key' }]);
  },
};
