import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import { installedJudgeTools, runLocalJudge } from '../scorers/judge.js';

let root = '';
afterEach(async () => { vi.unstubAllEnvs(); if (root) await fs.rm(root, { recursive: true, force: true }); });

it.each(['2.1.308 (Claude Code)', '', '9.9.9 (Claude Code)'])('confines Claude %s, preserves switch settings, and sends the prompt through stdin and a file', async (version) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-'));
  const evidence = path.join(root, 'evidence');
  await fs.mkdir(evidence);
  await fs.writeFile(path.join(evidence, 'prompt.md'), 'UNTRUSTED-PROMPT-SECRET');
  const config = path.join(root, 'claude');
  await fs.mkdir(config);
  await fs.writeFile(path.join(config, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.test', ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway-sonnet', GH_TOKEN: 'not-forwarded' }, hooks: { SessionStart: [] } }));
  vi.stubEnv('CLAUDE_CONFIG_DIR', config);
  vi.stubEnv('BASH_ENV', '/must-not-run');
  vi.stubEnv('GH_TOKEN', 'must-not-leak');
  vi.stubEnv('TEAMAI_LAUNCHED_TOOL', 'claude');
  vi.stubEnv('TEAMAI_LAUNCHED_CHECKOUT', '/must-not-capture');
  vi.stubEnv('CANARY_TOKEN', 'must-not-leak');
  vi.stubEnv('__TEAMAI_ENV_KEYS', 'ANTHROPIC_API_KEY');
  vi.stubEnv('ANTHROPIC_API_KEY', 'loaded-project-secret');
  const executable = path.join(root, 'claude-fake');
  const record = path.join(evidence, 'invocation.json');
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('fs');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(); }
let stdin=''; process.stdin.on('data', d => stdin += d); process.stdin.on('end', () => {
const args=process.argv.slice(2); const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
fs.writeFileSync('invocation.json', JSON.stringify({args,env:process.env,stdin,settings}));
console.log(JSON.stringify({type:'system',subtype:'init',model:'reported-model'}));
console.log(JSON.stringify({type:'result',structured_output:{label:'good',reasoning:'done'},usage:{input_tokens:3,output_tokens:2},total_cost_usd:0.01}));
});\n`, { mode: 0o755 });
  const result = await runLocalJudge({ tool: 'claude', evidence, schema: { type: 'object' } }, { resolveTool: () => executable });
  expect(result).toMatchObject({ ok: true, answer: { label: 'good' }, judge: { tool: 'claude', model: { reported: 'reported-model' }, access: 'read', isolation: version === '2.1.308 (Claude Code)' ? 'verified' : 'best-effort', usage: { inputTokens: 3, outputTokens: 2, cost: { amount: 0.01, unit: 'USD' } } } });
  const invocation = z.object({ args: z.array(z.string()), env: z.record(z.string()), stdin: z.string(), settings: z.object({ env: z.record(z.string()) }) }).parse(JSON.parse(await fs.readFile(record, 'utf8')));
  expect(invocation.args).toEqual(expect.arrayContaining(['--restricted', '--tools=Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts', 'none', '--append-system-prompt-file']));
  expect(invocation.args.join(' ')).not.toContain('UNTRUSTED-PROMPT-SECRET');
  expect(invocation.stdin).toContain('rubric');
  expect(invocation.env.TEAMAI_LAUNCHED_BY).toBe('scorer');
  for (const key of ['GH_TOKEN', 'BASH_ENV', 'CANARY_TOKEN', '__TEAMAI_ENV_KEYS', 'TEAMAI_LAUNCHED_TOOL', 'TEAMAI_LAUNCHED_CHECKOUT', 'ANTHROPIC_API_KEY']) expect(invocation.env).not.toHaveProperty(key);
  expect(invocation.settings.env).toEqual({ ANTHROPIC_BASE_URL: 'https://gateway.test', ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway-sonnet' });
});

it.each(['codex-cli 0.163.0', '', 'codex-cli 9.9.9'])('confines Codex %s to the evidence through a permission profile in a temporary home, and reads only the final answer file', async (version) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-'));
  const evidence = path.join(root, 'evidence');
  const home = path.join(root, 'codex');
  await fs.mkdir(evidence); await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'auth.json'), '{"login":"fixture"}');
  await fs.writeFile(path.join(home, 'config.toml'), 'model="gateway-model"\nmodel_provider="teamai"\n[model_providers.teamai]\nname="Gateway"\nbase_url="https://gateway.test"\nwire_api="responses"\nenv_key="JUDGE_GATEWAY_TOKEN"\n');
  vi.stubEnv('JUDGE_GATEWAY_TOKEN', 'gateway-credential');
  await fs.writeFile(path.join(home, 'AGENTS.md'), 'MUST NOT LOAD');
  await fs.writeFile(path.join(evidence, 'prompt.md'), 'CODEX-INLINE-PROMPT');
  vi.stubEnv('CODEX_HOME', home);
  vi.stubEnv('BASH_ENV', '/must-not-run');
  const record = path.join(root, 'invocation.json');
  const executable = path.join(root, 'codex-fake');
  await fs.writeFile(executable, `#!${process.execPath}
