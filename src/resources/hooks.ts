import path from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import { ResourceHandler } from './base.js';
import type { ResourceItem, TeamaiConfig, LocalConfig, HookDef } from '../types.js';
import { TEAMAI_CUSTOM_HOOK_PREFIX, areTeamHooksDisabled, getHooksSharing } from '../types.js';
import { pathExists, readFileSafe } from '../utils/fs.js';
import { log } from '../utils/logger.js';

// ─── Schema for hooks/hooks.yaml ────────────────────────────
//
//  Team-declared hooks. Event names use Claude PascalCase as the cross-tool
//  lingua franca; the reconcile engine maps to each tool's native format.

const TeamHookSchema = z.object({
  /** Unique id (marker + manifest index). */
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Written into the hook description. */
  description: z.string(),
  /** Claude PascalCase event name. */
  event: z.string().min(1),
  /** Optional tool matcher (e.g. "Bash"). */
  matcher: z.string().optional(),
  /** Shell command to run. */
  command: z.string().min(1),
  /** Optional per-hook timeout in seconds. */
  timeout: z.number().optional(),
  /** Optional restriction to specific tools (default = all hook-capable tools). */
  tools: z.array(z.string()).optional(),
});

/** §4.8 team override of built-in (A) hooks. Whitelisted fields only. */
const BuiltinOverrideSchema = z
  .object({
    disabled: z.array(z.string()).default([]),
    overrides: z.record(z.string(), z.object({ timeout: z.number().optional() })).default({}),
  })
  .default({ disabled: [], overrides: {} });

export const HooksYamlSchema = z.object({
  hooks: z.array(TeamHookSchema).default([]),
  builtin: BuiltinOverrideSchema,
});

export type TeamHook = z.infer<typeof TeamHookSchema>;
export type HooksYaml = z.infer<typeof HooksYamlSchema>;
export type BuiltinOverride = z.infer<typeof BuiltinOverrideSchema>;

/** Absolute path of a team repo's hooks/hooks.yaml. */
export function teamHooksYamlPath(repoPath: string): string {
  return path.join(repoPath, 'hooks', 'hooks.yaml');
}

/**
 * Parse hooks/hooks.yaml into the raw, validated structure. Returns null when the
 * file is absent or fails validation (so callers never act on a broken set).
 */
export async function parseHooksYaml(repoPath: string): Promise<HooksYaml | null> {
  const content = await readFileSafe(teamHooksYamlPath(repoPath));
  if (!content) return null;
  try {
    return HooksYamlSchema.parse(YAML.parse(content));
  } catch (e) {
    log.warn(`Invalid hooks.yaml format: ${(e as Error).message} — skipping team hooks this run`);
    return null;
  }
}

/** Convert one validated team hook into the unified HookDef model. */
export function teamHookToDef(h: TeamHook): HookDef {
  return {
    source: 'team',
    key: h.id,
    event: h.event,
    matcher: h.matcher,
    command: h.command,
    timeout: h.timeout,
    description: `${TEAMAI_CUSTOM_HOOK_PREFIX}${h.id}] ${h.description}`,
    tools: h.tools,
  };
}

/**
 * Parse the team repo's hooks/hooks.yaml into team HookDefs.
 * Returns [] when absent or invalid.
 */
export async function parseTeamHooks(repoPath: string): Promise<HookDef[]> {
  const parsed = await parseHooksYaml(repoPath);
  if (!parsed) return [];
  return parsed.hooks.map(teamHookToDef);
}

/**
 * Parse hooks.yaml into both the team HookDefs (B) and the built-in override
 * (§4.8). Returns empty defs + undefined override when absent or invalid.
 */
export async function parseTeamHooksConfig(
  repoPath: string,
): Promise<{ defs: HookDef[]; builtin: BuiltinOverride | undefined }> {
  const parsed = await parseHooksYaml(repoPath);
  if (!parsed) return { defs: [], builtin: undefined };
  return { defs: parsed.hooks.map(teamHookToDef), builtin: parsed.builtin };
}

