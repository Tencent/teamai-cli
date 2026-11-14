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
import { toolHome } from '../tool-home.js';
import { mcpSyntaxOf } from '../tool-registry.js';
import { parseJsonAs } from '../utils/json.js';
import { resolveCliPath } from '../utils/cli-path.js';
import { execCommand, probeBinary } from '../utils/exec.js';
import { agyGatewayEnv } from '../models/agy-gateway.js';
import { resolveMemberToolRoots } from '../config.js';
import { JsonValueSchema, type JsonValue, type LocalConfig } from '../types.js';
import type { ConfinedLevel, ConfinedUsage } from './confined-level.js';
import type { CallLaunch, ConfinedAccess, ConfinedLaunch } from '@teamai/tool-core/launch';
import { runTool, type ToolRun } from './run.js';
import { toolStdout, type TokenUsage } from './stdout.js';
import { CONFINED_TOOLS, executableOf, launchAdapterIdOf, launchAdapterOf, opencodeModelArgs, toolCommandEnv, type ConfinedTool } from './tools.js';

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
const REQUEST = 'Answer from the files in this directory alone. Return only the requested JSON answer.\n';

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

/** What `tool`, run confined, can do beyond answering, by its adapter's profile. */
export function confinedAccess(tool: ConfinedTool): ConfinedAccess {
  return profileOf(tool).access;
}

function profileIsolation(tool: ConfinedTool, version: string, isInsideCheckout: boolean): ConfinedLevel {
  return profileOf(tool).verified?.test(version) && !isInsideCheckout ? 'verified' : 'best-effort';
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

  return { tool, version, isolation: profileIsolation(tool, version, launchAdapterIdOf(tool) === 'opencode' && await insideCheckout(tmp)) };
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

export interface ConfinedInput {
  tool: ConfinedTool;
  model?: { name: string; effort?: string };
  /** The tool's working directory and only readable root. Nothing is written into it. */
  dir: string;
  prompt: string;
  /** The JSON Schema the reply must follow, which tools that take one enforce. */
  schema?: JsonValue;
  /** The least level the run must reach; a tool that cannot reach it does not run. */
  level: ConfinedLevel;
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
  isolation: ConfinedLevel;
  access: ConfinedAccess;
  usage?: ConfinedUsage;
}

export type ConfinedFailureCode = 'confined_tool_unavailable' | 'confined_failed' | 'confined_reply_invalid';

export type ConfinedResult =
  | { ok: true; reply: JsonValue; run: ConfinedRun }
  /** `raw`: the tool's saved output. `reported`: the error the tool itself reported, when it reported one. */
  | { ok: false; code: ConfinedFailureCode; message: string; raw?: string; reported?: string; usage?: ConfinedUsage };

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
    ...Object.fromEntries([...COMMON_ENV, ...profileOf(tool).env].flatMap((key) => restored[key] === undefined ? [] : [[key, restored[key]]])),
    ...home.env,
  };

  if (tool === 'agy') Object.assign(env, agyGatewayEnv(restored));
  env[LAUNCHED_BY_ENV] = 'confined';
  env[RUN_MODE_ENV] = resolveRunMode(process.env);

  return { kind: 'ready', env };
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

const CodexProviderSchema = z.object({ name: z.string().optional(), base_url: z.string().optional(), wire_api: z.string().optional(), env_key: z.string().optional(), experimental_bearer_token: z.string().optional() });

const CodexConfigSchema = z.object({ model: z.string().optional(), model_provider: z.string().optional(), model_providers: z.record(z.string(), CodexProviderSchema).optional() });

/** The overrides that keep the member's provider `name`, with its credential in a variable the confined env carries. */
function codexProviderArgs(name: string, provider: z.infer<typeof CodexProviderSchema>, env: NodeJS.ProcessEnv): string[] {
  const overrides: string[] = [];

  for (const key of ['name', 'base_url', 'wire_api'] as const) {
    if (provider[key]) overrides.push('-c', `model_providers.${name}.${key}=${JSON.stringify(provider[key])}`);
  }

  const credential = provider.experimental_bearer_token ?? (provider.env_key && credentialEnv(provider.env_key));

  if (credential) {
    env.TEAMAI_JUDGE_API_KEY = credential;
    overrides.push('-c', `model_providers.${name}.env_key="TEAMAI_JUDGE_API_KEY"`);
  }

  return overrides;
}

