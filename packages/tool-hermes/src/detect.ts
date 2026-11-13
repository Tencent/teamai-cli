import type { VersionDetector } from '@teamai/tool-core/detect';

/** How teamai reads the version of Hermes. */
export const detect = {
  // hermes --version may print "(2026.8.7)\nProject: ...": the version is in the parens or leading digits.
  hermes: { probe: ['hermes', '--version'], read: (raw) => raw.match(/^\(?(\d+(?:\.\d+)*)\)?/)?.[1] ?? '' },
} as const satisfies Record<string, VersionDetector>;
