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
 * OPENCLAW_HOME, OPENCLAW_PROFILE, OPENCLAW_CONFIG_PATH, OPENCLAW_WORKSPACE_DIR.
 *
 * Events (OpenClaw calls the handler with `{ type, action, sessionKey, context }`):
 *   command:new, command:reset, session:auto-reset, gateway:startup
 *                      → session-start dispatch (report + sync);
 *   message:received   → prompt-submit dispatch (sync only).
 *
 * The team's hooks need what an internal hook cannot do (block a tool call,
 * add context to a prompt), so they run from a standalone plugin,
 * `<state dir>/teamai/teamai-team-hooks.mjs`, which openclaw.json loads
 * (`plugins.load.paths`) and enables (`plugins.entries.teamai-team-hooks`)
 * while the team has hooks for OpenClaw.
 */

import path from 'node:path';
import { writeIfChanged, pathExists, readJsonObject, writeJsonAtomic, remove, symlinkTarget } from './utils/fs.js';
import { log } from './utils/logger.js';
import { getUserHome } from './utils/home.js';
import { resolveOpenclawConfigPath, resolveOpenclawStateDir } from './openclaw-home.js';
import { resolveCliEntry } from './builtin-hooks.js';
import { openclawWorkspaceDir } from './locate.js';
import { bridgedTeamHookEvents, bridgedTeamHookFile } from './bridged-team-hooks.js';

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

