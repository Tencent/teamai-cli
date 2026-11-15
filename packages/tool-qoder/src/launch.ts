import { readPlainReply, type LaunchAdapter } from '@teamai/tool-core/launch';

/** How teamai launches Qoder CLI headless; Qoder CN has no launch profile. */
export const launch = {
  qoder: {
    executable: 'qodercli',
    call: { evidence: 'docs', prompt: 'argv', args: ({ prompt }) => ['-p', prompt], read: readPlainReply },
  },
} as const satisfies Record<string, LaunchAdapter>;
