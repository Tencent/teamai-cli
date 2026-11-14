import type { VersionDetector } from '@teamai/tool-core/detect';

/** How teamai reads the version of OpenClaw. */
export const detect = {
  openclaw: { probe: ['openclaw', '--version'], read: (raw) => raw.match(/^([\d.]+)/)?.[1] ?? '' },
} as const satisfies Record<string, VersionDetector>;
