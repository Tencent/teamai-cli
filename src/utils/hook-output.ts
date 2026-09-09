/**
 * Format Stop hook STDOUT for the given AI tool.
 *
 * Schema choice per tool:
 * - Cursor: `{ followup_message }`  (Cursor stop hook docs)
 * - Codex: `{ systemMessage }` (UI notice; model context is deferred to prompt-submit)
 * - Everyone else (Claude / CodeBuddy / WorkBuddy / unknown):
 *   `{ hookSpecificOutput: { hookEventName: 'Stop', additionalContext } }`
 *   (Claude Code stop hook docs — the "additional context that continues
 *   the conversation" branch, NOT top-level `stopReason`, which requires
 *   `continue:false` and aborts the run.)
 */
export function formatStopHookOutput(message: string, tool: string): string {
  const normalized = tool?.toLowerCase() ?? '';

  if (normalized === 'codex') {
    return JSON.stringify({ systemMessage: message });
  }

  if (normalized === 'cursor') {
    return JSON.stringify({ followup_message: message });
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: message,
    },
  });
}
