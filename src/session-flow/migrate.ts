/**
 * migrate.ts — 迁移引擎。
 *
 * 编排源平台适配器读取 → IR → 目标平台适配器写入的完整流程，
 * 同时计算保真度（FidelityReport）、生成迁移预览（MigrationPreview）。
 *
 * 增强保真度：ThinkingBlock 迁移到不支持思考块的平台时，降级为 TextBlock
 * 而非直接丢弃，用 <thinking> 标签包裹保留内容。
 */

import type { Session, ContentBlock } from './ir.js';
import { getAdapter, listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';

// ---------------------------------------------------------------------------
// 各平台能力矩阵
// ---------------------------------------------------------------------------

export const THINKING_SUPPORT: Record<string, boolean> = {
  'claude-code': true,
  'claude-internal': true,
  tclaude: true,
  codex: true,
  'codex-internal': true,
  tcodex: true,
  codebuddy: true,
  cursor: false, // Cursor 无 thinking，降级为 text
};

export const NATIVE_TOOLS: Record<string, Set<string>> = {
  'claude-code': new Set([
    'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
    'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
  ]),
  'claude-internal': new Set([
    'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
    'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
  ]),
  tclaude: new Set([
    'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
    'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
  ]),
  codex: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
  'codex-internal': new Set(['bash', 'edit_file', 'read_file', 'write_file']),
  tcodex: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
  codebuddy: new Set([
    'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'task', 'todo_write',
  ]),
  cursor: new Set([
    'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'delete_file',
    'web_fetch', 'web_search', 'semantic_search',
  ]),
};

// ---------------------------------------------------------------------------
// FidelityReport
// ---------------------------------------------------------------------------

export interface FidelityReport {
  score: number;
  mode: 'A';
  totalMessages: number;
  totalBlocks: number;
  preservedBlocks: number;
  degradedBlocks: number;
  lostBlocks: number;
  losses: string[];
  degradations: string[];
  warnings: string[];
  platformSpecificLosses: string[];
}

export function fidelityFromSession(session: Session, targetPlatform: string): FidelityReport {
  const totalMessages = session.messages.length;
  let totalBlocks = 0;
  let preservedBlocks = 0;
  let degradedBlocks = 0;
  let lostBlocks = 0;
  const losses: string[] = [];
  const degradations: string[] = [];
  const warnings: string[] = [];
  const platformSpecificLosses: string[] = [];
  let thinkingCount = 0;
  const unknownTools = new Set<string>();

  const targetSupportsThinking = THINKING_SUPPORT[targetPlatform] ?? true;
  const nativeTools = NATIVE_TOOLS[targetPlatform] ?? new Set();

  for (const msg of session.messages) {
    for (const block of msg.content) {
      totalBlocks++;

      if (block.type === 'thinking') {
        if (targetSupportsThinking) {
          preservedBlocks++;
        } else {
          thinkingCount++;
          degradedBlocks++;
        }
      } else if (block.type === 'text') {
        preservedBlocks++;
      } else if (block.type === 'tool_result') {
        // Cursor 不存储 tool_result，降级为 text
        if (targetPlatform === 'cursor') {
          degradedBlocks++;
          platformSpecificLosses.push('tool_result_degraded_to_text (cursor)');
        } else {
          preservedBlocks++;
        }
      } else if (block.type === 'tool_call') {
        preservedBlocks++;
        if (nativeTools.size > 0 && !nativeTools.has(block.toolName)) {
          unknownTools.add(block.toolName);
        }
      }
    }
  }

  if (thinkingCount > 0 && !targetSupportsThinking) {
    degradations.push('thinking_blocks_degraded_to_text');
  }

  for (const toolName of [...unknownTools].sort()) {
    warnings.push(`tool_not_in_target: ${toolName}`);
  }

  const score = totalBlocks === 0 ? 1.0 : (preservedBlocks + 0.7 * degradedBlocks) / totalBlocks;

  return {
    score,
    mode: 'A',
    totalMessages,
    totalBlocks,
    preservedBlocks,
    degradedBlocks,
    lostBlocks,
    losses,
    degradations,
    warnings,
    platformSpecificLosses,
  };
}

// ---------------------------------------------------------------------------
// 增强处理：降级 ThinkingBlock
// ---------------------------------------------------------------------------

export function degradeThinkingBlocks(session: Session, targetPlatform: string): Session {
  const targetSupportsThinking = THINKING_SUPPORT[targetPlatform] ?? true;
  if (targetSupportsThinking) return session;

  return {
    ...session,
    messages: session.messages.map((msg) => ({
      ...msg,
      content: msg.content.map((block): ContentBlock => {
        if (block.type === 'thinking') {
          return { type: 'text', text: `<thinking>\n${block.text}\n</thinking>` };
        }
        return block;
      }),
    })),
  };
}

// ---------------------------------------------------------------------------
// MigrationPreview / MigrationResult
// ---------------------------------------------------------------------------

export interface MigrationPreview {
  sourcePlatform: string;
  targetPlatform: string;
  sessionId: string;
  sessionTitle: string;
  cwd: string;
  messageCount: number;
  fidelity: FidelityReport;
  targetSessionId?: string;
}

export interface MigrationResult {
  preview: MigrationPreview;
  success: boolean;
  targetSessionId?: string;
  targetFilePath?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// MigrationEngine
// ---------------------------------------------------------------------------

export class MigrationEngine {
  constructor(
    private sourcePlatform: string,
    private targetPlatform: string,
  ) {}

  async preview(sessionId: string, projectPath?: string): Promise<MigrationPreview> {
    const source = getAdapter(this.sourcePlatform);
    const session = await source.readSession(sessionId, projectPath);
    const fidelity = fidelityFromSession(session, this.targetPlatform);

    return {
      sourcePlatform: this.sourcePlatform,
      targetPlatform: this.targetPlatform,
      sessionId: session.sessionId,
      sessionTitle: session.title,
      cwd: session.cwd,
      messageCount: session.messages.length,
      fidelity,
    };
  }

  async migrate(sessionId: string, projectPath?: string, targetProjectPath?: string): Promise<MigrationResult> {
    const startedAt = new Date().toISOString();
    let targetSid: string | undefined;

    try {
      const source = getAdapter(this.sourcePlatform);
      const target = getAdapter(this.targetPlatform);

      const session = await source.readSession(sessionId, projectPath);
      const fidelity = fidelityFromSession(session, this.targetPlatform);

      // 降级 ThinkingBlock
      const enhancedSession = degradeThinkingBlocks(session, this.targetPlatform);

      targetSid = await target.writeSession(enhancedSession, targetProjectPath);

      // 尝试定位目标文件路径
      let targetFilePath: string | undefined;
      try {
        const targetAdapter = getAdapter(this.targetPlatform);
        // 通过 list 查找刚写入的会话
        const metas = await targetAdapter.listConversations(targetProjectPath);
        const found = metas.find((m) => m.sessionId === targetSid);
        if (found) targetFilePath = found.filePath;
      } catch {
        // ignore
      }

      const completedAt = new Date().toISOString();
      return {
        preview: {
          sourcePlatform: this.sourcePlatform,
          targetPlatform: this.targetPlatform,
          sessionId: session.sessionId,
          sessionTitle: session.title,
          cwd: session.cwd,
          messageCount: session.messages.length,
          fidelity,
          targetSessionId: targetSid,
        },
        success: true,
        targetSessionId: targetSid,
        targetFilePath,
        startedAt,
        completedAt,
      };
    } catch (e) {
      // 自动回退
      if (targetSid) {
        try {
          const target = getAdapter(this.targetPlatform);
          await target.deleteSession(targetSid);
        } catch {
          // 回退失败不掩盖原始错误
        }
      }

      const completedAt = new Date().toISOString();
      return {
        preview: {
          sourcePlatform: this.sourcePlatform,
          targetPlatform: this.targetPlatform,
          sessionId,
          sessionTitle: '',
          cwd: '',
          messageCount: 0,
          fidelity: {
            score: 0,
            mode: 'A',
            totalMessages: 0,
            totalBlocks: 0,
            preservedBlocks: 0,
            degradedBlocks: 0,
            lostBlocks: 0,
            losses: [],
            degradations: [],
            warnings: [],
            platformSpecificLosses: [],
          },
        },
        success: false,
        error: (e as Error).message,
        startedAt,
        completedAt,
      };
    }
  }

  async migrateBatch(sessionIds: string[], projectPath?: string, targetProjectPath?: string): Promise<MigrationResult[]> {
    const results: MigrationResult[] = [];
    for (const sid of sessionIds) {
      results.push(await this.migrate(sid, projectPath, targetProjectPath));
    }
    return results;
  }

  async rollback(targetSessionId: string): Promise<boolean> {
    try {
      const target = getAdapter(this.targetPlatform);
      await target.deleteSession(targetSessionId);
      return true;
    } catch {
      return false;
    }
  }
}

export { getAdapter, listAvailablePlatforms, listInstalledPlatforms };
