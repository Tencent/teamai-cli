import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAUNCH_ADAPTERS } from '../../launch-registry.js';
import type { LaunchAdapter } from '@teamai/tool-core/launch';
import { stringify } from 'yaml';
import { z } from 'zod';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState } from '../../workflow/types.js';
import { folderRevision } from '../../workflow/runtimes/resource-folder.js';
import { CLAUDE_SESSIONS, envelope, ROOT, runCLI, type Ran } from '../helpers/step-runtime-e2e.js';
import { entriesUnder } from '@teamai/shared/entries-under';

// The sandbox runtime teamai ships, on a fake docker whose containers run on the host
// (packages/runtime-sandbox/src/testing/fake-engine.mjs), driven by the built CLI.

const IMAGE = 'e2e/agent:1';

/**
 * The image's headless Claude, as the sandbox launches it: in the container it has only the environment the sandbox
 * gives it, so it keeps its session in the Claude home its variable names, laid out as Claude Code does, continues the
 * one --resume names, writes the result and states the session.
 */
const IMAGE_CLAUDE = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const at = args.indexOf('--resume');
const session = at === -1 ? 'sess-' + path.basename(process.env.TEAMAI_WORKFLOW_ATTEMPT ?? String(process.pid)) : args[at + 1];
const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', ${CLAUDE_SESSIONS.project});
fs.mkdirSync(project, { recursive: true });
fs.appendFileSync(path.join(project, session + '.jsonl'), JSON.stringify(${CLAUDE_SESSIONS.record}) + '\\n');
// A prompt that asks it to spend streams usage until it is stopped, as a long answer does.
if (args[args.indexOf('-p') + 1].includes('Spend')) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-4-5' }));
  let n = 0;
  setInterval(() => { n += 1; console.log(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' + n, usage: { input_tokens: 100, output_tokens: 1 } } } })); }, 20);
  return;
}
// It notes the base URL it was given, beside its sessions.
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'base-url.txt'), String(process.env.ANTHROPIC_BASE_URL));
fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ output: { ok: true } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: session, usage: { input_tokens: 10, output_tokens: 5 } }));
`;
const FAKE_ENGINE = path.join(ROOT, 'packages', 'runtime-sandbox', 'src', 'testing', 'fake-engine.mjs');

let dir: string;
let repo: string;
let engineLog: string;
let engineEnv: NodeJS.ProcessEnv;
let dataHome: string;
/** The member's sign-in variables, kept out of every run here and put back after. */
const signIns = Object.values(LAUNCH_ADAPTERS).flatMap((adapter: LaunchAdapter) => [...(adapter.signIn?.variables ?? []), ...(adapter.signIn?.alongside ?? [])]);
const savedSignIns = Object.fromEntries(signIns.map((name) => [name, process.env[name]]));

const writeFlow = (name: string, setup: string): void => {
  fs.writeFileSync(path.join(repo, '.teamai', 'workflows', `${name}.yaml`), `schemaVersion: v1alpha1
name: ${name}
description: ${name}
setup:
  command: ${JSON.stringify(setup)}
  requires: { env: [NPM_TOKEN] }
steps:
  - id: review
    workspace: new
    tool: claude
    prompt: Review the change in a fresh worktree.
    requires: { env: [PROMPT_KEY] }
    output:
      ok: boolean
`);
};

const start = (flow: string): Promise<Ran> => runCLI(['workflow', 'start', flow, '--driver', 'containers'], repo, {
  ...engineEnv, NPM_TOKEN: 'npm-value-7f3a', PROMPT_KEY: 'prompt-value-91c2', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-4d8e',
});

const readRunState = (ran: Ran): RunState => {
  const done = envelope(ran);
  const run = 'data' in done && typeof done.data.done === 'object' && done.data.done !== null && 'run' in done.data.done ? done.data.done.run : undefined;

  if (typeof run !== 'string') throw new Error(`no run in the envelope:\n${ran.stdout}\n${ran.stderr}`);

  return JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${run}.json`), 'utf8')) as RunState;
};

/** Each command the fake docker ran, as its argv. */
const engineCalls = (): string[][] => (fs.existsSync(engineLog) ? fs.readFileSync(engineLog, 'utf8').trim().split('\n').map((line) => z.array(z.string()).parse(JSON.parse(line)).slice(1)) : []);

