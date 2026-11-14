import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { confinedOffers, installedConfinedTools, runConfined } from '../tool-launch/confined.js';
import { saveToolHomes } from '../tool-home.js';
import { getUserHome } from '../utils/home.js';

let root = '';
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-confined-'))); });
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

/** A tool executable that prints `version` for `--version` and runs `body` on its stdin otherwise. */
async function fakeTool(name: string, version: string, body = ''): Promise<string> {
  const executable = path.join(root, `${name}-fake`);
  await fs.writeFile(executable, `#!${process.execPath}
const fs=require('fs');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(); }
let stdin=''; process.stdin.on('data', d => stdin += d); process.stdin.on('end', () => {
${body}
});\n`, { mode: 0o755 });

  return executable;
}

/** Resolves only the executables in `onPath`, as a machine with only those tools installed does. */
function machineWith(onPath: Record<string, string>): (executable: string) => string | null {
  return (executable) => onPath[executable] ?? null;
}

it('offers a Cursor-only machine best-effort with full access, and nothing verified', async () => {
  const cursor = await fakeTool('cursor', '2026.10.1');

  expect(await confinedOffers({ resolveTool: machineWith({ 'cursor-agent': cursor }) })).toEqual([
    { level: 'best-effort', access: 'full', tools: ['cursor'] },
  ]);
});

it('offers each level split by the access of its tools, a verified tool at both levels', async () => {
  const claude = await fakeTool('claude', '2.1.308 (Claude Code)');
  const codex = await fakeTool('codex', 'codex-cli 9.9.9');
  const cursor = await fakeTool('cursor', '2026.10.1');

  expect(await confinedOffers({ resolveTool: machineWith({ claude, codex, 'cursor-agent': cursor }) })).toEqual([
    { level: 'verified', access: 'read', tools: ['claude'] },
    { level: 'best-effort', access: 'read', tools: ['claude', 'codex'] },
    { level: 'best-effort', access: 'full', tools: ['cursor'] },
  ]);
});

/** A directory holding one evidence file, and its listing, which a confined run must leave as it was. */
async function evidenceDir(): Promise<{ dir: string; listing: () => Promise<string[]> }> {
  const dir = path.join(root, 'evidence');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'transcript.md'), 'The member asked for a fix.');

  return { dir, listing: async () => (await fs.readdir(dir)).sort() };
}

const Invocation = z.object({ args: z.array(z.string()), cwd: z.string(), env: z.record(z.string(), z.string()), stdin: z.string(), profile: z.string().optional() });

it('runs Codex in the directory, readable only there, with the prompt on stdin and nothing written into it', async () => {
  const { dir, listing } = await evidenceDir();
  const record = path.join(root, 'invocation.json');
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex-home'));
  const codex = await fakeTool('codex', 'codex-cli 0.163.0', `
const args=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd(), env: process.env, stdin, profile: fs.readFileSync(require('path').join(process.env.CODEX_HOME,'config.toml'),'utf8') }));
fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({ verdict: 'fixed' }));`);

  const result = await runConfined({ tool: 'codex', dir, prompt: 'Say whether the fix landed.', schema: { type: 'object' }, level: 'verified', timeoutMs: 60_000 }, { resolveTool: machineWith({ codex }) });

  expect(result).toEqual({ ok: true, reply: { verdict: 'fixed' }, run: { tool: 'codex', isolation: 'verified', access: 'read' } });
  const invocation = Invocation.parse(JSON.parse(await fs.readFile(record, 'utf8')));
  expect(invocation.cwd).toBe(dir);
  const readable = Object.entries(z.object({ permissions: z.object({ judge: z.object({ filesystem: z.record(z.string(), z.string()) }) }) }).parse(parseToml(invocation.profile ?? '')).permissions.judge.filesystem).filter(([, access]) => access === 'read').map(([at]) => at);
  expect(readable).toEqual([':minimal', dir]);
  expect(invocation.stdin).toContain('Say whether the fix landed.');
  // A confined step is any step's prompt, so what the launch adds names no rubric or evidence.
  expect(invocation.stdin.replace('Say whether the fix landed.', '')).not.toMatch(/rubric|evidence/i);
  expect(invocation.args).toContain('--output-schema');
  expect(await listing()).toEqual(['transcript.md']);
});

