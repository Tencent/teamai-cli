import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import { PiAdapter } from './session-adapter.js';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { facts } from './facts.js';

/** Each session platform's adapter on its store, over the facts the family declares (`facts.ts`). */
export const platforms = {
  'pi': {
    ...facts.platforms.pi,
    adapter: (storeDir): AgentAdapter => new PiAdapter('pi', storeDir, !process.env.PI_CODING_AGENT_SESSION_DIR),
  },
  'omp': {
    ...facts.platforms.omp,
    adapter: (storeDir): AgentAdapter => new PiAdapter('omp', storeDir),
  },
} as const satisfies Record<keyof typeof facts.platforms, SessionPlatformDefinition>;
