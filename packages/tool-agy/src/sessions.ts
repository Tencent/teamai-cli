import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import { AgyAdapter, agyStoreRoots } from './session-adapter.js';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { facts } from './facts.js';

/** Each session platform's adapter on its store, over the facts the family declares (`facts.ts`). */
export const platforms = {
  'agy': {
    ...facts.platforms.agy,
    adapter: (storeDir, { processes }): AgentAdapter => new AgyAdapter(agyStoreRoots(storeDir), processes),
  },
} as const satisfies Record<keyof typeof facts.platforms, SessionPlatformDefinition>;
