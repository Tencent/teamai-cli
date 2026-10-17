/**
 * migrate.ts — what a migration keeps: fidelity (FidelityReport) and the migration
 * preview (MigrationPreview). The copy itself is `AgentSession.copy` in agent-session.ts.
 *
 * Enhanced fidelity: when a ThinkingBlock is migrated to a platform that does not
 * support thinking blocks, degrade it to a TextBlock instead of dropping it, wrapping
 * the content in a <thinking> tag.
 */

import type { Session, ContentBlock } from './ir.js';
import { getAdapter, listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';

// ---------------------------------------------------------------------------
// Per-platform capability matrix
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
  cursor: false, // Cursor has no thinking; degrade to text
  opencode: true, // reasoning parts
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
  // IDE tool names do not fully match the CLI (write_to_file / execute_command / search_content …).
  // If they are not registered, the migration preview reports every one of these normal tools as tool_not_in_target.
  'codebuddy-ide': new Set([
    'read_file', 'write_file', 'write_to_file', 'edit_file', 'replace_in_file', 'delete_file',
    'bash', 'execute_command', 'grep', 'search_content', 'glob', 'list_dir', 'codebase_search',
    'web_search', 'web_fetch', 'preview_url', 'lsp', 'task', 'todo_write', 'use_skill',
    'update_memory', 'image_gen',
  ]),
  // workbuddy has the same shape as codebuddy, but was not registered at all before: fidelity
  // counted unknown tools as preserved (100%) and produced **no warnings**, so the user never saw tool incompatibility.
  workbuddy: new Set([
    'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'task', 'todo_write',
  ]),
  cursor: new Set([
    'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'delete_file',
    'web_fetch', 'web_search', 'semantic_search',
  ]),
  // The IR names adapters/opencode.ts reads OpenCode's tools as.
  opencode: new Set([
    'read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep', 'task', 'todo_write', 'web_fetch', 'web_search',
  ]),
};

/**
 * Image support matrix. True only when the target platform can natively represent an inline
 * image in a message (an image block in user-message content). When false, images degrade to
 * placeholder text (counted as degraded in fidelity; see fidelityFromSession).
 */
export const IMAGE_SUPPORT: Record<string, boolean> = {
  'claude-code': true,
  'claude-internal': true,
  tclaude: true,
  'codebuddy-ide': true, // Write back assets/ + codebuddy-asset:// refs, fully restored
  codex: false, // rollout UserMessage supports text only
  'codex-internal': false,
  tcodex: false,
  codebuddy: false,
  workbuddy: false,
  cursor: false,
  opencode: true, // a user message carries image files inline (base64 + mime)
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
        // Cursor does not store tool_result; degrade to text
        if (targetPlatform === 'cursor') {
          degradedBlocks++;
          platformSpecificLosses.push('tool_result_degraded_to_text (cursor)');
        } else {
          preservedBlocks++;
        }
      } else if (block.type === 'tool_call') {
        // Unknown tools no longer score full marks: the tool itself is written, but the target
        // does not recognize it → execution semantics are lost. Same class as thinking degradation,
        // counted as degraded (weight 0.7), so an inflated 100% falls back to a real score.
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
          // Degrade to placeholder text (keep a pointer to the file name/size; visual content is lost)
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
// Enhancement: degrade ThinkingBlock
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
// MigrationPreview
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

/** Whether cwd is a writable real absolute path (excludes irreversible placeholders such as md5:<hash>). */
function isUsableCwd(cwd: string | undefined): cwd is string {
  if (!cwd) return false;
  // Windows drive paths (C:\... / C:/...) are valid absolute paths too
  return cwd.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cwd);
}

/**
 * Resolve the target workspace: **keep the source session's workspace by default**.
 *
 * Priority: explicit value > source session cwd > projectPath used to locate the source.
 * The source session cwd may be an `md5:<hash>` placeholder (when codebuddy-ide was not given
 * a workspace), which is not a writable path. Fall back to projectPath (usually the directory
 * the command is running in) so writeSession has a definite destination.
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

/** What migrating `session`, read from `sourcePlatform`, would carry over. */
export function previewMigration(
  session: Session,
  sourcePlatform: string,
  targetPlatform: string,
): MigrationPreview {
  return {
    sourcePlatform,
    targetPlatform,
    sessionId: session.sessionId,
    sessionTitle: session.title,
    cwd: session.cwd,
    messageCount: session.messages.length,
    fidelity: fidelityFromSession(session, targetPlatform),
  };
}

export { getAdapter, listAvailablePlatforms, listInstalledPlatforms };