it('gives Claude the directory as its cwd and the prompt as a system prompt file outside it', async () => {
  const { dir, listing } = await evidenceDir();
  const record = path.join(root, 'invocation.json');
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude-home'));
  const claude = await fakeTool('claude', '2.1.308 (Claude Code)', `
const args=process.argv.slice(2); const file=args[args.indexOf('--append-system-prompt-file')+1];
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd(), env: process.env, stdin, profile: fs.readFileSync(file,'utf8') + '\\n' + file }));
console.log(JSON.stringify({ type: 'result', structured_output: { verdict: 'fixed' } }));`);

  const result = await runConfined({ tool: 'claude', dir, prompt: 'Say whether the fix landed.', level: 'verified', timeoutMs: 60_000 }, { resolveTool: machineWith({ claude }) });

  expect(result).toMatchObject({ ok: true, reply: { verdict: 'fixed' }, run: { tool: 'claude', isolation: 'verified', access: 'read' } });
  const invocation = Invocation.parse(JSON.parse(await fs.readFile(record, 'utf8')));
  const [prompt, file] = (invocation.profile ?? '').split('\n');
  expect(invocation.cwd).toBe(dir);
  expect(prompt).toBe('Say whether the fix landed.');
  expect(path.relative(dir, file ?? '').startsWith('..')).toBe(true);
  expect(invocation.args).toEqual(expect.arrayContaining(['--restricted', '--tools=Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence']));
  expect(invocation.args).not.toContain('--json-schema');
  expect(await listing()).toEqual(['transcript.md']);
});

it('passes no team secret or credential to the tool, and marks its session as launched by teamai', async () => {
  const { dir } = await evidenceDir();
  const record = path.join(root, 'invocation.json');
  vi.stubEnv('__TEAMAI_ENV_KEYS', 'TEAM_DEPLOY_TOKEN ANTHROPIC_API_KEY');
  vi.stubEnv('TEAM_DEPLOY_TOKEN', 'team-secret');
  vi.stubEnv('ANTHROPIC_API_KEY', 'team-loaded-key');
  vi.stubEnv('GH_TOKEN', 'member-gh-token');
  vi.stubEnv('CANARY_TOKEN', 'member-shell-secret');
  vi.stubEnv('TEAMAI_LAUNCHED_TOOL', 'claude');
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude-home'));
  const claude = await fakeTool('claude', '2.1.308 (Claude Code)', `
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: [], cwd: process.cwd(), env: process.env, stdin }));
console.log(JSON.stringify({ type: 'result', structured_output: { verdict: 'fixed' } }));`);

  const result = await runConfined({ tool: 'claude', dir, prompt: 'Say whether the fix landed.', level: 'verified', timeoutMs: 60_000 }, { resolveTool: machineWith({ claude }) });

  expect(result).toMatchObject({ ok: true, reply: { verdict: 'fixed' }, run: { tool: 'claude', isolation: 'verified' } });
  const { env } = Invocation.parse(JSON.parse(await fs.readFile(record, 'utf8')));
  expect(Object.values(env)).not.toEqual(expect.arrayContaining([expect.stringMatching(/team-secret|team-loaded-key|member-gh-token|member-shell-secret/)]));
  expect(Object.keys(env).filter((key) => key.startsWith('__TEAMAI_ENV_') || key === 'TEAMAI_LAUNCHED_TOOL')).toEqual([]);
  expect(env.TEAMAI_LAUNCHED_BY).toBe('confined');
});

it('refuses a verified run on a tool that cannot reach verified, without starting it', async () => {
  const { dir } = await evidenceDir();
  const started = path.join(root, 'started');
  const cursor = await fakeTool('cursor', '2026.10.1', `fs.writeFileSync(${JSON.stringify(started)}, '');`);

  const result = await runConfined({ tool: 'cursor', dir, prompt: 'Say whether the fix landed.', level: 'verified', timeoutMs: 60_000 }, { resolveTool: machineWith({ 'cursor-agent': cursor }) });

  expect(result).toEqual({ ok: false, code: 'confined_tool_unavailable', message: 'cursor 2026.10.1 has no verified judge profile. Install a supported version or use another driver.' });
  expect(await fs.access(started).then(() => true, () => false)).toBe(false);
});

