import type { VersionDetector } from '@teamai/tool-core/detect';

/** How teamai reads the version of Cursor. */
export const detect = {
  // cursor --version prints several lines; the version is the first.
  cursor: { probe: ['cursor', '--version'], read: (raw) => raw.split('\n')[0]?.trim() ?? '' },
} as const satisfies Record<string, VersionDetector>;
