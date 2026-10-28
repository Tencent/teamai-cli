/**
 * adapters/index.ts — Adapter registration.
 *
 * Register every platform adapter in ADAPTER_REGISTRY for the migration engine.
 */

import type { LocalConfig } from '../../types.js';
import type { AgentAdapter } from './base.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { CodeBuddyAdapter } from './codebuddy.js';
import { CodeBuddyIdeAdapter } from './codebuddy-ide.js';
import { WorkBuddyAdapter } from './workbuddy.js';
import { CursorAdapter } from './cursor.js';
import { OpencodeAdapter } from './opencode.js';
import type { SessionPlatform } from './platform-facts.js';
import { sessionStoreDir } from '../../locate.js';

/** Builds a platform's adapter on its store, which follows the member's recorded `toolRoots` (`sessionStoreDir`). */
export type AdapterFactory = (toolRoots?: LocalConfig['toolRoots']) => AgentAdapter;

export const ADAPTER_REGISTRY: Record<string, AdapterFactory> = {
  // Base platforms
  'claude-code': (toolRoots) => new ClaudeCodeAdapter('claude-code', sessionStoreDir('claude-code', toolRoots)),
  codex: (toolRoots) => new CodexAdapter('codex', sessionStoreDir('codex', toolRoots)),
  // CodeBuddy has two independent stores, split into two platforms:
  //   codebuddy     = CLI (<CodeBuddy home>/projects/...)
  //   codebuddy-ide = IDE GUI (CodeBuddyExtension/.../history)
  codebuddy: (toolRoots) => new CodeBuddyAdapter(sessionStoreDir('codebuddy', toolRoots)),
  'codebuddy-ide': () => new CodeBuddyIdeAdapter(),
  workbuddy: (toolRoots) => new WorkBuddyAdapter(sessionStoreDir('workbuddy', toolRoots)),
  cursor: (toolRoots) => new CursorAdapter('cursor', sessionStoreDir('cursor', toolRoots)),
  opencode: (toolRoots) => new OpencodeAdapter(sessionStoreDir('opencode', toolRoots)),
  // TeamAI variants (different path prefixes, identical format)
  'claude-internal': (toolRoots) => new ClaudeCodeAdapter('claude-internal', sessionStoreDir('claude-internal', toolRoots)),
  tclaude: (toolRoots) => new ClaudeCodeAdapter('tclaude', sessionStoreDir('tclaude', toolRoots)),
  'codex-internal': (toolRoots) => new CodexAdapter('codex-internal', sessionStoreDir('codex-internal', toolRoots)),
  tcodex: (toolRoots) => new CodexAdapter('tcodex', sessionStoreDir('tcodex', toolRoots)),
} satisfies Record<SessionPlatform, AdapterFactory>;

export function getAdapter(platform: string, toolRoots?: LocalConfig['toolRoots']): AgentAdapter {
  const factory = ADAPTER_REGISTRY[platform];
  if (!factory) {
    throw new Error(`Unsupported platform: ${platform}. Registered: ${Object.keys(ADAPTER_REGISTRY).join(', ')}`);
  }
  return factory(toolRoots);
}

export function listAvailablePlatforms(): string[] {
  return Object.keys(ADAPTER_REGISTRY);
}

export function listInstalledPlatforms(toolRoots?: LocalConfig['toolRoots']): string[] {
  const installed: string[] = [];
  for (const [platform, factory] of Object.entries(ADAPTER_REGISTRY)) {
    try {
      const adapter = factory(toolRoots);
      if (adapter.isReady()) installed.push(platform);
    } catch {
      // skip
    }
  }
  return installed;
}

export { AgentAdapter, type SessionMeta } from './base.js';
export { ClaudeCodeAdapter } from './claude-code.js';
export { CodexAdapter } from './codex.js';
export { CodeBuddyAdapter } from './codebuddy.js';
export { CodeBuddyIdeAdapter } from './codebuddy-ide.js';
export { WorkBuddyAdapter } from './workbuddy.js';
export { CursorAdapter } from './cursor.js';
export { OpencodeAdapter } from './opencode.js';
