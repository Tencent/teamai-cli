import type { VersionDetector } from '@teamai/tool-core/detect';

/** How teamai reads the version of the CodeBuddy CLI, the CodeBuddy IDE and WorkBuddy. */
export const detect = {
  codebuddy: { probe: ['codebuddy', '--version'], read: (raw) => raw },
  'codebuddy-ide': { apps: ['/Applications/CodeBuddy.app', '/Applications/CodeBuddy CN.app'] },
  workbuddy: { apps: ['/Applications/WorkBuddy.app'] },
} as const satisfies Record<string, VersionDetector>;
