/**
 * OpenClaw / 龙虾-family hook injection (issue #1, 方案二 §四).
 *
 * NOTE: WorkBuddy was originally assumed to use this OpenClaw engine, but
 * real-device verification (WorkBuddy 5.2.0) showed it embeds the CodeBuddy CLI
 * engine and reads Claude-format hooks from ~/.workbuddy/settings.json instead.
 * WorkBuddy is therefore wired via the settings-based path (see types.ts
 * toolPaths.workbuddy.settings), NOT here. This adapter remains for the other
 * claw variants (openclaw / qclaw / easyclaw / autoclaw) whose engine is still
 * unconfirmed; it writes a `HOOK.md` (frontmatter with metadata.openclaw.events)
 * plus a `handler.ts` under `<hooksDir>/<hookName>/`, both shelling out to the
 * same `teamai hook-dispatch` entry point.
 *
 * The teamai hook is a workspace hook (`<workspace>/hooks/teamai-status-report`),
 * which OpenClaw loads only once openclaw.json enables its entry
 * (`hooks.internal.entries.teamai-status-report.enabled`). The workspace and
 * state dir resolve the way OpenClaw resolves them: OPENCLAW_STATE_DIR,
 * OPENCLAW_PROFILE, OPENCLAW_CONFIG_PATH, OPENCLAW_WORKSPACE_DIR.
 *
 * Events (OpenClaw calls the handler with `{ type, action, sessionKey, context }`):
 *   command:new, command:reset, session:auto-reset, gateway:startup
 *                      → session-start dispatch (report + sync);
 *   message:received   → prompt-submit dispatch (sync only).
 */

import path from 'node:path';
import { writeFile, writeIfChanged, ensureDir, pathExists, readJsonObject, writeJsonAtomic, remove } from './utils/fs.js';
import { log } from './utils/logger.js';
import { expandHome, getUserHome } from './utils/home.js';

/**
 * The OpenClaw state dir: `OPENCLAW_STATE_DIR`, else `~/.openclaw-<profile>`
 * for a non-default `OPENCLAW_PROFILE`, else `~/.openclaw`. It holds
 * `openclaw.json`, managed hooks and, by default, the workspace.
 */
export function resolveOpenclawStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) return path.resolve(expandHome(override));
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  const suffix = profile && profile.toLowerCase() !== 'default' ? `-${profile}` : '';
  return path.join(getUserHome(), `.openclaw${suffix}`);
}

/** The `openclaw.json` OpenClaw reads: `OPENCLAW_CONFIG_PATH`, else the state dir's. */
export function resolveOpenclawConfigPath(): string {
  const override = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) return path.resolve(expandHome(override));
  return path.join(resolveOpenclawStateDir(), 'openclaw.json');
}

/**
 * Resolve the managed hooks directory for an OpenClaw-family tool:
 * `<state dir>/hooks` for `openclaw`. Other claw variants
 * (qclaw/easyclaw/autoclaw) are not confirmed to use OpenClaw's env vars and
 * always fall back to ~/.<tool>/hooks.
 */
export function resolveOpenClawHooksDir(tool: string): string {
  if (tool === 'openclaw') return path.join(resolveOpenclawStateDir(), 'hooks');
  return path.join(getUserHome(), `.${tool}`, 'hooks');
}

/** Sub-directory name under <hooksDir> that holds the teamai OpenClaw hook. */
export const OPENCLAW_HOOK_DIR = 'teamai-status-report';

/** Marker so we can recognize (and cleanly remove) our own hook. */
const TEAMAI_MARKER = '[teamai]';

/**
 * The key OpenClaw reads this hook's settings under
 * (`hooks.internal.entries.<hookKey>`). Same as the directory name, so
 * `openclaw hooks enable teamai-status-report` finds it by either.
 */
export const OPENCLAW_HOOK_KEY = OPENCLAW_HOOK_DIR;

