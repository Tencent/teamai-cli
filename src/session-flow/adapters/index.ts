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
import type { SESSION_PLATFORM_FACTS } from './platform-facts.js';
import {
  getClaudeCodeProjectsDir,
  getClaudeInternalProjectsDir,
  getTClaudeProjectsDir,
  getCodexSessionsDir,
  getCodexInternalSessionsDir,
  getTCodexSessionsDir,
  getCursorProjectsDir,
} from '../fs.js';

/** Builds a platform's adapter. Claude Code, Codex and Cursor keep their stores under the member's recorded `toolRoots`. */
export type AdapterFactory = (toolRoots?: LocalConfig['toolRoots']) => AgentAdapter;

export const ADAPTER_REGISTRY: Record<string, AdapterFactory> = {
  // Base platforms
  'claude-code': (toolRoots) => new ClaudeCodeAdapter('claude-code', getClaudeCodeProjectsDir(toolRoots)),
  codex: (toolRoots) => new CodexAdapter('codex', getCodexSessionsDir(toolRoots)),
  // CodeBuddy has two independent stores, split into two platforms:
  //   codebuddy     = CLI (~/.codebuddy/projects/...)
  //   codebuddy-ide = IDE GUI (CodeBuddyExtension/.../history)
  codebuddy: () => new CodeBuddyAdapter(),
  'codebuddy-ide': () => new CodeBuddyIdeAdapter(),
  workbuddy: () => new WorkBuddyAdapter(),
  cursor: (toolRoots) => new CursorAdapter('cursor', getCursorProjectsDir(toolRoots)),
  opencode: () => new OpencodeAdapter(),
  // TeamAI variants (different path prefixes, identical format)
  'claude-internal': () => new ClaudeCodeAdapter('claude-internal', getClaudeInternalProjectsDir()),
  tclaude: () => new ClaudeCodeAdapter('tclaude', getTClaudeProjectsDir()),
  'codex-internal': () => new CodexAdapter('codex-internal', getCodexInternalSessionsDir()),
  tcodex: () => new CodexAdapter('tcodex', getTCodexSessionsDir()),
} satisfies Record<keyof typeof SESSION_PLATFORM_FACTS, AdapterFactory>;

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
