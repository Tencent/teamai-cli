/**
 * Real CLI: command steps under `--driver skill`, which this session's runner runs as the local driver would. A
 * `finally` step runs once the steps ended, whatever their outcome, and a step that runs `teamai` finds the CLI that
 * runs it with no teamai of its own on PATH. `--timeout` bounds the run as it does under the local driver.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, type BenchmarkFixture, type CliResult } from '../helpers/benchmark-fixture.js';
import { AGENT_SESSION_ENV } from '../../utils/session-id.js';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

const CLEANUP = `schemaVersion: v1alpha1
name: cleanup
description: Fail, then report.
invoke: allow
steps:
  - id: work
    command: node -e "process.exit(1)"
finally:
  - id: report
    command: node report.js
    output: { text: string }
outputs:
  text: steps.report.outputs.text
`;
const REPORT = `require('node:fs').writeFileSync(process.env.FIXTURE_ROOT + '/finally.txt', 'ran');
process.stdout.write(JSON.stringify({ text: 'reported' }));
`;

const VERSION = `schemaVersion: v1alpha1
name: version
description: Print the teamai that runs this step.
invoke: allow
steps:
  - id: print
    command: node print.js
    output: { teamai: string }
`;
const PRINT = `const teamai = require('node:child_process').execFileSync('teamai', ['--version'], { encoding: 'utf8' }).trim();
process.stdout.write(JSON.stringify({ teamai }));
`;

const SLOW = `schemaVersion: v1alpha1
name: slow
description: Wait half a minute.
invoke: allow
timeout: 1h
steps:
  - id: wait
    command: node -e "setTimeout(() => {}, 30000)"
`;

const TurnSchema = z.object({ turn: z.object({ run: z.string(), status: z.enum(['driving', 'done']) }).passthrough() });
const RunSchema = z.object({
  status: z.string(),
  failure: z.object({ code: z.string() }).passthrough().optional(),
  steps: z.array(z.object({ id: z.string(), status: z.string(), outputs: z.unknown().optional(), message: z.string().optional() }).passthrough()),
});

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

/** `teamai <args>` as this session's agent calls it. */
function asAgent(fixture: BenchmarkFixture, args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...fixture.env, CLAUDE_CODE_SESSION_ID: 'session-skill-commands' };
  for (const other of AGENT_SESSION_ENV.filter((name) => name !== 'CLAUDE_CODE_SESSION_ID')) delete env[other];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: fixture.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Starts `workflow` with the skill driver, and asks for its next turn until it is done. Answers the run id. */
async function driveSkill(fixture: BenchmarkFixture, workflow: string, flags: string[] = []): Promise<string> {
  const started = await asAgent(fixture, ['workflow', 'start', workflow, '--driver', 'skill', ...flags]);
  expect(started.code, said(started)).toBe(0);
  let turn = TurnSchema.parse(envelope(started).data).turn;
  for (let poll = 0; poll < 20 && turn.status !== 'done'; poll += 1) {
    const next = await asAgent(fixture, ['workflow', 'next', turn.run, '--driver', 'skill', '--wait']);
    turn = TurnSchema.parse(envelope(next).data).turn;
  }
  expect(turn.status).toBe('done');
  return turn.run;
}

describe('command steps under the skill driver, through the CLI', () => {
  it('runs finally after the only step fails, keeps the run failed, and returns an output finally wrote', async () => {
    const fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false, tools: [], team: { 'workflows/cleanup.yaml': CLEANUP }, app: { 'report.js': REPORT } });
    fixtures.push(fixture);

    const run = RunSchema.parse(fixture.runFile(await driveSkill(fixture, 'cleanup')));

    expect(run.status).toBe('failed');
    expect(run.steps.find((step) => step.id === 'report')).toMatchObject({ status: 'succeeded', outputs: { text: 'reported' } });
    expect(fs.readFileSync(path.join(fixture.root, 'finally.txt'), 'utf8')).toBe('ran');
  }, 120_000);

  it('times a run out at the --timeout its start gave, and refuses a --timeout it cannot keep', async () => {
    const fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false, tools: [], team: { 'workflows/slow.yaml': SLOW } });
    fixtures.push(fixture);

    const started = Date.now();
    const run = RunSchema.parse(fixture.runFile(await driveSkill(fixture, 'slow', ['--timeout', '2s'])));

    expect(run).toMatchObject({ status: 'failed', failure: { code: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(25_000);
    const refused = await asAgent(fixture, ['workflow', 'start', 'slow', '--driver', 'skill', '--timeout', 'soon']);
    expect(refused.code).toBe(1);
    expect(envelope(refused).error).toEqual({ code: 'invalid_arguments', message: '--timeout must be a positive duration, such as 500ms, 30s, 10m, or 2h', next: null });
  }, 120_000);

  it('runs a teamai command step on the teamai that drives the run, with none of its own on PATH', async () => {
    const fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false, tools: [], team: { 'workflows/version.yaml': VERSION }, app: { 'print.js': PRINT } });
    fixtures.push(fixture);
    const version = (await fixture.teamai(['--version'])).stdout.trim();
    // Only the running CLI can answer teamai on PATH now.
    fs.rmSync(path.join(fixture.bin, 'teamai'));

    const run = RunSchema.parse(fixture.runFile(await driveSkill(fixture, 'version')));

    expect(run.status).toBe('succeeded');
    expect(run.steps.find((step) => step.id === 'print')).toMatchObject({ status: 'succeeded', outputs: { teamai: version } });
  }, 120_000);
});