/**
 * OpenClaw event key (`${type}:${action}`) → teamai dispatch event. Only keys
 * OpenClaw emits (docs/automation/hooks/event-types.md). `command:stop` only
 * observes a cancel, so it is not a stop.
 */
const EVENT_MAP: Record<string, string> = {
  'command:new': 'session-start',
  'command:reset': 'session-start',
  'session:auto-reset': 'session-start',
  'gateway:startup': 'session-start',
  'message:received': 'prompt-submit',
};

function buildHookMd(tool: string): string {
  const events = Object.keys(EVENT_MAP);
  const metadata = JSON.stringify({ openclaw: { events, hookKey: OPENCLAW_HOOK_KEY } });
  return [
    '---',
    // A bare `[teamai] ...` value is a YAML flow sequence followed by a
    // scalar: a parse error, and OpenClaw then treats the metadata as invalid.
    `name: ${OPENCLAW_HOOK_KEY}`,
    `description: ${JSON.stringify(`${TEAMAI_MARKER} Reports agent status to the team backend and syncs team resources.`)}`,
    `metadata:`,
    `  ${metadata}`,
    `handler: ./handler.ts`,
    '---',
    '',
    `${TEAMAI_MARKER} Reports agent status to the team backend (report/sync/ack) for tool \`${tool}\`.`,
    'Managed by teamai — do not edit by hand.',
    '',
  ].join('\n');
}

function buildHandlerTs(tool: string): string {
  // OpenClaw calls the default export with the event itself
  // ({ type, action, sessionKey, context, ... }). Map `${type}:${action}` to a
  // teamai dispatch event and shell out, passing the event's workspace as the
  // hook cwd so hook-dispatch resolves the scope from it. Events that carry no
  // workspaceDir (message:received) use the workspace this hook is installed
  // in: <workspace>/hooks/teamai-status-report/handler.ts. Failures are
  // swallowed so the agent is never blocked; the child is not awaited.
  const mapLiteral = JSON.stringify(EVENT_MAP);
  return `// ${TEAMAI_MARKER} status-report handler — generated by teamai, do not edit.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENT_MAP: Record<string, string> = ${mapLiteral};
const TOOL = ${JSON.stringify(tool)};
const HOOK_WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type HookEvent = { type?: unknown; action?: unknown; sessionKey?: unknown; context?: { workspaceDir?: unknown } | null };

export default async function handler(event?: HookEvent): Promise<void> {
  if (!event || typeof event.type !== 'string' || typeof event.action !== 'string') return;
  const key = event.type + ':' + event.action;
  const dispatchEvent = Object.hasOwn(EVENT_MAP, key) ? EVENT_MAP[key] : undefined;
  if (!dispatchEvent) return;
  const workspaceDir = event.context?.workspaceDir;
  const payload: Record<string, string> = {
    cwd: typeof workspaceDir === 'string' && workspaceDir ? workspaceDir : HOOK_WORKSPACE,
  };
  if (typeof event.sessionKey === 'string' && event.sessionKey) payload.session_id = event.sessionKey;
  try {
    const child = spawn('teamai', ['hook-dispatch', dispatchEvent, '--tool', TOOL], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => {});
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(payload));
  } catch {
    // never block the agent
  }
}
`;
}

/**
 * Inject (or refresh) the teamai OpenClaw hook.
 *
 * Writes into the resolved OpenClaw workspace directory (the same location
 * skills sync to and the engine reads from), NOT the HOME-relative
 * `~/.<tool>/hooks` — writing there left the hook where the engine never
 * looks, so status reporting silently stopped. Idempotent — writes and reports
 * the two files only when their content changes. Skips (no-op) when the
 * workspace dir cannot be resolved.
 *
 * @param workspacePath optional server-sent workspace path (highest priority)
 * @param tool          claw variant (openclaw/qclaw/easyclaw/autoclaw)
 */
