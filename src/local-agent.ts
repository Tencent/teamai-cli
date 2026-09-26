/**
 * @deprecated Moved to the ClawPro HTTP provider adapter as part of the
 * Git/HTTP ResourceProvider unification (issue #404). The implementation now
 * lives in `providers/http/adapters/clawpro/client.ts`; this module re-exports
 * it so existing importers keep working. New code should depend on the provider
 * abstraction (`providers/http`) rather than importing this path directly.
 */
export * from './providers/http/adapters/clawpro/client.js';
