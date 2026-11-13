/**
 * Runs a prompt with one directory as the tool's only readable root, through each adapter's `confined` profile: no team
 * env or secrets, no saved session, no hooks or MCP, and `TEAMAI_LAUNCHED_BY` set so the session is never captured. The
 * tools runtime launches and reads the run (`@teamai/runtime-tools/confined`); this module knows the member's machine:
 * which tools are installed and the level each reaches, the env and home a run gets, and what ran.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { withoutTomlBom } from '../utils/toml.js';
import { observedEffort, observedModel, type ObservedEffort, type ObservedModel } from '../agent-observation.js';
import { LAUNCHED_BY_ENV, resolveRunMode, RUN_MODE_ENV } from '../launch-context.js';
import { opencodeMajorVersion } from '../opencode-version.js';
import { toolHome } from '../tool-home.js';
import { mcpSyntaxOf } from '../tool-registry.js';
import { parseJsonAs } from '../utils/json.js';
import { resolveCliPath } from '@teamai/shared/cli-path';
import { execCommand, probeBinary } from '@teamai/shared/exec';
import { agyGatewayEnv } from '../models/agy-gateway.js';
import type { JsonValue } from '@teamai/shared/json';
import type { ConfinedAccess, ConfinedLaunch, ConfinedLevel } from '@teamai/tool-core/launch';
import type { ConfinedUsage } from '@teamai/tool-core/stdout';
import { confinedVariables } from '@teamai/tool-launch/confined-launch';
import { confinedIsolation, runConfined as launchConfined, type ConfinedDeps, type ConfinedFailure, type ConfinedFamily, type ConfinedRequest } from '@teamai/runtime-tools/confined';
import { CONFINED_TOOLS, executableOf, launchAdapterIdOf, launchAdapterOf, toolCommandEnv, type ConfinedTool } from '../launch-registry.js';
import { holdLoginFrom } from './runtimes/login.js';
import { resolveMemberToolRoots } from '../config.js';
import type { LocalConfig } from '../types.js';
import { AttemptIdSchema, RunIdSchema } from './store.js';

type ToolLookup = { resolveTool?: (tool: string) => string | null };

export function isConfinedTool(value: string): value is ConfinedTool {
  return CONFINED_TOOLS.some((tool) => tool === value);
}

/** The confined tools on this machine's PATH: `preferred` first, then the rest in launch-tool order. */
export function installedConfinedTools(preferred: readonly string[], { resolveTool = resolveCliPath }: ToolLookup = {}): ConfinedTool[] {
  const tools = new Set([...preferred, ...CONFINED_TOOLS].filter(isConfinedTool));

  return [...tools].filter((tool) => resolveTool(executableOf(tool)) !== null);
}

function profileOf(tool: ConfinedTool): ConfinedLaunch {
  return launchAdapterOf(tool).confined;
}

/** The launch adapter `tool` runs confined with; a confined adapter the tools runtime cannot set up fails here. */
function familyOf(tool: ConfinedTool): ConfinedFamily {
  return launchAdapterIdOf(tool);
}

/**
 * The variables a confined run of `tool` gets: the common ones, proxies included, and those its profile reads, such as
 * its API key and gateway. Of a runtime's credentials, a confined prompt on it gets these. None for a tool with no
 * confined profile.
 */
export function confinedEnvNames(tool: string): readonly string[] {
  return isConfinedTool(tool) ? confinedVariables(profileOf(tool)) : [];
}

/** What `tool`, run confined, can do beyond answering, by its adapter's profile. */
export function confinedAccess(tool: ConfinedTool): ConfinedAccess {
  return profileOf(tool).access;
}

export interface ConfinedToolLevel {
  tool: ConfinedTool;
  version: string;
  isolation: ConfinedLevel;
}

/** The version of `tool` and the level its confined profile reaches on this machine; undefined when it is not on PATH or its recorded home is gone. */
export async function confinedToolLevel(tool: ConfinedTool, { resolveTool = resolveCliPath }: ToolLookup = {}): Promise<ConfinedToolLevel | undefined> {
  const executable = resolveTool(executableOf(tool));

  if (executable === null) return undefined;
  const confined = confinedEnv(tool, await resolveMemberToolRoots());

  // Delivery skips a tool whose recorded home is gone, and so does what this machine offers.
  if (confined.kind === 'home_gone') return undefined;
  const tmp = await fs.realpath(os.tmpdir());
  const version = await probeBinary(executable, ['--version'], (command, args, options) => execCommand(command, args, { ...options, env: confined.env, cwd: tmp }));

  return { tool, version, isolation: await confinedIsolation({ profile: profileOf(tool), family: familyOf(tool), version, dir: tmp }) };
}

/** Each confined tool on PATH, its version, and the level its confined profile reaches on this machine. */
export async function confinedToolLevels({ resolveTool = resolveCliPath }: ToolLookup = {}): Promise<ConfinedToolLevel[]> {
  const levels = await Promise.all(installedConfinedTools([], { resolveTool }).map((tool) => confinedToolLevel(tool, { resolveTool })));

  return levels.flatMap((level) => level ?? []);
}

/** Tools this machine runs confined at `level`, all with `access`, in launch-tool order. */
export interface ConfinedOffer {
  level: ConfinedLevel;
  access: ConfinedAccess;
  tools: [ConfinedTool, ...ConfinedTool[]];
}

/**
 * What this machine offers, strictest level first: the tools whose profile reaches `verified`, then every installed
 * tool at `best-effort`, each level split by what its tools can do. A tool is never offered at a level it cannot reach.
 */
