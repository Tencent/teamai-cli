import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import { z } from 'zod';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { observedEffort, observedModel } from '../agent-observation.js';
import { opencodeMajorVersion } from '../opencode-hooks.js';
import { toolHome } from '../tool-home.js';
import { resolveCliPath } from '../utils/cli-path.js';
import { execCommand, probeBinary } from '../utils/exec.js';
import { stopProcess } from '../tool-launch/process-stop.js';
import { toolStdout } from '../tool-launch/stdout.js';
import { LAUNCH_TOOLS, localToolFamily, opencodeModelArgs, type LaunchTool } from '../tool-launch/tools.js';
import { JudgeAnswerSchema, type JudgeAnswer } from './batch.js';
import type { ScoreLabel, Isolation, JudgeAccess, JudgeUsage } from './label.js';

const RecordSchema = z.record(z.unknown());
const COMMON_ENV = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];
const CLAUDE_ENV = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'];
const TOOL_ENV = {
  claude: CLAUDE_ENV,
  codex: ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  opencode: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENCODE_API_KEY'],
  codebuddy: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_CONFIG_DIR'],
} as const;
const CODEX_DISABLED = ['hooks', 'plugins', 'apps', 'browser_use', 'computer_use', 'multi_agent', 'multi_agent_v2'];
const VERIFIED = { claude: /^2\.1\.308 \(Claude Code\)$/, codex: /^codex-cli 0\.163\.0$/, opencode: /^opencode v2\.1\.2$/, codebuddy: undefined } as const;
/** What each profile lets the judge do. CodeBuddy lists about 70 tools whatever `--tools` says. */
const ACCESS = { claude: 'read', codex: 'read', opencode: 'read', codebuddy: 'full' } as const satisfies Record<keyof typeof TOOL_ENV, JudgeAccess>;

/** The tools the local judge launches: those a workflow step runs, and CodeBuddy. */
const JUDGE_TOOLS = [...LAUNCH_TOOLS, 'codebuddy'] as const;

export type JudgeTool = LaunchTool | 'codebuddy';

export function isJudgeTool(value: string): value is JudgeTool {
  return (JUDGE_TOOLS as readonly string[]).includes(value);
}

/** The judge tools on this machine's PATH: `preferred` first, then the rest in launch-tool order. */
export function installedJudgeTools(preferred: readonly string[], { resolveTool = resolveCliPath }: { resolveTool?: (tool: string) => string | null } = {}): JudgeTool[] {
  const tools = new Set([...preferred, ...JUDGE_TOOLS].filter(isJudgeTool));
  return [...tools].filter((tool) => resolveTool(tool) !== null);
}

function judgeFamily(tool: JudgeTool): keyof typeof TOOL_ENV {
  return tool === 'codebuddy' ? 'codebuddy' : localToolFamily(tool);
}

function profileIsolation(tool: JudgeTool, version: string, insideCheckout: boolean): Isolation {
  return VERIFIED[judgeFamily(tool)]?.test(version) && !insideCheckout ? 'verified' : 'best-effort';
}

/** Each judge tool on PATH, its version, and the isolation its judge profile reaches on this machine. */
export async function judgeToolLevels({ resolveTool = resolveCliPath }: { resolveTool?: (tool: string) => string | null } = {}): Promise<Array<{ tool: JudgeTool; version: string; isolation: Isolation }>> {
  const tmp = await fs.realpath(os.tmpdir());
  return Promise.all(installedJudgeTools([], { resolveTool }).flatMap((tool) => {
    const executable = resolveTool(tool);
    return executable === null ? [] : [(async () => {
      const version = await probeBinary(executable, ['--version'], (command, args, options) => execCommand(command, args, { ...options, env: judgeEnv(tool), cwd: tmp }));
      return { tool, version, isolation: profileIsolation(tool, version, judgeFamily(tool) === 'opencode' && await insideCheckout(tmp)) };
    })()];
  }));
}

export interface JudgeInput {
  tool: JudgeTool;
  model?: { name: string; effort?: string };
  evidence: string;
  schema: Record<string, unknown>;
  isolation?: Isolation;
}

