import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { stringify as stringifyToml, type TomlTable } from 'smol-toml';
import { execCommand, probeBinary } from '@teamai/shared/exec';
import { JsonValueSchema, type JsonValue } from '@teamai/shared/json';
import { copyRegularTree, readRegularFile, writeRegularFile } from '@teamai/shared/regular-file';
import { ASSUMED_OPENCODE_MAJOR, type CallLaunch, type ConfinedLaunch, type ConfinedLevel } from '@teamai/tool-core/launch';
import { extractReply } from '@teamai/tool-core/reply';
import { stoppedOnUsageLimit, toolStdout, type ConfinedUsage, type TokenUsage } from '@teamai/tool-core/stdout';
import type { HeadlessRun } from '@teamai/tool-launch/call-launch';
import { confinedArgs, confinedStdin } from '@teamai/tool-launch/confined-launch';
import { runTool } from './headless.js';

/**
 * How teamai reads the member's own tool config, which a confined run carries over: the core builds this once, with its
 * readers of OpenCode's JSONC and Codex's TOML and its probe of OpenCode's version.
 */
export interface ConfinedDeps {
  /** OpenCode's major version, from its executable. */
  opencodeMajor(executable: string): Promise<number>;
  /** The member's `opencode.json`, as OpenCode reads it. */
  parseOpenCodeConfig(text: string): JsonValue;
  /** The member's Codex `config.toml`. */
  parseCodexConfig(text: string): TomlTable;
  /** The variable a confined Codex reads the credential of the member's provider from, which teamai names. */
  judgeKeyVariable: string;
  /**
   * Brings the Codex login in the home `from` into the run's own Codex home `toolHome`, under the machine-wide login
   * lock, as the attempt the run belongs to. Codex rotates its refresh token when it refreshes, so `release` writes a
   * login refreshed there back to `from` before it frees the lock, and says why when it could not.
   */
  holdCodexLogin(input: { executable: string; from: string; toolHome: string; attempt: ConfinedAttempt; signal: AbortSignal }): Promise<ConfinedLoginHold>;
  /** The home variables teamai sets on `tool`'s command started in `dir`, a home it chose for the run. */
  toolCommandEnv(tool: string, dir: string): Readonly<Record<string, string>>;
}

/** The attempt a confined run belongs to, which holds a login the run brings. */
export interface ConfinedAttempt { readonly run: string; readonly attempt: string }

/** A login a confined run holds, or why it could not take it. */
export type ConfinedLoginHold =
  | { ok: true; release(): Promise<{ code: 'login_not_written_back'; message: string } | undefined> }
  | { ok: false; code: 'login_held' | 'login_missing'; message: string };

/** The launch adapter ids that run confined, each with its own setup below. */
export type ConfinedFamily = 'claude' | 'codex' | 'codebuddy' | 'cursor' | 'pi' | 'agy' | 'opencode';

/** One confined run, with the facts of its tool that the core resolved for it. */
export interface ConfinedRequest {
  tool: string;
  family: ConfinedFamily;
  /** The tool's call and confined profiles, from its launch adapter. */
  adapter: { readonly call: CallLaunch; readonly confined: ConfinedLaunch };
  executable: string;
  /** The variables the run gets, which the core built from the member's own. */
  env: NodeJS.ProcessEnv;
  /** The member's variables, which a provider credential the tool's config names is read from. */
  memberEnv: NodeJS.ProcessEnv;
  /** The tool's home on this machine, where its config and sign-in are read unless `env` moves it. */
  home: string;
  model?: { name: string; effort?: string };
  /** The tool's working directory and only readable root. Nothing is written into it. */
  dir: string;
  prompt: string;
  /** The JSON Schema the reply must follow, which tools that take one enforce. */
  schema?: JsonValue;
  /** The least level the run must reach; a tool that cannot reach it does not run. */
  level: ConfinedLevel;
  timeoutMs: number;
  /**
   * The attempt's directory, which outlives the caller: the tool's process group is recorded there, where
   * `stopRecordedGroup` finds it if its caller dies, and a Codex run keeps its home there while it holds the login.
   */
  group?: string;
  /** The attempt the run belongs to. */
  attempt: ConfinedAttempt;
  signal?: AbortSignal;
}

export type ConfinedFailureCode = 'confined_tool_unavailable' | 'confined_failed' | 'confined_reply_invalid' | 'usage_limited' | 'login_held' | 'login_missing' | 'login_not_written_back';

