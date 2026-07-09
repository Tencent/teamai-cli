import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// ─── GUI tool PATH wrapper ─────────────────────────────────
//
//  WorkBuddy and CodeBuddy use bundled Node runtimes and their hook
//  subprocesses may lack the user's PATH, so `teamai` is not found.
//  We write a thin wrapper script at `~/.teamai/bin/teamai` that invokes
//  the real entry script with the best available Node, then prepend
//  `~/.teamai/bin` to PATH in hook commands for WorkBuddy and CodeBuddy.
//  The PATH is expressed as `$HOME/.teamai/bin` (shell literal) so that
//  the golden fixture output is stable across machines.
//  Other tools keep the plain `bash -lc "teamai ..."` form.

const WORKBUDDY_BUNDLED_NODE_DIR = '.workbuddy/bundled/node/versions';
const TEAMAI_BIN_DIR = '.teamai/bin';
const WRAPPER_NAME = 'teamai';

/**
 * Compare two semver-like version strings numerically (segment by segment).
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareSemver(a: string, b: string): number {
  const aParts = a.split('.').map(s => parseInt(s, 10) || 0);
  const bParts = b.split('.').map(s => parseInt(s, 10) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Pick the latest version string from an array using numeric semver comparison.
 */
function pickLatestVersion(versions: string[]): string | undefined {
  if (versions.length === 0) return undefined;
  return versions.reduce((best, v) => compareSemver(v, best) > 0 ? v : best, versions[0]);
}

/**
 * Find WorkBuddy's bundled Node binary. WorkBuddy ships its own Node under
 * ~/.workbuddy/bundled/node/versions/<ver>/bin/node. Pick the latest version
 * using numeric semver comparison (avoids '9.0.0' > '10.11.0' lexicographic error).
 */
function resolveWorkbuddyNode(): string | null {
  const home = process.env.HOME ?? '';
  const versionsDir = path.join(home, WORKBUDDY_BUNDLED_NODE_DIR);
  try {
    const versions = fs.readdirSync(versionsDir).filter(d => !d.startsWith('.'));
    const latest = pickLatestVersion(versions);
    if (!latest) return null;
    const nodeBin = path.join(versionsDir, latest, 'bin', 'node');
    if (fs.existsSync(nodeBin)) return nodeBin;
  } catch { /* not installed */ }
  return null;
}

/**
 * Find CodeBuddy's bundled Node binary. CodeBuddy ships its own Node under
 * ~/.codebuddy-server-<variant>/bin/stable-<version>/node (prefix may vary).
 */
function resolveCodebuddyNode(): string | null {
  const home = process.env.HOME ?? '';
  try {
    const entries = fs.readdirSync(home);
    for (const entry of entries) {
      if (!entry.startsWith('.codebuddy-server')) continue;
      try {
        const binDir = path.join(home, entry, 'bin');
        const stableDirs = fs.readdirSync(binDir).filter(d => d.startsWith('stable-'));
        for (const stable of stableDirs) {
          const nodeBin = path.join(binDir, stable, 'node');
          if (fs.existsSync(nodeBin)) return nodeBin;
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* home not readable */ }
  return null;
}

/**
 * Resolve the teamai CLI entry script (dist/index.js) by walking up from
 * this module's location. Returns null when resolution fails.
 */
function resolveTeamaiEntryScript(): string | null {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const distDir = path.dirname(thisFile);
    const candidate = path.join(distDir, 'index.js');
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* fallback */ }
  return null;
}

/**
 * Write a `teamai` wrapper script to `~/.teamai/bin/teamai` that invokes
 * the real entry script with the best available Node binary. Idempotent —
 * overwrites on every init/pull so the paths stay current after upgrades.
 *
 * Returns the bin directory path, or null if the wrapper could not be created.
 */
export function ensureTeamaiWrapper(): string | null {
  const entryScript = resolveTeamaiEntryScript();
  if (!entryScript) return null;

  const nodeBin = resolveWorkbuddyNode() ?? resolveCodebuddyNode() ?? process.argv[0];
  const home = process.env.HOME ?? '';
  const binDir = path.join(home, TEAMAI_BIN_DIR);
  const wrapperPath = path.join(binDir, WRAPPER_NAME);

  const script = [
    '#!/bin/sh',
    `# Auto-generated by teamai — do not edit.`,
    `# Wrapper that invokes teamai CLI with a known Node binary so hooks`,
    `# work in environments without PATH (e.g. WorkBuddy GUI subprocess).`,
    `exec "${nodeBin}" "${entryScript}" "$@"`,
    '',
  ].join('\n');

  try {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
    return binDir;
  } catch {
    return null;
  }
}

/** Generate the hook-dispatch command for a given event, tool, and optional matcher. */
export function getDispatchCommand(event: string, tool: string, matcher?: string, binPath?: string): string {
  const bin = binPath ?? 'teamai';
  const matcherArg = matcher && matcher !== '*' ? ` --matcher ${matcher}` : '';
  return `bash -lc "${bin} hook-dispatch ${event} --tool ${tool}${matcherArg} 2>/dev/null" || true`;
}

/**
 * Build a hook command that prepends `$HOME/.teamai/bin` to PATH so the
 * wrapper script is found even without the user's login shell PATH.
 * Used by GUI tools (WorkBuddy, CodeBuddy) that spawn hook subprocesses
 * with a limited environment. The PATH value uses the `$HOME` shell literal
 * so that golden fixture output stays stable across machines.
 */
function getWrapperDispatchCommand(event: string, tool: string, matcher?: string): string {
  const matcherArg = matcher && matcher !== '*' ? ` --matcher ${matcher}` : '';
  return `PATH="$HOME/${TEAMAI_BIN_DIR}:$PATH" teamai hook-dispatch ${event} --tool ${tool}${matcherArg} 2>/dev/null || true`;
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
 *
 * GUI tools (WorkBuddy, CodeBuddy) use the wrapper dispatch command so their
 * hook subprocesses can find `teamai` even without the user's full PATH.
 */
const WRAPPER_TOOLS = new Set(['workbuddy', 'codebuddy']);

export function builtinHookDefs(tool: string): HookDef[] {
  const withTimeout = tool === 'cursor' || tool === 'workbuddy';
  const buildCommand = WRAPPER_TOOLS.has(tool) ? getWrapperDispatchCommand : getDispatchCommand;
  return BUILTIN_HOOK_SPECS.map((spec) => ({
    source: 'builtin' as const,
    key: spec.key,
    event: spec.event,
    matcher: spec.matcher,
    command: buildCommand(spec.dispatchEvent, tool, spec.matcher),
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