const fs=require('fs'),path=require('path');
if(process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(); }
let stdin=''; process.stdin.on('data', d=>stdin+=d); process.stdin.on('end',()=>{
const args=process.argv.slice(2); const home=process.env.CODEX_HOME;
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args,env:process.env,stdin,cwd:process.cwd(),homeFiles:fs.readdirSync(home).sort(),config:fs.readFileSync(path.join(home,'config.toml'),'utf8')}));
fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({label:'good',reasoning:'final answer'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'commentary is not the answer'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,output_tokens:4}}));
});\n`, { mode: 0o755 });
  const result = await runLocalJudge({ tool: 'codex', evidence, schema: { type: 'object' } }, { resolveTool: () => executable });
  expect(result).toMatchObject({ ok: true, answer: { label: 'good', reasoning: 'final answer' }, judge: { tool: 'codex', model: { requested: 'gateway-model' }, access: 'read', isolation: version === 'codex-cli 0.163.0' ? 'verified' : 'best-effort', usage: { inputTokens: 7, outputTokens: 4 } } });
  const invocation = z.object({ args: z.array(z.string()), env: z.record(z.string()), stdin: z.string(), cwd: z.string(), homeFiles: z.array(z.string()), config: z.string() }).parse(JSON.parse(await fs.readFile(record, 'utf8')));
  const real = await fs.realpath(evidence);
  expect(invocation.cwd).toBe(real);
  expect(invocation.args.slice(0, 3)).toEqual(['-a', 'never', 'exec']);
  expect(invocation.args.at(-1)).toBe('-');
  expect(invocation.args).toEqual(expect.arrayContaining(['--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--output-schema']));
  expect(invocation.args).not.toContain('--ignore-user-config');
  for (const feature of ['hooks', 'plugins', 'apps', 'browser_use', 'computer_use', 'multi_agent', 'multi_agent_v2']) expect(invocation.args.some((arg, i) => arg === '--disable' && invocation.args[i + 1] === feature)).toBe(true);
  expect(invocation.homeFiles).toEqual(['auth.json', 'config.toml']);
  expect(parseToml(invocation.config)).toEqual({
    default_permissions: 'judge',
    web_search: 'disabled',
    agents: { enabled: false },
    shell_environment_policy: { inherit: 'core' },
    permissions: { judge: { filesystem: { ':minimal': 'read', ':tmpdir': 'none', ':slash_tmp': 'none', [real]: 'read' }, network: { enabled: false } } },
  });
  expect(invocation.stdin).toContain('CODEX-INLINE-PROMPT');
  expect(invocation.args.join(' ')).not.toContain('CODEX-INLINE-PROMPT');
  expect(invocation.args).toContain('model_provider="teamai"');
  expect(invocation.env.TEAMAI_JUDGE_API_KEY).toBe('gateway-credential');
  expect(invocation.env).not.toHaveProperty('JUDGE_GATEWAY_TOKEN');
  expect(invocation.env).not.toHaveProperty('BASH_ENV');
  expect(invocation.env.TEAMAI_LAUNCHED_BY).toBe('scorer');
  expect(await fs.access(invocation.env.CODEX_HOME ?? '').then(() => true, () => false)).toBe(false);
});

it.each([
  ['no scorer model', undefined, ['-c', 'model="member-chosen"'], 'member-chosen'],
  ['a scorer model', { name: 'gpt-6-mini' }, ['--model', 'gpt-6-mini'], 'gpt-6-mini'],
])('keeps the Codex model the member configured without a custom provider, unless the scorer names one: %s', async (_, model, expected, requested) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-'));
  const evidence = path.join(root, 'evidence');
  const home = path.join(root, 'codex');
  await fs.mkdir(evidence); await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'config.toml'), 'model = "member-chosen"\n');
  await fs.writeFile(path.join(evidence, 'prompt.md'), 'Judge.');
  vi.stubEnv('CODEX_HOME', home);
  const record = path.join(root, 'args.json');
  const executable = path.join(root, 'codex-fake');
  await fs.writeFile(executable, `#!${process.execPath}
