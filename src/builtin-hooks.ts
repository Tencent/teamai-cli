import fs from 'node:fs';
import path from 'node:path';
import { TEAMAI_HOOK_DESCRIPTION_PREFIX } from './types.js';
import type { HookDef } from './types.js';

// ─── Built-in (A) operational hooks as data ─────────────────
//
//  The CLI ships a fixed set of operational hooks (the unified
//  `teamai hook-dispatch <event>` entries). Historically these lived as
//  hardcoded objects in hooks.ts; issue #19 lowers them to `HookDef[]` data so
//  the same reconcile engine drives both built-in and team hooks.
//
//  COMPATIBILITY ANCHOR: the rendered on-disk output of these defs must stay
//  byte-for-byte identical to the previous hardcoded version, so that machines
//  upgrading the CLI see a zero-diff reconcile. Pinned by hooks-golden.test.ts.

/**
 * Resolve the absolute path of the `teamai` binary so hook commands work
 * in GUI-launched processes that lack a complete PATH.
 *
 * npm global install places the `teamai` symlink next to the `node` binary
 * (process.argv[0]), so we look there first.
 */
export function resolveTeamaiBinPath(): string {
  try {
    const nodeDir = path.dirname(process.argv[0]);
    const candidate = path.join(nodeDir, 'teamai');
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* fallback below */ }
  return 'teamai';
}

/** Generate the hook-dispatch command for a given event, tool, and optional matcher. */
export function getDispatchCommand(event: string, tool: string, matcher?: string, binPath?: string): string {
  const bin = binPath ?? 'teamai';
  const matcherArg = matcher && matcher !== '*' ? ` --matcher ${matcher}` : '';
  return `bash -lc "${bin} hook-dispatch ${event} --tool ${tool}${matcherArg} 2>/dev/null" || true`;
}

/** Canonical, ordered description of each built-in hook. Order is load-bearing
 *  for byte-compat (it fixes array order within each event). */
interface BuiltinHookSpec {
  /** description keyword (stable identity / HookDef.key). */
  key: string;
  /** Claude PascalCase event. */
  event: string;
  /** hook-dispatch sub-event passed to the command. */
  dispatchEvent: string;
  /** matcher ("*" = wildcard, no --matcher arg, omitted in Cursor output). */
  matcher: string;
  /** Per-hook timeout in seconds (rendered for Cursor and WorkBuddy). */
  timeoutSec: number;
}

const BUILTIN_HOOK_SPECS: BuiltinHookSpec[] = [
  { key: 'Hook dispatch session-start', event: 'SessionStart', dispatchEvent: 'session-start', matcher: '*', timeoutSec: 60 },
  { key: 'Hook dispatch stop', event: 'Stop', dispatchEvent: 'stop', matcher: '*', timeoutSec: 15 },
  { key: 'Hook dispatch post-tool-use wildcard', event: 'PostToolUse', dispatchEvent: 'post-tool-use', matcher: '*', timeoutSec: 10 },
  { key: 'Hook dispatch post-tool-use Skill', event: 'PostToolUse', dispatchEvent: 'post-tool-use', matcher: 'Skill', timeoutSec: 10 },
  { key: 'Hook dispatch post-tool-use TodoWrite', event: 'PostToolUse', dispatchEvent: 'post-tool-use', matcher: 'TodoWrite', timeoutSec: 3 },
  { key: 'Hook dispatch prompt-submit', event: 'UserPromptSubmit', dispatchEvent: 'prompt-submit', matcher: '*', timeoutSec: 10 },
];

/**
 * Build the built-in hook definitions for a tool.
 *
 * Tool-specific by design: Cursor and WorkBuddy entries carry per-hook timeouts
 * so a slow/unreachable backend hook cannot hang the host; Claude/CodeBuddy
 * entries carry no timeout (matching the historical byte-compat output). The
 * reconcile engine renders the same HookDef into each tool's on-disk shape.
 */
export function builtinHookDefs(tool: string): HookDef[] {
  const binPath = resolveTeamaiBinPath();
  const withTimeout = tool === 'cursor' || tool === 'workbuddy';
  return BUILTIN_HOOK_SPECS.map((spec) => ({
    source: 'builtin' as const,
    key: spec.key,
    event: spec.event,
    matcher: spec.matcher,
    command: getDispatchCommand(spec.dispatchEvent, tool, spec.matcher, binPath),
    timeout: withTimeout ? spec.timeoutSec : undefined,
    description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} ${spec.key}`,
  }));
}

/** §4.8 team override of built-in hooks. Only whitelisted fields are honored. */
export interface BuiltinHookOverride {
  /** Built-in hook keys to disable (drop entirely). */
  disabled?: string[];
  /** Per-key field overrides (timeout only — never command, for safety). */
  overrides?: Record<string, { timeout?: number }>;
}

/**
 * Apply a team `builtin:` override to the built-in defs: drop disabled keys and
 * apply whitelisted field overrides. An empty/absent override is a no-op, so
 * default behavior stays byte-identical.
 */
export function applyBuiltinOverride(defs: HookDef[], override?: BuiltinHookOverride): HookDef[] {
  if (!override) return defs;
  const disabled = new Set(override.disabled ?? []);
  return defs
    .filter((d) => !disabled.has(d.key))
    .map((d) => {
      const o = override.overrides?.[d.key];
      return o && o.timeout !== undefined ? { ...d, timeout: o.timeout } : d;
    });
}
