import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import { OpencodeAdapter } from './session-adapter.js';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { facts } from './facts.js';

/** Each session platform's adapter on its store, over the facts the family declares (`facts.ts`). */
export const platforms = {
  'opencode': {
    ...facts.platforms.opencode,
    adapter: (storeDir, { processes }): AgentAdapter => new OpencodeAdapter(storeDir, processes),
    adapterAs: (platform, storeDir, { processes }): AgentAdapter => new OpencodeAdapter(storeDir, processes, platform),
  },
} as const satisfies Record<keyof typeof facts.platforms, SessionPlatformDefinition>;