const fs=require('fs');
if(process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(); }
process.stdin.resume(); process.stdin.on('end',()=>{
const args=process.argv.slice(2); fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(args));
fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({label:'good',reasoning:'r'}));
});\n`, { mode: 0o755 });

  const result = await runLocalJudge({ tool: 'codex', ...(model ? { model } : {}), evidence, schema: {} }, { resolveTool: () => executable });

  expect(result).toMatchObject({ ok: true, judge: { model: { requested } } });
  const args = z.array(z.string()).parse(JSON.parse(await fs.readFile(record, 'utf8')));
  expect(args.join(' ')).toContain(expected.join(' '));
  expect(args.lastIndexOf('--model')).toBe(model ? args.length - 3 : -1);
});

it.each([
  ['opencode v2.1.2', ['--model', 'anthropic/claude-haiku-4-5#low']],
  ['opencode v1.4.0', ['--model', 'anthropic/claude-haiku-4-5', '--variant', 'low']],
])('passes an alias effort to %s the way a workflow step does', async (version, expected) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-'));
  const evidence = path.join(root, 'evidence');
  await fs.mkdir(evidence);
  await fs.writeFile(path.join(evidence, 'prompt.md'), 'Judge.');
  const settings = path.join(root, 'user-opencode.json');
  await fs.writeFile(settings, '{}');
  vi.stubEnv('OPENCODE_CONFIG', settings);
  const record = path.join(root, 'args.json');
  const executable = path.join(root, `opencode-${version.replace(/\W/g, '')}`);
  await fs.writeFile(executable, `#!${process.execPath}
const fs=require('fs'); const args=process.argv.slice(2);
if(args.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(); }
if(args[0]==='session') process.exit();
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(args));
process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({type:'text',sessionID:'ses_judge',part:{text:JSON.stringify({label:'good',reasoning:'r'})}})));
\n`, { mode: 0o755 });

  const result = await runLocalJudge({ tool: 'opencode', model: { name: 'anthropic/claude-haiku-4-5', effort: 'low' }, evidence, schema: {} }, { resolveTool: () => executable });

  expect(result).toMatchObject({ ok: true, judge: { model: { requested: 'anthropic/claude-haiku-4-5' }, effort: { requested: 'low' } } });
  expect(z.array(z.string()).parse(JSON.parse(await fs.readFile(record, 'utf8')))).toEqual(['run', '--standalone', '--format', 'json', ...expected]);
});

it('runs OpenCode standalone with denied tools, an instruction-free parent chain, and deletes the judge session', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-'));
  const evidence = path.join(root, 'evidence');
  await fs.mkdir(evidence);
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'MUST NOT LOAD');
  await fs.writeFile(path.join(evidence, 'prompt.md'), 'OPENCODE-INLINE-PROMPT');
  const settings = path.join(root, 'user-opencode.json');
  await fs.writeFile(settings, '{}');
  vi.stubEnv('OPENCODE_CONFIG', settings);
  const record = path.join(root, 'invocation.json');
  const deleted = path.join(root, 'deleted.json');
  const executable = path.join(root, 'opencode-fake');
  await fs.writeFile(executable, `#!${process.execPath}
