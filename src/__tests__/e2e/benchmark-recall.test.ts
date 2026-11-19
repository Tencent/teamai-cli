/**
 * Real CLI: a benchmark arm with `recall: true` gets the team's recall deployment in its trial clone, and an arm
 * without it does not. The fake tool records the files of the directory it ran in, which is the trial's clone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { benchmarkFixture, envelope, FIX_SUITE, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

// Two arms: one asks for recall, one does not. The second changes a defaults
// key, as a suite needs, since `recall` is not one.
const RECALL_SUITE = FIX_SUITE.replace(
  'arms:\n  - name: claude\n',
  'arms:\n  - name: with-recall\n    recall: true\n  - name: baseline\n    model: claude-x\n',
);

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

describe('benchmark arm recall', () => {
  it('deploys the team recall into the clone of an arm that asks for it, and none into one that does not', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, suite: RECALL_SUITE, team: { 'docs/probe.md': '# Provenance sentinel\n' },
      recallProbe: `
if (fs.existsSync('.claude/agents/teamai-recall.md')) {
  const recall = () => {
    const ran = spawnSync(process.execPath, [recallCli, 'recall', 'provenance sentinel'], { encoding: 'utf8' });
    if (ran.status !== 0) throw new Error(ran.stderr);
  };
  const home = path.resolve('..', 'h');
  const files = fs.readdirSync(home, { recursive: true, withFileTypes: true }).filter((entry) => entry.name === 'search-index.json');
  if (files.length !== 1) throw new Error('Expected one trial index, found ' + files.length);
  const file = path.join(files[0].parentPath, files[0].name);
  const index = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!index.provenance?.teamRevision || index.provenance.learningsRevision !== null) throw new Error('Missing build provenance');
  recall();
  index.provenance = { teamRevision: 'a'.repeat(40), learningsRevision: null };
  fs.writeFileSync(file, JSON.stringify(index));
  recall();
  delete index.provenance;
  fs.writeFileSync(file, JSON.stringify(index));
  recall();
}`,
    });
    fixtures.push(fixture);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
    const done = envelope(ran).data?.done as { outcome?: string } | undefined;
    expect(done?.outcome).toBe('succeeded');

    // Each launch records the files of the directory it ran in: the trial's clone.
    const launches = fixture.toolLaunches();
    const recallFiles = [
      '.claude/agents/teamai-recall.md',
      '.claude/rules/teamai-recall.md',
      '.claude/rules/teamai-context.md',
    ];
    const withRecall = launches.find((launch) => launch.paths.includes('.claude/agents/teamai-recall.md'));
    const without = launches.find((launch) => !launch.paths.includes('.claude/agents/teamai-recall.md'));

    // The arm that asked for it gets the recall agent, the recall rule and the
    // context rule; the arm that did not gets none of them.
    expect(withRecall?.paths).toEqual(expect.arrayContaining(recallFiles));
    // The clone without recall has to exist: without this, a change that
    // gave every clone recall would leave `without` undefined and the case
    // would still pass.
    expect(without, 'no clone ran without recall').toBeDefined();
    expect(without?.paths.filter((file) => recallFiles.includes(file))).toEqual([]);
    // Both arms ran the same task on the same tool.
    expect(launches).toHaveLength(2);

    // The record the run wrote keeps which arms ran with recall, so a reader of it, not only a watcher of the clone, can
    // tell a run that measured recall from one that did not.
    const runId = (envelope(ran).data?.done as { run?: string } | undefined)?.run;
    expect(runId, 'the run answers its id').toBeDefined();
    const record = fixture.benchmarkRecord(String(runId)) as {
      arms: Array<{ name: string; recall?: boolean }>;
      trials: Array<{ arm: string; recallProvenance?: unknown }>;
    };
    expect(record.arms.map(({ name, recall }) => ({ name, recall }))).toEqual([
      { name: 'with-recall', recall: true },
      { name: 'baseline', recall: undefined },
    ]);
    const trial = record.trials.find(({ arm }) => arm === 'with-recall');
    expect(trial?.recallProvenance).toEqual({
      queried: true, unavailable: true,
      indexes: [
        { teamRevision: expect.stringMatching(/^[0-9a-f]{40}$/), learningsRevision: null },
        { teamRevision: 'a'.repeat(40), learningsRevision: null },
      ],
    });
    expect(record.trials.find(({ arm }) => arm === 'baseline')?.recallProvenance).toBeUndefined();

    // And the report the run prints shows it, so the record's own text says which arms ran with recall.
    const text = (envelope(ran).data?.done as { outputs?: { text?: string } } | undefined)?.outputs?.text ?? '';
    expect(text).toContain('| Arm | Tool | Model (source) | Recall | Planned |');
    expect(text).toMatch(/\| with-recall \| claude \|[^|]+\| on \|/);
    expect(text).toMatch(/\| baseline \| claude \|[^|]+\| off \|/);
  }, 240_000);
});
