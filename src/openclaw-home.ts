import { z } from 'zod';
import { absoluteOn, realHost, toolHome, type Host } from './tool-home.js';
import type { JsonObjectRead } from './utils/fs.js';

/** A bootstrap cap OpenClaw honors: a finite number above zero. */
const BootstrapCapSchema = z.number().positive().optional().catch(undefined);

/** The default agent's settings teamai reads from openclaw.json; a field of another type counts as absent. */
const OpenclawAgentDefaultsSchema = z.object({
  workspace: z.string().optional().catch(undefined),
  bootstrapMaxChars: BootstrapCapSchema,
  bootstrapTotalMaxChars: BootstrapCapSchema,
});

const OpenclawConfigSchema = z.object({
  agents: z.object({ defaults: OpenclawAgentDefaultsSchema.optional().catch(undefined) }).optional().catch(undefined),
});

/** The default agent's settings in openclaw.json, or undefined when the file sets none or was not read. */
function agentDefaultsOf(read: JsonObjectRead): z.infer<typeof OpenclawAgentDefaultsSchema> | undefined {
  if (read.kind !== 'ok') return undefined;
  const config = OpenclawConfigSchema.safeParse(read.value);

  return config.success ? config.data.agents?.defaults : undefined;
}

/**
 * The OpenClaw state dir: the recorded one (`toolHome`), else
 * `OPENCLAW_STATE_DIR`, else `.openclaw-<profile>` for a non-default
 * `OPENCLAW_PROFILE`, else `.openclaw`, in `OPENCLAW_HOME` or `$HOME`. It holds
 * `openclaw.json`, managed hooks and, by default, the workspace.
 */
export function resolveOpenclawStateDir(): string {
  return toolHome('openclaw');
}

/** The plugin that runs the team's hooks in OpenClaw: its id, which is also its `plugins.entries` key. */
export const OPENCLAW_TEAM_HOOK_PLUGIN = 'teamai-team-hooks';

/**
 * Where teamai writes that plugin under the state dir, in a directory of its own: OpenClaw reads a
 * standalone plugin's manifest, when there is one, from the file's directory.
 */
export function openclawTeamHookPluginIn(stateDir: string, host: Host = realHost()): string {
  return host.path.join(stateDir, 'teamai', `${OPENCLAW_TEAM_HOOK_PLUGIN}.mjs`);
}

/** The `openclaw.json` OpenClaw reads: `OPENCLAW_CONFIG_PATH`, else the state dir's. */
export function resolveOpenclawConfigPath(host: Host = realHost(), stateDir: string = resolveOpenclawStateDir()): string {
  const p = host.path;
  const override = host.env.OPENCLAW_CONFIG_PATH?.trim();

  if (override) return absoluteOn(override, host);

  return p.join(stateDir, 'openclaw.json');
}

/** Where OpenClaw's default agent reads its workspace from, as far as teamai can tell (`resolveOpenclawWorkspace`). */
export type OpenclawWorkspace =
  | { readonly kind: 'found'; readonly dir: string }
  /** `candidate` is the directory OpenClaw would read, although it does not exist. */
  | { readonly kind: 'none'; readonly tried: string; readonly candidate: string }
  /** openclaw.json is there but does not parse as JSON5 either, so a workspace it sets is unknown. */
  | { readonly kind: 'unreadable-config'; readonly file: string; readonly error: string; readonly fallback: string | null };

/**
 * Resolve the OpenClaw workspace directory the way OpenClaw resolves its
 * default agent's workspace (agents/agent-scope-config.ts,
 * agents/workspace-default-path.ts):
 * 1. Explicit workspacePath (server-sent), when it exists
 * 2. `agents.defaults.workspace` in the resolved openclaw.json
 * 3. `OPENCLAW_WORKSPACE_DIR`
 * 4. `<state dir>/workspace` (`OPENCLAW_STATE_DIR`, profile, `OPENCLAW_HOME`, `~/.openclaw`)
 *
 * Found only when the directory from that order exists: another workspace
 * that happens to exist is not the one OpenClaw reads. An openclaw.json
 * that does not parse, as JSON or as JSON5, hides step 2, so the result says
 * so, with the directory steps 3-4 give as `fallback`.
 * Per-agent workspaces in `agents.list` are not followed.
 */
export async function resolveOpenclawWorkspace(
  workspacePath?: string,
  { host = realHost(), stateDir = resolveOpenclawStateDir() }: { host?: Host; stateDir?: string } = {},
): Promise<OpenclawWorkspace> {
  if (workspacePath && await host.exists(workspacePath)) return { kind: 'found', dir: workspacePath };
  const p = host.path;
  const cfgPath = resolveOpenclawConfigPath(host, stateDir);
  const read = await host.readOpenclawConfig(cfgPath);
  const configured = agentDefaultsOf(read)?.workspace?.trim();
  const envDir = host.env.OPENCLAW_WORKSPACE_DIR?.trim();

  const candidate = configured
    ? absoluteOn(configured, host)
    : envDir
      ? absoluteOn(envDir, host)
      : p.join(stateDir, 'workspace');

  const exists = await host.exists(candidate);

  if (read.kind === 'invalid') {
    return { kind: 'unreadable-config', file: cfgPath, error: read.error, fallback: exists ? candidate : null };
  }

  return exists ? { kind: 'found', dir: candidate } : { kind: 'none', tried: [workspacePath, candidate].filter(Boolean).join(', '), candidate };
}

/** The default workspace's AGENTS.md is the first bootstrap file and shares the total cap. */
export async function openclawBootstrapBudget(): Promise<{ limit: number; config: string; error?: string }> {
  const config = resolveOpenclawConfigPath();
  const read = await realHost().readOpenclawConfig(config);

  if (read.kind === 'invalid') return { limit: 0, config, error: read.error };
  const defaults = agentDefaultsOf(read);
  const cap = (value: number | undefined, fallback: number): number => (value === undefined ? fallback : Math.floor(value));

  const perFile = cap(defaults?.bootstrapMaxChars, 20_000);
  const total = Math.max(1, cap(defaults?.bootstrapTotalMaxChars, 60_000));

  // OpenClaw skips even the first existing file when less than 64 chars remain.
  return { limit: total < 64 ? 0 : Math.max(1, Math.min(perFile, total)), config };
}