const fs=require('fs'),path=require('path'); const args=process.argv.slice(2);
if(args.includes('--version')) { console.log('opencode v2.1.2'); process.exit(); }
if(args[0]==='session') { fs.writeFileSync(${JSON.stringify(deleted)},JSON.stringify(args)); process.exit(); }
let stdin=''; process.stdin.on('data',d=>stdin+=d); process.stdin.on('end',()=>{
const config=JSON.parse(fs.readFileSync(path.join(process.env.OPENCODE_CONFIG_DIR,'opencode.json'),'utf8'));
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({args,env:process.env,stdin,config,cwd:process.cwd()}));
console.log(JSON.stringify({type:'text',sessionID:'ses_judge',part:{text:JSON.stringify({label:'good',reasoning:'done'})}}));
console.log(JSON.stringify({type:'step_finish',part:{modelID:'reported-open-model',tokens:{input:4,output:3}}}));
});\n`, { mode: 0o755 });
  expect(await runLocalJudge({ tool: 'opencode', evidence, schema: {} }, { resolveTool: () => executable })).toMatchObject({ ok: true, judge: { tool: 'opencode', model: { reported: 'reported-open-model' }, access: 'read', isolation: 'verified' } });
  const invocation = z.object({ args: z.array(z.string()), env: z.record(z.string()), stdin: z.string(), config: z.object({ permission: z.record(z.string()), plugin: z.array(z.unknown()), mcp: z.record(z.unknown()) }), cwd: z.string() }).parse(JSON.parse(await fs.readFile(record, 'utf8')));
  expect(invocation.args).toEqual(['run', '--standalone', '--format', 'json']);
  expect(invocation.config).toMatchObject({ permission: { '*': 'deny', external_directory: 'deny', bash: 'deny', edit: 'deny', webfetch: 'deny' }, plugin: [], mcp: {} });
  expect(invocation.stdin).toContain('OPENCODE-INLINE-PROMPT');
  expect(invocation.env).not.toHaveProperty('OPENCODE_CONFIG');
  expect(invocation.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
  const judgeHome = path.dirname(invocation.cwd);
  for (const key of ['OPENCODE_DB', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']) expect(invocation.env[key]?.startsWith(`${judgeHome}${path.sep}`)).toBe(true);
  expect(invocation.cwd.startsWith(root)).toBe(false);
  expect(JSON.parse(await fs.readFile(deleted, 'utf8'))).toEqual(['session', 'delete', 'ses_judge', '--standalone']);
  expect(await fs.access(invocation.env.OPENCODE_CONFIG_DIR ?? '').then(() => true, () => false)).toBe(false);
});

async function openCodeFake(dir: string): Promise<string> {
  const executable = path.join(dir, 'opencode-fake');
  await fs.writeFile(executable, `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes('--version')) { console.log('opencode v2.1.2'); process.exit(); }
