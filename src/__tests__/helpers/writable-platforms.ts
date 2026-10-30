import { listAvailablePlatforms } from '../../session-flow/adapters/index.js';
import { sessionPlatformFacts } from '../../session-flow/adapters/platform-facts.js';

/**
 * TeamAI's own builds of Claude Code and Codex run their base adapter's code against another
 * directory, so the contract suites cover them through the base.
 */
const VARIANTS = new Set(['claude-internal', 'tclaude', 'codex-internal', 'tcodex']);

/**
 * Every platform the session contract suites run against: each adapter in the registry, so a
 * new one is covered without anyone adding it. A case that does not apply to a platform filters
 * it out where the case is, with the reason. A read-only platform (agy) is never a target, which
 * `noAdapter` refuses.
 */
export const WRITABLE = listAvailablePlatforms().filter((platform) => !VARIANTS.has(platform) && !sessionPlatformFacts(platform)?.readOnly);
