import type { StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import type { RuntimeEntryIdentity } from '../../workflow/runtimes/entry-identity.js';

/** The identity of `runtime` as the only entry of its name in a test's driver definition. */
export function soleEntry(runtime: Pick<StepRuntime, 'name'>): RuntimeEntryIdentity {
  return { name: runtime.name, digest: runtime.name, resource: runtime.name, sameName: { at: 1, of: 1 } };
}