it('fails a reply that is not JSON, keeping what the tool printed', async () => {
  const { dir } = await evidenceDir();
  const cursor = await fakeTool('cursor', '2026.10.1', "console.log(JSON.stringify({ type: 'result', result: 'The fix landed.' }));");

  const result = await runConfined({ tool: 'cursor', dir, prompt: 'Say whether the fix landed.', level: 'best-effort', timeoutMs: 60_000 }, { resolveTool: machineWith({ 'cursor-agent': cursor }) });

  expect(result).toEqual({ ok: false, code: 'confined_reply_invalid', message: 'cursor did not reply with JSON. See the saved output, then retry.', raw: expect.stringContaining('The fix landed.') });
});

it.each([
  ['inlines a provider key OpenCode reads from the env, which the confined env does not carry', 'provider-key', { ok: true, reply: { verdict: 'fixed' } }, 'provider-key'],
  ['fails when that provider key is not set', undefined, { ok: false, code: 'confined_failed', message: 'opencode could not run confined: OpenCode provider credential JUDGE_PROVIDER_KEY is not set. Fix that, then retry.' }, undefined],
])('%s', async (_, key, expected, inlined) => {
  const { dir } = await evidenceDir();
  const record = path.join(root, 'config.json');
  const settings = path.join(root, 'opencode.json');
  await fs.writeFile(settings, JSON.stringify({ provider: { gateway: { options: { baseURL: 'https://gateway.test', apiKey: '{env:JUDGE_PROVIDER_KEY}' } }, local: { name: 'Local' }, direct: { options: { apiKey: 'sk-literal' } }, keyless: { options: { baseURL: 'https://local.test' } }, removed: null } }));
  vi.stubEnv('OPENCODE_CONFIG', settings);
  vi.stubEnv('JUDGE_PROVIDER_KEY', key);
  const opencode = await fakeTool('opencode', 'opencode v2.1.2', `
fs.writeFileSync(${JSON.stringify(record)}, fs.readFileSync(require('path').join(process.env.OPENCODE_CONFIG_DIR, 'opencode.json'), 'utf8'));
console.log(JSON.stringify({ type: 'text', part: { text: '{"verdict":"fixed"}' } }));`);

  const result = await runConfined({ tool: 'opencode', dir, prompt: 'Say whether the fix landed.', level: 'best-effort', timeoutMs: 60_000 }, { resolveTool: machineWith({ opencode }) });

  expect(result).toMatchObject(expected);
  const written = await fs.readFile(record, 'utf8').then((text) => z.object({ provider: z.object({ gateway: z.object({ options: z.object({ apiKey: z.string() }) }) }) }).parse(JSON.parse(text)).provider.gateway.options.apiKey, () => undefined);
  expect(written).toBe(inlined);
});

it("gives the tool the member's own key where the team env replaced it, and drops a key only the team set", async () => {
  const { dir } = await evidenceDir();
  const record = path.join(root, 'env.json');
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude-home'));
  vi.stubEnv('__TEAMAI_ENV_KEYS', 'ANTHROPIC_API_KEY ANTHROPIC_BASE_URL');
  vi.stubEnv('ANTHROPIC_API_KEY', 'team-key');
  vi.stubEnv('__TEAMAI_ENV_SET_ANTHROPIC_API_KEY', '2');
  vi.stubEnv('__TEAMAI_ENV_PREV_ANTHROPIC_API_KEY', 'member-key');
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://team-gateway.test');
  vi.stubEnv('__TEAMAI_ENV_SET_ANTHROPIC_BASE_URL', '1');
  const claude = await fakeTool('claude', '2.1.308 (Claude Code)', `
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ key: process.env.ANTHROPIC_API_KEY ?? null, url: process.env.ANTHROPIC_BASE_URL ?? null }));
console.log(JSON.stringify({ type: 'result', structured_output: {} }));`);

  expect(await runConfined({ tool: 'claude', dir, prompt: 'Say whether the fix landed.', level: 'best-effort', timeoutMs: 60_000 }, { resolveTool: machineWith({ claude }) })).toMatchObject({ ok: true });
  expect(JSON.parse(await fs.readFile(record, 'utf8'))).toEqual({ key: 'member-key', url: null });
});

