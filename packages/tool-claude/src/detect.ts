import type { VersionDetector } from '@teamai/tool-core/detect';

/** How teamai reads the version of each Claude build it reads one of. */
export const detect = {
  // "2.1.199 (Claude Code)" → "2.1.199"
  claude: { probe: ['claude', '--version'], read: (raw) => raw.match(/^([\d.]+)/)?.[1] ?? raw },
} as const satisfies Record<string, VersionDetector>;
