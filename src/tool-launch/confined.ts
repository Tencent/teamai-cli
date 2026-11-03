/**
 * Runs a prompt with one directory as the tool's only readable root, through each adapter's `confined` profile: no team
 * env or secrets, no saved session, no hooks or MCP, and `TEAMAI_LAUNCHED_BY` set so the session is never captured.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { withoutTomlBom } from '../utils/toml.js';
import { observedEffort, observedModel, type ObservedEffort, type ObservedModel } from '../agent-observation.js';
import { LAUNCHED_BY_ENV, resolveRunMode, RUN_MODE_ENV } from '../launch-context.js';
import { opencodeMajorVersion } from '../opencode-hooks.js';
import { movedToolHome, realHost, toolHome } from '../tool-home.js';
import { isToolId } from '../tools.js';
import { resolveCliPath } from '../utils/cli-path.js';
import { execCommand, probeBinary } from '../utils/exec.js';
import { agyGatewayEnv } from '../models/agy-gateway.js';
import { JsonValueSchema, type JsonValue } from '../types.js';
import type { Isolation, JudgeAccess, JudgeUsage } from '../scorers/label.js';
import { LAUNCH_ADAPTERS, type CallLaunch, type ConfinedLaunch } from './adapters.js';
import { runTool } from './run.js';
import { toolStdout } from './stdout.js';
import { CONFINED_TOOLS, executableOf, launchAdapterIdOf, opencodeModelArgs, type ConfinedTool } from './tools.js';

/** A JSON line a tool prints; a field of the wrong type reads as absent. */
const RecordSchema = z.looseObject({
  type: z.unknown().optional(),
  result: z.string().optional().catch(undefined),
  structured_output: JsonValueSchema.optional().catch(undefined),
  total_cost_usd: z.number().optional().catch(undefined),
});

const COMMON_ENV = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];
const CODEX_DISABLED = ['hooks', 'plugins', 'apps', 'browser_use', 'computer_use', 'multi_agent', 'multi_agent_v2'];

// Claude reads the prompt as a system prompt file, so its user turn only asks for the reply.
const REQUEST = 'Apply the rubric to the evidence. Return only the requested JSON answer.\n';

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
  return LAUNCH_ADAPTERS[launchAdapterIdOf(tool)].confined;
}

/** What `tool`, run confined, can do beyond answering, by its adapter's profile. */
export function confinedAccess(tool: ConfinedTool): JudgeAccess {
  return profileOf(tool).access;
}

function profileIsolation(tool: ConfinedTool, version: string, isInsideCheckout: boolean): Isolation {
  return profileOf(tool).verified?.test(version) && !isInsideCheckout ? 'verified' : 'best-effort';
}

export interface ConfinedToolLevel {
  tool: ConfinedTool;
  version: string;
  isolation: Isolation;
}

/** The version of `tool` and the level its confined profile reaches on this machine; undefined when it is not on PATH. */
export async function confinedToolLevel(tool: ConfinedTool, { resolveTool = resolveCliPath }: ToolLookup = {}): Promise<ConfinedToolLevel | undefined> {
  const executable = resolveTool(executableOf(tool));

  if (executable === null) return undefined;
  const tmp = await fs.realpath(os.tmpdir());
  const version = await probeBinary(executable, ['--version'], (command, args, options) => execCommand(command, args, { ...options, env: confinedEnv(tool), cwd: tmp }));

  return { tool, version, isolation: profileIsolation(tool, version, launchAdapterIdOf(tool) === 'opencode' && await insideCheckout(tmp)) };
}

/** Each confined tool on PATH, its version, and the level its confined profile reaches on this machine. */
export async function confinedToolLevels({ resolveTool = resolveCliPath }: ToolLookup = {}): Promise<ConfinedToolLevel[]> {
  const levels = await Promise.all(installedConfinedTools([], { resolveTool }).map((tool) => confinedToolLevel(tool, { resolveTool })));

  return levels.flatMap((level) => level ?? []);
}

