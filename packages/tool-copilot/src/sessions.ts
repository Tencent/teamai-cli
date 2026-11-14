import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import { CopilotAdapter } from './session-adapter.js';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { facts } from './facts.js';

/** Each session platform's adapter on its store, over the facts the family declares (`facts.ts`). */
export const platforms = {
  copilot: {
    ...facts.platforms.copilot,
    adapter: (storeDir): AgentAdapter => new CopilotAdapter(storeDir),
  },
} as const satisfies Record<keyof typeof facts.platforms, SessionPlatformDefinition>;
