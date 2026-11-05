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
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, suite: RECALL_SUITE });
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
    expect(without?.paths).not.toEqual(expect.arrayContaining(recallFiles));
    // Both arms ran the same task on the same tool.
    expect(launches).toHaveLength(2);
  }, 240_000);
});