/** The names each `exec` passes into the container with `-e`. */
const passedNames = (exec: string[]): string[] => exec.flatMap((arg, at) => (exec[at - 1] === '-e' ? [arg] : []));

beforeAll(async () => {
  for (const name of signIns) delete process.env[name];
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sandbox-setup-e2e-')));
  repo = path.join(dir, 'repo');
  engineLog = path.join(dir, 'engine.log');
  const engineBin = path.join(dir, 'engine-bin');
  const imageBin = path.join(dir, 'image-bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(engineBin);
  fs.mkdirSync(imageBin);
  fs.writeFileSync(path.join(engineBin, 'docker'), `#!/bin/sh\nFAKE_ENGINE_NAME=docker exec "${process.execPath}" "${FAKE_ENGINE}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(imageBin, 'claude'), IMAGE_CLAUDE, { mode: 0o755 });
  engineEnv = {
    PATH: `${engineBin}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_ENGINE_STATE: path.join(dir, 'engine-state'), FAKE_ENGINE_LOG: engineLog, FAKE_ENGINE_IMAGES: JSON.stringify({ [IMAGE]: imageBin }),
  };

  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.npmrc\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['add', 'README.md', '.gitignore'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], { cwd: repo });
  const initialized = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
  expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
  const origin = path.join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['remote', 'set-url', 'origin', origin], { cwd: repo });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repo });

  fs.mkdirSync(path.join(repo, '.teamai', 'drivers'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.teamai', 'sandboxes'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.teamai', 'sandboxes', 'e2e.yaml'), stringify({ provider: 'docker', image: IMAGE }));
  fs.writeFileSync(path.join(repo, '.teamai', 'drivers', 'containers.yaml'), stringify({
    schemaVersion: 'v1alpha1', name: 'containers', tool: 'claude',
    runtimes: [{ use: 'sandbox', sandbox: 'e2e', options: { credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'env:CLAUDE_CODE_OAUTH_TOKEN' } } }],
  }));
  fs.writeFileSync(path.join(repo, '.teamai', 'drivers', 'keychain.yaml'), stringify({
    schemaVersion: 'v1alpha1', name: 'keychain', tool: 'claude', runtimes: [{ use: 'sandbox', sandbox: 'e2e' }],
  }));
  fs.writeFileSync(path.join(repo, '.teamai', 'drivers', 'gateway.yaml'), stringify({
    schemaVersion: 'v1alpha1', name: 'gateway', tool: 'claude', runtimes: [{ use: 'sandbox', sandbox: 'e2e' }, { use: 'tools' }],
  }));
  // The sandbox runs its prompt steps itself, and the tools runtime beside it takes what it does not.
  fs.writeFileSync(path.join(repo, '.teamai', 'drivers', 'boxed.yaml'), stringify({
    schemaVersion: 'v1alpha1', name: 'boxed', tool: 'claude',
    runtimes: [{ use: 'sandbox', sandbox: 'e2e', options: { credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'env:CLAUDE_CODE_OAUTH_TOKEN' } } }, { use: 'tools' }],
  }));
  fs.mkdirSync(path.join(repo, '.teamai', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.teamai', 'workflows', 'spend.yaml'), 'schemaVersion: v1alpha1\nname: spend\ndescription: spend\nsteps:\n  - id: spend\n    tool: claude\n    prompt: Spend tokens.\n    budget: { tokens: 300 }\n    on_limit: end_turn\n');
  fs.writeFileSync(path.join(repo, '.teamai', 'workflows', 'slow.yaml'), 'schemaVersion: v1alpha1\nname: slow\ndescription: slow\nsteps:\n  - id: slow\n    tool: claude\n    prompt: Spend tokens.\n    timeout: 2s\n    on_limit: end_turn\n');
  fs.writeFileSync(path.join(repo, '.teamai', 'workflows', 'pair.yaml'), 'schemaVersion: v1alpha1\nname: pair\ndescription: pair\nsteps:\n  - id: plan\n    tool: claude\n    prompt: Plan the change.\n    output:\n      ok: boolean\n  - id: apply\n    needs: [plan]\n    session:\n      from: plan\n    prompt: Make the change you planned.\n    output:\n      ok: boolean\n');
  fs.writeFileSync(path.join(repo, '.teamai', 'workflows', 'review.yaml'), 'schemaVersion: v1alpha1\nname: review\ndescription: review\nsteps:\n  - id: review\n    tool: claude\n    prompt: Review the repository.\n    output:\n      ok: boolean\n');
  fs.writeFileSync(path.join(repo, '.teamai', 'workflows', 'codexreview.yaml'), 'schemaVersion: v1alpha1\nname: codexreview\ndescription: codexreview\nsteps:\n  - id: review\n    tool: codex\n    prompt: Review the repository.\n    max_turns: 3\n    output:\n      ok: boolean\n');
  // Setup prints the names it gets, then fails, so its output is quoted in the failure.
  writeFlow('setupnames', 'env | cut -d= -f1 | sort | tr "\\n" " "; exit 3');
  writeFlow('setupsecret', 'printf "%s" "$NPM_TOKEN" > .npmrc');
  const pulled = await runCLI(['pull'], repo);
  expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
  dataHome = await resolveProjectDataHome(repo);
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedSignIns)) if (value !== undefined) process.env[name] = value;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the workflow's setup", () => {
  it("runs setup in the step's container with setup's keys only, and fails the step with setup_failed when it exits non-zero", async () => {
    const before = engineCalls().length;
    const ran = await start('setupnames');

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const [review] = readRunState(ran).steps;
    expect(review).toMatchObject({ id: 'review', status: 'failed', failure: { code: 'setup_failed', message: expect.stringContaining('exited with code 3, so the step did not run') } });
    const printed = review !== undefined && 'failure' in review ? String(review.failure?.message) : '';
    expect(printed).toMatch(/\bNPM_TOKEN\b/);
    expect(printed).not.toMatch(/\bPROMPT_KEY\b/);
    expect(printed).not.toMatch(/\bCLAUDE_CODE_OAUTH_TOKEN\b/);
    // Setup ran in the container teamai created for the attempt, and the step's tool never started.
    const calls = engineCalls().slice(before);
    const execs = calls.filter(([command]) => command === 'exec');
    expect(execs).toEqual([expect.arrayContaining(['/bin/sh', '-c'])]);
    expect(passedNames(execs[0] ?? []).sort()).toEqual(['NPM_TOKEN', 'TEAMAI_MODE', 'TEAMAI_RUN_DIR', 'TEAMAI_WORKFLOW_ATTEMPT']);
    expect(execs.flat()).not.toContain('claude');
    expect(JSON.stringify(calls)).not.toMatch(/npm-value|prompt-value|oauth-value/);
  });

  it("fails the step with setup_secret when setup in the container leaves a key's value in a file, naming the file, never the value", async () => {
    const before = engineCalls().length;
    const ran = await start('setupsecret');

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(readRunState(ran).steps).toMatchObject([{
      id: 'review', status: 'failed',
      failure: { code: 'setup_secret', message: expect.stringMatching(/left the value of NPM_TOKEN in \.npmrc/) },
    }]);
    expect(`${ran.stdout}${ran.stderr}`).not.toContain('npm-value-7f3a');
    const execs = engineCalls().slice(before).filter(([command]) => command === 'exec');
    expect(execs).toHaveLength(1);
    expect(execs.flat()).not.toContain('claude');
  });
});

