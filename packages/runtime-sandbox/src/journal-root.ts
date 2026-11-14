import path from 'node:path';
import { runtimeStateRoot } from '@teamai/runtime-protocol/state-root';

/**
 * Where the sandbox runtime keeps its journal for the member whose home is `home`: its id labels what the runtime makes.
 * Its own module, which loads nothing of the runtime, so a caller that only looks there pays for no more.
 */
export function sandboxJournalRoot(home: string): string {
  return path.join(runtimeStateRoot(home), 'sandbox');
}