if(args[0]==='session') process.exit();
process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({type:'text',sessionID:'ses_judge',part:{text:JSON.stringify({label:'good',reasoning:'done'})}})));
\n`, { mode: 0o755 });
  return executable;
}

it('judges with OpenCode only at best-effort when the evidence it reads sits inside a git checkout, and refuses a scorer that asks for verified', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-'));
  const evidence = path.join(root, 'evidence');
  await fs.mkdir(evidence);
  await fs.writeFile(path.join(evidence, 'prompt.md'), 'prompt');
  const checkout = path.join(root, 'checkout');
  await fs.mkdir(path.join(checkout, '.git'), { recursive: true });
  const executable = await openCodeFake(root);
  vi.stubEnv('OPENCODE_CONFIG', path.join(root, 'none.json'));
  vi.stubEnv('TMPDIR', checkout);

  expect(await runLocalJudge({ tool: 'opencode', evidence, schema: {} }, { resolveTool: () => executable })).toMatchObject({ ok: true, judge: { isolation: 'best-effort' } });
  expect(await runLocalJudge({ tool: 'opencode', evidence, schema: {}, isolation: 'verified' }, { resolveTool: () => executable })).toMatchObject({ ok: false, code: 'judge_tool_unavailable' });
});

async function codeBuddyFake(dir: string, record: string, body: string): Promise<string> {
  const executable = path.join(dir, 'codebuddy-fake');
  await fs.writeFile(executable, `#!${process.execPath}
const fs=require('fs'); const args=process.argv.slice(2);
if(args.includes('--version')) { console.log('2.173.0'); process.exit(); }
let stdin=''; process.stdin.on('data',d=>stdin+=d); process.stdin.on('end',()=>{
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({args,env:process.env,stdin,cwd:process.cwd()}));
${body}
});\n`, { mode: 0o755 });
  return executable;
}

it('runs CodeBuddy with its Claude-like flags, the prompt on stdin, at best-effort and with full access', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-'));
  const evidence = path.join(root, 'evidence');
  await fs.mkdir(evidence);
  await fs.writeFile(path.join(evidence, 'prompt.md'), 'CODEBUDDY-INLINE-PROMPT');
  vi.stubEnv('CODEBUDDY_API_KEY', 'buddy-key');
  vi.stubEnv('GH_TOKEN', 'must-not-leak');
  const record = path.join(root, 'invocation.json');
  const executable = await codeBuddyFake(root, record,
    "console.log(JSON.stringify({type:'result',subtype:'success',result:'',structured_output:{label:'good',reasoning:'done'},usage:{input_tokens:5,output_tokens:2},total_cost_usd:0.02}));");

  const result = await runLocalJudge({ tool: 'codebuddy', evidence, schema: { type: 'object' } }, { resolveTool: () => executable });

  expect(result).toMatchObject({ ok: true, answer: { label: 'good' }, judge: { tool: 'codebuddy', access: 'full', isolation: 'best-effort', usage: { inputTokens: 5, outputTokens: 2, cost: { amount: 0.02, unit: 'USD' } } } });
  const invocation = z.object({ args: z.array(z.string()), env: z.record(z.string()), stdin: z.string(), cwd: z.string() }).parse(JSON.parse(await fs.readFile(record, 'utf8')));
  expect(invocation.args.slice(0, 1)).toEqual(['-p']);
  for (const [flag, value] of [['--tools', 'Read,Grep,Glob'], ['--setting-sources', ''], ['--permission-mode', 'dontAsk'], ['--output-format', 'json'], ['--json-schema', '{"type":"object"}']]) {
    expect(invocation.args[invocation.args.indexOf(flag) + 1]).toBe(value);
  }
  expect(invocation.args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--no-session-persistence']));
  expect(invocation.args.join(' ')).not.toContain('CODEBUDDY-INLINE-PROMPT');
  expect(invocation.stdin).toContain('CODEBUDDY-INLINE-PROMPT');
  expect(invocation.cwd).toBe(await fs.realpath(evidence));
  expect(invocation.env.CODEBUDDY_API_KEY).toBe('buddy-key');
  expect(invocation.env.TEAMAI_LAUNCHED_BY).toBe('scorer');
  expect(invocation.env).not.toHaveProperty('GH_TOKEN');
});

it('fails a CodeBuddy judge that is not signed in, though CodeBuddy exits 0', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-'));
  const evidence = path.join(root, 'evidence');
  await fs.mkdir(evidence);
  await fs.writeFile(path.join(evidence, 'prompt.md'), 'prompt');
  const executable = await codeBuddyFake(root, path.join(root, 'invocation.json'),
    "process.stderr.write('Authentication required. Please use /login command to sign in to your account\\n');");

  expect(await runLocalJudge({ tool: 'codebuddy', evidence, schema: {} }, { resolveTool: () => executable })).toMatchObject({ ok: false, code: 'judge_tool_unavailable', message: expect.stringContaining('sign') });
});

it.each([
  ['codex-internal', '.codex-internal', 'auth.json', '{"login":"variant"}'],
  ['claude-internal', '.claude-internal', 'settings.json', '{"env":{"ANTHROPIC_BASE_URL":"https://variant.test"}}'],
] as const)('reads the login of %s from its own tool home', async (tool, dir, file, content) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-'));
  const evidence = path.join(root, 'evidence');
  await fs.mkdir(evidence);
  await fs.writeFile(path.join(evidence, 'prompt.md'), 'Judge.');
  await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(root, dir, file), content);
  vi.stubEnv('HOME', root);
  vi.stubEnv('CODEX_HOME', undefined);
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
  const record = path.join(root, 'seen.txt');
  const executable = path.join(root, 'judge-fake');
  await fs.writeFile(executable, `#!${process.execPath}