export async function confinedOffers(lookup: ToolLookup = {}): Promise<ConfinedOffer[]> {
  const levels = await confinedToolLevels(lookup);
  const offers: ConfinedOffer[] = [];

  for (const level of ['verified', 'best-effort'] as const) {
    for (const { tool } of levels.filter((probed) => level === 'best-effort' || probed.isolation === 'verified')) {
      const access = confinedAccess(tool);
      const offer = offers.find((existing) => existing.level === level && existing.access === access);

      if (offer) offer.tools.push(tool);
      else offers.push({ level, access, tools: [tool] });
    }
  }

  return offers;
}

/** A confined run teamai asks for: the tool, and what the runtime's request carries of the work itself. */
export type ConfinedInput = Pick<ConfinedRequest, 'model' | 'dir' | 'prompt' | 'schema' | 'level' | 'timeoutMs' | 'group' | 'attempt' | 'signal'> & { tool: ConfinedTool };

/** What ran: the tool, the model and effort observed, the level it reached, what it could do, and what it spent. */
export interface ConfinedRun {
  tool: ConfinedTool;
  model?: ObservedModel;
  effort?: ObservedEffort;
  isolation: ConfinedLevel;
  access: ConfinedAccess;
  usage?: ConfinedUsage;
}

export type ConfinedResult = { ok: true; reply: JsonValue; run: ConfinedRun } | ConfinedFailure;

function memberEnv(): NodeJS.ProcessEnv {
  const restored = { ...process.env };

  for (const key of (restored.__TEAMAI_ENV_KEYS ?? '').split(' ').filter(Boolean)) {
    if (restored[`__TEAMAI_ENV_SET_${key}`] === '2') restored[key] = restored[`__TEAMAI_ENV_PREV_${key}`];
    else delete restored[key];
  }

  return restored;
}

/** The env a confined run of `tool` starts with, or why it cannot start: the home a record names is gone. */
function confinedEnv(tool: ConfinedTool, toolRoots: LocalConfig['toolRoots']): { readonly kind: 'ready'; readonly env: NodeJS.ProcessEnv } | { readonly kind: 'home_gone'; readonly message: string } {
  const restored = memberEnv();
  const home = toolCommandEnv(tool, { kind: 'delivered', inherited: restored, toolRoots });

  if (home.kind === 'home_gone') return home;

  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(confinedEnvNames(tool).flatMap((key) => restored[key] === undefined ? [] : [[key, restored[key]]])),
    ...home.env,
  };

  if (tool === 'agy') Object.assign(env, agyGatewayEnv(restored));
  env[LAUNCHED_BY_ENV] = 'confined';
  env[RUN_MODE_ENV] = resolveRunMode(process.env);

  return { kind: 'ready', env };
}

/** How teamai reads the member's config files a confined run carries over, given to the tools runtime once. */
const CONFINED_DEPS: ConfinedDeps = {
  opencodeMajor: opencodeMajorVersion,
  parseOpenCodeConfig: (text) => parseJsonAs(text, mcpSyntaxOf('opencode', 'user')),
  parseCodexConfig: (text) => parseToml(withoutTomlBom(text)),
  judgeKeyVariable: 'TEAMAI_JUDGE_API_KEY',
  async holdCodexLogin({ executable, from, toolHome: home, attempt, signal }) {
    const held = await holdLoginFrom({ tool: 'codex', executable, from, toolHome: home, run: RunIdSchema.parse(attempt.run), attempt: AttemptIdSchema.parse(attempt.attempt), signal });

    if (!held.ok) return { ok: false, code: held.failure.code === 'login_held' ? 'login_held' : 'login_missing', message: held.failure.message };

    return {
      ok: true,
      release: async () => {
        const kept = await held.release();

        return kept && { code: 'login_not_written_back', message: kept.message };
      },
    };
  },
  toolCommandEnv: (tool, dir) => toolCommandEnv(tool, { kind: 'at', dir }),
};

/**
 * Runs `input.prompt` on `input.tool` with `input.dir` as its working directory and only readable root, at least at
 * `input.level`, and returns its JSON reply with what ran.
 */
export async function runConfined(input: ConfinedInput, { resolveTool = resolveCliPath }: ToolLookup = {}): Promise<ConfinedResult> {
  const executable = resolveTool(executableOf(input.tool));

  if (!executable) return { ok: false, code: 'confined_tool_unavailable', message: `The ${input.tool} executable is not available on PATH. Install it, or use another tool or driver.` };

  let machine: Pick<ConfinedRequest, 'env' | 'memberEnv' | 'home'>;

  // The runtime reports its own failures; what the member's machine gives the run is read here, before it starts.
  try {
    const confined = confinedEnv(input.tool, await resolveMemberToolRoots());

    if (confined.kind === 'home_gone') return { ok: false, code: 'confined_tool_unavailable', message: confined.message };
    machine = { env: confined.env, memberEnv: memberEnv(), home: toolHome(input.tool) };
  } catch (error) {
    return { ok: false, code: 'confined_failed', message: `${input.tool} could not run confined: ${error instanceof Error ? error.message : String(error)}. Fix that, then retry.` };
  }

  const end = await launchConfined({
    ...input, family: familyOf(input.tool), adapter: { call: launchAdapterOf(input.tool).call, confined: profileOf(input.tool) }, executable, ...machine,
  }, CONFINED_DEPS);

  if (!end.ok) return end;
  const model = observedModel({ requested: input.model?.name ?? end.configuredModel, reported: end.reportedModel });
  const effort = observedEffort({ requested: input.model?.effort });
  const run: ConfinedRun = { tool: input.tool, model: model || undefined, effort: effort || undefined, isolation: end.isolation, access: confinedAccess(input.tool), ...(end.usage && { usage: end.usage }) };

  return { ok: true, reply: end.reply, run };
}