it('refuses a Codex provider whose key lives in a credential variable teamai blocks', async () => {
  const { dir } = await evidenceDir();
  const home = path.join(root, 'codex-home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider="gateway"\n[model_providers.gateway]\nbase_url="https://gateway.test"\nenv_key="GH_TOKEN"\n');
  vi.stubEnv('CODEX_HOME', home);
  vi.stubEnv('GH_TOKEN', 'member-gh-token');
  const codex = await fakeTool('codex', 'codex-cli 0.163.0');

  expect(await runConfined({ tool: 'codex', dir, prompt: 'Say whether the fix landed.', level: 'best-effort', timeoutMs: 60_000 }, { resolveTool: machineWith({ codex }) })).toEqual({
    ok: false, code: 'confined_failed', message: 'codex could not run confined: The confined profile uses blocked credential variable GH_TOKEN. Use a dedicated provider API-key variable instead. Fix that, then retry.',
  });
});

it('gives a confined Codex judge the member\'s CODEX_API_KEY, and nothing else it did not ask for', async () => {
  // Codex reads its credential from CODEX_API_KEY as well as from OPENAI_API_KEY
  // or ~/.codex/auth.json — "run `codex login` or set CODEX_API_KEY". A member
  // who signs in that way and has no auth.json has no credential inside the
  // confined run, and the judge fails with Codex's authentication error.
  const { dir } = await evidenceDir();
  const record = path.join(root, 'invocation.json');
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex-home'));
  vi.stubEnv('CODEX_API_KEY', 'member-codex-key');
  vi.stubEnv('OPENAI_API_KEY', 'member-openai-key');
  vi.stubEnv('CANARY_TOKEN', 'member-shell-secret');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'member-aws-secret');
  const codex = await fakeTool('codex', 'codex-cli 0.163.0', `
const args=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd(), env: process.env, stdin }));
fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({ verdict: 'fixed' }));`);

  const result = await runConfined({ tool: 'codex', dir, prompt: 'Say whether the fix landed.', schema: { type: 'object' }, level: 'verified', timeoutMs: 60_000 }, { resolveTool: machineWith({ codex }) });

  expect(result).toMatchObject({ ok: true, reply: { verdict: 'fixed' } });
  const { env } = Invocation.parse(JSON.parse(await fs.readFile(record, 'utf8')));
  expect(env.CODEX_API_KEY).toBe('member-codex-key');
  expect(env.OPENAI_API_KEY).toBe('member-openai-key');
  // The canaries must not ride along: confinement limits what the judge reaches.
  expect(env.CANARY_TOKEN).toBeUndefined();
  expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(Object.values(env)).not.toEqual(expect.arrayContaining([expect.stringMatching(/member-shell-secret|member-aws-secret/)]));
  // Nothing outside the common names, Codex's own profile names and the
  // variables teamai sets itself, PWD among them as the judge's own directory, may reach the child. The suite's own
  // tracker injects NODE_OPTIONS into every child it starts, so that one is
  // not teamai's to account for.
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'TEAMAI_LAUNCHED_BY', 'TEAMAI_MODE', 'PWD']);
  expect(Object.keys(env).filter((key) => !allowed.has(key) && key !== 'NODE_OPTIONS' && key !== '__CF_USER_TEXT_ENCODING')).toEqual([]);
});

it('leaves a confined Codex judge that has no CODEX_API_KEY alone', async () => {
  // A member signed in with auth.json, or with OPENAI_API_KEY alone, must get
  // the environment they had before: the allow-list names a variable, it
  // does not add one.
  const { dir } = await evidenceDir();
  const record = path.join(root, 'invocation.json');
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex-home'));
  vi.stubEnv('OPENAI_API_KEY', 'member-openai-key');
  const codex = await fakeTool('codex', 'codex-cli 0.163.0', `
const args=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd(), env: process.env, stdin }));
fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({ verdict: 'fixed' }));`);

  const result = await runConfined({ tool: 'codex', dir, prompt: 'Say whether the fix landed.', schema: { type: 'object' }, level: 'verified', timeoutMs: 60_000 }, { resolveTool: machineWith({ codex }) });

  expect(result).toMatchObject({ ok: true, reply: { verdict: 'fixed' } });
  const { env } = Invocation.parse(JSON.parse(await fs.readFile(record, 'utf8')));
  expect(env.CODEX_API_KEY).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBe('member-openai-key');
});