async function codexSettings(tool: ConfinedTool, env: NodeJS.ProcessEnv) {
  const text = await optionalFile(path.join(env.CODEX_HOME || toolHome(tool), 'config.toml'));

  if (!text) return { args: [], model: undefined };
  const config = CodexConfigSchema.parse(parseToml(withoutTomlBom(text)));
  const model = config.model ? ['-c', `model=${JSON.stringify(config.model)}`] : [];
  const name = config.model_provider;
  const provider = name ? config.model_providers?.[name] : undefined;

  if (!name || !provider) return { args: model, model: config.model };

  return { args: ['-c', `model_provider=${JSON.stringify(name)}`, ...model, ...codexProviderArgs(name, provider, env)], model: config.model };
}

const OpenCodeProviderSchema = z.object({ npm: z.enum(['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/anthropic']).optional(), name: z.string().optional(), options: z.object({ baseURL: z.string().optional(), apiKey: z.string().optional() }).optional(), models: z.record(z.string(), z.object({ name: z.string().optional() })).optional() });

const OpenCodeConfigSchema = z.object({ model: z.string().optional(), provider: z.record(z.string(), OpenCodeProviderSchema.nullable()).optional() });

/** Replaces an `{env:KEY}` API key with that variable's value, which the confined env does not carry. */
function inlineEnvKey(options: { apiKey?: string } | undefined): void {
  const key = options?.apiKey?.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];

  if (options === undefined || key === undefined) return;
  const credential = credentialEnv(key);

  if (!credential) throw new Error(`OpenCode provider credential ${key} is not set`);
  options.apiKey = credential;
}

async function openCodeSettings(env: NodeJS.ProcessEnv, tmp: string): Promise<string | undefined> {
  const text = await optionalFile(process.env.OPENCODE_CONFIG || path.join(toolHome('opencode'), 'opencode.json'));
  const settings = text ? OpenCodeConfigSchema.parse(parseJsonAs(text, mcpSyntaxOf('opencode', 'user'))) : {};

  for (const entry of Object.values(settings.provider ?? {})) inlineEnvKey(entry?.options);

  const auth = await optionalFile(path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'auth.json'));

  // oxlint-disable-next-line teamai/tool-home-env -- the judge's throwaway XDG homes, as OPENCODE_CONFIG_DIR below; OpenCode's launch profile names no homeEnv (packages/tool-opencode/src/launch.ts), so toolCommandEnv gives it no variable
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
  // oxlint-disable-next-line teamai/tool-home-env -- the judge's throwaway config home, as Codex's tmp/codex below; OpenCode's launch profile names no homeEnv (packages/tool-opencode/src/launch.ts), so toolCommandEnv gives it no variable
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

/** The JSON value a reply holds, inside a fenced block or bare, or undefined when it holds none. */
export function parseReply(text: string): JsonValue | undefined {
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
  usage?: ConfinedUsage;
}

function tokensOf(tool: ConfinedTool, stdout: string): TokenUsage | undefined {
  const reading = launchAdapterOf(tool).call.read({ stdout, lastMessage: undefined });

  return toolStdout(launchAdapterIdOf(tool), stdout)?.tokens ?? (reading.ok ? reading.tokens : undefined);
}

function spendOf(tool: ConfinedTool, stdout: string): Spend {
  const tokens = tokensOf(tool, stdout);
  const cost = records(stdout).findLast((record) => record.total_cost_usd !== undefined)?.total_cost_usd;

  if (!tokens && cost === undefined) return {};
  const usage: ConfinedUsage = {};

  if (tokens?.input !== undefined) usage.inputTokens = tokens.input;

  if (tokens?.output !== undefined) usage.outputTokens = tokens.output;

  if (cost !== undefined) usage.cost = { amount: cost, unit: 'USD' };

  return { usage };
}

type Family = ReturnType<typeof launchAdapterIdOf<ConfinedTool>>;

type ConfinedFailure = Extract<ConfinedResult, { ok: false }>;

/** What a family's launch is given: the run, where its tool runs, and the env and temporary directory it may set up. */
interface LaunchContext {
  input: ConfinedInput;
  executable: string;
  /** The real path of `input.dir`. */
  dir: string;
  cwd: string;
  tmp: string;
  env: NodeJS.ProcessEnv;
}

