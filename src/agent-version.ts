/**
 * Detect the installed version of AI coding agents.
 *
 * Each agent has its own detection strategy:
 *  - CLI-based agents: run `<binary> --version` and parse stdout.
 *  - Electron apps (macOS): read CFBundleShortVersionString from Info.plist.
 *  - Fallback: return '' when detection fails (best-effort, never throws).
 */

import { log } from '@teamai/shared/log';
import { BUILT_IN_FACTS } from '@teamai/tool-definitions/facts';
import { probeBinary } from '@teamai/shared/exec';
import { readPlistVersion, readVersion, type VersionDetector } from '@teamai/tool-core/detect';
import { type ToolId } from './tools.js';
import { isToolId } from './tool-registry.js';

const VERSION_CACHE = new Map<string, string>();

// ─── Per-agent detection ────────────────────────────────

// ─── Registry ───────────────────────────────────────────

/** How teamai reads each tool's version, or null when it reads none. */
const DETECTORS: Record<ToolId, VersionDetector | null> = {
  claude: BUILT_IN_FACTS.claude.detect.claude,
  codex: null,
  'codex-internal': null,
  'claude-internal': null,
  tclaude: null,
  tcodex: null,
  cursor: BUILT_IN_FACTS.cursor.detect.cursor,
  copilot: null,
  joycode: null,
  qoder: null,
  'qoder-cn': null,
  kiro: null,
  trae: null,
  'trae-cn': null,
  zcode: null,
  omp: null,
  pi: BUILT_IN_FACTS.pi.detect.pi,
  codebuddy: BUILT_IN_FACTS.codebuddy.detect.codebuddy,
  openclaw: BUILT_IN_FACTS.openclaw.detect.openclaw,
  hermes: BUILT_IN_FACTS.hermes.detect.hermes,
  dsh: BUILT_IN_FACTS.dsh.detect.dsh,
  workbuddy: BUILT_IN_FACTS.codebuddy.detect.workbuddy,
  opencode: null,
  muse: BUILT_IN_FACTS.muse.detect.muse,
  agy: BUILT_IN_FACTS.agy.detect.agy,
};

/** The detector for `agentType`: a tool's, or the CodeBuddy IDE's (`codebuddy-ide`). */
function detectorOf(agentType: string): VersionDetector | null {
  if (agentType === 'codebuddy-ide') return BUILT_IN_FACTS.codebuddy.detect['codebuddy-ide'];

  return isToolId(agentType) ? DETECTORS[agentType] : null;
}

/**
 * Detect the version of a given agent. Returns '' on failure.
 * Results are cached for the process lifetime (version won't change mid-session).
 */
export async function getAgentVersion(agentType: string): Promise<string> {
  if (VERSION_CACHE.has(agentType)) return VERSION_CACHE.get(agentType)!;

  const detector = detectorOf(agentType);
  let version = '';

  if (detector) {
    try {
      version = await readVersion(detector, probeBinary);
    } catch {
      // best-effort
    }
  }

  VERSION_CACHE.set(agentType, version);
  log.debug(`[agent-version] ${agentType} → "${version}"`);

  return version;
}

/** Clear the version cache (for testing). */
export function clearVersionCache(): void {
  VERSION_CACHE.clear();
}

/** Exposed for testing: the plist-reading utility. */
export { readPlistVersion as _readPlistVersion };