it('lists the preferred confined tools first and leaves out a tool with no confined profile', async () => {
  const onPath = machineWith({ copilot: '/bin/copilot', 'cursor-agent': '/bin/cursor-agent', claude: '/bin/claude' });

  expect(installedConfinedTools(['copilot', 'cursor'], { resolveTool: onPath })).toEqual(['cursor', 'claude']);
});

/** Puts the temporary directory the launcher works in under `parent`, holding `file`. */
async function tmpUnder(file: string): Promise<void> {
  const parent = path.join(root, 'parent');
  await fs.mkdir(path.join(parent, 'tmp'), { recursive: true });
  await fs.writeFile(path.join(parent, file), '');
  vi.stubEnv('TMPDIR', path.join(parent, 'tmp'));
}

it('offers a verified OpenCode only at best-effort when its temporary copy would sit inside a checkout, and Claude still verified', async () => {
  await tmpUnder('.git');
  const opencode = await fakeTool('opencode', 'opencode v2.1.2');
  const claude = await fakeTool('claude', '2.1.308 (Claude Code)');

  expect(await confinedOffers({ resolveTool: machineWith({ opencode, claude }) })).toEqual([
    { level: 'verified', access: 'read', tools: ['claude'] },
    { level: 'best-effort', access: 'read', tools: ['claude', 'opencode'] },
  ]);
});

it('refuses to run OpenCode where it would load an AGENTS.md above its copy of the directory', async () => {
  const { dir } = await evidenceDir();
  await tmpUnder('AGENTS.md');
  const opencode = await fakeTool('opencode', 'opencode v2.1.2');

  expect(await runConfined({ tool: 'opencode', dir, prompt: 'Say whether the fix landed.', level: 'best-effort', timeoutMs: 60_000 }, { resolveTool: machineWith({ opencode }) })).toMatchObject({
    ok: false, code: 'confined_failed', message: expect.stringContaining(`OpenCode would load instructions from ${path.join(root, 'parent', 'AGENTS.md')}`),
  });
});

it('fails a tool that exits non-zero with only stderr by its exit code, keeping that stderr', async () => {
  const { dir } = await evidenceDir();
  const cursor = await fakeTool('cursor', '2026.10.1', "process.stderr.write('network unreachable'); process.exit(2);");

  expect(await runConfined({ tool: 'cursor', dir, prompt: 'Say whether the fix landed.', level: 'best-effort', timeoutMs: 60_000 }, { resolveTool: machineWith({ 'cursor-agent': cursor }) })).toEqual({
    ok: false, code: 'confined_failed', message: 'cursor exited with code 2. See the saved output, then retry or use another tool or driver.', raw: '\nnetwork unreachable',
  });
});

it('fails a tool that is not on PATH without creating anything', async () => {
  const { dir, listing } = await evidenceDir();

  expect(await runConfined({ tool: 'claude', dir, prompt: 'Say whether the fix landed.', level: 'best-effort', timeoutMs: 60_000 }, { resolveTool: machineWith({}) })).toEqual({
    ok: false, code: 'confined_tool_unavailable', message: 'The claude executable is not available on PATH. Install it, or use another tool or driver.',
  });
  expect(await listing()).toEqual(['transcript.md']);
});