/** Tools this machine runs confined at `level`, all with `access`, in launch-tool order. */
export interface ConfinedOffer {
  level: Isolation;
  access: JudgeAccess;
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

export interface ConfinedInput {
  tool: ConfinedTool;
  model?: { name: string; effort?: string };
  /** The tool's working directory and only readable root. Nothing is written into it. */
  dir: string;
  prompt: string;
  /** The JSON Schema the reply must follow, which tools that take one enforce. */
  schema?: JsonValue;
  /** The least level the run must reach; a tool that cannot reach it does not run. */
  level: Isolation;
  timeoutMs: number;
  /** The directory the tool's process group is recorded in, where `stopRecordedGroup` finds it if its caller dies. */
  group?: string;
  signal?: AbortSignal;
}

/** What ran: the tool, the model and effort observed, the level it reached, what it could do, and what it spent. */
export interface ConfinedRun {
  tool: ConfinedTool;
  model?: ObservedModel;
  effort?: ObservedEffort;
  isolation: Isolation;
  access: JudgeAccess;
  usage?: JudgeUsage;
}

export type ConfinedFailureCode = 'confined_tool_unavailable' | 'confined_failed' | 'confined_reply_invalid';

export type ConfinedResult =
  | { ok: true; reply: JsonValue; run: ConfinedRun }
  /** `raw`: the tool's saved output. `reported`: the error the tool itself reported, when it reported one. */
  | { ok: false; code: ConfinedFailureCode; message: string; raw?: string; reported?: string; usage?: JudgeUsage };

function memberEnv(): NodeJS.ProcessEnv {
  const restored = { ...process.env };

  for (const key of (restored.__TEAMAI_ENV_KEYS ?? '').split(' ').filter(Boolean)) {
    if (restored[`__TEAMAI_ENV_SET_${key}`] === '2') restored[key] = restored[`__TEAMAI_ENV_PREV_${key}`];
    else delete restored[key];
  }

  return restored;
}

function confinedEnv(tool: ConfinedTool): NodeJS.ProcessEnv {
  const restored = memberEnv();
  const { env: toolEnv, homeEnv: variable } = profileOf(tool);
  const moved = variable !== undefined && restored[variable] === undefined && isToolId(tool) ? movedToolHome(tool, realHost({ env: restored })) : null;

  const env: NodeJS.ProcessEnv = Object.fromEntries([...COMMON_ENV, ...toolEnv].flatMap((key) => restored[key] === undefined ? [] : [[key, restored[key]]]));

  if (variable !== undefined && moved !== null) env[variable] = moved;

  if (tool === 'agy') Object.assign(env, agyGatewayEnv(restored));
  env[LAUNCHED_BY_ENV] = 'scorer';
  env[RUN_MODE_ENV] = resolveRunMode(process.env);

  return env;
}

async function optionalFile(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
}

async function claudeSettings(tool: ConfinedTool, env: NodeJS.ProcessEnv, tmp: string): Promise<string> {
  const file = path.join(env.CLAUDE_CONFIG_DIR || toolHome(tool), 'settings.json');
  const text = await optionalFile(file);
  const settings = text ? z.object({ env: z.record(z.string(), z.string()).optional(), model: z.string().optional() }).parse(JSON.parse(text)) : {};
  const allowed = Object.fromEntries(Object.entries(settings.env ?? {}).filter(([key]) => profileOf(tool).env.includes(key)));
  const target = path.join(tmp, 'claude-settings.json');
  // An empty model stays undefined, which the JSON leaves out.
  await fs.writeFile(target, JSON.stringify({ env: allowed, model: settings.model || undefined }));

  return target;
}

function credentialEnv(key: string): string | undefined {
  if (['GH_TOKEN', 'GITHUB_TOKEN', 'GL_TOKEN', 'GITLAB_TOKEN', 'CI_JOB_TOKEN', 'BASH_ENV', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS'].includes(key) || key.startsWith('__TEAMAI_ENV_')) {
    throw new Error(`The confined profile uses blocked credential variable ${key}. Use a dedicated provider API-key variable instead`);
  }

  return memberEnv()[key];
}

async function codexSettings(tool: ConfinedTool, env: NodeJS.ProcessEnv) {
  const text = await optionalFile(path.join(env.CODEX_HOME || toolHome(tool), 'config.toml'));

  if (!text) return { args: [], model: undefined };
  const config = z.object({ model: z.string().optional(), model_provider: z.string().optional(), model_providers: z.record(z.string(), z.object({ name: z.string().optional(), base_url: z.string().optional(), wire_api: z.string().optional(), env_key: z.string().optional(), experimental_bearer_token: z.string().optional() })).optional() }).parse(parseToml(withoutTomlBom(text)));
  const model = config.model ? ['-c', `model=${JSON.stringify(config.model)}`] : [];
  const provider = config.model_provider && config.model_providers?.[config.model_provider];

  if (!provider) return { args: model, model: config.model };
  const overrides = ['-c', `model_provider=${JSON.stringify(config.model_provider)}`, ...model];

  for (const key of ['name', 'base_url', 'wire_api'] as const) {
    if (provider[key]) overrides.push('-c', `model_providers.${config.model_provider}.${key}=${JSON.stringify(provider[key])}`);
  }

  const credential = provider.experimental_bearer_token ?? (provider.env_key && credentialEnv(provider.env_key));

  if (credential) {
    env.TEAMAI_JUDGE_API_KEY = credential;
    overrides.push('-c', `model_providers.${config.model_provider}.env_key="TEAMAI_JUDGE_API_KEY"`);
  }

  return { args: overrides, model: config.model };
}

async function openCodeSettings(env: NodeJS.ProcessEnv, tmp: string): Promise<string | undefined> {
  const file = process.env.OPENCODE_CONFIG || path.join(toolHome('opencode'), 'opencode.json');
  const text = await optionalFile(file);
  const provider = z.object({ npm: z.enum(['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/anthropic']).optional(), name: z.string().optional(), options: z.object({ baseURL: z.string().optional(), apiKey: z.string().optional() }).optional(), models: z.record(z.string(), z.object({ name: z.string().optional() })).optional() });
  const settings = text ? z.object({ model: z.string().optional(), provider: z.record(z.string(), provider.nullable()).optional() }).parse(JSON.parse(text)) : {};

  for (const entry of Object.values(settings.provider ?? {})) {
    const key = entry?.options?.apiKey?.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];

    if (key && entry?.options) {
      const credential = credentialEnv(key);

      if (!credential) throw new Error(`OpenCode provider credential ${key} is not set`);
      entry.options.apiKey = credential;
    }
  }

  const auth = await optionalFile(path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'auth.json'));