export async function injectOpenClawHooks(workspacePath?: string, tool = 'openclaw'): Promise<void> {
  const wsDir = await resolveOpenclawWorkspaceDir(workspacePath);
  if (!wsDir) {
    log.debug(`openclaw: skip hook injection for ${tool} — workspace dir not found`);
    return;
  }
  const dir = path.join(wsDir, 'hooks', OPENCLAW_HOOK_DIR);
  const hookMdChanged = await writeIfChanged(path.join(dir, 'HOOK.md'), buildHookMd(tool));
  const handlerChanged = await writeIfChanged(path.join(dir, 'handler.ts'), buildHandlerTs(tool));
  if (hookMdChanged || handlerChanged) {
    log.success(`Injected teamai OpenClaw hook into ${dir}`);
  } else {
    log.debug(`teamai OpenClaw hook already up-to-date in ${dir}`);
  }
  // openclaw-only: other claw variants are not known to use this config.
  if (tool === 'openclaw') await enableOpenClawHookEntry(OPENCLAW_HOOK_KEY, 'workspace');
}

type OpenclawInternalHooks = {
  enabled?: unknown;
  entries?: Record<string, { enabled?: unknown } | undefined>;
  load?: { extraDirs?: unknown };
};

function internalHooksOf(cfg: Record<string, unknown>): OpenclawInternalHooks {
  const hooks = cfg.hooks as { internal?: unknown } | undefined;
  const internal = hooks && typeof hooks === 'object' ? hooks.internal : undefined;
  return internal && typeof internal === 'object' ? internal as OpenclawInternalHooks : {};
}

/**
 * True when OpenClaw would load every hook it discovers with these entries:
 * master flag on, no named entry, no extra dir (src/hooks/configured.ts).
 */
function isOpenEndedDiscovery(internal: OpenclawInternalHooks, entries: Record<string, unknown>): boolean {
  const extraDirs = internal.load?.extraDirs;
  const hasExtraDirs = Array.isArray(extraDirs) && extraDirs.some((d) => typeof d === 'string' && d.trim());
  return internal.enabled === true && !Object.keys(entries).some((name) => name.trim()) && !hasExtraDirs;
}

/** True when OpenClaw's config loads teamai's workspace hook: internal hooks on and its entry enabled. */
export async function isOpenclawHookEnabled(): Promise<boolean> {
  const read = await readJsonObject(resolveOpenclawConfigPath());
  if (read.kind !== 'ok') return false;
  const internal = internalHooksOf(read.value);
  return internal.enabled !== false && internal.entries?.[OPENCLAW_HOOK_KEY]?.enabled === true;
}

/**
 * Enable one of teamai's hooks in OpenClaw's config, by its hook key.
 *
 * OpenClaw loads a workspace hook only when
 * `hooks.internal.entries.<hookKey>.enabled` is true, and once any named entry
 * exists only the named hooks load (docs/automation/hooks/configuration.md).
 * This writes the entry, deep-merged so every other field stays, and without
 * the master flag, so removing the entry restores the config.
 *
 * Adding the first named entry turns open-ended discovery into an allowlist
 * of one, which would silently stop every other hook. There a managed hook
 * already loads and needs nothing; for the workspace hook the config is left
 * alone and a warning names the command that enables it. The same warning is
 * given when the user switched internal hooks or this entry off, or the config
 * is not plain JSON. No-op when the config's directory does not exist.
 */
