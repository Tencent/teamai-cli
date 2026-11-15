import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { BUILT_IN_FACTS } from '@teamai/tool-definitions/facts';
import type { ToolId } from '../../tools.js';

// oxlint-disable-next-line teamai/tool-facts -- keyed by session platform, which this table defines; a tool lists its own in TOOLS.sessions
export const SESSION_PLATFORM_FACTS = {
  'claude-code': BUILT_IN_FACTS.claude.platforms['claude-code'],
  'claude-internal': BUILT_IN_FACTS.claude.platforms['claude-internal'],
  tclaude: BUILT_IN_FACTS.claude.platforms.tclaude,
  codex: BUILT_IN_FACTS.codex.platforms.codex,
  'codex-internal': BUILT_IN_FACTS.codex.platforms['codex-internal'],
  tcodex: BUILT_IN_FACTS.codex.platforms.tcodex,
  qoder: BUILT_IN_FACTS.qoder.platforms.qoder,
  'qoder-cn': BUILT_IN_FACTS.qoder.platforms['qoder-cn'],
  joycode: BUILT_IN_FACTS.joycode.platforms.joycode,
  codebuddy: BUILT_IN_FACTS.codebuddy.platforms.codebuddy,
  'codebuddy-ide': BUILT_IN_FACTS.codebuddy.platforms['codebuddy-ide'],
  workbuddy: BUILT_IN_FACTS.codebuddy.platforms.workbuddy,
  cursor: BUILT_IN_FACTS.cursor.platforms.cursor,
  opencode: BUILT_IN_FACTS.opencode.platforms.opencode,
  agy: BUILT_IN_FACTS.agy.platforms.agy,
  pi: BUILT_IN_FACTS.pi.platforms.pi,
  omp: BUILT_IN_FACTS.pi.platforms.omp,
  muse: BUILT_IN_FACTS.muse.platforms.muse,
  hermes: BUILT_IN_FACTS.hermes.platforms.hermes,
  copilot: BUILT_IN_FACTS.copilot.platforms.copilot,
} satisfies Record<string, SessionPlatformFacts<ToolId>>;

/** A platform teamai has a session adapter for. */
export type SessionPlatform = keyof typeof SESSION_PLATFORM_FACTS;

/** A platform whose store `sessionStoreDir` resolves: every one but a store its adapter finds itself. */
export type StoredSessionPlatform = {
  [P in SessionPlatform]: (typeof SESSION_PLATFORM_FACTS)[P]['store'] extends { readonly in: 'ide-history' } ? never : P
}[SessionPlatform];

/** Whether `platform`'s store is one `sessionStoreDir` resolves, not one its adapter finds itself. */
export function isStoredSessionPlatform(platform: SessionPlatform): platform is StoredSessionPlatform {
  return SESSION_PLATFORM_FACTS[platform].store.in !== 'ide-history';
}

export function isSessionPlatform(platform: string): platform is SessionPlatform {
  return Object.hasOwn(SESSION_PLATFORM_FACTS, platform);
}

export function sessionPlatformFacts(platform: string): SessionPlatformFacts | undefined {
  return isSessionPlatform(platform) ? SESSION_PLATFORM_FACTS[platform] : undefined;
}

/** The command that continues a restored session in its platform's CLI. */
export function resumeCommand(platform: SessionPlatform, sessionId: string): string {
  const facts: SessionPlatformFacts = SESSION_PLATFORM_FACTS[platform];

  return facts.resume(sessionId);
}