/** `raw`: the tool's saved output. `reported`: the error the tool itself reported, when it reported one. */
export type ConfinedFailure = { ok: false; code: ConfinedFailureCode; message: string; raw?: string; reported?: string; usage?: ConfinedUsage };

/** How a confined run ended: its JSON reply, the level it reached, what it spent, and the model its config and its output name. */
export type ConfinedEnd =
  | { ok: true; reply: JsonValue; isolation: ConfinedLevel; usage?: ConfinedUsage; configuredModel?: string; reportedModel?: string }
  | ConfinedFailure;

/** A JSON line a tool prints; a field of the wrong type reads as absent. */
const RecordSchema = z.looseObject({
  type: z.unknown().optional(),
  result: z.string().optional().catch(undefined),
  structured_output: JsonValueSchema.optional().catch(undefined),
  total_cost_usd: z.number().optional().catch(undefined),
});

/** Whether `dir` or a directory above it holds `.git` or `.hg`: OpenCode then lets its file tools read the whole checkout. */
async function insideCheckout(dir: string): Promise<boolean> {
  for (let at = dir;; at = path.dirname(at)) {
    for (const marker of ['.git', '.hg']) if (await fs.access(path.join(at, marker)).then(() => true, () => false)) return true;

    if (path.dirname(at) === at) return false;
  }
}

/**
 * The level a tool's confined profile reaches at `version` when it reads `dir`: `verified` for a checked version, unless
 * OpenCode would read a checkout around `dir`.
 */
export async function confinedIsolation({ profile, family, version, dir }: { profile: ConfinedLaunch; family: ConfinedFamily; version: string; dir: string }): Promise<ConfinedLevel> {
  return profile.verified?.test(version) && !(family === 'opencode' && await insideCheckout(dir)) ? 'verified' : 'best-effort';
}

