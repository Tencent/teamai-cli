import type { VersionDetector } from '@teamai/tool-core/detect';

/** How teamai reads the version of Codex; it reads none of its variants. */
export const detect = {
  // "codex-cli 0.167.0" → "0.167.0"
  codex: { probe: ['codex', '--version'], read: (raw) => raw.match(/codex-cli\s+(\S+)/)?.[1] ?? '' },
} as const satisfies Record<string, VersionDetector>;
