import type { VersionDetector } from '@teamai/tool-core/detect';

/** How teamai reads the version of pi; it reads none of omp. */
export const detect = {
  // Pi Coding Agent: "1.4.0"
  pi: { probe: ['pi', '--version'], read: (raw) => raw.match(/\d+\.\d+\.\d+/)?.[0] ?? '' },
} as const satisfies Record<string, VersionDetector>;
