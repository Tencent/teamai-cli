import { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { facts } from './facts.js';

/** Each session platform's adapter on its store, over the facts the family declares (`facts.ts`). */
export const platforms = {
  'qoder': {
    ...facts.platforms.qoder,
    adapter: (storeDir) => new ClaudeCodeAdapter('qoder', storeDir),
    adapterAs: (platform, storeDir) => new ClaudeCodeAdapter(platform, storeDir),
  },
  'qoder-cn': {
    ...facts.platforms['qoder-cn'],
    adapter: (storeDir) => new ClaudeCodeAdapter('qoder-cn', storeDir),
    adapterAs: (platform, storeDir) => new ClaudeCodeAdapter(platform, storeDir),
  },
} as const satisfies Record<keyof typeof facts.platforms, SessionPlatformDefinition>;
