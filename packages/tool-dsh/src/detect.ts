import type { VersionDetector } from '@teamai/tool-core/detect';

/** How teamai reads the version of dsh. */
export const detect = {
  // DeepSeek Harness prints e.g. "0.1.1", optionally with a leading "v" or trailing commit info.
  dsh: { probe: ['dsh', '--version'], read: (raw) => raw.match(/v?(\d+(?:\.\d+)*)/)?.[1] ?? '' },
} as const satisfies Record<string, VersionDetector>;