/** How a family runs: its arguments and stdin, the model its own config names, and a failure its run shows besides its exit code. */
interface Launch {
  args: string[];
  stdin: string;
  configuredModel?: string;
  failureOf?(run: ToolRun, spent: Spend): Promise<ConfinedFailure | undefined>;
}

const modelArgs = ({ input }: LaunchContext): string[] => input.model ? ['--model', input.model.name] : [];

const jsonSchemaArgs = ({ input }: LaunchContext): string[] => input.schema === undefined ? [] : ['--json-schema', JSON.stringify(input.schema)];

const asked = ({ input }: LaunchContext): string => REQUEST + input.prompt;

const rawOf = (run: ToolRun): string => run.stdout + '\n' + run.stderr;

/** How each family is set up and started confined. */
// oxlint-disable-next-line teamai/tool-facts -- keyed by launch adapter id, as LAUNCH_ADAPTERS is; a tool picks one with TOOLS.launch
const LAUNCHES = {
  async claude(context) {
    const { input, env, tmp } = context;
    const settings = await claudeSettings(input.tool, env, tmp);
    const prompt = path.join(tmp, 'prompt.md');
    await fs.writeFile(prompt, input.prompt);

    return { stdin: REQUEST, args: ['-p', '--restricted', '--tools=Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose', ...jsonSchemaArgs(context), '--append-system-prompt-file', prompt, '--settings', settings, ...modelArgs(context), ...(input.model?.effort ? ['--effort', input.model.effort] : [])] };
  },
  async codex(context) {
    const { input, env, tmp, dir } = context;
    const settings = await codexSettings(input.tool, env);
    const auth = await optionalFile(path.join(env.CODEX_HOME || toolHome(input.tool), 'auth.json'));
    const codexHome = path.join(tmp, 'codex');
    Object.assign(env, toolCommandEnv(input.tool, { kind: 'at', dir: codexHome }));
    await fs.mkdir(codexHome);

    if (auth !== undefined) await fs.writeFile(path.join(codexHome, 'auth.json'), auth, { mode: 0o600 });
    await fs.writeFile(path.join(codexHome, 'config.toml'), codexProfile(dir));
    const schema = path.join(tmp, 'schema.json');

    if (input.schema !== undefined) await fs.writeFile(schema, JSON.stringify(input.schema));

    return {
      stdin: asked(context),
      configuredModel: settings.model,
      args: ['-a', 'never', 'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', ...(input.schema === undefined ? [] : ['--output-schema', schema]), ...CODEX_DISABLED.flatMap((feature) => ['--disable', feature]), '-o', path.join(tmp, 'answer.json'), ...settings.args, ...modelArgs(context), ...(input.model?.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(input.model.effort)}`] : []), '-'],
    };
  },
  async codebuddy(context) {
    return {
      stdin: asked(context),
      args: ['-p', '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--permission-mode', 'dontAsk', '--settings', JSON.stringify({ permissions: { allow: ['Read(./**)'] } }), '--output-format', 'json', ...jsonSchemaArgs(context), ...modelArgs(context)],
      // CodeBuddy exits 0 when it is not signed in.
      async failureOf(run) {
        if (!/Authentication required/.test(rawOf(run))) return undefined;

        return { ok: false, code: 'confined_tool_unavailable', message: 'CodeBuddy is not signed in. Sign in with codebuddy /login or set CODEBUDDY_API_KEY, then retry, or use another tool or driver.', raw: rawOf(run) };
      },
    };
  },
  async cursor(context) {
    return { stdin: asked(context), args: ['-p', '--output-format', 'json', '--mode', 'ask', '--sandbox', 'enabled', '--trust', ...modelArgs(context)] };
  },
  async pi(context) {
    return { stdin: asked(context), args: ['-p', '--mode', 'json', '--tools', 'read,grep,find,ls', '--no-context-files', '--no-extensions', '--no-skills', '--no-session', ...modelArgs(context)] };
  },
  async agy(context) {
    return { stdin: asked(context), args: ['--input-format=stream-json', '--output-format=stream-json', '--print=', '--mode', 'plan', '--sandbox', ...modelArgs(context)] };
  },
  async opencode(context) {
    const { input, executable, dir, cwd, env, tmp } = context;
    await fs.cp(dir, cwd, { recursive: true, dereference: false });
    const entries = await fs.readdir(cwd, { recursive: true, withFileTypes: true });

    if (entries.some((entry) => entry.isSymbolicLink())) throw new Error(`OpenCode would follow a symlink in ${dir}. Remove the symlink before running it confined`);
    await noInstructionsAbove(cwd);

    return {
      stdin: asked(context),
      configuredModel: await openCodeSettings(env, tmp),
      args: ['run', '--standalone', '--format', 'json', ...opencodeModelArgs(input.model, input.model?.effort ? await opencodeMajorVersion(executable) : 2)],
      // OpenCode keeps every run as a session in its database; the confined one must not outlive the run.
      async failureOf(run, spent) {
        const session = toolStdout('opencode', run.stdout)?.session;

        if (!session) return undefined;
        const deleted = await runTool({ executable, args: ['session', 'delete', session, '--standalone'], cwd, env, stdin: '', timeoutMs: input.timeoutMs, detached: true });

        if (deleted.code === 0) return undefined;

        return { ok: false, code: 'confined_failed', message: `OpenCode could not delete its session ${session}. Delete it with opencode session delete before retrying.`, raw: deleted.stderr, ...spent };
      },
    };
  },
} satisfies { [F in Family]: (context: LaunchContext) => Promise<Launch> };

/** Claude's result record, which CodeBuddy and Cursor print too; only Claude and CodeBuddy fill structured_output. */
async function resultRecordReply(stdout: string): Promise<JsonValue | undefined> {
  const last = records(stdout).findLast((record) => record.type === 'result');

  return last?.structured_output ?? parseReply(last?.result ?? '');
}

async function adapterReply(tool: ConfinedTool, stdout: string): Promise<JsonValue | undefined> {
  const reading = launchAdapterOf(tool).call.read({ stdout, lastMessage: undefined });

  return reading.ok ? parseReply(reading.text) : undefined;
}

const OpenCodeText = z.object({ type: z.literal('text'), part: z.object({ text: z.string() }) });

/** Where each family leaves its reply: Codex's answer file, a result record, OpenCode's text parts, or the adapter's reading. */
// oxlint-disable-next-line teamai/tool-facts -- keyed by launch adapter id, as LAUNCH_ADAPTERS is; a tool picks one with TOOLS.launch
const REPLIES = {
  codex: async (_stdout, tmp) => parseReply(await optionalFile(path.join(tmp, 'answer.json')) ?? ''),
  claude: resultRecordReply,
  codebuddy: resultRecordReply,
  cursor: resultRecordReply,
  opencode: async (stdout) => parseReply(records(stdout).flatMap((record) => {
    const parsed = OpenCodeText.safeParse(record);

    return parsed.success ? [parsed.data.part.text] : [];
  }).join('\n')),
  pi: async (stdout, _tmp, tool) => adapterReply(tool, stdout),
  agy: async (stdout, _tmp, tool) => adapterReply(tool, stdout),
} satisfies { [F in Family]: (stdout: string, tmp: string, tool: ConfinedTool) => Promise<JsonValue | undefined> };

/** The level `context`'s tool reaches here, or why it does not reach `context.input.level`. */
async function levelReached({ input, executable, dir, cwd, env, tmp }: LaunchContext): Promise<{ ok: true; isolation: ConfinedLevel } | ConfinedFailure> {
  const version = await probeBinary(executable, ['--version'], (command, args, options) => execCommand(command, args, { ...options, env, cwd: tmp }));
  const checkout = launchAdapterIdOf(input.tool) === 'opencode' && await insideCheckout(cwd);
  const isolation = version ? profileIsolation(input.tool, version, checkout) : 'best-effort';

  if (input.level !== 'verified' || isolation === 'verified') return { ok: true, isolation };

  return { ok: false, code: 'confined_tool_unavailable', message: checkout
    ? `OpenCode would read ${dir} inside the checkout above ${cwd}, which it lets its file tools read. Move the temp dir (TMPDIR) outside any git or hg checkout, or use another driver.`
    : `${input.tool} ${version || '(version unknown)'} has no verified judge profile. Install a supported version or use another driver.` };
}

/** The error the tool reported, or '' when it reported none. */
function reportedError(tool: ConfinedTool, run: ToolRun): string {
  const family = launchAdapterIdOf(tool);
  const reading = launchAdapterOf(tool).call.read({ stdout: run.stdout, lastMessage: undefined });

  if (!reading.ok && reading.message) return reading.message;

  // agy exits 1 with the reason in its result, or on stderr when it refuses to start.
  return family === 'agy' && run.code !== 0 && !run.stdout.trim() ? run.stderr.trim() : '';
}

/** What ran, as far as the run showed it. A model or effort it did not observe stays undefined, which the JSON leaves out. */
function ranOn(input: ConfinedInput, launch: Launch, run: ToolRun, isolation: ConfinedLevel): ConfinedRun {
  const model = observedModel({ requested: input.model?.name ?? launch.configuredModel, reported: toolStdout(launchAdapterIdOf(input.tool), run.stdout)?.model });
  const effort = observedEffort({ requested: input.model?.effort });

  return { tool: input.tool, model: model || undefined, effort: effort || undefined, isolation, access: confinedAccess(input.tool) };
}

/** What a finished run gave: the error the tool reported, its exit code, or its reply. */
async function outcomeOf({ input, tmp }: LaunchContext, launch: Launch, run: ToolRun, isolation: ConfinedLevel): Promise<ConfinedResult> {
  const family = launchAdapterIdOf(input.tool);
  const raw = rawOf(run);
  const spent = spendOf(input.tool, run.stdout);
  const failure = await launch.failureOf?.(run, spent);

  if (failure) return failure;
  const reported = reportedError(input.tool, run);

  const toolError: ConfinedFailure | undefined = reported
    ? { ok: false, code: 'confined_failed', message: `${input.tool} reported an error: ${reported.replace(/\.?$/, '.')} Fix that, then retry or use another tool or driver.`, raw, reported, ...spent }
    : undefined;

  if (run.code !== 0) return toolError ?? { ok: false, code: 'confined_failed', message: `${input.tool} exited with code ${run.code}${run.timedOut ? ` after its ${input.timeoutMs} ms limit` : ''}. See the saved output, then retry or use another tool or driver.`, raw, ...spent };
  const reply = await REPLIES[family](run.stdout, tmp, input.tool);

  // pi exits 0 on a provider error, which its reply carries.
  if (reply === undefined) return toolError ?? { ok: false, code: 'confined_reply_invalid', message: `${input.tool} did not reply with JSON. See the saved output, then retry.`, raw, ...spent };

  return { ok: true, reply, run: { ...ranOn(input, launch, run, isolation), ...spent } };
}

/**
 * Runs `input.prompt` on `input.tool` with `input.dir` as its working directory and only readable root, at least at
 * `input.level`, and returns its JSON reply with what ran. The prompt and the tool's own files go in a temporary
 * directory that is removed afterwards, never into `dir`, which may be evidence a hash covers.
 */
export async function runConfined(input: ConfinedInput, { resolveTool = resolveCliPath }: ToolLookup = {}): Promise<ConfinedResult> {
  const executable = resolveTool(executableOf(input.tool));

  if (!executable) return { ok: false, code: 'confined_tool_unavailable', message: `The ${input.tool} executable is not available on PATH. Install it, or use another tool or driver.` };
  const confined = confinedEnv(input.tool, await resolveMemberToolRoots());

  if (confined.kind === 'home_gone') return { ok: false, code: 'confined_tool_unavailable', message: confined.message };
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-confined-')));

  try {
    const dir = await fs.realpath(input.dir);
    const family = launchAdapterIdOf(input.tool);
    // OpenCode reads a copy, so a checkout above the directory is checked where the copy goes.
    const context: LaunchContext = { input, executable, dir, cwd: family === 'opencode' ? path.join(tmp, 'dir') : dir, tmp, env: confined.env };
    const level = await levelReached(context);

    if (!level.ok) return level;
    const launch = await LAUNCHES[family](context);
    const { stdinOf }: CallLaunch = launchAdapterOf(input.tool).call;
    const run = await runTool({ executable, args: launch.args, cwd: context.cwd, env: context.env, stdin: stdinOf ? stdinOf(launch.stdin) : launch.stdin, timeoutMs: input.timeoutMs, detached: true, group: input.group, signal: input.signal });

    return await outcomeOf(context, launch, run, level.isolation);
  } catch (error) {
    return { ok: false, code: 'confined_failed', message: `${input.tool} could not run confined: ${error instanceof Error ? error.message : String(error)}. Fix that, then retry.` };
  } finally { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }); }
}