async function enableOpenClawHookEntry(hookKey: string, source: 'workspace' | 'managed'): Promise<void> {
  const cfgPath = resolveOpenclawConfigPath();
  if (!await pathExists(path.dirname(cfgPath))) {
    log.debug(`openclaw: skip enabling ${hookKey} — ${path.dirname(cfgPath)} does not exist`);
    return;
  }
  const enableCmd = `\`openclaw hooks enable ${hookKey}\``;
  const read = await readJsonObject(cfgPath);
  if (read.kind === 'invalid') {
    log.warn(`OpenClaw: teamai cannot read ${cfgPath} as plain JSON (${read.error}), so it cannot enable `
      + `its hook ${hookKey} there; the hook does not run until you run ${enableCmd}.`);
    return;
  }
  const config = read.kind === 'ok' ? read.value : {};
  const internal = internalHooksOf(config);
  const entries = internal.entries && typeof internal.entries === 'object' ? internal.entries : {};
  const entry = entries[hookKey];
  if (internal.enabled === false) {
    log.warn(`OpenClaw internal hooks are switched off (hooks.internal.enabled: false in ${cfgPath}), `
      + `so teamai's hook ${hookKey} does not run. teamai leaves that setting to you: run ${enableCmd} to turn them on.`);
    return;
  }
  if (entry?.enabled === true) {
    log.debug(`openclaw: ${hookKey} already enabled`);
    return;
  }
  if (entry?.enabled === false) {
    log.warn(`teamai's OpenClaw hook ${hookKey} is disabled in ${cfgPath} (hooks.internal.entries.${hookKey}), `
      + `so it does not run. Run ${enableCmd} to turn it back on.`);
    return;
  }
  if (isOpenEndedDiscovery(internal, entries)) {
    if (source === 'managed') return;
    log.warn(`OpenClaw loads every hook it discovers (${cfgPath} turns internal hooks on with no named entries). `
      + `Enabling teamai's hook adds the first named entry, which makes that an allowlist and stops the other hooks, `
      + `so teamai left the config unchanged and its hook does not run. Run ${enableCmd}, `
      + `then \`openclaw hooks enable <name>\` for each other hook you use.`);
    return;
  }
  const hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks as Record<string, unknown> : {};
  config.hooks = { ...hooks, internal: { ...internal, entries: { ...entries, [hookKey]: { ...entry, enabled: true } } } };
  try {
    await writeJsonAtomic(cfgPath, config);
    log.success(`Enabled the teamai OpenClaw hook ${hookKey} in ${cfgPath}`);
  } catch (e) {
    log.warn(`OpenClaw: could not enable the teamai hook ${hookKey} in ${cfgPath}: ${(e as Error).message}. Run ${enableCmd}.`);
  }
}

/** `obj` without `key`; `undefined` when nothing is left. */
function withoutKey(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const { [key]: _dropped, ...rest } = obj;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Take one of teamai's entries back out of openclaw.json (uninstall,
 * `hooks remove`, a removed agent hook), dropping parents it leaves empty.
 *
 * Kept when removing it would turn the allowlist the entry made back into
 * open-ended discovery (master flag on, no other named entry).
 */
export async function removeOpenClawHookEntry(hookKey: string = OPENCLAW_HOOK_KEY): Promise<void> {
  const cfgPath = resolveOpenclawConfigPath();
  const read = await readJsonObject(cfgPath);
  if (read.kind === 'missing') return;
  if (read.kind === 'invalid') {
    log.warn(`OpenClaw: teamai cannot read ${cfgPath} as plain JSON (${read.error}), so it left `
      + `hooks.internal.entries.${hookKey} there; remove it by hand or run \`openclaw hooks disable ${hookKey}\`.`);
    return;
  }
  const cfg = read.value;
  const internal = internalHooksOf(cfg);
  const entries = internal.entries;
  if (!entries || typeof entries !== 'object' || !Object.hasOwn(entries, hookKey)) return;
  const rest = withoutKey(entries, hookKey);
  if (isOpenEndedDiscovery(internal, rest ?? {})) {
    log.debug(`openclaw: keeping ${hookKey} in ${cfgPath}; removing it would load every discovered hook`);
    return;
  }
  const nextInternal = rest ? { ...internal, entries: rest } : withoutKey(internal, 'entries');
  const hooks = cfg.hooks as Record<string, unknown>;
  const nextHooks = nextInternal ? { ...hooks, internal: nextInternal } : withoutKey(hooks, 'internal');
  const next = nextHooks ? { ...cfg, hooks: nextHooks } : withoutKey(cfg, 'hooks') ?? {};
  await writeJsonAtomic(cfgPath, next);
  log.success(`Removed the teamai OpenClaw hook entry ${hookKey} from ${cfgPath}`);
}

