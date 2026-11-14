import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import { HermesAdapter } from './session-adapter.js';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { facts } from './facts.js';

/** Each session platform's adapter on its store, over the facts the family declares (`facts.ts`). */
export const platforms = {
  hermes: {
    ...facts.platforms.hermes,
    adapter: (storeDir, { processes }): AgentAdapter => new HermesAdapter(storeDir, processes),
  },
} as const satisfies Record<keyof typeof facts.platforms, SessionPlatformDefinition>;
