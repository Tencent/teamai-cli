import { readPlainReply, type LaunchAdapter } from '@teamai/tool-core/launch';


/** How teamai launches Hermes headless. */
export const launch = {
  hermes: {
    call: { evidence: 'source', prompt: 'argv', args: ({ prompt }) => ['-z', prompt], read: readPlainReply },
  },
} as const satisfies Record<string, LaunchAdapter>;