export type LocalJudgeResult =
  | { ok: true; answer: JudgeAnswer; judge: Omit<Extract<ScoreLabel['judge'], { kind: 'model' }>, 'kind'> }
  | { ok: false; code: 'judge_failed' | 'judge_answer_invalid' | 'judge_tool_unavailable'; message: string; raw?: string; usage?: JudgeUsage };

function memberEnv(): NodeJS.ProcessEnv {
  const restored = { ...process.env };
  for (const key of (restored.__TEAMAI_ENV_KEYS ?? '').split(' ').filter(Boolean)) {
    if (restored[`__TEAMAI_ENV_SET_${key}`] === '2') restored[key] = restored[`__TEAMAI_ENV_PREV_${key}`];
    else delete restored[key];
  }
  return restored;
}

function judgeEnv(tool: JudgeTool): NodeJS.ProcessEnv {
  const restored = memberEnv();
  return { ...Object.fromEntries([...COMMON_ENV, ...TOOL_ENV[judgeFamily(tool)]].flatMap((key) => restored[key] === undefined ? [] : [[key, restored[key]]])), TEAMAI_LAUNCHED_BY: 'scorer' };
}

async function optionalFile(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
}

async function claudeSettings(tool: JudgeTool, env: NodeJS.ProcessEnv, tmp: string): Promise<string> {
  const file = path.join(env.CLAUDE_CONFIG_DIR || toolHome(tool), 'settings.json');
  const text = await optionalFile(file);
  const settings = text ? z.object({ env: z.record(z.string()).optional(), model: z.string().optional() }).parse(JSON.parse(text)) : {};
  const allowed = Object.fromEntries(Object.entries(settings.env ?? {}).filter(([key]) => CLAUDE_ENV.includes(key)));
  const target = path.join(tmp, 'claude-settings.json');
  await fs.writeFile(target, JSON.stringify({ env: allowed, ...(settings.model ? { model: settings.model } : {}) }));
  return target;
}