function buildHandlerTs(tool: string, entry: string): string {
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
const NODE = ${JSON.stringify(process.execPath)};
const ENTRY = ${JSON.stringify(entry)};
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
    const child = spawn(NODE, [ENTRY, 'hook-dispatch', dispatchEvent, '--tool', TOOL], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
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
 * @param tool claw variant (openclaw/qclaw/easyclaw/autoclaw)
 */
export async function injectOpenClawHooks(tool = 'openclaw'): Promise<void> {
  const entry = resolveCliEntry();
  if (!entry) {
    log.warn('OpenClaw: cannot resolve the teamai CLI entry; run `teamai hooks inject` from the installed CLI.');
    return;
  }
  const wsDir = await openclawWorkspaceDir();
  if (!wsDir) {
    log.debug(`openclaw: skip hook injection for ${tool} — workspace dir not found`);
    return;
  }
  const dir = path.join(wsDir, 'hooks', OPENCLAW_HOOK_DIR);
  const hookMdChanged = await writeIfChanged(path.join(dir, 'HOOK.md'), buildHookMd(tool));
  const handlerChanged = await writeIfChanged(path.join(dir, 'handler.ts'), buildHandlerTs(tool, entry));
  if (hookMdChanged || handlerChanged) {
    log.success(`Injected teamai OpenClaw hook into ${dir}`);
  } else {
    log.debug(`teamai OpenClaw hook already up-to-date in ${dir}`);
  }
  // openclaw-only: other claw variants are not known to use this config.
  if (tool === 'openclaw') {
    await enableOpenClawHookEntry(OPENCLAW_HOOK_KEY);
    await reconcileOpenClawTeamHooks(entry, wsDir);
  }
}

/** Reconcile only the team hooks plugin, leaving teamai's own OpenClaw hook as it is. */
export async function refreshOpenClawTeamHooks(): Promise<void> {
  const entry = resolveCliEntry();
  if (!entry) {
    log.warn('OpenClaw: cannot resolve the teamai CLI entry; run `teamai hooks inject` from the installed CLI.');
    return;
  }
  const wsDir = await openclawWorkspaceDir();
  if (wsDir) await reconcileOpenClawTeamHooks(entry, wsDir);
}

/** The team-hook plugin's id, which OpenClaw takes from its file name. */
const TEAM_HOOK_PLUGIN = 'teamai-team-hooks';

/**
 * In a directory of its own: OpenClaw reads a standalone plugin's manifest,
 * when there is one, from the file's directory.
 */
function openclawTeamHookPluginFile(stateDir = resolveOpenclawStateDir()): string {
  return path.join(stateDir, 'teamai', `${TEAM_HOOK_PLUGIN}.mjs`);
}

/** The entry teamai writes under `plugins.entries`: conversation access lets the plugin read the prompt. */
const TEAM_HOOK_PLUGIN_ENTRY = { enabled: true, hooks: { allowConversationAccess: true } };

/** OpenClaw's longest handler timeout; past it a before_tool_call fails closed. */
const OPENCLAW_MAX_HANDLER_MS = 600000;

function buildTeamHookPluginSource(entry: string, workspace: string): string {
  return `// ${TEAMAI_MARKER} team hooks plugin — generated by teamai, do not edit by hand.
//
// Runs the team's hooks (hooks/hooks.yaml) through
// \`teamai hook-dispatch <Event> --tool openclaw --team-hooks\`, on the events
// the team has hooks on: a PreToolUse hook can block a tool call, SessionStart
// (on a session's first prompt) and UserPromptSubmit hooks add context to the
// prompt, PostToolUse and Stop hooks observe. Never throws: OpenClaw blocks a
// tool call whose before_tool_call handler fails.

import { spawn } from "node:child_process";
import fs from "node:fs";

const NODE = ${JSON.stringify(process.execPath)};
const ENTRY = ${JSON.stringify(entry)};
const TEAM_HOOKS_FILE = ${JSON.stringify(bridgedTeamHookFile('openclaw'))};
/** Where a session runs when OpenClaw does not say: the agent workspace. */
const WORKSPACE = ${JSON.stringify(workspace)};
const HANDLER_TIMEOUT_MS = ${OPENCLAW_MAX_HANDLER_MS};
/** Ends the run before OpenClaw gives up on the handler. */
const TEAM_HOOKS_TIMEOUT_MS = HANDLER_TIMEOUT_MS - 10000;

/** A tool call's context has no workspace, so each session's comes from its prompt. */
const workspaces = new Map();
/** Sessions whose SessionStart hooks ran. */
const started = new Set();

const sessionOf = (ctx) => ctx.sessionId || ctx.sessionKey;

// {block} for a PreToolUse hook that refuses, {context} for what a
// SessionStart or UserPromptSubmit hook adds, else undefined. What a hook
// wrote on stderr goes to OpenClaw's console.
const teamHooks = (event, ctx, payload) => new Promise((resolve) => {
  try {
    const hooks = JSON.parse(fs.readFileSync(TEAM_HOOKS_FILE, "utf8")).hooks;
    if (!hooks || !Array.isArray(hooks[event]) || hooks[event].length === 0) return resolve(undefined);
    const session = sessionOf(ctx);
    const cwd = ctx.workspaceDir || workspaces.get(session) || WORKSPACE;
    const child = spawn(NODE, [ENTRY, "hook-dispatch", event, "--tool", "openclaw", "--team-hooks"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let out = "";
    let err = "";
    const finish = () => {
      clearTimeout(timer);
      if (err.trim()) console.error(err.trimEnd());
      err = "";
      try {
        resolve(out.trim() ? JSON.parse(out) : undefined);
      } catch {
        resolve(undefined);
      }
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      out = "";
      finish();
    }, TEAM_HOOKS_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.stderr?.on("data", (chunk) => { err += chunk; });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ cwd, ...(session ? { session_id: session } : {}), ...(payload || {}) }));
    child.once("close", finish);
    child.once("error", () => { out = ""; finish(); });
  } catch {
    resolve(undefined);
  }
});

export default {
  id: ${JSON.stringify(TEAM_HOOK_PLUGIN)},
  name: "teamai team hooks",
  description: "Runs the team's hooks from hooks/hooks.yaml.",
  register(api) {
    api.on("before_prompt_build", async (event, ctx) => {
      const session = sessionOf(ctx);
      if (ctx.workspaceDir) workspaces.set(session, ctx.workspaceDir);
      const first = !started.has(session);
      started.add(session);
      const start = first ? await teamHooks("SessionStart", ctx) : undefined;
      // currentUserMessage is the member's request; prompt may hold the history OpenClaw rebuilt.
      const prompt = await teamHooks("UserPromptSubmit", ctx, { prompt: event.currentUserMessage ?? event.prompt });
      const added = [start?.context, prompt?.context].filter((part) => typeof part === "string" && part);
      return added.length ? { prependContext: added.join("\\n\\n") } : undefined;
    }, { timeoutMs: HANDLER_TIMEOUT_MS });

    api.on("before_tool_call", async (event, ctx) => {
      const decision = await teamHooks("PreToolUse", ctx, { tool_name: event.toolName, tool_input: event.params });
      return decision && typeof decision.block === "string" ? { block: true, blockReason: decision.block } : undefined;
    }, { timeoutMs: HANDLER_TIMEOUT_MS });

    api.on("after_tool_call", async (event, ctx) => {
      await teamHooks("PostToolUse", ctx, { tool_name: event.toolName, tool_input: event.params, tool_response: event.error ?? event.result });
    });

    api.on("agent_end", async (_event, ctx) => {
      await teamHooks("Stop", ctx);
    });
  },
};
`;
}

/**
 * Install the team-hook plugin and load it from openclaw.json while the team
 * has hooks for OpenClaw (the bridged file), and take both out otherwise.
 */
async function reconcileOpenClawTeamHooks(entry: string, wsDir: string): Promise<void> {
  if ((await bridgedTeamHookEvents('openclaw')).size === 0) {
    await removeOpenClawTeamHooks();
    return;
  }
  const file = openclawTeamHookPluginFile();
  if (await writeIfChanged(file, buildTeamHookPluginSource(entry, wsDir))) log.success(`Installed the teamai OpenClaw team hooks plugin at ${file}`);
  await updateOpenClawPluginConfig(file, 'load');
}

/** Remove the team-hook plugin and its openclaw.json entries. */
export async function removeOpenClawTeamHooks(): Promise<void> {
  const file = openclawTeamHookPluginFile();
  await updateOpenClawPluginConfig(file, 'unload');
  if (await pathExists(file)) {
    await remove(path.dirname(file));
    log.success(`Removed the teamai OpenClaw team hooks plugin from ${file}`);
  }
}

type PluginsConfig = { enabled?: unknown; allow?: unknown; deny?: unknown; load?: { paths?: unknown }; entries?: Record<string, unknown> };

function pluginsOf(config: Record<string, unknown>): PluginsConfig {
  return config.plugins && typeof config.plugins === 'object' ? config.plugins as PluginsConfig : {};
}

/** Why the plugin does not load under this config and the fix, or null when it loads once listed and enabled. */
function teamHookPluginBlocker(plugins: PluginsConfig): string | null {
  const listed = (list: unknown) => Array.isArray(list) && list.includes(TEAM_HOOK_PLUGIN);
  if (plugins.enabled === false) return 'plugins are switched off (plugins.enabled: false); turn them on';
  if (listed(plugins.deny)) return `plugins.deny lists ${TEAM_HOOK_PLUGIN}; take it out`;
  if (Array.isArray(plugins.allow) && plugins.allow.length > 0 && !listed(plugins.allow)) return `plugins.allow does not list ${TEAM_HOOK_PLUGIN}; add it`;
  const entry = plugins.entries?.[TEAM_HOOK_PLUGIN];
  if (entry && typeof entry === 'object' && (entry as { enabled?: unknown }).enabled === false) return `plugins.entries.${TEAM_HOOK_PLUGIN}.enabled is false; set it to true`;
  return null;
}

/** `config` with the plugin's load path and entry added (`load`) or taken out (`unload`), dropping parents left empty. */
function withTeamHookPlugin(config: Record<string, unknown>, file: string, action: 'load' | 'unload'): Record<string, unknown> {
  const plugins = pluginsOf(config);
  const paths = Array.isArray(plugins.load?.paths) ? plugins.load.paths.filter((p) => p !== file) : [];
  const entries = plugins.entries && typeof plugins.entries === 'object' ? plugins.entries : {};
  const ownEntry = JSON.stringify(entries[TEAM_HOOK_PLUGIN]) === JSON.stringify(TEAM_HOOK_PLUGIN_ENTRY);
  const nextPaths = action === 'load' ? [...paths, file] : paths;
  const nextEntries = action === 'load'
    ? { ...entries, [TEAM_HOOK_PLUGIN]: TEAM_HOOK_PLUGIN_ENTRY }
    : ownEntry ? withoutKey(entries, TEAM_HOOK_PLUGIN) ?? {} : entries;
  const load = { ...plugins.load, paths: nextPaths };
  const nextLoad = nextPaths.length > 0 ? load : withoutKey(load, 'paths');
  const next: Record<string, unknown> = { ...plugins, load: nextLoad, entries: nextEntries };
  if (!nextLoad) delete next.load;
  if (Object.keys(nextEntries).length === 0) delete next.entries;
  return Object.keys(next).length > 0 ? { ...config, plugins: next } : withoutKey(config, 'plugins') ?? {};
}

/**
 * Load (`load`) or unload the team-hook plugin in openclaw.json. When the
 * config keeps the plugin from loading (plugins off, denied, left out of an
 * allowlist, or its entry disabled), teamai leaves that choice alone and says
 * so. No-op when the config's directory does not exist.
 */
async function updateOpenClawPluginConfig(file: string, action: 'load' | 'unload'): Promise<void> {
  const cfgPath = resolveOpenclawConfigPath();
  if (!await pathExists(path.dirname(cfgPath))) return;
  const read = await readJsonObject(cfgPath);
  if (read.kind === 'missing' && action === 'unload') return;
  if (read.kind === 'invalid') {
    log.warn(action === 'load'
      ? `OpenClaw: teamai cannot read ${cfgPath} as plain JSON (${read.error}), so the team's hooks do not run. Add ${file} to plugins.load.paths by hand.`
      : `OpenClaw: teamai cannot read ${cfgPath} as plain JSON (${read.error}), so the team's hooks plugin is still listed there. Remove ${file} from plugins.load.paths by hand.`);
    return;
  }
  const config = read.kind === 'ok' ? read.value : {};
  const plugins = pluginsOf(config);
  const blocker = action === 'load' ? teamHookPluginBlocker(plugins) : null;
  if (blocker) {
    log.warn(`OpenClaw does not load teamai's team hooks plugin, so the team's hooks do not run in OpenClaw: in ${cfgPath}, ${blocker}. teamai leaves that setting to you.`);
    return;
  }
  const next = withTeamHookPlugin(config, file, action);
  if (JSON.stringify(next) === JSON.stringify(config)) return;
  await writeJsonAtomic(await symlinkTarget(cfgPath), next);
  log.success(action === 'load'
    ? `Loaded the teamai OpenClaw team hooks plugin in ${cfgPath}`
    : `Unloaded the teamai OpenClaw team hooks plugin in ${cfgPath}`);
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
 * of one, which would silently stop every other hook, so there the config is
 * left alone and a warning names the command that enables it. The same warning is
 * given when the user switched internal hooks or this entry off, or the config
 * is not plain JSON. No-op when the config's directory does not exist.
 */
async function enableOpenClawHookEntry(hookKey: string): Promise<void> {
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
    log.warn(`OpenClaw loads every hook it discovers (${cfgPath} turns internal hooks on with no named entries). `
      + `Enabling teamai's hook adds the first named entry, which makes that an allowlist and stops the other hooks, `
      + `so teamai left the config unchanged and its hook does not run. Run ${enableCmd}, `
      + `then \`openclaw hooks enable <name>\` for each other hook you use.`);
    return;
  }
  const hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks as Record<string, unknown> : {};
  config.hooks = { ...hooks, internal: { ...internal, entries: { ...entries, [hookKey]: { ...entry, enabled: true } } } };
  try {
    await writeJsonAtomic(await symlinkTarget(cfgPath), config);
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
  await writeJsonAtomic(await symlinkTarget(cfgPath), next);
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

/** The key a server-pushed agent hook is selected and configured under in openclaw.json. */
function agentHookKey(slug: string): string {
  return `teamai-agent-${slug}`;
}

/**
 * Remove the agent hook directory an earlier release installed for an
 * OpenClaw-family tool; agent hooks now run from the team-hook plugin.
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

