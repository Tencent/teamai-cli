/**
 * Multi-tool-aware hook output formatting.
 *
 * Different AI tools parse Stop hook STDOUT differently:
 * - Claude Code / CodeBuddy: hookSpecificOutput.additionalContext → visible to AI
 * - Cursor: direct JSON message → shown in UI
 * - Codex etc.: default hookSpecificOutput (maximum compatibility)
 */

/**
 * Format Stop hook output so the AI can see the hint content.
 *
 * @param message  Hint text to pass to the AI
 * @param tool     Current AI tool identifier (claude / cursor / codebuddy / codex / etc.)
 * @returns        JSON string to write to STDOUT
 */
export function formatStopHookOutput(message: string, tool: string): string {
  if (tool === 'cursor') {
    return JSON.stringify({ message });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: message,
    },
  });
}
