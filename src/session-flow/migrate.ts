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
import { scrubSession } from './scrub.js';

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
  'codebuddy-ide': true,
  workbuddy: true,
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
  // IDE 侧工具名与 CLI 不完全一致（write_to_file / execute_command / search_content …），
  // 不登记的话迁移预览会把这些正常工具全报成 tool_not_in_target。
  'codebuddy-ide': new Set([
    'read_file', 'write_file', 'write_to_file', 'edit_file', 'replace_in_file', 'delete_file',
    'bash', 'execute_command', 'grep', 'search_content', 'glob', 'list_dir', 'codebase_search',
    'web_search', 'web_fetch', 'preview_url', 'lsp', 'task', 'todo_write', 'use_skill',
    'update_memory', 'image_gen',
  ]),
  // workbuddy 与 codebuddy 同构，但此前完全没登记：保真度会把未知工具算成
  // preserved（100%）且**一条警告都不产生**，用户完全看不到工具不兼容。
  workbuddy: new Set([
    'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'task', 'todo_write',
  ]),
  cursor: new Set([
    'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'delete_file',
    'web_fetch', 'web_search', 'semantic_search',
  ]),
};

/**
 * 图片支持矩阵。目标平台能原生表示消息内嵌图片（用户消息 content 里的 image 块）
 * 才算 true；false 时图片降级为占位文本（保真度计 degraded，见 fidelityFromSession）。
 */
export const IMAGE_SUPPORT: Record<string, boolean> = {
  'claude-code': true,
  'claude-internal': true,
  tclaude: true,
  'codebuddy-ide': true, // 写回 assets/ + codebuddy-asset:// 引用，完整还原
  codex: false, // rollout UserMessage 只支持 text
  'codex-internal': false,
  tcodex: false,
  codebuddy: false,
  workbuddy: false,
  cursor: false,
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
  let imageCount = 0;
  const unknownTools = new Set<string>();

  const targetSupportsThinking = THINKING_SUPPORT[targetPlatform] ?? true;
  const targetSupportsImage = IMAGE_SUPPORT[targetPlatform] ?? false;
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
        // 未知工具不再计满分：工具本身会写进去，但目标端不认识 → 执行语义丢失，
        // 与 thinking 降级同类，计 degraded（0.7 权重），让虚高的 100% 真实回落。
        if (nativeTools.size > 0 && !nativeTools.has(block.toolName)) {
          unknownTools.add(block.toolName);
          degradedBlocks++;
        } else {
          preservedBlocks++;
        }
      } else if (block.type === 'image') {
        imageCount++;
        if (targetSupportsImage) {
          preservedBlocks++;
        } else {
          // 降级为占位文本（保留文件名/大小的指针，视觉内容丢失）
          degradedBlocks++;
        }
      }
    }
  }

  if (thinkingCount > 0 && !targetSupportsThinking) {
    degradations.push('thinking_blocks_degraded_to_text');
  }
  if (imageCount > 0 && !targetSupportsImage) {
    degradations.push(`image_blocks_degraded_to_placeholder (${imageCount})`);
  }

  for (const toolName of [...unknownTools].sort()) {
    warnings.push(`tool_not_in_target: ${toolName}`);
  }

  const score = totalBlocks === 0 ? 1.0 : (preservedBlocks + 0.7 * degradedBlocks + 0 * lostBlocks) / totalBlocks;

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
  /** 实际写入的目标工作区（默认 = 源会话 cwd，显式 --target-cwd 时为其值）。 */
  targetCwd?: string;
  /** --scrub 时被替换掉的疑似密钥数量（未脱敏时无此字段）。 */
  redactedCount?: number;
  targetFilePath?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

/** cwd 是否是可写入的真实绝对路径（排除 md5:<hash> 这类不可逆占位）。 */
function isUsableCwd(cwd: string | undefined): cwd is string {
  if (!cwd) return false;
  // Windows 盘符路径（C:\... / C:/...）同样是合法绝对路径
  return cwd.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cwd);
}

/**
 * 解析目标工作区：**默认保持源会话的工作区**。
 *
 * 优先级：显式指定 > 源会话 cwd > 源端定位用的 projectPath。
 * 源会话 cwd 可能是 `md5:<hash>` 占位（codebuddy-ide 未传工作区时），不是可写路径，
 * 此时回退到 projectPath（通常是命令运行的目录），让 writeSession 有确定的落点。
 */
export function resolveTargetCwd(
  explicit: string | undefined,
  sourceSessionCwd: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (explicit) return explicit;
  if (isUsableCwd(sourceSessionCwd)) return sourceSessionCwd;
  return fallback;
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

  async migrate(
    sessionId: string,
    projectPath?: string,
    targetProjectPath?: string,
    scrub = false,
  ): Promise<MigrationResult> {
    const startedAt = new Date().toISOString();
    let targetSid: string | undefined;

    try {
      const source = getAdapter(this.sourcePlatform);
      const target = getAdapter(this.targetPlatform);

      // 目标端安装检查：没装客户端时写入只会落到一个无人读取的目录，
      // 之前会照样报「迁移成功」。这里提前失败并给出明确原因。
      if (!target.isReady()) {
        throw new Error(
          `Target platform "${this.targetPlatform}" is not installed or its storage directory was not found. ` +
            `Install the client first, or pick another target (available: ${listInstalledPlatforms().join(', ') || 'none'}).`,
        );
      }

      const session = await source.readSession(sessionId, projectPath);
      const fidelity = fidelityFromSession(session, this.targetPlatform);

      // 降级 ThinkingBlock
      // 脱敏在 thinking 降级之后、写入之前：--scrub 时整份 IR 过一遍 redact，
      // 让敏感内容不会随会话扩散到目标端（以及后续可能的团队归档）。
      const degraded = degradeThinkingBlocks(session, this.targetPlatform);
      const scrubbed = scrub ? scrubSession(degraded) : null;
      const enhancedSession = scrubbed ? scrubbed.session : degraded;

      // 目标工作区语义：**默认保持源会话的工作区**。
      // 迁移是「把 thpc 的会话搬到 Codex/WorkBuddy」，而不是「搬到我当前所在的目录」；
      // 只有显式指定 targetProjectPath（--target-cwd）才搬走。
      const targetCwd = resolveTargetCwd(targetProjectPath, session.cwd, projectPath);
      targetSid = await target.writeSession(enhancedSession, targetCwd);

      // 尝试定位目标文件路径
      let targetFilePath: string | undefined;
      try {
        const targetAdapter = getAdapter(this.targetPlatform);
        // 通过 list 查找刚写入的会话
        const metas = await targetAdapter.listConversations(targetCwd);
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
        targetCwd,
        ...(scrubbed ? { redactedCount: scrubbed.redactedCount } : {}),
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

  async migrateBatch(
    sessionIds: string[],
    projectPath?: string,
    targetProjectPath?: string,
    scrub = false,
  ): Promise<MigrationResult[]> {
    const results: MigrationResult[] = [];
    for (const sid of sessionIds) {
      results.push(await this.migrate(sid, projectPath, targetProjectPath, scrub));
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
