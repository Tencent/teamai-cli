import path from 'node:path';
import { z } from 'zod';
import { DRIVERS, type Driver } from './sessions.js';
import { readRegularFileSync } from '@teamai/shared/regular-file';

// ─── The member's T3 Code settings, as T3 resolves them for one project ───
//
//  `<T3 home>/userdata/settings.json` holds the defaults the member set in T3 Code, globally and per project
//  (`projectSettingsOverrides.<projectId>`, which wins). The runtime reads what a launch from outside a thread would
//  inherit, so a step runs as the member's own threads do. Each field is read on its own: a field this runtime does
//  not understand reads as unset, never as a failure, since T3 owns the file and adds to it.
//

const RUNTIME_MODES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const;

export type T3RuntimeMode = (typeof RUNTIME_MODES)[number];

const ModelSelectionSchema = z.object({
  instanceId: z.string().min(1),
  model: z.string().min(1),
  options: z.array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) })).optional(),
});

export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const ScriptSchema = z.object({ name: z.string(), runOnWorktreeCreate: z.boolean().optional(), runOnSettle: z.boolean().optional() });

export type ProjectScript = z.infer<typeof ScriptSchema>;

/** A value of `schema`, or undefined for one that is absent or of another shape. */
const lenient = <TSchema extends z.ZodType>(schema: TSchema) => schema.optional().catch(undefined);

const OverrideSchema = z.object({
  defaultModelSelection: lenient(ModelSelectionSchema.nullable()),
  defaultRuntimeMode: lenient(z.enum(RUNTIME_MODES)),
  defaultProjectScripts: lenient(z.array(ScriptSchema)),
  providerInstances: lenient(z.record(z.string(), z.object({ enabled: z.boolean().optional() }).catch({}))),
});

/** T3's settings file, each field read on its own. */
export const SettingsSchema = z.object({
  defaultModelSelection: lenient(ModelSelectionSchema.nullable()),
  defaultRuntimeMode: lenient(z.enum(RUNTIME_MODES)),
  defaultProjectScripts: lenient(z.array(ScriptSchema)),
  projectSettingsFolded: lenient(z.boolean()),
  projectScriptOverrides: lenient(z.record(z.string(), lenient(z.array(ScriptSchema).nullable()))),
  projectSettingsOverrides: lenient(z.record(z.string(), OverrideSchema.catch({}))),
  providerInstances: lenient(z.record(z.string(), z.object({
    driver: lenient(z.string()),
    enabled: lenient(z.boolean().nullable()),
    /**
     * Where the instance keeps its tool's sessions, `homePath`, and `binaryPath`, the command T3 starts for it in place
     * of the tool's own. A Codex shadow home holds only its sign-in: T3 links the shadow's `sessions` and
     * `archived_sessions` to `homePath` (`KNOWN_SHARED_DIRECTORIES` in T3's server).
     */
    config: lenient(z.object({ homePath: lenient(z.string()), binaryPath: lenient(z.string()) }).catch({})),
  }).catch({}))),
});

type Read = z.infer<typeof SettingsSchema>;

/** What a launch from outside a thread inherits in one project, and what T3 runs around its threads there. */
export interface ProjectSettings {
  /** The member's default model for new threads, or none. */
  defaultModel: ModelSelection | undefined;
  /** The mode the member's own threads start in, or none set. */
  defaultMode: T3RuntimeMode | undefined;
  /** Whether the member turned the provider instance on or off for this project, or neither. */
  instanceEnabled(instanceId: string): boolean | undefined;
  /** The project script T3 runs in a worktree a thread binds, and the one it runs when a thread is settled. */
  scripts: { setup: string | undefined; settle: string | undefined };
}

/** The member's T3 settings in `t3Home`; an absent or unreadable file reads as nothing set. */
export function readSettings(t3Home: string): Read {
  try {
    const parsed = SettingsSchema.safeParse(JSON.parse(readRegularFileSync(path.join(t3Home, 'userdata', 'settings.json'), 'utf8')));

    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * The home the provider instance `instanceId` runs `driver`'s tool in, as T3 resolves it: the instance's `homePath`
 * (a Codex shadow home links its sessions there), with `~` as the home of the user T3 Code runs as, `userHome`; else the
 * tool's own home there.
 */
export function instanceToolHome(settings: Read, { instanceId, driver, userHome }: { instanceId: string; driver: Driver; userHome: string }): string {
  const config = settings.providerInstances?.[instanceId]?.config;
  const own = config?.homePath?.trim() ?? '';

  if (own === '') return path.join(userHome, DRIVERS[driver].home);

  return homePathOf(own, userHome);
}

/** A provider instance's `homePath` as T3 resolves it, with `~` as `userHome`, the home of the user T3 Code runs as. */
export function homePathOf(homePath: string, userHome: string): string {
  return path.resolve(homePath === '~' ? userHome : homePath.startsWith('~/') ? path.join(userHome, homePath.slice(2)) : homePath);
}

/** The settings of `project` as T3 resolves them: the project's override first, then the global setting. */
export function projectSettings(settings: Read, project: { id: string; scripts?: ProjectScript[] | undefined } | undefined): ProjectSettings {
  const override = project ? settings.projectSettingsOverrides?.[project.id] : undefined;
  const defaultModel = override && override.defaultModelSelection !== undefined ? override.defaultModelSelection : settings.defaultModelSelection;
  const scripts = project ? projectScripts(settings, project) : [];

  return {
    defaultModel: defaultModel ?? undefined,
    defaultMode: override?.defaultRuntimeMode ?? settings.defaultRuntimeMode,
    instanceEnabled: (instanceId) => override?.providerInstances?.[instanceId]?.enabled ?? settings.providerInstances?.[instanceId]?.enabled ?? undefined,
    scripts: { setup: scripts.find((script) => script.runOnWorktreeCreate)?.name, settle: scripts.find((script) => script.runOnSettle)?.name },
  };
}

/** The scripts of `project`, in T3's own order of precedence (`resolveProjectScripts` in T3's shared package). */
function projectScripts(settings: Read, project: { id: string; scripts?: ProjectScript[] | undefined }): ProjectScript[] {
  const global = settings.defaultProjectScripts ?? [];
  const override = settings.projectSettingsOverrides?.[project.id]?.defaultProjectScripts;

  if (override !== undefined) return override;

  if (settings.projectSettingsFolded) return global;
  const legacy = settings.projectScriptOverrides?.[project.id];

  if (legacy === null) return global;

  return legacy ?? ((project.scripts ?? []).length > 0 ? project.scripts ?? [] : global);
}