function credentialEnv(key: string): string | undefined {
  if (['GH_TOKEN', 'GITHUB_TOKEN', 'GL_TOKEN', 'GITLAB_TOKEN', 'CI_JOB_TOKEN', 'BASH_ENV', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS'].includes(key) || key.startsWith('__TEAMAI_ENV_')) {
    throw new Error(`The judge profile uses blocked credential variable ${key}. Use a dedicated provider API-key variable instead`);
  }
  return memberEnv()[key];
}

async function codexSettings(tool: JudgeTool, env: NodeJS.ProcessEnv) {
  const text = await optionalFile(path.join(env.CODEX_HOME || toolHome(tool), 'config.toml'));
  if (!text) return { args: [], model: undefined };
  const config = z.object({ model: z.string().optional(), model_provider: z.string().optional(), model_providers: z.record(z.object({ name: z.string().optional(), base_url: z.string().optional(), wire_api: z.string().optional(), env_key: z.string().optional(), experimental_bearer_token: z.string().optional() })).optional() }).parse(parseToml(text));
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
  const provider = z.object({ npm: z.enum(['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/anthropic']).optional(), name: z.string().optional(), options: z.object({ baseURL: z.string().optional(), apiKey: z.string().optional() }).optional(), models: z.record(z.object({ name: z.string().optional() })).optional() });
  const settings = text ? z.object({ model: z.string().optional(), provider: z.record(provider.nullable()).optional() }).parse(JSON.parse(text)) : {};
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

/** Codex's own permission profile: its sandboxed shell reads only the evidence, with no network, no writes and core env. */
function codexProfile(evidence: string): string {
  return stringifyToml({
    default_permissions: 'judge',
    web_search: 'disabled',
    agents: { enabled: false },
    shell_environment_policy: { inherit: 'core' },
    permissions: { judge: { filesystem: { ':minimal': 'read', ':tmpdir': 'none', ':slash_tmp': 'none', [evidence]: 'read' }, network: { enabled: false } } },
  });
}

function records(stdout: string): Array<Record<string, unknown>> {
  return stdout.split('\n').flatMap((line) => {
    try { const parsed = RecordSchema.safeParse(JSON.parse(line)); return parsed.success ? [parsed.data] : []; }
    catch { return []; }
  });
}

function answerFrom(tool: JudgeTool, stdout: string): JudgeAnswer | undefined {
  const family = judgeFamily(tool);
  const events = records(stdout);
  if (family === 'claude' || family === 'codebuddy') {
    const last = events.filter((record) => record.type === 'result').at(-1);
    const structured = JudgeAnswerSchema.safeParse(last?.structured_output);
    if (structured.success) return structured.data;
    return parseAnswer(typeof last?.result === 'string' ? last.result : '');
  }
  const texts = events.flatMap((record) => {
    const parsed = z.object({ type: z.string().optional(), part: z.object({ text: z.string().optional() }).optional() }).safeParse(record);
    if (!parsed.success) return [];
    if (family === 'opencode' && parsed.data.type === 'text') return parsed.data.part?.text ?? [];
    return [];
  });
  return parseAnswer(texts.join('\n'));
}

function parseAnswer(text: string): JudgeAnswer | undefined {
  try {
    const parsed = JudgeAnswerSchema.safeParse(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

async function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, prompt: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const detached = process.platform !== 'win32';
  const child = crossSpawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached, windowsHide: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.setEncoding('utf8').on('data', (text: string) => stdout.push(text));
  child.stderr?.setEncoding('utf8').on('data', (text: string) => stderr.push(text));
  const exited = new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code ?? 1)); });
  const stop = stopProcess(child, exited, detached);
  const timer = setTimeout(() => { void stop(); }, 10 * 60_000);
  child.stdin?.on('error', () => {});
  child.stdin?.end(prompt);
  try { const code = await exited; return { stdout: stdout.join(''), stderr: stderr.join(''), code }; }
  finally { clearTimeout(timer); }
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

export async function runLocalJudge(input: JudgeInput, { resolveTool = resolveCliPath }: { resolveTool?: (tool: string) => string | null } = {}): Promise<LocalJudgeResult> {
  const executable = resolveTool(input.tool);
  if (!executable) return { ok: false, code: 'judge_tool_unavailable', message: `The ${input.tool} executable is not available on PATH. Install it, or submit this lease through another driver.` };
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-')));
  try {
    const evidence = await fs.realpath(input.evidence);
    const env = judgeEnv(input.tool);
    const family = judgeFamily(input.tool);
    const codex = family === 'codex' ? await codexSettings(input.tool, env) : { args: [], model: undefined };
    let configuredModel = codex.model;
    if (family === 'codex') {
      const auth = await optionalFile(path.join(env.CODEX_HOME || toolHome(input.tool), 'auth.json'));
      env.CODEX_HOME = path.join(tmp, 'codex');
      await fs.mkdir(env.CODEX_HOME);
      if (auth !== undefined) await fs.writeFile(path.join(env.CODEX_HOME, 'auth.json'), auth, { mode: 0o600 });
      await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'), codexProfile(evidence));
    }
    const version = await probeBinary(executable, ['--version'], (command, args, options) => execCommand(command, args, { ...options, env, cwd: tmp }));
    const cwd = family === 'opencode' ? path.join(tmp, 'evidence') : evidence;
    const checkout = family === 'opencode' && await insideCheckout(cwd);
    let isolation = profileIsolation(input.tool, version, checkout);
    if (input.isolation === 'verified' && isolation !== 'verified') {
      return { ok: false, code: 'judge_tool_unavailable', message: checkout
        ? `OpenCode would judge evidence inside the checkout above ${cwd}, which it lets its file tools read. Move the temp dir (TMPDIR) outside any git or hg checkout, or use another driver.`
        : `${input.tool} ${version || '(version unknown)'} has no verified judge profile. Install a supported version or use another driver.` };
    }
    let prompt = 'Apply the rubric to the evidence. Return only the requested JSON answer.\n';
    let args: string[];
    const model = input.model ? ['--model', input.model.name] : [];
    if (family === 'claude') {
      const settings = await claudeSettings(input.tool, env, tmp);
      args = ['-p', '--restricted', '--tools=Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(input.schema), '--append-system-prompt-file', path.join(evidence, 'prompt.md'), '--settings', settings, ...model, ...(input.model?.effort ? ['--effort', input.model.effort] : [])];
    } else if (family === 'codex') {
      const schema = path.join(tmp, 'schema.json');
      await fs.writeFile(schema, JSON.stringify(input.schema));
      args = ['-a', 'never', 'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--output-schema', schema, ...CODEX_DISABLED.flatMap((feature) => ['--disable', feature]), '-o', path.join(tmp, 'answer.json'), ...codex.args, ...model, ...(input.model?.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(input.model.effort)}`] : []), '-'];
      prompt += await fs.readFile(path.join(evidence, 'prompt.md'), 'utf8');
    } else if (family === 'codebuddy') {
      args = ['-p', '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--permission-mode', 'dontAsk', '--settings', JSON.stringify({ permissions: { allow: ['Read(./**)'] } }), '--output-format', 'json', '--json-schema', JSON.stringify(input.schema), ...model];
      prompt += await fs.readFile(path.join(evidence, 'prompt.md'), 'utf8');
    } else {
      await fs.cp(evidence, cwd, { recursive: true, dereference: false });
      const entries = await fs.readdir(cwd, { recursive: true, withFileTypes: true });
      if (entries.some((entry) => entry.isSymbolicLink())) throw new Error('OpenCode judge evidence contains a symlink. Rebuild the evidence before judging.');
      await noInstructionsAbove(cwd);
      configuredModel = await openCodeSettings(env, tmp);
      args = ['run', '--standalone', '--format', 'json', ...opencodeModelArgs(input.model, input.model?.effort ? await opencodeMajorVersion(executable) : 2)];
      prompt += await fs.readFile(path.join(cwd, 'prompt.md'), 'utf8');
    }
    const result = await run(executable, args, cwd, env, prompt);
    if (family === 'codebuddy' && /Authentication required/.test(result.stdout + result.stderr)) {
      return { ok: false, code: 'judge_tool_unavailable', message: 'CodeBuddy is not signed in. Sign in with codebuddy /login or set CODEBUDDY_API_KEY, then retry, or submit this lease through another driver.', raw: result.stdout + '\n' + result.stderr };
    }
    // CodeBuddy prints Claude's result record.
    const report = toolStdout(input.tool === 'codebuddy' ? 'claude' : input.tool, result.stdout);
    const tokens = report?.tokens;
    const cost = records(result.stdout).filter((record) => typeof record.total_cost_usd === 'number').at(-1)?.total_cost_usd;
    const spent = tokens || typeof cost === 'number'
      ? { usage: { ...(tokens?.input !== undefined ? { inputTokens: tokens.input } : {}), ...(tokens?.output !== undefined ? { outputTokens: tokens.output } : {}), ...(typeof cost === 'number' ? { cost: { amount: cost, unit: 'USD' } } : {}) } }
      : {};
    if (family === 'opencode' && report?.session) {
      const deleted = await run(executable, ['session', 'delete', report.session, '--standalone'], cwd, env, '');
      if (deleted.code !== 0) return { ok: false, code: 'judge_failed', message: 'OpenCode could not delete the judge session. Delete it with opencode session delete before retrying.', raw: deleted.stderr, ...spent };
    }
    if (result.code !== 0) return { ok: false, code: 'judge_failed', message: `${input.tool} exited with code ${result.code}. See the saved output, then retry or submit the lease through another driver.`, raw: result.stdout + '\n' + result.stderr, ...spent };
    const answer = family === 'codex' ? parseAnswer(await optionalFile(path.join(tmp, 'answer.json')) ?? '') : answerFrom(input.tool, result.stdout);
    if (!answer) return { ok: false, code: 'judge_answer_invalid', message: `${input.tool} did not return JSON with label and reasoning. See the saved output, then retry.`, raw: result.stdout + '\n' + result.stderr, ...spent };
    const ranModel = observedModel({ requested: input.model?.name ?? configuredModel, reported: report?.model });
    const ranEffort = observedEffort({ requested: input.model?.effort });
    if (!version) isolation = 'best-effort';
    return { ok: true, answer, judge: { tool: input.tool, ...(ranModel ? { model: ranModel } : {}), ...(ranEffort ? { effort: ranEffort } : {}), isolation, access: ACCESS[family], ...spent } };
  } catch (error) {
    return { ok: false, code: 'judge_failed', message: `The judge could not run: ${error instanceof Error ? error.message : String(error)}. Fix that, then retry this lease.` };
  } finally { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }); }
}
