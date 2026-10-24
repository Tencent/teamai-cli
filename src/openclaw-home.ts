import { absoluteOn, realHost, toolHome, type Host } from './tool-home.js';

/**
 * The OpenClaw state dir: the recorded one (`toolHome`), else
 * `OPENCLAW_STATE_DIR`, else `~/.openclaw-<profile>` for a non-default
 * `OPENCLAW_PROFILE`, else `~/.openclaw`. It holds
 * `openclaw.json`, managed hooks and, by default, the workspace.
 */
export function resolveOpenclawStateDir(): string {
  return toolHome('openclaw');
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
  /** openclaw.json is there but not plain JSON, so a workspace it sets is unknown. */
  | { readonly kind: 'unreadable-config'; readonly file: string; readonly error: string; readonly fallback: string | null };

/**
 * Resolve the OpenClaw workspace directory the way OpenClaw resolves its
 * default agent's workspace (agents/agent-scope-config.ts,
 * agents/workspace-default-path.ts):
 * 1. Explicit workspacePath (server-sent), when it exists
 * 2. `agents.defaults.workspace` in the resolved openclaw.json
 * 3. `OPENCLAW_WORKSPACE_DIR`
 * 4. `<state dir>/workspace` (`OPENCLAW_STATE_DIR`, profile, `~/.openclaw`)
 *
 * Found only when the directory from that order exists: another workspace
 * that happens to exist is not the one OpenClaw reads. An openclaw.json
 * teamai cannot parse (OpenClaw reads JSON5) hides step 2, so the result says
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
  const read = await host.readJson(cfgPath);
  const agents = read.kind === 'ok' ? read.value.agents as { defaults?: { workspace?: unknown } } | undefined : undefined;
  const configured = agents?.defaults?.workspace;
  const envDir = host.env.OPENCLAW_WORKSPACE_DIR?.trim();
  const candidate = typeof configured === 'string' && configured.trim()
    ? absoluteOn(configured.trim(), host)
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
  const read = await realHost().readJson(config);
  if (read.kind === 'invalid') return { limit: 0, config, error: read.error };
  const agents = read.kind === 'ok' ? read.value.agents as { defaults?: Record<string, unknown> } | undefined : undefined;
  const defaults = agents?.defaults;
  const cap = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  const perFile = cap(defaults?.bootstrapMaxChars, 20_000);
  const total = Math.max(1, cap(defaults?.bootstrapTotalMaxChars, 60_000));
  // OpenClaw skips even the first existing file when less than 64 chars remain.
  return { limit: total < 64 ? 0 : Math.max(1, Math.min(perFile, total)), config };
}
