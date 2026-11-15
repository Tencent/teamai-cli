import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { facts } from './facts.js';

/** Each session platform's adapter on its store, over the facts the family declares (`facts.ts`). */
export const platforms = {
  'codex': {
    ...facts.platforms.codex,
    adapter: (storeDir, host) => new CodexAdapter('codex', storeDir, host),
    adapterAs: (platform, storeDir, host) => new CodexAdapter(platform, storeDir, host),
  },
  'codex-internal': {
    ...facts.platforms['codex-internal'],
    adapter: (storeDir, host) => new CodexAdapter('codex-internal', storeDir, host),
    adapterAs: (platform, storeDir, host) => new CodexAdapter(platform, storeDir, host),
  },
  'tcodex': {
    ...facts.platforms.tcodex,
    adapter: (storeDir, host) => new CodexAdapter('tcodex', storeDir, host),
    adapterAs: (platform, storeDir, host) => new CodexAdapter(platform, storeDir, host),
  },
} as const satisfies Record<keyof typeof facts.platforms, SessionPlatformDefinition>;
