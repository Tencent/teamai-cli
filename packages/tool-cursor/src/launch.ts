import { readClaudeResult, type LaunchAdapter } from '@teamai/tool-core/launch';


/** How teamai launches the Cursor agent CLI headless. */
export const launch = {
  cursor: {
    executable: 'cursor-agent',
    // Ask mode answers without editing.
    call: { evidence: 'docs', prompt: 'stdin', args: () => ['-p', '--output-format', 'json', '--mode', 'ask', '--trust'], read: readClaudeResult },
    confined: { evidence: 'docs', env: ['CURSOR_API_KEY', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR'], access: 'full' },
  },
} as const satisfies Record<string, LaunchAdapter>;