async function optionalFile(file: string): Promise<string | undefined> {
  try { return await readRegularFile(file, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
}

async function claudeSettings(request: ConfinedRequest, env: NodeJS.ProcessEnv, tmp: string): Promise<string> {
  const file = path.join(env.CLAUDE_CONFIG_DIR || request.home, 'settings.json');
  const text = await optionalFile(file);
  const settings = text ? z.object({ env: z.record(z.string(), z.string()).optional(), model: z.string().optional() }).parse(JSON.parse(text)) : {};
  const allowed = Object.fromEntries(Object.entries(settings.env ?? {}).filter(([key]) => request.adapter.confined.env.includes(key)));
  const target = path.join(tmp, 'claude-settings.json');
  // An empty model stays undefined, which the JSON leaves out.
  await writeRegularFile(target, JSON.stringify({ env: allowed, model: settings.model || undefined }));

  return target;
}

function credentialEnv(request: ConfinedRequest, key: string): string | undefined {
  if (['GH_TOKEN', 'GITHUB_TOKEN', 'GL_TOKEN', 'GITLAB_TOKEN', 'CI_JOB_TOKEN', 'BASH_ENV', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS'].includes(key) || key.startsWith('__TEAMAI_ENV_')) {
    throw new Error(`The confined profile uses blocked credential variable ${key}. Use a dedicated provider API-key variable instead`);
  }

  return request.memberEnv[key];
}

const CodexProviderSchema = z.object({ name: z.string().optional(), base_url: z.string().optional(), wire_api: z.string().optional(), env_key: z.string().optional(), experimental_bearer_token: z.string().optional() });

const CodexConfigSchema = z.object({ model: z.string().optional(), model_provider: z.string().optional(), model_providers: z.record(z.string(), CodexProviderSchema).optional() });

/** The overrides that keep the member's provider `name`, with its credential in a variable the confined env carries. */
function codexProviderArgs(request: ConfinedRequest, deps: ConfinedDeps, name: string, provider: z.infer<typeof CodexProviderSchema>, env: NodeJS.ProcessEnv): string[] {
  const overrides: string[] = [];

  for (const key of ['name', 'base_url', 'wire_api'] as const) {
    if (provider[key]) overrides.push('-c', `model_providers.${name}.${key}=${JSON.stringify(provider[key])}`);
  }

  const credential = provider.experimental_bearer_token ?? (provider.env_key && credentialEnv(request, provider.env_key));

  if (credential) {
    env[deps.judgeKeyVariable] = credential;
    overrides.push('-c', `model_providers.${name}.env_key=${JSON.stringify(deps.judgeKeyVariable)}`);
  }

  return overrides;
}

async function codexSettings(request: ConfinedRequest, env: NodeJS.ProcessEnv, deps: ConfinedDeps) {
  const text = await optionalFile(path.join(env.CODEX_HOME || request.home, 'config.toml'));

  if (!text) return { args: [], model: undefined };
  const config = CodexConfigSchema.parse(deps.parseCodexConfig(text));
  const model = config.model ? ['-c', `model=${JSON.stringify(config.model)}`] : [];
  const name = config.model_provider;
  const provider = name ? config.model_providers?.[name] : undefined;

  if (!name || !provider) return { args: model, model: config.model };

  return { args: ['-c', `model_provider=${JSON.stringify(name)}`, ...model, ...codexProviderArgs(request, deps, name, provider, env)], model: config.model };
}

const OpenCodeProviderSchema = z.object({ npm: z.enum(['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/anthropic']).optional(), name: z.string().optional(), options: z.object({ baseURL: z.string().optional(), apiKey: z.string().optional() }).optional(), models: z.record(z.string(), z.object({ name: z.string().optional() })).optional() });

const OpenCodeConfigSchema = z.object({ model: z.string().optional(), provider: z.record(z.string(), OpenCodeProviderSchema.nullable()).optional() });

/** Replaces an `{env:KEY}` API key with that variable's value, which the confined env does not carry. */
function inlineEnvKey(request: ConfinedRequest, options: { apiKey?: string } | undefined): void {
  const key = options?.apiKey?.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];

  if (options === undefined || key === undefined) return;
  const credential = credentialEnv(request, key);

  if (!credential) throw new Error(`OpenCode provider credential ${key} is not set`);
  options.apiKey = credential;
}

async function openCodeSettings(request: ConfinedRequest, env: NodeJS.ProcessEnv, tmp: string, deps: ConfinedDeps): Promise<string | undefined> {
  const text = await optionalFile(process.env.OPENCODE_CONFIG || path.join(request.home, 'opencode.json'));
  const settings = text ? OpenCodeConfigSchema.parse(deps.parseOpenCodeConfig(text)) : {};

  for (const entry of Object.values(settings.provider ?? {})) inlineEnvKey(request, entry?.options);

  const auth = await optionalFile(path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'auth.json'));

  // oxlint-disable-next-line teamai/tool-home-env -- the judge's throwaway XDG homes, as OPENCODE_CONFIG_DIR below; OpenCode's launch profile names no homeEnv (packages/tool-opencode/src/launch.ts), so toolCommandEnv gives it no variable
  for (const [key, dir] of [['XDG_DATA_HOME', 'data'], ['XDG_CACHE_HOME', 'cache'], ['XDG_STATE_HOME', 'state'], ['XDG_CONFIG_HOME', 'xdg-config']] as const) {
    env[key] = path.join(tmp, dir);
    await fs.mkdir(path.join(tmp, dir), { recursive: true });
  }

  const data = path.join(tmp, 'data');
  await fs.mkdir(path.join(data, 'opencode'), { recursive: true });

  if (auth !== undefined) await writeRegularFile(path.join(data, 'opencode', 'auth.json'), auth, { mode: 0o600 });
  env.OPENCODE_DB = path.join(data, 'judge.db');
  env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  env.OPENCODE_DISABLE_CLAUDE_CODE = '1';
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  const config = path.join(tmp, 'config');
  await fs.mkdir(config);
  await writeRegularFile(path.join(config, 'opencode.json'), JSON.stringify({ ...settings,
    permission: { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow', external_directory: 'deny', bash: 'deny', edit: 'deny', webfetch: 'deny', websearch: 'deny', task: 'deny', skill: 'deny' }, plugin: [], mcp: {},
  }), { mode: 0o600 });
  // oxlint-disable-next-line teamai/tool-home-env -- the judge's throwaway config home; OpenCode's launch profile names no homeEnv (packages/tool-opencode/src/launch.ts), so toolCommandEnv gives it no variable
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

function tokensOf(request: ConfinedRequest, stdout: string): TokenUsage | undefined {
  const reading = request.adapter.call.read({ stdout, lastMessage: undefined });

  return toolStdout(request.family, stdout)?.tokens ?? (reading.ok ? reading.tokens : undefined);
}

function spendOf(request: ConfinedRequest, stdout: string): Spend {
  const tokens = tokensOf(request, stdout);
  const cost = records(stdout).findLast((record) => record.total_cost_usd !== undefined)?.total_cost_usd;

  if (!tokens && cost === undefined) return {};
  const usage: ConfinedUsage = {};

  if (tokens?.input !== undefined) usage.inputTokens = tokens.input;

  if (tokens?.output !== undefined) usage.outputTokens = tokens.output;

  if (cost !== undefined) usage.cost = { amount: cost, unit: 'USD' };

  return { usage };
}

/** What a family's launch is given: the run, where its tool runs, and the env and temporary directory it may set up. */
interface LaunchContext {
  request: ConfinedRequest;
  deps: ConfinedDeps;
  /** The real path of `request.dir`. */
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
  failureOf?(run: HeadlessRun, spent: Spend): Promise<ConfinedFailure | undefined>;
  /** Ends what the launch holds once its tool ended, saying why the run fails when that did not end well. */
  release?(): Promise<ConfinedFailure | undefined>;
}

const rawOf = (run: HeadlessRun): string => run.stdout + '\n' + run.stderr;

/** How each family is set up and started confined. */
// oxlint-disable-next-line teamai/tool-facts -- keyed by launch adapter id, as LAUNCH_ADAPTERS is; a tool picks one with TOOLS.launch
const LAUNCHES = {
  async claude(context) {
    const { request, env, tmp } = context;
    const settings = await claudeSettings(request, env, tmp);
    const prompt = path.join(tmp, 'prompt.md');
    await writeRegularFile(prompt, request.prompt);

    return { stdin: confinedStdin('claude', request.prompt), args: confinedArgs({ family: 'claude', model: request.model, schema: request.schema, settingsFile: settings, promptFile: prompt }) };
  },
  async codex(context): Promise<Launch | ConfinedFailure> {
    const { request, deps, env, tmp, dir } = context;
    const settings = await codexSettings(request, env, deps);
    const from = env.CODEX_HOME || request.home;
    // In the attempt's directory when it has one, so a run killed while it held the login leaves what Codex refreshed.
    const toolHome = request.group === undefined ? path.join(tmp, 'codex') : path.join(request.group, 'tool-home', 'codex');
    Object.assign(env, deps.toolCommandEnv(request.tool, toolHome));
    await fs.mkdir(toolHome, { recursive: true });
    await writeRegularFile(path.join(toolHome, 'config.toml'), codexProfile(dir));
    const schema = path.join(tmp, 'schema.json');

    if (request.schema !== undefined) await writeRegularFile(schema, JSON.stringify(request.schema));
    // Last, so nothing after it fails while it holds the login.
    const waitEnds = AbortSignal.any([AbortSignal.timeout(request.timeoutMs), ...(request.signal ? [request.signal] : [])]);
    const login = await deps.holdCodexLogin({ executable: request.executable, from, toolHome, attempt: request.attempt, signal: waitEnds });

    if (!login.ok) {
      await fs.rm(toolHome, { recursive: true, force: true });

      return { ok: false, code: login.code, message: login.message };
    }

    return {
      async release() {
        try {
          const kept = await login.release();

          return kept && { ok: false, ...kept };
        } finally {
          await fs.rm(toolHome, { recursive: true, force: true });
        }
      },
      stdin: confinedStdin('codex', request.prompt),
      configuredModel: settings.model,
      args: confinedArgs({ family: 'codex', model: request.model, schemaFile: request.schema === undefined ? undefined : schema, answerFile: path.join(tmp, 'answer.json'), configArgs: settings.args }),
    };
  },
  async codebuddy({ request }) {
    return {
      stdin: confinedStdin('codebuddy', request.prompt),
      args: confinedArgs({ family: 'codebuddy', model: request.model, schema: request.schema }),
      // CodeBuddy exits 0 when it is not signed in.
      async failureOf(run) {
        if (!/Authentication required/.test(rawOf(run))) return undefined;

        return { ok: false, code: 'confined_tool_unavailable', message: 'CodeBuddy is not signed in. Sign in with codebuddy /login or set CODEBUDDY_API_KEY, then retry, or use another tool or driver.', raw: rawOf(run) };
      },
    };
  },
  async cursor({ request }) {
    return { stdin: confinedStdin('cursor', request.prompt), args: confinedArgs({ family: 'cursor', model: request.model }) };
  },
  async pi({ request }) {
    return { stdin: confinedStdin('pi', request.prompt), args: confinedArgs({ family: 'pi', model: request.model }) };
  },
  async agy({ request }) {
    return { stdin: confinedStdin('agy', request.prompt), args: confinedArgs({ family: 'agy', model: request.model }) };
  },
  async opencode(context) {
    const { request, deps, dir, cwd, env, tmp } = context;
    const { executable } = request;
    // OpenCode follows a link it finds there, out of the directory or round a loop. The copy walks without following
    // one, so it refuses each as it meets it: a recursive readdir follows links to folders on Node 26 and never ends.
    await copyRegularTree(dir, cwd, {
      filter: async (source) => {
        if ((await fs.lstat(source)).isSymbolicLink()) throw new Error(`OpenCode would follow a symlink in ${dir}. Remove the symlink before running it confined`);

        return true;
      },
    });
    await noInstructionsAbove(cwd);

    return {
      stdin: confinedStdin('opencode', request.prompt),
      configuredModel: await openCodeSettings(request, env, tmp, deps),
      args: confinedArgs({ family: 'opencode', model: request.model, opencodeMajor: request.model?.effort ? await deps.opencodeMajor(executable) : ASSUMED_OPENCODE_MAJOR }),
      // OpenCode keeps every run as a session in its database; the confined one must not outlive the run.
      async failureOf(run, spent) {
        const session = toolStdout('opencode', run.stdout)?.session;

        if (!session) return undefined;
        const deleted = await runTool({ executable, args: ['session', 'delete', session, '--standalone'], cwd, env, stdin: '', timeoutMs: request.timeoutMs, detached: true });

        if (deleted.code === 0) return undefined;

        return { ok: false, code: 'confined_failed', message: `OpenCode could not delete its session ${session}. Delete it with opencode session delete before retrying.`, raw: deleted.stderr, ...spent };
      },
    };
  },
} satisfies { [F in ConfinedFamily]: (context: LaunchContext) => Promise<Launch | ConfinedFailure> };

/** Claude's result record, which CodeBuddy and Cursor print too; only Claude and CodeBuddy fill structured_output. */
async function resultRecordReply(stdout: string): Promise<JsonValue | undefined> {
  const last = records(stdout).findLast((record) => record.type === 'result');

  return last?.structured_output ?? extractReply(last?.result ?? '', JsonValueSchema);
}

async function adapterReply(request: ConfinedRequest, stdout: string): Promise<JsonValue | undefined> {
  const reading = request.adapter.call.read({ stdout, lastMessage: undefined });

  return reading.ok ? extractReply(reading.text, JsonValueSchema) : undefined;
}

const OpenCodeText = z.object({ type: z.literal('text'), part: z.object({ text: z.string() }) });

/** Where each family leaves its reply: Codex's answer file, a result record, OpenCode's text parts, or the adapter's reading. */
// oxlint-disable-next-line teamai/tool-facts -- keyed by launch adapter id, as LAUNCH_ADAPTERS is; a tool picks one with TOOLS.launch
const REPLIES = {
  codex: async (_stdout, tmp) => extractReply(await optionalFile(path.join(tmp, 'answer.json')) ?? '', JsonValueSchema),
  claude: resultRecordReply,
  codebuddy: resultRecordReply,
  cursor: resultRecordReply,
  opencode: async (stdout) => extractReply(records(stdout).flatMap((record) => {
    const parsed = OpenCodeText.safeParse(record);

    return parsed.success ? [parsed.data.part.text] : [];
  }).join('\n'), JsonValueSchema),
  pi: async (stdout, _tmp, request) => adapterReply(request, stdout),
  agy: async (stdout, _tmp, request) => adapterReply(request, stdout),
} satisfies { [F in ConfinedFamily]: (stdout: string, tmp: string, request: ConfinedRequest) => Promise<JsonValue | undefined> };

/** The level `context`'s tool reaches here, or why it does not reach `context.request.level`. */
async function levelReached({ request, dir, cwd, env, tmp }: LaunchContext): Promise<{ ok: true; isolation: ConfinedLevel } | ConfinedFailure> {
  const { executable } = request;
  const version = await probeBinary(executable, ['--version'], (command, args, options) => execCommand(command, args, { ...options, env, cwd: tmp }));
  const checkout = request.family === 'opencode' && await insideCheckout(cwd);
  const isolation = version ? await confinedIsolation({ profile: request.adapter.confined, family: request.family, version, dir: cwd }) : 'best-effort';

  if (request.level !== 'verified' || isolation === 'verified') return { ok: true, isolation };

  return { ok: false, code: 'confined_tool_unavailable', message: checkout
    ? `OpenCode would read ${dir} inside the checkout above ${cwd}, which it lets its file tools read. Move the temp dir (TMPDIR) outside any git or hg checkout, or use another driver.`
    : `${request.tool} ${version || '(version unknown)'} has no verified judge profile. Install a supported version or use another driver.` };
}

/** The error the tool reported, or '' when it reported none. */
function reportedError(request: ConfinedRequest, run: HeadlessRun): string {
  const reading = request.adapter.call.read({ stdout: run.stdout, lastMessage: undefined });

  if (!reading.ok && reading.message) return reading.message;

  // agy exits 1 with the reason in its result, or on stderr when it refuses to start.
  return request.family === 'agy' && run.code !== 0 && !run.stdout.trim() ? run.stderr.trim() : '';
}

/** What a finished run gave: the error the tool reported, its exit code, or its reply. */
async function outcomeOf({ request, tmp }: LaunchContext, launch: Launch, run: HeadlessRun, isolation: ConfinedLevel): Promise<ConfinedEnd> {
  const { family, tool } = request;
  const raw = rawOf(run);
  const spent = spendOf(request, run.stdout);
  const failure = await launch.failureOf?.(run, spent);

  if (failure) return failure;
  const reported = reportedError(request, run);

  // A usage limit keeps its own code, which says the step can run again once the limit resets. A typed error decides by
  // its kind (OpenCode 2.x); one without a kind, by its text.
  const toolError: ConfinedFailure | undefined = !reported
    ? undefined
    : stoppedOnUsageLimit(toolStdout(family, run.stdout), reported)
      ? { ok: false, code: 'usage_limited', message: `${tool} hit its usage limit: ${reported}`, raw, reported, ...spent }
      : { ok: false, code: 'confined_failed', message: `${tool} reported an error: ${reported.replace(/\.?$/, '.')} Fix that, then retry or use another tool or driver.`, raw, reported, ...spent };

  if (run.code !== 0) return toolError ?? { ok: false, code: 'confined_failed', message: `${tool} exited with code ${run.code}${run.stopped === 'timeout' ? ` after its ${request.timeoutMs} ms limit` : ''}. See the saved output, then retry or use another tool or driver.`, raw, ...spent };
  const reply = await REPLIES[family](run.stdout, tmp, request);

  // pi exits 0 on a provider error, which its reply carries.
  if (reply === undefined) return toolError ?? { ok: false, code: 'confined_reply_invalid', message: `${tool} did not reply with JSON. See the saved output, then retry.`, raw, ...spent };
  const reportedModel = toolStdout(family, run.stdout)?.model;

  return { ok: true, reply, isolation, ...spent, ...(launch.configuredModel !== undefined && { configuredModel: launch.configuredModel }), ...(reportedModel !== undefined && { reportedModel }) };
}

/**
 * Runs `request.prompt` on its tool with `request.dir` as its working directory and only readable root, at least at
 * `request.level`, and returns its JSON reply with what it reached and spent. The prompt and the tool's own files go in
 * a temporary directory that is removed afterwards, never into `dir`, which may be evidence a hash covers.
 */
export async function runConfined(request: ConfinedRequest, deps: ConfinedDeps): Promise<ConfinedEnd> {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-confined-')));

  try {
    const dir = await fs.realpath(request.dir);
    // OpenCode reads a copy, so a checkout above the directory is checked where the copy goes.
    const context: LaunchContext = { request, deps, dir, cwd: request.family === 'opencode' ? path.join(tmp, 'dir') : dir, tmp, env: { ...request.env } };
    const level = await levelReached(context);

    if (!level.ok) return level;
    const launch: Launch | ConfinedFailure = await LAUNCHES[request.family](context);

    if ('ok' in launch) return launch;
    let end: ConfinedEnd;
    let released: ConfinedFailure | undefined;

    try {
      const { stdinOf } = request.adapter.call;
      const run = await runTool({ executable: request.executable, args: launch.args, cwd: context.cwd, env: context.env, stdin: stdinOf ? stdinOf(launch.stdin) : launch.stdin, timeoutMs: request.timeoutMs, detached: true, group: request.group, signal: request.signal });
      end = await outcomeOf(context, launch, run, level.isolation);
    } finally {
      released = await launch.release?.();
    }

    // A run that failed keeps its own failure, with why the release failed too.
    if (!released) return end;

    return end.ok ? released : { ...end, message: `${end.message} ${released.message}` };
  } catch (error) {
    return { ok: false, code: 'confined_failed', message: `${request.tool} could not run confined: ${error instanceof Error ? error.message : String(error)}. Fix that, then retry.` };
  } finally { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }); }
}