const fs=require('fs'),path=require('path');
if(process.argv.includes('--version')) process.exit();
process.stdin.resume(); process.stdin.on('end',()=>{
const args=process.argv.slice(2);
if(args.includes('exec')){ fs.writeFileSync(${JSON.stringify(record)}, fs.readFileSync(path.join(process.env.CODEX_HOME,'auth.json'),'utf8')); fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({label:'good',reasoning:'r'})); }
else { fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8')).env)); console.log(JSON.stringify({type:'result',structured_output:{label:'good',reasoning:'r'}})); }
});\n`, { mode: 0o755 });

  const result = await runLocalJudge({ tool, evidence, schema: {} }, { resolveTool: () => executable });

  expect(result).toMatchObject({ ok: true, judge: { tool } });
  expect(await fs.readFile(record, 'utf8')).toBe(tool === 'codex-internal' ? content : '{"ANTHROPIC_BASE_URL":"https://variant.test"}');
});

it('offers every launch tool on PATH as a judge, the preferred one first', () => {
  const onPath = new Set(['tclaude', 'codex-internal', 'codebuddy']);

  expect(installedJudgeTools(['codebuddy'], { resolveTool: (tool) => onPath.has(tool) ? `/bin/${tool}` : null })).toEqual(['codebuddy', 'tclaude', 'codex-internal']);
});

it('gives a Claude judge the home the tool-homes record names when nothing in the environment moves it', async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-')));
  const evidence = path.join(root, 'evidence');
  const moved = path.join(root, 'claude-work');
  await fs.mkdir(evidence);
  await fs.mkdir(moved);
  await fs.mkdir(path.join(root, '.teamai'));
  await fs.writeFile(path.join(root, '.teamai', 'tool-homes.json'), JSON.stringify({ claude: moved }));
  await fs.writeFile(path.join(moved, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://moved.test' } }));
  await fs.writeFile(path.join(evidence, 'prompt.md'), 'Judge.');
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
  const executable = path.join(root, 'claude-fake');
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('fs');
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => {
const args=process.argv.slice(2); const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
fs.writeFileSync('invocation.json', JSON.stringify({ home: process.env.CLAUDE_CONFIG_DIR ?? null, settings }));
console.log(JSON.stringify({type:'result',structured_output:{label:'good',reasoning:'done'}}));
});\n`, { mode: 0o755 });

  expect(await runLocalJudge({ tool: 'claude', evidence, schema: { type: 'object' } }, { resolveTool: () => executable })).toMatchObject({ ok: true });
  expect(JSON.parse(await fs.readFile(path.join(evidence, 'invocation.json'), 'utf8'))).toEqual({ home: moved, settings: { env: { ANTHROPIC_BASE_URL: 'https://moved.test' } } });
});
