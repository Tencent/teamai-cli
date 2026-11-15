import type { VersionDetector } from '@teamai/tool-core/detect';

/** How teamai reads the version of agy. */
export const detect = {
  // Antigravity CLI: "1.4.10"
  agy: { probe: ['agy', '--version'], read: (raw) => raw.match(/\d+\.\d+\.\d+/)?.[0] ?? '' },
} as const satisfies Record<string, VersionDetector>;
