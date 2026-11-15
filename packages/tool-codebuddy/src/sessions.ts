import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { CodeBuddyAdapter } from './codebuddy-adapter.js';
import { CodeBuddyIdeAdapter } from './codebuddy-ide-adapter.js';
import { WorkBuddyAdapter } from './workbuddy-adapter.js';
import { facts } from './facts.js';

/** Each session platform's adapter on its store, over the facts the family declares (`facts.ts`). */
export const platforms = {
  'codebuddy': {
    ...facts.platforms.codebuddy,
    adapter: (storeDir): AgentAdapter => new CodeBuddyAdapter(storeDir),
  },
  'codebuddy-ide': {
    ...facts.platforms['codebuddy-ide'],
    adapter: (): AgentAdapter => new CodeBuddyIdeAdapter(),
  },
  'workbuddy': {
    ...facts.platforms.workbuddy,
    adapter: (storeDir, { processes }): AgentAdapter => new WorkBuddyAdapter(storeDir, processes),
  },
} as const satisfies Record<keyof typeof facts.platforms, SessionPlatformDefinition>;
