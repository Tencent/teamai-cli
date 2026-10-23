/**
 * migrate.ts — what a migration keeps: fidelity (FidelityReport) and the migration
 * preview (MigrationPreview). The copy itself is `AgentSession.copy` in agent-session.ts.
 *
 * Enhanced fidelity: when a ThinkingBlock is migrated to a platform that does not
 * support thinking blocks, degrade it to a TextBlock instead of dropping it, wrapping
 * the content in a <thinking> tag.
 */

import { SESSION_PLATFORM_FACTS } from './adapters/platform-facts.js';
import type { Session, ContentBlock } from './ir.js';
import { getAdapter, listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';

export const THINKING_SUPPORT: Record<string, boolean> = Object.fromEntries(
  Object.entries(SESSION_PLATFORM_FACTS).map(([name, facts]) => [name, facts.thinking]),
);
export const IMAGE_SUPPORT: Record<string, boolean> = Object.fromEntries(
  Object.entries(SESSION_PLATFORM_FACTS).map(([name, facts]) => [name, facts.images]),
);
export const NATIVE_TOOLS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries(SESSION_PLATFORM_FACTS).map(([name, facts]) => [name, facts.nativeTools]),
);

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
