import path from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import { ResourceHandler } from './base.js';
import type { ResourceItem, TeamaiConfig, LocalConfig, HookDef } from '../types.js';
import { TEAMAI_CUSTOM_HOOK_PREFIX, areTeamHooksDisabled, getHooksSharing } from '../types.js';
import { pathExists } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import {
  entryFilePath, readEntryFileText, reportEntryResolution, resolveEntriesFor,
  type EntryReader, type EntryResolution,
} from '../namespaced-entries.js';

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
  /** Deprecated (0.25.0): members holding one of these role ids. Use hooks/<ns>/hooks.yaml. */
  roles: z.array(z.string()).optional(),
  /** Removed (0.26.0 betas only): kept so it is detected; such a hook reaches nobody. */
  projects: z.array(z.string()).optional(),
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

/** One hooks file, parsed, or why it cannot be used. */
type HooksFileRead = { ok: true; yaml: HooksYaml; declaresBuiltin: boolean } | { ok: false; reason: string };

/** Read one hooks file; null when it does not exist. */
async function readHooksFile(absolutePath: string, relativePath: string): Promise<HooksFileRead | null> {
  const file = await readEntryFileText(absolutePath, relativePath);
  if (!file.ok) return file;
  const content = file.text;
  if (content === null) return null;
  try {
    const raw: unknown = YAML.parse(content);
    const declaresBuiltin = !!raw && typeof raw === 'object' && 'builtin' in raw;
    return { ok: true, yaml: HooksYamlSchema.parse(raw ?? {}), declaresBuiltin };
  } catch (e) {
    return { ok: false, reason: `${relativePath} does not parse: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * How `hooks/hooks.yaml` and `hooks/<ns>/hooks.yaml` are read for delivery.
 * The `builtin:` overrides are team-wide and read from the root file alone.
 */
export const hooksEntryReader: EntryReader<TeamHook> = {
  type: 'hooks',
  async read(absolutePath, relativePath) {
    const read = await readHooksFile(absolutePath, relativePath);
    if (read === null || !read.ok) return read;
    const notes = read.declaresBuiltin && relativePath !== entryFilePath('hooks', null)
      ? [`${relativePath}: \`builtin:\` is ignored outside hooks/hooks.yaml; built-in hook overrides apply to the whole team. Move it there.`]
      : [];
    return { ok: true, entries: read.yaml.hooks, notes };
  },
  nameOf: (hook) => hook.id,
  scopeOf: (hook) => hook,
};

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
 * The root file's `builtin:` block. `known: false` when hooks/hooks.yaml does
 * not parse: applying the built-in hooks without its overrides would re-enable
 * the ones the team disabled.
 */
export type BuiltinOverrideRead = { known: true; override: BuiltinOverride | undefined } | { known: false };

/**
 * The team hooks this member receives, with where each comes from, plus the
 * built-in overrides of the root file. The overrides are known whenever the
 * root file parses, even when the resolution fails elsewhere (a namespace file,
 * a hook id twice).
 */
export async function resolveTeamHookEntries(
  localConfig: LocalConfig,
): Promise<{ resolution: EntryResolution<TeamHook>; builtin: BuiltinOverrideRead }> {
  const resolution = await resolveEntriesFor(hooksEntryReader, localConfig);
  const root = await readHooksFile(teamHooksYamlPath(localConfig.repo.localPath), entryFilePath('hooks', null));
  if (root === null) return { resolution, builtin: { known: true, override: undefined } };
  return { resolution, builtin: root.ok ? { known: true, override: root.yaml.builtin } : { known: false } };
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
  localConfig: LocalConfig,
  opts: { auto?: boolean; silent?: boolean; preview?: boolean } = {},
): Promise<{ ok: true; defs: HookDef[]; builtin: BuiltinOverride | undefined } | { ok: false; builtin: BuiltinOverrideRead }> {
  // Which hooks this member receives: root plus active namespace files, before
  // the security gates so the transparency print below lists only hooks this
  // member will actually run. A resolution that fails keeps what is installed.
  const { resolution, builtin: builtinRead } = await resolveTeamHookEntries(localConfig);
  reportEntryResolution(resolution);
  if (resolution.kind === 'failed') return { ok: false, builtin: builtinRead };
  // A root file that does not parse fails the resolution, so it is known here.
  const builtin = builtinRead.known ? builtinRead.override : undefined;
  const sharing = getHooksSharing(teamConfig);
  let defs = resolution.entries.map((entry) => teamHookToDef(entry.entry));

  if (areTeamHooksDisabled()) {
    if (defs.length > 0) log.warn(`Team hooks disabled (TEAMAI_HOOKS_DISABLED) — skipping ${defs.length} team hook(s)`);
    return { ok: true, defs: [], builtin };
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
    return { ok: true, defs: [], builtin };
  }

  if (defs.length > 0 && !opts.silent) {
    // A preview must not claim the hooks were applied: `pull --dry-run` resolves
    // them only to report what a real pull would write (#822).
    log.info(opts.preview
      ? `Would apply ${defs.length} team hook(s):`
      : `Applying ${defs.length} team hook(s):`);
    for (const d of defs) log.info(`  [${d.key}] ${d.command}`);
  }

  return { ok: true, defs, builtin };
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

  /** Count the team hooks this member receives (for status output). */
  async countHooks(localConfig: LocalConfig): Promise<number> {
    const { resolution } = await resolveTeamHookEntries(localConfig);
    return resolution.kind === 'resolved' ? resolution.entries.length : 0;
  }
}
