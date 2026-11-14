import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasPython, TYPED_TERMINAL } from '../helpers/in-terminal.js';
import { installFakeCodex, pathWithoutCodex, readFakeCodexState } from '../helpers/fake-codex.js';

/**
 * A team adds its internal Claude build as a tool instance in the team repo: `pull` delivers to its paths, a workflow
 * prompt step on `--tools default=acme-claude` launches its own command once a person accepted it, and its session is
 * found and scored as acme-claude's, apart from Claude's.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const SESSION = '11111111-2222-4333-8444-555555555555';

const ACME_CLAUDE = `schemaVersion: v1alpha1
name: acme-claude
extends: claude
command: acme-claude
home: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }
`;

/**
 * A Claude build that keeps Claude Code transcripts in its own home: it writes one session there, the step's result,
 * the command name it ran as to `<HOME>/launches.log`, and the session it resumed (`-` for none) to `<HOME>/resumes.log`.
 */
function fakeClaude(name: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
fs.appendFileSync(path.join(process.env.HOME, 'launches.log'), ${JSON.stringify(name)} + '\\n');
const home = ${name === 'claude' ? "process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude')" : "process.env.ACME_CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.acme-claude')"};
const agentAt = process.argv.indexOf('--agent');
if (agentAt >= 0 && ![path.join(process.cwd(), ${JSON.stringify(name === 'claude' ? '.claude' : '.acme-claude')}), home].some((dir) => fs.existsSync(path.join(dir, 'agents', process.argv[agentAt + 1] + '.md')))) {
  console.error('Agent not found: ' + process.argv[agentAt + 1]); process.exit(1);
}
const resumeAt = process.argv.indexOf('--resume');
fs.appendFileSync(path.join(process.env.HOME, 'resumes.log'), (resumeAt >= 0 ? process.argv[resumeAt + 1] : '-') + '\\n');
const judging = process.argv.includes('--json-schema');
if (judging) {
  process.stdin.resume(); process.stdin.on('end', () => {
    const schema = JSON.parse(process.argv[process.argv.indexOf('--json-schema') + 1]);
    const answer = { label: 'thorough', reasoning: 'It reviewed the repository.' };
    console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'judge-model' }));
    console.log(JSON.stringify({ type: 'result', structured_output: schema.properties.answer ? { answer } : answer }));
  });
} else {
  const id = ${JSON.stringify(name === 'claude' ? '99999999-2222-4333-8444-555555555555' : SESSION)};
  const dir = path.join(home, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  const at = new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), [
    { type: 'user', sessionId: id, cwd: process.cwd(), uuid: 'u1', parentUuid: null, timestamp: at, message: { role: 'user', content: 'Review the repository.' } },
    { type: 'assistant', sessionId: id, cwd: process.cwd(), uuid: 'a1', parentUuid: 'u1', timestamp: at, message: { role: 'assistant', model: 'acme-model', content: [{ type: 'text', text: 'Reviewed.' }] } },
  ].map((line) => JSON.stringify(line)).join('\\n') + '\\n');
  fs.mkdirSync(path.dirname(process.env.TEAMAI_WORKFLOW_RESULT), { recursive: true });
  fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ output: { ok: true } }));
  console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'acme-model', session_id: id }));
  console.log(JSON.stringify({ type: 'result', session_id: id, usage: { input_tokens: 3, output_tokens: 2 } }));
}
`;
}

type Ran = { code: number | null; stdout: string; stderr: string };

function envelope(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return JSON.parse(line) as Record<string, unknown>;
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; !check(); waited += 50) {
    if (waited >= ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

describe.skipIf(process.platform === 'win32')('tool instances through the CLI', () => {
  let root: string;
  let repo: string;
  let bin: string;
  let home: string;

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, ...extra });

  function runCLI(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Ran> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  const launches = (): string[] => (fs.existsSync(path.join(home, 'launches.log')) ? fs.readFileSync(path.join(home, 'launches.log'), 'utf8').trim().split('\n').filter(Boolean) : []);
  const clearLaunches = (): void => fs.rmSync(path.join(home, 'launches.log'), { force: true });
  const write = (file: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
  const commit = (message: string): void => {
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', message], { cwd: repo, env: env() });
  };
  const start = (tool: string, extra: NodeJS.ProcessEnv = {}): Promise<Ran> => runCLI(['workflow', 'start', 'review', '--driver', 'local', '--tools', `default=${tool}`], extra);
  const unattended = { TEAMAI_MODE: 'unattended' };
  const forgetAcceptances = (): void => fs.rmSync(path.join(home, '.teamai', 'trust'), { recursive: true, force: true });

  /** Runs the CLI with `args` in a terminal a person types into: what it printed so far, and a line typed into it. */
  function inTerminal(args: string[]): { printed: () => string; type: (line: string) => void; press: (keys: string) => void; ended: Promise<number | null>; stop: () => void } {
    const dir = fs.mkdtempSync(path.join(root, 'terminal-'));
    const output = path.join(dir, 'out');
    const input = path.join(dir, 'in');
    const wrapper = spawn('python3', ['-c', TYPED_TERMINAL, path.join(dir, 'pid'), output, input, process.execPath, CLI, ...args], { cwd: repo, env: env(), stdio: 'ignore' });
    const ended = new Promise<number | null>((resolve) => { wrapper.on('close', (code) => resolve(code)); });

    return {
      printed: () => (fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : ''),
      type: (line) => fs.appendFileSync(input, `${line}\n`),
      press: (keys) => fs.appendFileSync(input, keys),
      ended,
      stop: () => {
        const pid = path.join(dir, 'pid');
        if (wrapper.exitCode === null && fs.existsSync(pid)) process.kill(Number(fs.readFileSync(pid, 'utf8')), 'SIGKILL');
      },
    };
  }

  /** How the terminal's command exited, or `still running` once `ms` passed. */
  const endedWithin = (terminal: { ended: Promise<number | null> }, ms: number): Promise<number | null | 'still running'> =>
    Promise.race([terminal.ended, new Promise<'still running'>((resolve) => { setTimeout(() => resolve('still running'), ms); })]);

  /** Whether `text` is printed after the last `after` the terminal printed. */
  const printedAfter = (terminal: { printed: () => string }, after: string, text: string): boolean => {
    const printed = terminal.printed();
    const at = printed.lastIndexOf(after);

    return at !== -1 && printed.includes(text, at);
  };

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-tool-instances-e2e-')));
    repo = path.join(root, 'repo');
    bin = path.join(root, 'bin');
    home = path.join(root, 'home');
    for (const dir of [repo, bin, home]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[gc]\n\tauto = 0\n');
    for (const name of ['acme-claude', 'claude', 'my-acme-build']) {
      fs.writeFileSync(path.join(bin, name), fakeClaude(name));
      fs.chmodSync(path.join(bin, name), 0o755);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    write('README.md', '# fixture\n');
    write('.teamai/tools/acme-claude.yaml', ACME_CLAUDE);
    write('.teamai/agents/reviewer.yaml', 'name: reviewer\ndescription: Reviews a change\ninstructions: Review it.\n');
    write('.teamai/skills/review-checklist/SKILL.md', '---\nname: review-checklist\ndescription: What to check in a review.\n---\nCheck the tests first.\n');
    write('.teamai/workflows/review.yaml', 'schemaVersion: v1alpha1\nname: review\ndescription: One review prompt.\nsteps:\n  - id: review\n    prompt: Review the repository without changing it.\n    output:\n      ok: boolean\n');
    write('.teamai/workflows/gated.yaml', 'schemaVersion: v1alpha1\nname: gated\ndescription: An approval beside a review.\nsteps:\n  - id: warmup\n    command: sleep 2\n  - id: ship\n    needs: []\n    approve: { message: Ship it?, required: true }\n  - id: review\n    needs: [warmup]\n    prompt: Review the repository without changing it.\n    output:\n      ok: boolean\n');
    write('.teamai/scorers/review-quality.md', '---\nlabels:\n  - { value: thorough, score: 1, description: Did the review }\n  - { value: shallow, score: 0, description: Did not }\npassingScore: 0.5\nsamplingRate: 0\n---\nJudge whether the session reviewed the repository.\n');
    commit('initial');
    execFileSync('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/app.git'], { cwd: repo });
    const initialized = await runCLI(['init', '--self', '--agent', 'claude,acme-claude', '--force']);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    const pulled = await runCLI(['pull']);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('delivers the team skills and agents to the instance\'s own paths, beside Claude\'s', async () => {
    const pulled = await runCLI(['pull']);

    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(repo, '.acme-claude', 'skills', 'review-checklist', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.claude', 'skills', 'review-checklist', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, '.acme-claude', 'agents', 'reviewer.md'), 'utf8')).toBe(fs.readFileSync(path.join(repo, '.claude', 'agents', 'reviewer.md'), 'utf8'));
  });

  it('refuses to run a team instance\'s command no one accepted in an unattended run, and says how to accept it', async () => {
    clearLaunches();
    const started = await start('acme-claude', unattended);

    expect(started.stdout + started.stderr).toMatch(/Tool "acme-claude" comes from the team repo \(.*acme-claude\.yaml, content [0-9a-f]{12}\) and runs acme-claude, which no one has accepted on this machine, and an unattended run does not ask\. Run the same command once in a terminal, attended/);
    expect(launches()).toEqual([]);
  });

  it.skipIf(!hasPython)('asks in a terminal, runs the instance\'s command once accepted, and asks again only when its file changes', async () => {
    clearLaunches();
    forgetAcceptances();
    const terminal = inTerminal(['workflow', 'start', 'review', '--driver', 'local', '--tools', 'default=acme-claude']);

    try {
      expect(await waitFor(() => terminal.printed().includes('Run it? [y/N]'), 30_000), terminal.printed()).toBe(true);
      expect(terminal.printed()).toContain('It runs acme-claude as you, with your files, in place of claude.');
      terminal.type('y');
      expect(await terminal.ended, terminal.printed()).toBe(0);
    } finally {
      terminal.stop();
    }
    expect(launches()).toEqual(['acme-claude']);

    // A team-repo commit that leaves the file as it was asks nothing.
    write('notes.md', 'Unrelated.\n');
    commit('unrelated');
    clearLaunches();
    const again = await start('acme-claude', unattended);
    expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
    expect(envelope(again.stdout)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(launches()).toEqual(['acme-claude']);

    // A change to the file is a new content to accept.
    write('.teamai/tools/acme-claude.yaml', ACME_CLAUDE.replace('command: acme-claude', 'command: acme-claude\n# Build 2.4.\n'));
    commit('acme-claude 2.4');
    clearLaunches();
    const changed = await start('acme-claude', unattended);
    expect(changed.stdout + changed.stderr).toContain('which no one has accepted on this machine');
    expect(launches()).toEqual([]);
    write('.teamai/tools/acme-claude.yaml', ACME_CLAUDE);
    commit('acme-claude back');
  });

  it.skipIf(!hasPython)('asks to accept a command while an approval waits, and each line typed answers one question', async () => {
    clearLaunches();
    forgetAcceptances();
    const terminal = inTerminal(['workflow', 'start', 'gated', '--driver', 'local', '--tools', 'default=acme-claude']);

    try {
      // The approval is asked while the warmup runs, then the review asks to accept its command. Both take yes: the
      // first one accepts the command alone, and the approval is asked again.
      expect(await waitFor(() => printedAfter(terminal, 'Ship it?', 'Run it? [y/N]'), 30_000), terminal.printed()).toBe(true);
      terminal.type('yes');
      expect(await waitFor(() => printedAfter(terminal, 'Run it? [y/N]', 'Choice, followed by an optional note'), 30_000), terminal.printed()).toBe(true);
      terminal.type('yes');
      expect(await endedWithin(terminal, 30_000), terminal.printed()).toBe(0);
    } finally {
      terminal.stop();
    }
    expect(terminal.printed()).not.toContain('accepts these choices');
    expect(terminal.printed()).not.toContain('was not accepted');
    expect(launches()).toEqual(['acme-claude']);
  }, 120_000);

  it.skipIf(!hasPython)('stops the run at Ctrl-C to accept a command, accepting nothing, and resume asks again', async () => {
    clearLaunches();
    forgetAcceptances();
    const terminal = inTerminal(['workflow', 'start', 'review', '--driver', 'local', '--tools', 'default=acme-claude']);
    let run: string | undefined;

    try {
      expect(await waitFor(() => terminal.printed().includes('Run it? [y/N]'), 30_000), terminal.printed()).toBe(true);
      run = /Run (\S+) started/.exec(terminal.printed())?.[1];
      terminal.press('\x03');
      expect(await endedWithin(terminal, 15_000), terminal.printed()).not.toBe('still running');
    } finally {
      terminal.stop();
    }
    expect(terminal.printed()).toContain('Continue with teamai workflow resume');
    expect(terminal.printed()).not.toContain('was not accepted');
    expect(launches()).toEqual([]);

    expect(run, terminal.printed()).toBeDefined();
    const resumed = inTerminal(['workflow', 'resume', String(run)]);

    try {
      expect(await waitFor(() => resumed.printed().includes('Run it? [y/N]'), 30_000), resumed.printed()).toBe(true);
      resumed.type('y');
      expect(await endedWithin(resumed, 30_000), resumed.printed()).toBe(0);
    } finally {
      resumed.stop();
    }
    expect(launches()).toEqual(['acme-claude']);
  }, 120_000);

  it.skipIf(!hasPython)('stops asking to accept a command once the run is cancelled, and the driver ends', async () => {
    clearLaunches();
    forgetAcceptances();
    const terminal = inTerminal(['workflow', 'start', 'review', '--driver', 'local', '--tools', 'default=acme-claude']);

    try {
      expect(await waitFor(() => terminal.printed().includes('Run it? [y/N]'), 30_000), terminal.printed()).toBe(true);
      const run = /Run (\S+) started/.exec(terminal.printed())?.[1];
      expect(run, terminal.printed()).toBeDefined();
      const cancelled = await runCLI(['workflow', 'cancel', String(run)]);
      expect(cancelled.code, `${cancelled.stdout}\n${cancelled.stderr}`).toBe(0);

      expect(await endedWithin(terminal, 15_000), terminal.printed()).not.toBe('still running');
    } finally {
      terminal.stop();
    }
    expect(launches()).toEqual([]);
  });

  it('finds the instance\'s session in its own home, credits it to the instance, and scores and migrates it as the instance\'s', async () => {
    // A member's own copy of the team file runs with no acceptance, which the terminal case covers.
    const own = path.join(home, '.teamai', 'tools', 'acme-claude.yaml');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, ACME_CLAUDE);
    let started: Ran;
    try {
      started = await start('acme-claude', unattended);
    } finally {
      fs.rmSync(own);
    }
    const { run } = (envelope(started.stdout) as { data: { done: { run: string } } }).data.done;
    const [record] = execFileSync('find', [home, '-path', `*workflows/runs/${run}.json`], { encoding: 'utf8' }).trim().split('\n');
    const stored = JSON.parse(fs.readFileSync(record, 'utf8')) as { steps: Array<{ tool?: string; session?: string }> };
    const sessionFiles = execFileSync('find', [home, '-name', `${SESSION}.jsonl`], { encoding: 'utf8' }).trim().split('\n');

    expect(stored.steps, `${started.stdout}\n${started.stderr}`).toContainEqual(expect.objectContaining({ tool: 'acme-claude', session: SESSION }));
    expect(sessionFiles).toEqual([expect.stringContaining(path.join(home, '.acme-claude', 'projects'))]);

    const scored = await runCLI(['score', '--session', SESSION, '--source', 'acme-claude', '--scorer', 'review-quality']);
    expect(scored.code, `${scored.stdout}\n${scored.stderr}`).toBe(0);
    expect(envelope(scored.stdout)).toMatchObject({ data: { label: { subject: { platform: 'acme-claude', sessionId: SESSION }, label: 'thorough' } } });

    const asClaude = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'review-quality']);
    expect(asClaude.code).not.toBe(0);

    // The session commands know the instance too.
    const platforms = await runCLI(['session', 'platforms']);
    expect(platforms.stdout, platforms.stderr).toContain('acme-claude: ✓ installed');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const migrated = await runCLI(['session', 'migrate', SESSION, '--source', 'acme-claude', '--target', 'claude-code', '--json', '--yes']);
    expect(envelope(migrated.stdout), `${migrated.stdout}\n${migrated.stderr}`).toHaveProperty('data');
  });

  it('continues an instance\'s session in the tool it extends through a copy in that tool\'s own home', async () => {
    write('.teamai/workflows/handoff.yaml', 'schemaVersion: v1alpha1\nname: handoff\ndescription: Plan on the instance, build on Claude.\nsteps:\n  - id: plan\n    tool: acme-claude\n    prompt: Plan the change.\n    output:\n      ok: boolean\n  - id: build\n    needs: [plan]\n    tool: claude\n    prompt: Build it.\n    session: { from: plan }\n    output:\n      ok: boolean\n');
    commit('handoff');
    expect((await runCLI(['pull'])).code).toBe(0);
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const own = path.join(home, '.teamai', 'tools', 'acme-claude.yaml');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, ACME_CLAUDE);
    fs.rmSync(path.join(home, 'resumes.log'), { force: true });
    try {
      const ran = await runCLI(['workflow', 'start', 'handoff', '--driver', 'local'], unattended);
      expect(envelope(ran.stdout), `${ran.stdout}\n${ran.stderr}`).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    } finally {
      fs.rmSync(own);
    }
    const [, resumed = ''] = fs.readFileSync(path.join(home, 'resumes.log'), 'utf8').trim().split('\n');
    const copies = execFileSync('find', [path.join(home, '.claude', 'projects'), '-name', `${resumed}.jsonl`], { encoding: 'utf8' }).trim();

    expect(resumed).not.toBe(SESSION);
    expect(copies).not.toBe('');
    expect(fs.readFileSync(copies, 'utf8')).toContain('Review the repository.');
  });

  it('runs an instance that sets no command unattended with no acceptance, on the command of the tool it extends', async () => {
    write('.teamai/tools/review-claude.yaml', 'schemaVersion: v1alpha1\nname: review-claude\nextends: claude\npaths: { skills: .claude/review-skills }\n');
    commit('review-claude');
    clearLaunches();
    const started = await start('review-claude', unattended);

    expect(started.code, `${started.stdout}\n${started.stderr}`).toBe(0);
    expect(launches()).toEqual(['claude']);

    // It keeps Claude's home, so a session there is Claude's alone.
    const claudeSession = '99999999-2222-4333-8444-555555555555';
    const found = await runCLI(['score', '--session', claudeSession, '--scorer', 'review-quality']);
    expect(envelope(found.stdout), found.stderr).toMatchObject({ error: { code: 'source_required', message: expect.stringContaining('Found in: claude-code.') } });

    // A step that names the instance as its own tool runs on it too.
    write('.teamai/workflows/named.yaml', 'schemaVersion: v1alpha1\nname: named\ndescription: A step on the instance.\nsteps:\n  - id: review\n    tool: review-claude\n    prompt: Review the repository.\n    output:\n      ok: boolean\n');
    commit('named');
    expect((await runCLI(['pull'])).code).toBe(0);
    clearLaunches();
    const named = await runCLI(['workflow', 'start', 'named', '--driver', 'local'], unattended);

    expect(envelope(named.stdout), `${named.stdout}\n${named.stderr}`).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(launches()).toEqual(['claude']);
  });

  it('lets a member\'s own instance replace the team\'s, with no acceptance', async () => {
    const own = path.join(home, '.teamai', 'tools', 'acme-claude.yaml');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, ACME_CLAUDE.replace('command: acme-claude', 'command: my-acme-build'));
    clearLaunches();
    try {
      const started = await start('acme-claude', unattended);

      expect(started.code, `${started.stdout}\n${started.stderr}`).toBe(0);
      expect(launches()).toEqual(['my-acme-build']);
    } finally {
      fs.rmSync(own);
    }
  });
});

describe.skipIf(process.platform === 'win32')('a tool instance that moves only its home', () => {
  let root: string;
  let repo: string;
  let bin: string;
  let home: string;

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, ...extra });
  const runCLI = (args: string[], extra: NodeJS.ProcessEnv = {}): Ran => {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { cwd: repo, env: env(extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
    } catch (error) {
      const failed = error as { status: number | null; stdout: string; stderr: string };
      return { code: failed.status, stdout: failed.stdout, stderr: failed.stderr };
    }
  };
  const write = (file: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
  const filesUnder = (dir: string): string[] => (fs.existsSync(path.join(repo, dir)) ? fs.readdirSync(path.join(repo, dir), { recursive: true, encoding: 'utf8' }).sort() : []);
  const init = (agents: string): void => {
    const initialized = runCLI(['init', '--self', '--agent', agents, '--force']);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    const pulled = runCLI(['pull']);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
  };

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-home-instance-e2e-')));
    repo = path.join(root, 'repo');
    bin = path.join(root, 'bin');
    home = path.join(root, 'home');
    for (const dir of [repo, bin, home]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[gc]\n\tauto = 0\n');
    fs.writeFileSync(path.join(bin, 'claude'), fakeClaude('claude'));
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    write('README.md', '# fixture\n');
    write('.teamai/tools/home-claude.yaml', 'schemaVersion: v1alpha1\nname: home-claude\nextends: claude\nhome: { dir: .home-claude }\n');
    write('.teamai/agents/reviewer.yaml', 'name: reviewer\ndescription: Reviews a change\ninstructions: Review it.\n');
    write('.teamai/rules/house-style.md', 'Keep functions short.\n');
    write('.teamai/workflows/reviewed.yaml', 'schemaVersion: v1alpha1\nname: reviewed\ndescription: A review by the reviewer agent.\nsteps:\n  - id: review\n    agent: reviewer\n    prompt: Review the repository without changing it.\n    output:\n      ok: boolean\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo, env: env() });
    execFileSync('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/app.git'], { cwd: repo });
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('delivers project rules and agents where the shipped command reads them, so a step finds its agent', () => {
    init('home-claude');

    expect(filesUnder('.claude/rules')).toEqual(expect.arrayContaining([expect.stringContaining('house-style')]));
    expect(filesUnder('.claude/agents')).toContain('reviewer.md');
    expect(fs.existsSync(path.join(repo, '.home-claude'))).toBe(false);

    fs.rmSync(path.join(home, 'launches.log'), { force: true });
    const started = runCLI(['workflow', 'start', 'reviewed', '--driver', 'local', '--tools', 'default=home-claude'], { TEAMAI_MODE: 'unattended' });

    expect(envelope(started.stdout), `${started.stdout}\n${started.stderr}`).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(path.join(home, 'launches.log'), 'utf8').trim().split('\n')).toEqual(['claude']);
  });

  it('delivers once beside the tool it extends, and uninstalling either keeps what the other still reads', () => {
    const sessionStartTools = (): string[] => [...fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8').matchAll(/hook-dispatch session-start --tool ([a-z-]+)/g)].map(([, tool]) => tool!);
    const uninstall = (tool: string): void => {
      const removed = runCLI(['uninstall', '--agent', tool, '--force']);
      expect(removed.code, `${removed.stdout}\n${removed.stderr}`).toBe(0);
    };

    init('claude,home-claude');
    expect(filesUnder('.claude/agents')).toEqual(['reviewer.md']);
    expect(fs.existsSync(path.join(repo, '.home-claude'))).toBe(false);
    expect(sessionStartTools()).toEqual(['claude']);

    uninstall('home-claude');
    expect(filesUnder('.claude/agents')).toEqual(['reviewer.md']);
    expect(filesUnder('.claude/rules')).toEqual(['house-style.md']);
    expect(sessionStartTools()).toEqual(['claude']);

    init('claude,home-claude');
    uninstall('claude');
    expect(filesUnder('.claude/agents')).toEqual(['reviewer.md']);
    expect(filesUnder('.claude/rules')).toEqual(['house-style.md']);
    expect(sessionStartTools()).toEqual(['home-claude']);
  });
});

describe.skipIf(process.platform === 'win32')('a Codex instance that moves only its home', () => {
  let root: string;
  let repo: string;
  let home: string;
  let codexBin: string;

  const env = (): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', PATH: `${codexBin}${path.delimiter}${pathWithoutCodex()}` };
    delete out.CODEX_HOME;
    return out;
  };
  const runCLI = (args: string[]): Ran => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env: env(), encoding: 'utf8', input: '' });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const ok = (args: string[]): void => {
    const ran = runCLI(args);
    expect(ran.code, `${args.join(' ')}\n${ran.stdout}\n${ran.stderr}`).toBe(0);
  };
  const hooksFile = (): string => path.join(repo, '.codex', 'hooks.json');
  const sessionStartTools = (): string[] => [...new Set([...fs.readFileSync(hooksFile(), 'utf8').matchAll(/hook-dispatch session-start --tool ([a-z-]+)/g)].map(([, tool]) => tool!))];
  /** The handlers of the project's hooks file a Codex on `codexHome` runs: the project trusted there, and each handler at its current hash, as Codex keys it. */
  /** Each handler of the project's hooks file, by the key Codex gives it, at its current hash. */
  const handlers = (): Array<{ key: string; hash: string }> => {
    const hooks: Record<string, Array<{ hooks?: unknown[] }>> = JSON.parse(fs.readFileSync(hooksFile(), 'utf8')).hooks;
    return Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((group, index) => (group.hooks ?? []).map((handler, at) => ({
      key: `${hooksFile()}:${event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}:${index}:${at}`,
      hash: `sha256:${createHash('sha256').update(JSON.stringify(handler)).digest('hex')}`,
    }))));
  };
  const handlerKeys = (): string[] => handlers().map(({ key }) => key);
  const runsIn = (dir: string): { project: boolean; untrusted: string[]; trusted: number } => {
    const state = readFakeCodexState(path.join(home, dir));
    const keys = handlers();
    return {
      project: state.projects[repo]?.trust_level === 'trusted',
      untrusted: keys.flatMap(({ key, hash }) => (state.hooksState[key]?.trusted_hash === hash ? [] : [key])),
      trusted: Object.entries(state.hooksState).filter(([key, entry]) => key.startsWith(hooksFile()) && entry.trusted_hash).length,
    };
  };
  const uninstall = (tool: string): void => ok(['uninstall', '--agent', tool, '--force']);

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-home-codex-e2e-')));
    repo = path.join(root, 'repo');
    home = path.join(root, 'home');
    for (const dir of [repo, path.join(home, '.codex'), path.join(home, '.home-codex')]) fs.mkdirSync(dir, { recursive: true });
    codexBin = installFakeCodex({ dir: path.join(root, 'bin') });
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[gc]\n\tauto = 0\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    fs.mkdirSync(path.join(repo, '.teamai', 'tools'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    fs.writeFileSync(path.join(repo, '.teamai', 'tools', 'home-codex.yaml'), 'schemaVersion: v1alpha1\nname: home-codex\nextends: codex\nhome: { dir: .home-codex }\n');
    fs.mkdirSync(path.join(repo, '.teamai', 'hooks'));
    fs.writeFileSync(path.join(repo, '.teamai', 'hooks', 'hooks.yaml'), 'hooks:\n  - id: team-note\n    description: A note after each tool use\n    event: PostToolUse\n    command: echo team-note\n    timeout: 5\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo, env: env() });
    execFileSync('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/app.git'], { cwd: repo });
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('shares the project\'s hooks file with Codex under one identity, trusts it in both homes, and hands it over on uninstall', () => {
    ok(['init', '--self', '--agent', 'codex,home-codex', '--force']);
    expect(sessionStartTools()).toEqual(['codex']);
    expect(runsIn('.codex')).toMatchObject({ project: true, untrusted: [] });
    expect(runsIn('.home-codex')).toMatchObject({ project: true, untrusted: [] });

    uninstall('home-codex');
    expect(sessionStartTools()).toEqual(['codex']);
    expect(runsIn('.codex')).toMatchObject({ project: true, untrusted: [] });
    expect(runsIn('.home-codex')).toMatchObject({ trusted: 0 });

    ok(['init', '--self', '--agent', 'codex,home-codex', '--force']);
    uninstall('codex');
    expect(sessionStartTools()).toEqual(['home-codex']);
    expect(runsIn('.home-codex')).toMatchObject({ project: true, untrusted: [] });
    expect(runsIn('.codex')).toMatchObject({ trusted: 0 });

    ok(['init', '--self', '--agent', 'codex,home-codex', '--force']);
    const removed = handlerKeys();
    ok(['uninstall', '--force']);
    expect(['.codex', '.home-codex'].flatMap((dir) => removed.filter((key) => readFakeCodexState(path.join(home, dir)).hooksState[key]?.trusted_hash))).toEqual([]);
  });
});
