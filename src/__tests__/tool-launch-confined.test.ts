import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { confinedOffers, runConfined } from '../tool-launch/confined.js';

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
  expect(env.TEAMAI_LAUNCHED_BY).toBe('scorer');
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
  await fs.writeFile(settings, JSON.stringify({ provider: { gateway: { options: { baseURL: 'https://gateway.test', apiKey: '{env:JUDGE_PROVIDER_KEY}' } } } }));
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