it('fails a Claude step whose only login is on this machine, in the Keychain, naming CLAUDE_CODE_OAUTH_TOKEN, before any container starts', async () => {
  const before = engineCalls().length;
  const ran = await runCLI(['workflow', 'start', 'review', '--driver', 'keychain'], repo, engineEnv);

  expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
  expect(readRunState(ran).steps).toMatchObject([{
    id: 'review', status: 'failed',
    failure: { code: 'tool_unavailable', message: expect.stringMatching(/a Claude login kept in the macOS Keychain or in ~\/\.claude never crosses into a container; run `claude setup-token` and add CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN/) },
  }]);
  expect(engineCalls().slice(before).filter(([command, ...rest]) => command === 'run' && rest.includes('-d'))).toEqual([]);
});

it("runs a Claude prompt step's tool itself in the attempt's container, keeps its session in the attempt's tool home, and resumes it there for a session.from step", async () => {
  const before = engineCalls().length;
  const ran = await runCLI(['workflow', 'start', 'pair', '--driver', 'boxed'], repo, { ...engineEnv, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-4d8e' });

  expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  const [plan, apply] = readRunState(ran).steps;
  const session = plan !== undefined && 'session' in plan ? String(plan.session) : '';
  expect(session).toMatch(/^sess-/);
  expect(apply).toMatchObject({ status: 'succeeded', resumed: { tool: 'claude', id: session } });
  // The tool ran in the container, the second pass on the first one's session.
  const launches = engineCalls().slice(before).filter(([command, ...rest]) => command === 'exec' && rest.includes('claude'));
  expect(launches).toHaveLength(2);
  expect(launches[1]).toEqual(expect.arrayContaining(['--resume', session]));
  expect(JSON.stringify(engineCalls().slice(before))).not.toContain('oauth-value');
  // Its session is in the attempt's tool home, where teamai reads it, never in the member's own Claude home.
  const transcripts = entriesUnder(dataHome).map(({ relative }) => relative).filter((file) => file.endsWith(`${session}.jsonl`));
  expect(transcripts.length).toBeGreaterThan(0);
  expect(transcripts.every((file) => file.includes(`tool-home${path.sep}claude${path.sep}projects`))).toBe(true);
});

it('stops a prompt step at its timeout in the container, and ends its turn there with its session', async () => {
  const ran = await runCLI(['workflow', 'start', 'slow', '--driver', 'boxed'], repo, { ...engineEnv, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-4d8e' });

  expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  const [slow] = readRunState(ran).steps;
  expect(slow).toMatchObject({ status: 'succeeded', limit: 'timeout', session: expect.stringMatching(/^sess-/) });
});

it('stops a prompt step past its budget in the container, and ends its turn there with its session', async () => {
  const ran = await runCLI(['workflow', 'start', 'spend', '--driver', 'boxed'], repo, { ...engineEnv, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-4d8e' });

  expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  const [spend] = readRunState(ran).steps;
  expect(spend).toMatchObject({ status: 'succeeded', limit: 'budget', session: expect.stringMatching(/^sess-/) });
});

it("signs a Codex prompt step in on the login teamai keeps, copied into the attempt's tool home, and writes the login the tool refreshed back", async () => {
  const dedicated = path.join(os.homedir(), '.teamai', 'logins', 'codex', 'auth.json');
  const login = (refresh: string): string => JSON.stringify({ OPENAI_API_KEY: null, tokens: { account_id: 'acct-1', refresh_token: refresh, access_token: 'access', id_token: 'id' } });
  fs.mkdirSync(path.dirname(dedicated), { recursive: true });
  fs.writeFileSync(dedicated, login('r1'), { mode: 0o600 });
  // The image's Codex reads the login in the home CODEX_HOME names, refreshes it as Codex does, and ends its turn.
  fs.writeFileSync(path.join(dir, 'image-bin', 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli 0.130.0'); process.exit(0); }
const file = path.join(process.env.CODEX_HOME, 'auth.json');
const login = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.writeFileSync(file, JSON.stringify({ ...login, tokens: { ...login.tokens, refresh_token: login.tokens.refresh_token + '-next' } }));
fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ output: { ok: true } }));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } }));
`, { mode: 0o755 });
  fs.writeFileSync(path.join(repo, '.teamai', 'drivers', 'codexlogin.yaml'), stringify({
    schemaVersion: 'v1alpha1', name: 'codexlogin', tool: 'codex',
    runtimes: [{ use: 'sandbox', sandbox: 'e2e', options: { credentials: { codex: 'login' } } }, { use: 'tools' }],
  }));
  const before = engineCalls().length;

  try {
    const ran = await runCLI(['workflow', 'start', 'codexreview', '--driver', 'codexlogin'], repo, engineEnv);

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    // Codex has no turn cap the sandbox could keep, so the step says it was not kept.
    expect(readRunState(ran).steps).toMatchObject([{ id: 'review', unenforced: [{ requirement: 'max_turns', asked: 3 }] }]);
    expect(engineCalls().slice(before).filter(([command, ...rest]) => command === 'exec' && rest.includes('codex'))).toHaveLength(1);
    expect(fs.readFileSync(dedicated, 'utf8')).toBe(login('r1-next'));
    expect(fs.existsSync(path.join(os.homedir(), '.teamai', 'logins', 'codex.lock'))).toBe(false);
  } finally {
    fs.rmSync(path.join(dir, 'image-bin', 'codex'), { force: true });
    fs.rmSync(path.dirname(dedicated), { recursive: true, force: true });
  }
});

it("signs a Claude prompt step in on the gateway the member's environment names, at the host alias the container reaches this machine by", async () => {
  const ran = await runCLI(['workflow', 'start', 'review', '--driver', 'gateway'], repo, { ...engineEnv, ANTHROPIC_AUTH_TOKEN: 'gateway-token-5b1c', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' });

  expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  const [review] = readRunState(ran).steps;
  const attempt = review !== undefined && 'attempt' in review ? String(review.attempt) : '';
  const noted = entriesUnder(dataHome).map(({ relative }) => relative).filter((file) => file.includes(attempt) && file.endsWith('base-url.txt'));
  expect(noted.map((file) => fs.readFileSync(path.join(dataHome, file), 'utf8'))).toEqual(['http://host.docker.internal:8317']);
  expect(JSON.stringify(engineCalls())).not.toContain('gateway-token-5b1c');
});

describe('sandbox profiles', () => {
  const writeDriver = (name: string, entry: Record<string, unknown>): void => {
    fs.writeFileSync(path.join(repo, '.teamai', 'drivers', `${name}.yaml`), stringify({ schemaVersion: 'v1alpha1', name, tool: 'claude', runtimes: [entry] }));
  };

  it('refuses a driver that still sets the sandbox provider inline, naming the profile to move it to', async () => {
    writeDriver('inline', { use: 'sandbox', options: { provider: 'docker', image: IMAGE } });
    const before = engineCalls().length;

    const ran = await runCLI(['workflow', 'start', 'review', '--driver', 'inline'], repo, { ...engineEnv, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-4d8e' });

    expect(envelope(ran)).toMatchObject({ error: { code: 'bad_option', message: expect.stringMatching(/^Driver definition drivers\/inline\.yaml in the team repo gives runtime "sandbox" the option "provider", and a sandbox's options live in a sandbox profile: move them to sandboxes\/inline\.yaml in the team repo \(or ~\/\.teamai\/sandboxes\/inline\.yaml for yourself\), name it on the entry with sandbox: inline, and start again\.$/) } });
    expect(engineCalls().slice(before)).toEqual([]);
  });

  it('builds a profile folder\'s Containerfile once, reuses it, builds again once the folder changes, and records the profile each attempt ran', async () => {
    const folder = path.join(repo, '.teamai', 'sandboxes', 'warmed');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SANDBOX.yaml'), stringify({ provider: 'docker', image: IMAGE, warm: { containerfile: './Containerfile', cache: ['package.json'] } }));
    fs.writeFileSync(path.join(folder, 'Containerfile'), `FROM ${IMAGE}\nRUN true\n`);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"app"}\n');
    execFileSync('git', ['add', 'package.json'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'package.json'], { cwd: repo });
    writeDriver('warmed', { use: 'sandbox', sandbox: 'warmed', options: { credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'env:CLAUDE_CODE_OAUTH_TOKEN' } } });
    const run = async (): Promise<{ ran: Ran; builds: string[][] }> => {
      const before = engineCalls().length;
      const ran = await runCLI(['workflow', 'start', 'review', '--driver', 'warmed'], repo, { ...engineEnv, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-4d8e' });
      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      return { ran, builds: engineCalls().slice(before).filter(([command]) => command === 'build') };
    };

    const first = await run();
    const second = await run();
    fs.writeFileSync(path.join(folder, 'Containerfile'), `FROM ${IMAGE}\nRUN echo changed\n`);
    const third = await run();

    expect([first.builds.length, second.builds.length, third.builds.length]).toEqual([1, 0, 1]);
    expect(third.builds[0]?.[third.builds[0].indexOf('-t') + 1]).not.toBe(first.builds[0]?.[first.builds[0].indexOf('-t') + 1]);
    const state = readRunState(third.ran);
    const [review] = state.steps;
    const attempt = review !== undefined && 'attempt' in review ? String(review.attempt) : '';
    const record = JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', state.id, 'attempts', attempt, 'runtime.json'), 'utf8')) as unknown;
    // The image has no node, so no network filter keeps its steps from this machine: they are at worktree.
    expect(record).toMatchObject({ sources: [{ runtime: 'teamai-sandbox', layer: 'teamai', sandbox: { profile: 'warmed', layer: 'team', location: 'sandboxes/warmed/', revision: await folderRevision(folder), provider: 'docker', enforces: { isolation: 'worktree', tokens: true, max_turns: true } } }] });
  });
});
