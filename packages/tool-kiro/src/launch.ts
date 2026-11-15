import { readPlainReply, type LaunchAdapter } from '@teamai/tool-core/launch';


/** How teamai launches Kiro CLI headless. */
export const launch = {
  kiro: {
    executable: 'kiro-cli',
    call: { evidence: 'docs', prompt: 'argv', args: ({ prompt }) => ['chat', '--no-interactive', prompt], read: readPlainReply },
  },
} as const satisfies Record<string, LaunchAdapter>;
