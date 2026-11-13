import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { facts } from './facts.js';

/** Each session platform's adapter on its store, over the facts the family declares (`facts.ts`). */
export const platforms = {
  'joycode': {
    ...facts.platforms.joycode,
    adapter: (storeDir, host) => new CodexAdapter('joycode', storeDir, host),
    adapterAs: (platform, storeDir, host) => new CodexAdapter(platform, storeDir, host),
  },
} as const satisfies Record<keyof typeof facts.platforms, SessionPlatformDefinition>;