  for (const [key, dir] of [['XDG_DATA_HOME', 'data'], ['XDG_CACHE_HOME', 'cache'], ['XDG_STATE_HOME', 'state'], ['XDG_CONFIG_HOME', 'xdg-config']] as const) {
    env[key] = path.join(tmp, dir);
    await fs.mkdir(path.join(tmp, dir), { recursive: true });
  }

  const data = path.join(tmp, 'data');
  await fs.mkdir(path.join(data, 'opencode'), { recursive: true });

  if (auth !== undefined) await fs.writeFile(path.join(data, 'opencode', 'auth.json'), auth, { mode: 0o600 });
  env.OPENCODE_DB = path.join(data, 'judge.db');
  env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  env.OPENCODE_DISABLE_CLAUDE_CODE = '1';
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  const config = path.join(tmp, 'config');
  await fs.mkdir(config);
  await fs.writeFile(path.join(config, 'opencode.json'), JSON.stringify({ ...settings,
    permission: { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow', external_directory: 'deny', bash: 'deny', edit: 'deny', webfetch: 'deny', websearch: 'deny', task: 'deny', skill: 'deny' }, plugin: [], mcp: {},
  }), { mode: 0o600 });
  env.OPENCODE_CONFIG_DIR = config;

  return settings.model;
}

/** Codex's own permission profile: its sandboxed shell reads only `dir`, with no network, no writes and core env. */
function codexProfile(dir: string): string {
  return stringifyToml({
    default_permissions: 'judge',
    web_search: 'disabled',
    agents: { enabled: false },
    shell_environment_policy: { inherit: 'core' },
    permissions: { judge: { filesystem: { ':minimal': 'read', ':tmpdir': 'none', ':slash_tmp': 'none', [dir]: 'read' }, network: { enabled: false } } },
  });
}

function records(stdout: string): Array<z.infer<typeof RecordSchema>> {
  return stdout.split('\n').flatMap((line) => {
    try { const parsed = RecordSchema.safeParse(JSON.parse(line));

 return parsed.success ? [parsed.data] : []; }
    catch { return []; }
  });
}

/** The reply in what the tool left: Codex's answer file, a result record, OpenCode's text parts, or a reply. */
async function replyFrom(tool: ConfinedTool, stdout: string, tmp: string): Promise<JsonValue | undefined> {
  const family = launchAdapterIdOf(tool);

  switch (family) {
    case 'codex':
      return parseReply(await optionalFile(path.join(tmp, 'answer.json')) ?? '');
    // Claude's result record, which CodeBuddy and Cursor print too; only Claude and CodeBuddy fill structured_output.
    case 'claude':
    case 'codebuddy':
    case 'cursor': {
      const last = records(stdout).findLast((record) => record.type === 'result');

      return last?.structured_output ?? parseReply(last?.result ?? '');
    }

    case 'opencode': {
      const texts = records(stdout).flatMap((record) => {
        const parsed = z.object({ type: z.string().optional(), part: z.object({ text: z.string().optional() }).optional() }).safeParse(record);

        return parsed.success && parsed.data.type === 'text' ? parsed.data.part?.text ?? [] : [];
      });

      return parseReply(texts.join('\n'));
    }

    case 'pi':
    case 'agy': {
      const reading = LAUNCH_ADAPTERS[family].call.read({ stdout, lastMessage: undefined });

      return reading.ok ? parseReply(reading.text) : undefined;
    }

    default: {
      const unhandled: never = family;
      throw new Error(`No confined reply reader for adapter ${String(unhandled)}`);
    }
  }
}

function parseReply(text: string): JsonValue | undefined {
  try {
    const parsed = JsonValueSchema.safeParse(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')));

    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

/** Whether `dir` or a directory above it holds `.git` or `.hg`: OpenCode then lets its file tools read the whole checkout. */
async function insideCheckout(dir: string): Promise<boolean> {
  for (let at = dir;; at = path.dirname(at)) {
    for (const marker of ['.git', '.hg']) if (await fs.access(path.join(at, marker)).then(() => true, () => false)) return true;

    if (path.dirname(at) === at) return false;
  }
}

async function noInstructionsAbove(cwd: string): Promise<void> {
  for (let dir = cwd;; dir = path.dirname(dir)) {
    if (await optionalFile(path.join(dir, 'AGENTS.md')) !== undefined) throw new Error(`OpenCode would load instructions from ${path.join(dir, 'AGENTS.md')}`);

    if (path.dirname(dir) === dir) break;
  }
}

/** What a run spent, carried on its result when the tool reported any. */
interface Spend {
  usage?: JudgeUsage;
}

function spendOf(family: ReturnType<typeof launchAdapterIdOf<ConfinedTool>>, stdout: string): Spend {
  const report = toolStdout(family, stdout);
  const reading = LAUNCH_ADAPTERS[family].call.read({ stdout, lastMessage: undefined });
  const tokens = report?.tokens ?? (reading.ok ? reading.tokens : undefined);
  const cost = records(stdout).findLast((record) => record.total_cost_usd !== undefined)?.total_cost_usd;

  if (!tokens && cost === undefined) return {};
  const usage: JudgeUsage = {};

  if (tokens?.input !== undefined) usage.inputTokens = tokens.input;

  if (tokens?.output !== undefined) usage.outputTokens = tokens.output;

  if (cost !== undefined) usage.cost = { amount: cost, unit: 'USD' };

  return { usage };
}

/**
 * Runs `input.prompt` on `input.tool` with `input.dir` as its working directory and only readable root, at least at
 * `input.level`, and returns its JSON reply with what ran. The prompt and the tool's own files go in a temporary
 * directory that is removed afterwards, never into `dir`, which may be evidence a hash covers.
 */
export async function runConfined(input: ConfinedInput, { resolveTool = resolveCliPath }: ToolLookup = {}): Promise<ConfinedResult> {
  const executable = resolveTool(executableOf(input.tool));

  if (!executable) return { ok: false, code: 'confined_tool_unavailable', message: `The ${input.tool} executable is not available on PATH. Install it, or use another tool or driver.` };
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-confined-')));

  try {
    const dir = await fs.realpath(input.dir);
    const env = confinedEnv(input.tool);
    const family = launchAdapterIdOf(input.tool);
    const codex = family === 'codex' ? await codexSettings(input.tool, env) : { args: [], model: undefined };
    let configuredModel = codex.model;

    if (family === 'codex') {
      const auth = await optionalFile(path.join(env.CODEX_HOME || toolHome(input.tool), 'auth.json'));
      env.CODEX_HOME = path.join(tmp, 'codex');
      await fs.mkdir(env.CODEX_HOME);

      if (auth !== undefined) await fs.writeFile(path.join(env.CODEX_HOME, 'auth.json'), auth, { mode: 0o600 });
      await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'), codexProfile(dir));
    }

    const version = await probeBinary(executable, ['--version'], (command, args, options) => execCommand(command, args, { ...options, env, cwd: tmp }));
    const cwd = family === 'opencode' ? path.join(tmp, 'dir') : dir;
    const checkout = family === 'opencode' && await insideCheckout(cwd);
    const isolation = version ? profileIsolation(input.tool, version, checkout) : 'best-effort';

    if (input.level === 'verified' && isolation !== 'verified') {
      return { ok: false, code: 'confined_tool_unavailable', message: checkout
        ? `OpenCode would read ${dir} inside the checkout above ${cwd}, which it lets its file tools read. Move the temp dir (TMPDIR) outside any git or hg checkout, or use another driver.`
        : `${input.tool} ${version || '(version unknown)'} has no verified judge profile. Install a supported version or use another driver.` };
    }

    let stdin = REQUEST + input.prompt;
    let args: string[];
    const model = input.model ? ['--model', input.model.name] : [];
    const jsonSchema = input.schema === undefined ? [] : ['--json-schema', JSON.stringify(input.schema)];

    switch (family) {
    case 'claude': {
      const settings = await claudeSettings(input.tool, env, tmp);
      const prompt = path.join(tmp, 'prompt.md');
      await fs.writeFile(prompt, input.prompt);
      stdin = REQUEST;
      args = ['-p', '--restricted', '--tools=Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose', ...jsonSchema, '--append-system-prompt-file', prompt, '--settings', settings, ...model, ...(input.model?.effort ? ['--effort', input.model.effort] : [])];
      break;
    }

    case 'codex': {
      const schema = path.join(tmp, 'schema.json');

      if (input.schema !== undefined) await fs.writeFile(schema, JSON.stringify(input.schema));
      args = ['-a', 'never', 'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', ...(input.schema === undefined ? [] : ['--output-schema', schema]), ...CODEX_DISABLED.flatMap((feature) => ['--disable', feature]), '-o', path.join(tmp, 'answer.json'), ...codex.args, ...model, ...(input.model?.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(input.model.effort)}`] : []), '-'];
      break;
    }

    case 'codebuddy':
      args = ['-p', '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--permission-mode', 'dontAsk', '--settings', JSON.stringify({ permissions: { allow: ['Read(./**)'] } }), '--output-format', 'json', ...jsonSchema, ...model];
      break;
    case 'cursor':
      args = ['-p', '--output-format', 'json', '--mode', 'ask', '--sandbox', 'enabled', '--trust', ...model];
      break;
    case 'pi':
      args = ['-p', '--mode', 'json', '--tools', 'read,grep,find,ls', '--no-context-files', '--no-extensions', '--no-skills', '--no-session', ...model];
      break;
    case 'agy':
      args = ['--input-format=stream-json', '--output-format=stream-json', '--print=', '--mode', 'plan', '--sandbox', ...model];
      break;
    case 'opencode': {
      await fs.cp(dir, cwd, { recursive: true, dereference: false });
      const entries = await fs.readdir(cwd, { recursive: true, withFileTypes: true });

      if (entries.some((entry) => entry.isSymbolicLink())) throw new Error(`OpenCode would follow a symlink in ${dir}. Remove the symlink before running it confined`);
      await noInstructionsAbove(cwd);
      configuredModel = await openCodeSettings(env, tmp);
      args = ['run', '--standalone', '--format', 'json', ...opencodeModelArgs(input.model, input.model?.effort ? await opencodeMajorVersion(executable) : 2)];
      break;
    }

    default: {
      const unhandled: never = family;
      throw new Error(`No confined profile for adapter ${String(unhandled)}`);
    }
    }

    const { stdinOf }: CallLaunch = LAUNCH_ADAPTERS[family].call;
    const result = await runTool({ executable, args, cwd, env, stdin: stdinOf ? stdinOf(stdin) : stdin, timeoutMs: input.timeoutMs, detached: true, group: input.group, signal: input.signal });
    const raw = result.stdout + '\n' + result.stderr;

    if (family === 'codebuddy' && /Authentication required/.test(raw)) {
      return { ok: false, code: 'confined_tool_unavailable', message: 'CodeBuddy is not signed in. Sign in with codebuddy /login or set CODEBUDDY_API_KEY, then retry, or use another tool or driver.', raw };
    }

    const report = toolStdout(family, result.stdout);
    const spent = spendOf(family, result.stdout);

    if (family === 'opencode' && report?.session) {
      const deleted = await runTool({ executable, args: ['session', 'delete', report.session, '--standalone'], cwd, env, stdin: '', timeoutMs: input.timeoutMs, detached: true });

      if (deleted.code !== 0) return { ok: false, code: 'confined_failed', message: `OpenCode could not delete its session ${report.session}. Delete it with opencode session delete before retrying.`, raw: deleted.stderr, ...spent };
    }

    const reading = LAUNCH_ADAPTERS[family].call.read({ stdout: result.stdout, lastMessage: undefined });

    // agy exits 1 with the reason in its result, or on stderr when it refuses to start.
    const reported = !reading.ok && reading.message ? reading.message : family === 'agy' && result.code !== 0 && !result.stdout.trim() ? result.stderr.trim() : '';

    const toolError = reported
      ? { ok: false as const, code: 'confined_failed' as const, message: `${input.tool} reported an error: ${reported.replace(/\.?$/, '.')} Fix that, then retry or use another tool or driver.`, raw, reported, ...spent }
      : undefined;

    if (result.code !== 0) return toolError ?? { ok: false, code: 'confined_failed', message: `${input.tool} exited with code ${result.code}${result.timedOut ? ` after its ${input.timeoutMs} ms limit` : ''}. See the saved output, then retry or use another tool or driver.`, raw, ...spent };
    const reply = await replyFrom(input.tool, result.stdout, tmp);

    // pi exits 0 on a provider error, which its reply carries.
    if (reply === undefined && toolError) return toolError;

    if (reply === undefined) return { ok: false, code: 'confined_reply_invalid', message: `${input.tool} did not reply with JSON. See the saved output, then retry.`, raw, ...spent };
    const ranModel = observedModel({ requested: input.model?.name ?? configuredModel, reported: report?.model });
    const ranEffort = observedEffort({ requested: input.model?.effort });

    // A model or effort it did not observe stays undefined, which the JSON leaves out.
    return { ok: true, reply, run: { tool: input.tool, model: ranModel || undefined, effort: ranEffort || undefined, isolation, access: confinedAccess(input.tool), ...spent } };
  } catch (error) {
    return { ok: false, code: 'confined_failed', message: `${input.tool} could not run confined: ${error instanceof Error ? error.message : String(error)}. Fix that, then retry.` };
  } finally { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }); }
}
