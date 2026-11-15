import { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { facts } from './facts.js';

/** A Claude build's platform `platform`: its facts, and Claude Code transcripts read on its store. */
function claudeBuild<const Platform extends keyof typeof facts.platforms>(platform: Platform) {
  return {
    ...facts.platforms[platform],
    adapter: (storeDir: string) => new ClaudeCodeAdapter(platform, storeDir),
    adapterAs: (as: string, storeDir: string) => new ClaudeCodeAdapter(as, storeDir),
  } as const satisfies SessionPlatformDefinition;
}

/** Each session platform's adapter on its store, over the facts the family declares (`facts.ts`). */
export const platforms = {
  'claude-code': claudeBuild('claude-code'),
  'claude-internal': claudeBuild('claude-internal'),
  'tclaude': claudeBuild('tclaude'),
} as const satisfies Record<keyof typeof facts.platforms, SessionPlatformDefinition>;
