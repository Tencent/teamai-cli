import { readPlainReply, type LaunchAdapter } from '@teamai/tool-core/launch';


/** How teamai launches the Copilot CLI headless. */
export const launch = {
  // `-s` prints only the reply. Copilot 0.0.x has no JSON output to read tokens from.
  copilot: {
    call: { evidence: 'docs', prompt: 'argv', args: ({ prompt }) => ['-p', prompt, '-s'], read: readPlainReply },
  },
} as const satisfies Record<string, LaunchAdapter>;