it('fails a tool whose recorded home is gone without starting it, and says how to fix the record', async () => {
  const { dir, listing } = await evidenceDir();
  const gone = path.join(getUserHome(), '.codebuddy-gone');
  await saveToolHomes({ codebuddy: gone });
  onTestFinished(async () => { await saveToolHomes({}); });
  const started = path.join(root, 'started');
  const codebuddy = await fakeTool('codebuddy', '2.176.0', `fs.writeFileSync(${JSON.stringify(started)}, '');`);

  expect(await runConfined({ tool: 'codebuddy', dir, prompt: 'Say whether the fix landed.', level: 'best-effort', timeoutMs: 60_000 }, { resolveTool: machineWith({ codebuddy }) })).toEqual({
    ok: false, code: 'confined_tool_unavailable',
    message: `The codebuddy home recorded on this machine, ${gone}, does not exist, so teamai did not start codebuddy there. `
      + 'Point CODEBUDDY_CONFIG_DIR at the home codebuddy uses and re-run `teamai init`, or clear the record with `CODEBUDDY_CONFIG_DIR= teamai init`.',
  });
  expect(await fs.access(started).then(() => true, () => false)).toBe(false);
  expect(await listing()).toEqual(['transcript.md']);
});

it("keeps the member's Claude model and only the switch variables its profile allows in the settings it passes", async () => {
  const { dir } = await evidenceDir();
  const home = path.join(root, 'claude-home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ model: 'member-model', env: { ANTHROPIC_BASE_URL: 'https://gateway.test', GH_TOKEN: 'member-gh-token' } }));
  vi.stubEnv('CLAUDE_CONFIG_DIR', home);
  const record = path.join(root, 'settings.json');
  const claude = await fakeTool('claude', '2.1.308 (Claude Code)', `
const args=process.argv.slice(2); fs.copyFileSync(args[args.indexOf('--settings')+1], ${JSON.stringify(record)});
console.log(JSON.stringify({ type: 'result', structured_output: {} }));`);

  expect(await runConfined({ tool: 'claude', dir, prompt: 'Say whether the fix landed.', level: 'best-effort', timeoutMs: 60_000 }, { resolveTool: machineWith({ claude }) })).toMatchObject({ ok: true });
  expect(JSON.parse(await fs.readFile(record, 'utf8'))).toEqual({ model: 'member-model', env: { ANTHROPIC_BASE_URL: 'https://gateway.test' } });
});

it('keeps the Codex model when the provider it names has no table', async () => {
  const { dir } = await evidenceDir();
  const home = path.join(root, 'codex-home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'config.toml'), 'model="member-model"\nmodel_provider="gateway"\n');
  vi.stubEnv('CODEX_HOME', home);
  const record = path.join(root, 'args.json');
  const codex = await fakeTool('codex', 'codex-cli 0.163.0', `
const args=process.argv.slice(2); fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(args));
fs.writeFileSync(args[args.indexOf('-o')+1], '{}');`);

  expect(await runConfined({ tool: 'codex', dir, prompt: 'Say whether the fix landed.', level: 'best-effort', timeoutMs: 60_000 }, { resolveTool: machineWith({ codex }) })).toMatchObject({ ok: true, run: { model: { requested: 'member-model' } } });
  expect(z.array(z.string()).parse(JSON.parse(await fs.readFile(record, 'utf8'))).filter((arg) => arg.startsWith('model'))).toEqual(['model="member-model"']);
});

it('records a cost the tool reported without its tokens', async () => {
  const { dir } = await evidenceDir();
  const cursor = await fakeTool('cursor', '2026.10.1', "console.log(JSON.stringify({ type: 'result', result: '{}', total_cost_usd: 0.02 }));");

  expect(await runConfined({ tool: 'cursor', dir, prompt: 'Say whether the fix landed.', level: 'best-effort', timeoutMs: 60_000 }, { resolveTool: machineWith({ 'cursor-agent': cursor }) })).toEqual({
    ok: true, reply: {}, run: { tool: 'cursor', isolation: 'best-effort', access: 'full', usage: { cost: { amount: 0.02, unit: 'USD' } } },
  });
});

it('fails a tool that exits 0 without a result record as a reply that is not JSON', async () => {
  const { dir } = await evidenceDir();
  const cursor = await fakeTool('cursor', '2026.10.1', "console.log('done');");

  expect(await runConfined({ tool: 'cursor', dir, prompt: 'Say whether the fix landed.', level: 'best-effort', timeoutMs: 60_000 }, { resolveTool: machineWith({ 'cursor-agent': cursor }) })).toMatchObject({ ok: false, code: 'confined_reply_invalid', raw: 'done\n\n' });
});