// ─── Security gate (§6) ─────────────────────────────────────
//
//  Team hooks are arbitrary shell run on session events — a supply-chain
//  execution surface. Before applying, run them through layered guards.

/** True if a command points at a script under ~/.teamai/team-scripts/. */
function isTeamScriptCommand(command: string): boolean {
  return command.includes('.teamai/team-scripts/');
}

/**
 * Resolve the team hooks that should actually be applied, after security gating:
 *   1. Local kill-switch (TEAMAI_HOOKS_DISABLED) → drop all team hooks.
 *   2. Optional command whitelist (sharing.hooks.requireTeamScripts).
 *   3. autoApply gate: during `pull` (auto), if sharing.hooks.autoApply is false,
 *      hold team hooks and hint the user to run `teamai hooks inject`.
 *   4. Transparency: print the commands that will run (unless silent).
 *
 * Always returns the built-in override (A overrides are not security-sensitive).
 */
export async function resolveTeamHooks(
  teamConfig: TeamaiConfig,
  repoPath: string,
  opts: { auto?: boolean; silent?: boolean } = {},
): Promise<{ defs: HookDef[]; builtin: BuiltinOverride | undefined }> {
  const { defs: parsed, builtin } = await parseTeamHooksConfig(repoPath);
  const sharing = getHooksSharing(teamConfig);
  let defs = parsed;

  if (areTeamHooksDisabled()) {
    if (defs.length > 0) log.warn(`Team hooks disabled (TEAMAI_HOOKS_DISABLED) — skipping ${defs.length} team hook(s)`);
    return { defs: [], builtin };
  }

  if (sharing.requireTeamScripts) {
    const before = defs.length;
    defs = defs.filter((d) => isTeamScriptCommand(d.command));
    const dropped = before - defs.length;
    if (dropped > 0) {
      log.warn(`Skipped ${dropped} team hook(s) whose command is not under ~/.teamai/team-scripts/ (sharing.hooks.requireTeamScripts)`);
    }
  }

  if (opts.auto && sharing.autoApply === false && defs.length > 0) {
    log.info(`${defs.length} team hook(s) pending — run 'teamai hooks inject' to apply (sharing.hooks.autoApply=false)`);
    return { defs: [], builtin };
  }

  if (defs.length > 0 && !opts.silent) {
    log.info(`Applying ${defs.length} team hook(s):`);
    for (const d of defs) log.info(`  [${d.key}] ${d.command}`);
  }

  return { defs, builtin };
}

// ─── Handler ────────────────────────────────────────────────
//
//  Structurally mirrors EnvHandler: a single YAML in the team repo, parsed and
//  injected on pull. Unlike other resources, the actual injection runs in
//  pull.ts (reconcileHooksAllScopes) outside the rev fast-path, so pullItem here
//  is a no-op — the handler exists for registration, scanning, and counting.

export class HooksHandler extends ResourceHandler {
  readonly type = 'hooks' as const;

  /** Never reverse-push from local settings (avoids confusion with built-in A hooks). */
  async scanLocalForPush(_teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<ResourceItem[]> {
    return [];
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const yamlPath = teamHooksYamlPath(localConfig.repo.localPath);
    if (!(await pathExists(yamlPath))) return [];
    return [{ name: 'hooks.yaml', type: 'hooks', sourcePath: yamlPath, relativePath: 'hooks/hooks.yaml' }];
  }

  async pushItem(_item: ResourceItem, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    // No-op — hooks.yaml is edited directly in the repo; push.ts handles git commit.
  }

  async pullItem(_item: ResourceItem, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    // No-op — reconcileHooksAllScopes() in pull.ts performs injection across all
    // tools/scopes, bypassing the "Already synced" fast-path.
  }

  async removeItem(_name: string, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<string[]> {
    log.warn('Edit hooks/hooks.yaml in the team repo to manage team hooks.');
    return [];
  }

  /** Count declared team hooks (for status/pull output). */
  async countHooks(repoPath: string): Promise<number> {
    const parsed = await parseHooksYaml(repoPath);
    return parsed ? parsed.hooks.length : 0;
  }
}