/** Remove the teamai OpenClaw hook from `<hooksDir>` if present. */
export async function removeOpenClawHooks(hooksDir: string): Promise<void> {
  const dir = path.join(hooksDir, OPENCLAW_HOOK_DIR);
  if (await pathExists(dir)) {
    await remove(dir);
    log.success(`Removed teamai OpenClaw hook from ${dir}`);
  }
  // Also check the state dir (OPENCLAW_STATE_DIR or the profile's) in case the hook was installed there
  const altDir = path.join(resolveOpenclawStateDir(), 'hooks', OPENCLAW_HOOK_DIR);
  if (altDir !== dir && await pathExists(altDir)) {
    await remove(altDir);
    log.success(`Removed teamai OpenClaw hook from ${altDir}`);
  }
}

/**
 * Map Claude PascalCase agent-hook events → the OpenClaw events that mean the
 * same (docs/automation/hooks/event-types.md). OpenClaw emits no
 * `session:start`: a session begins with `/new` or `/reset`.
 */
const CLAUDE_TO_OPENCLAW_EVENTS: Record<string, string[]> = {
  SessionStart: ['command:new', 'command:reset'],
  UserPromptSubmit: ['message:received'],
};

/** The key a server-pushed agent hook is selected and configured under in openclaw.json. */
function agentHookKey(slug: string): string {
  return `teamai-agent-${slug}`;
}

function buildAgentHookMd(slug: string, openclawEvents: string[]): string {
  const metadata = JSON.stringify({ openclaw: { events: openclawEvents, hookKey: agentHookKey(slug) } });
  return [
    '---',
    // Quoted: a bare `[teamai] ...` is not valid YAML (see buildHookMd).
    `name: ${JSON.stringify(`${TEAMAI_MARKER} ${slug}`)}`,
    `metadata:`,
    `  ${metadata}`,
    `handler: ./handler.ts`,
    '---',
    '',
    `${TEAMAI_MARKER} Agent hook [${slug}] — managed by teamai, do not edit by hand.`,
    '',
  ].join('\n');
}

function buildAgentHandlerTs(command: string, timeout: number): string {
  const timeoutMs = timeout * 1000;
  return [
    `// ${TEAMAI_MARKER} agent hook handler — generated by teamai, do not edit.`,
    `import { spawn } from 'node:child_process';`,
    '',
    `export default async function handler(): Promise<void> {`,
    '  try {',
    `    const child = spawn('sh', ['-c', ${JSON.stringify(command)}], {`,
    `      stdio: ['inherit', 'ignore', 'ignore'],`,
    `      timeout: ${timeoutMs},`,
    '    });',
    "    child.on('error', () => {});",
    '  } catch {',
    '    // never block the agent',
    '  }',
    '}',
    '',
  ].join('\n');
}

/**
 * Install a server-pushed agent hook as an OpenClaw hook directory.
 * Creates `~/<tool-root>/hooks/<slug>/HOOK.md + handler.ts`.
 * Events that have no OpenClaw equivalent are logged and skipped.
 */
export async function applyOpenClawAgentHook(def: {
  slug: string;
  event: string;
  command: string;
  tool?: string;
  matcher?: string;
  timeout?: number;
}): Promise<void> {
  const openclawEvents = CLAUDE_TO_OPENCLAW_EVENTS[def.event];
  if (!openclawEvents) {
    log.warn(`OpenClaw does not support event "${def.event}" — skipping hook [${def.slug}]`);
    return;
  }
  const tool = def.tool ?? 'openclaw';
  const hooksDir = resolveOpenClawHooksDir(tool);
  const dir = path.join(hooksDir, def.slug);
  await ensureDir(dir);
  await writeFile(path.join(dir, 'HOOK.md'), buildAgentHookMd(def.slug, openclawEvents));
  await writeFile(path.join(dir, 'handler.ts'), buildAgentHandlerTs(def.command, def.timeout ?? 10));
  log.success(`Installed OpenClaw agent hook [${def.slug}] in ${dir}`);
  // Once openclaw.json names any hook (teamai's own does), only named hooks load.
  if (tool === 'openclaw') await enableOpenClawHookEntry(agentHookKey(def.slug), 'managed');
}

