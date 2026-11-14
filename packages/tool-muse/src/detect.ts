import type { VersionDetector } from '@teamai/tool-core/detect';

/** How teamai reads the version of Muse Code. */
export const detect = {
  // "Muse Code 1.4.6 (1.4.6-R6000.1)" → "1.4.6"
  muse: { probe: ['muse', '--version'], read: (raw) => raw.match(/\d+\.\d+\.\d+/)?.[0] ?? '' },
} as const satisfies Record<string, VersionDetector>;
