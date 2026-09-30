/**
 * adapters/index.ts — 适配器注册。
 *
 * 将所有平台适配器注册到 ADAPTER_REGISTRY，供迁移引擎使用。
 */

import type { AgentAdapter } from './base.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { CodeBuddyAdapter } from './codebuddy.js';
import { CodeBuddyIdeAdapter } from './codebuddy-ide.js';
import { WorkBuddyAdapter } from './workbuddy.js';
import { CursorAdapter } from './cursor.js';
import {
  getClaudeCodeProjectsDir,
  getClaudeInternalProjectsDir,
  getTClaudeProjectsDir,
  getCodexSessionsDir,
  getCodexInternalSessionsDir,
  getTCodexSessionsDir,
} from '../fs.js';

export type AdapterFactory = () => AgentAdapter;

export const ADAPTER_REGISTRY: Record<string, AdapterFactory> = {
  // 基础平台
  'claude-code': () => new ClaudeCodeAdapter('claude-code', getClaudeCodeProjectsDir()),
  codex: () => new CodexAdapter('codex', getCodexSessionsDir()),
  // CodeBuddy 有两套独立存储，拆成两个平台：
  //   codebuddy     = CLI（~/.codebuddy/projects/...）
  //   codebuddy-ide = IDE 图形化（CodeBuddyExtension/.../history）
  codebuddy: () => new CodeBuddyAdapter(),
  'codebuddy-ide': () => new CodeBuddyIdeAdapter(),
  workbuddy: () => new WorkBuddyAdapter(),
  cursor: () => new CursorAdapter(),
  // TeamAI 变体（路径前缀不同，格式完全相同）
  'claude-internal': () => new ClaudeCodeAdapter('claude-internal', getClaudeInternalProjectsDir()),
  tclaude: () => new ClaudeCodeAdapter('tclaude', getTClaudeProjectsDir()),
  'codex-internal': () => new CodexAdapter('codex-internal', getCodexInternalSessionsDir()),
  tcodex: () => new CodexAdapter('tcodex', getTCodexSessionsDir()),
};

export function getAdapter(platform: string): AgentAdapter {
  const factory = ADAPTER_REGISTRY[platform];
  if (!factory) {
    throw new Error(`Unsupported platform: ${platform}. Registered: ${Object.keys(ADAPTER_REGISTRY).join(', ')}`);
  }
  return factory();
}

export function listAvailablePlatforms(): string[] {
  return Object.keys(ADAPTER_REGISTRY);
}

export function listInstalledPlatforms(): string[] {
  const installed: string[] = [];
  for (const [platform, factory] of Object.entries(ADAPTER_REGISTRY)) {
    try {
      const adapter = factory();
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