/**
 * Remove a server-pushed agent hook directory for an OpenClaw-family tool.
 */
export async function removeOpenClawAgentHook(opts: {
  slug: string;
  tool?: string;
}): Promise<void> {
  const tool = opts.tool ?? 'openclaw';
  const hooksDir = resolveOpenClawHooksDir(tool);
  const dir = path.join(hooksDir, opts.slug);
  if (await pathExists(dir)) {
    await remove(dir);
    log.success(`Removed OpenClaw agent hook [${opts.slug}] from ${dir}`);
  }
  if (tool === 'openclaw') await removeOpenClawHookEntry(agentHookKey(opts.slug));
}

/** Where OpenClaw's default agent reads its workspace from, as far as teamai can tell (`resolveOpenclawWorkspace`). */
export type OpenclawWorkspace =
  | { readonly kind: 'found'; readonly dir: string }
  | { readonly kind: 'none'; readonly tried: string }
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
export async function resolveOpenclawWorkspace(workspacePath?: string): Promise<OpenclawWorkspace> {
  if (workspacePath && await pathExists(workspacePath)) return { kind: 'found', dir: workspacePath };
  const cfgPath = resolveOpenclawConfigPath();
  const read = await readJsonObject(cfgPath);
  const agents = read.kind === 'ok' ? read.value.agents as { defaults?: { workspace?: unknown } } | undefined : undefined;
  const configured = agents?.defaults?.workspace;
  const envDir = process.env.OPENCLAW_WORKSPACE_DIR?.trim();
  const candidate = typeof configured === 'string' && configured.trim()
    ? path.resolve(expandHome(configured.trim()))
    : envDir
      ? path.resolve(expandHome(envDir))
      : path.join(resolveOpenclawStateDir(), 'workspace');
  const exists = await pathExists(candidate);
  if (read.kind === 'invalid') {
    return { kind: 'unreadable-config', file: cfgPath, error: read.error, fallback: exists ? candidate : null };
  }
  return exists ? { kind: 'found', dir: candidate } : { kind: 'none', tried: [workspacePath, candidate].filter(Boolean).join(', ') };
}

/**
 * The workspace directory OpenClaw's hooks and skills go to, or null
 * (`resolveOpenclawWorkspace`). An unreadable openclaw.json falls back to
 * the workspace `OPENCLAW_WORKSPACE_DIR` or the state dir gives.
 */
export async function resolveOpenclawWorkspaceDir(workspacePath?: string): Promise<string | null> {
  const workspace = await resolveOpenclawWorkspace(workspacePath);
  if (workspace.kind === 'unreadable-config') {
    log.debug(`openclaw: could not parse ${workspace.file} as JSON: ${workspace.error}`);
    if (workspace.fallback !== null) log.debug(`openclaw: resolved workspace dir to ${workspace.fallback}`);
    return workspace.fallback;
  }
  if (workspace.kind === 'found') {
    log.debug(`openclaw: resolved workspace dir to ${workspace.dir}`);
    return workspace.dir;
  }
  // A missing workspace dir is the normal case when OpenClaw is not installed;
  // callers treat null as "skip openclaw" and log their own debug line, so keep
  // this at debug level to avoid warning noise (one line per skill/file) on
  // machines without OpenClaw.
  log.debug(`openclaw: no workspace dir found (tried: ${workspace.tried})`);
  return null;
}
