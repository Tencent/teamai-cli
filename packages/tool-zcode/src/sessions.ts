import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { facts } from './facts.js';
import { ZCodeAdapter } from './session-adapter.js';

/** ZCode's adapter reads metadata from its SQLite snapshot and transcripts from rollout JSONL. */
export const platforms = {
  zcode: {
    ...facts.platforms.zcode,
    adapter: (storeDir, { processes }): AgentAdapter => new ZCodeAdapter(storeDir, processes),
  },
} as const satisfies Record<keyof typeof facts.platforms, SessionPlatformDefinition>;
