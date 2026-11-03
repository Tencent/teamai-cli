/**
 * Real CLI: every arm's trials run the model its alias named for its tool when the run started, read from the team's
 * aliases at the run's team revision, on every driver, whatever the aliases say later. The member's own aliases count
 * only with --member-aliases, and the table and the record say whose aliases resolved each model.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, PRODUCT_URL, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const SUITE = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
  model: strong
arms:
  - name: strong
  - name: fast
    model: fast
  - name: codex
    tool: codex
repetitions: 1
timeout: 10m
`;
const ALIASES = `aliases:
  strong:
    claude: { model: claude-strong-1, effort: high }
    codex: { model: gpt-strong-1, effort: high }
  fast:
    claude: claude-fast-1
`;
const LATER_ALIASES = `aliases:
  strong:
    claude: claude-strong-2
    codex: gpt-strong-2
  fast:
    claude: claude-fast-2
`;
const MEMBER_ALIASES = 'aliases:\n  strong:\n    claude: claude-member-1\n';

const AgentSchema = z.object({
  tool: z.object({ name: z.string() }),
  model: z.object({ requested: z.string().optional(), reported: z.string().optional() }).optional(),
  effort: z.object({ requested: z.string().optional() }).optional(),
}).passthrough();
const RunSchema = z.object({ status: z.string(), steps: z.array(z.object({ id: z.string(), agent: AgentSchema.optional() }).passthrough()) });
const RecordSchema = z.object({
  arms: z.array(z.object({ name: z.string() }).passthrough()),
  trials: z.array(z.object({ arm: z.string(), result: z.string(), durationMs: z.number().optional() }).passthrough()),
}).passthrough();
const DoneSchema = z.object({ run: z.string(), outputs: z.object({ text: z.string() }).passthrough() }).passthrough();

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function modelFixture(): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: true, suite: SUITE, team: { 'models/aliases.yaml': ALIASES },
    firstLaunch: 'pulls-a-team-change', teamChange: { 'models/aliases.yaml': LATER_ALIASES },
  });
  fixtures.push(fixture);
  fs.mkdirSync(path.join(fixture.home, '.teamai', 'models'), { recursive: true });
  fs.writeFileSync(path.join(fixture.home, '.teamai', 'models', 'aliases.yaml'), MEMBER_ALIASES);
  return fixture;
}

/** Runs the benchmark with `teamai benchmark run` on the local driver, and answers its run and the results text its `done` carries. */
async function runLocally(fixture: BenchmarkFixture): Promise<{ runId: string; text: string }> {
  const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
  const done = DoneSchema.safeParse(envelope(ran).data?.done);
  if (!done.success) throw new Error(`no done: ${said(ran)}`);
  return { runId: done.data.run, text: done.data.outputs.text };
}

describe('benchmark arm models on the local driver', () => {
  it('runs each arm on the model the team aliases named at start, also after the aliases change and are pulled during the run', async () => {
    const fixture = await modelFixture();

    const { runId, text } = await runLocally(fixture);

    expect(fs.readFileSync(path.join(fixture.teamClone, 'models', 'aliases.yaml'), 'utf8')).toBe(LATER_ALIASES);
    expect(fixture.toolLaunches().map(({ tool, model, effort }) => ({ tool, model, effort }))).toEqual([
      { tool: 'claude', model: 'claude-strong-1', effort: 'high' }, { tool: 'claude', model: 'claude-fast-1', effort: null }, { tool: 'codex', model: 'gpt-strong-1', effort: 'high' },
    ]);
    const stored = RunSchema.parse(fixture.runFile(runId));
    expect(stored.status).toBe('succeeded');
    const agentOf = (arm: string) => stored.steps.find((step) => step.id === `trials.r1.fix.${arm}.prompt`)?.agent;
    expect(agentOf('strong')).toMatchObject({ tool: { name: 'claude' }, model: { requested: 'claude-strong-1' }, effort: { requested: 'high' } });
    expect(agentOf('fast')).toMatchObject({ tool: { name: 'claude' }, model: { requested: 'claude-fast-1' } });
    expect(agentOf('codex')).toMatchObject({ tool: { name: 'codex' }, model: { requested: 'gpt-strong-1' }, effort: { requested: 'high' } });
    const record = RecordSchema.parse(fixture.benchmarkRecord(runId));
    expect(record.arms).toEqual([
      { name: 'strong', tool: 'claude', model: 'claude-strong-1', alias: 'strong', effort: 'high', source: 'team', team: { kind: 'pulled', revision: expect.any(String) } },
      { name: 'fast', tool: 'claude', model: 'claude-fast-1', alias: 'fast', source: 'team', team: { kind: 'pulled', revision: expect.any(String) } },
      { name: 'codex', tool: 'codex', model: 'gpt-strong-1', alias: 'strong', effort: 'high', source: 'team', team: { kind: 'pulled', revision: expect.any(String) } },
    ]);
    expect(record.trials.map(({ result, durationMs }) => ({ result, durationMs }))).toEqual(Array.from({ length: 3 }, () => ({ result: 'passed', durationMs: expect.any(Number) })));
    expect(record.trials.find((trial) => trial.arm === 'strong')).toMatchObject({ tokens: { input: 4, output: 2 }, cost: { amount: 0.25, unit: 'USD' } });
    expect(text).toContain('| strong | claude | claude-strong-1 high (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
    expect(text).toContain('| codex | codex | gpt-strong-1 high (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
    expect(text).toMatch(/\| fast \| 6 \(1\) \| \d+\.\d s \(1\) \| 0\.25 USD \(1\) \|/);
  }, 120_000);
});

describe('benchmark arm models at start', () => {
  it('refuses a plan whose --aliases is neither team nor member, naming both', async () => {
    const fixture = await modelFixture();

    const planned = await fixture.teamai(['benchmark', 'plan', 'fix', '--aliases', 'mine']);

    expect(planned.code, said(planned)).toBe(1);
    expect(planned.stdout).toBe('');
    expect(planned.stderr).toContain('invalid_arguments: --aliases takes team, the team\'s models/aliases.yaml, or member, your ~/.teamai/models/aliases.yaml over the team\'s; got mine.');
  }, 120_000);

  it('refuses to start when a member alias resolves to a credential URL, and leaves no run and no record', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, suite: SUITE, team: { 'models/aliases.yaml': ALIASES } });
    fixtures.push(fixture);
    fs.mkdirSync(path.join(fixture.home, '.teamai', 'models'), { recursive: true });
    fs.writeFileSync(path.join(fixture.home, '.teamai', 'models', 'aliases.yaml'), 'aliases:\n  strong:\n    claude: https://member:private-password-123@models.example.test/private-model\n');

    const started = await fixture.teamai(['benchmark', 'run', 'fix', '--member-aliases']);

    expect(envelope(started).error).toEqual({
      code: 'arm_unpublishable',
      message: 'Arm "strong" has a model that is not a plain name, such as a URL or a local path, and a benchmark record publishes it. Fix your entry in ~/.teamai/models/aliases.yaml, or start again without --member-aliases.',
    });
    expect(started.stdout + started.stderr).not.toContain('private-password-123');
    expect(fixture.runIds()).toEqual([]);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);
});
