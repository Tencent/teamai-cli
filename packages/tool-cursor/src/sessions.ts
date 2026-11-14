import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import { CursorAdapter } from './session-adapter.js';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { facts } from './facts.js';

/** Each session platform's adapter on its store, over the facts the family declares (`facts.ts`). */
export const platforms = {
  'cursor': {
    ...facts.platforms.cursor,
    adapter: (storeDir, { processes }): AgentAdapter => new CursorAdapter('cursor', storeDir, processes),
    adapterAs: (platform, storeDir, { processes }): AgentAdapter => new CursorAdapter(platform, storeDir, processes),
  },
} as const satisfies Record<keyof typeof facts.platforms, SessionPlatformDefinition>;
