import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowClient } from '../workflow/protocol.js';
import { AttemptIdSchema, RunIdSchema, type RunId } from '../workflow/store.js';
import type { Runners } from '../workflow/drivers/skill/skill-driver.js';
// The doc comparison reads the table itself; every behaviour below goes through runSkillCall.
import { TRANSITIONS, type TransitionRow } from '../workflow/drivers/skill/transitions.js';
import { skillHarness } from './helpers/skill-harness.js';

const CHECK = `schemaVersion: v1alpha1
name: check
description: Lint and test
invoke: allow
steps:
  - id: lint
    command: node -e "process.exit(0)"
  - id: test
    needs: [lint]
    command: node -e "console.log('Tests 42 passed (42)')"
`;

const DRAFT = `schemaVersion: v1alpha1
name: draft
description: Draft the notes
invoke: allow
steps:
  - id: write
    prompt: Write the notes.
`;

const GATED = `schemaVersion: v1alpha1
name: gated
description: Lint once the person agrees
invoke: ask
steps:
  - id: lint
    command: node -e "process.exit(0)"
`;

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function harness(workflows: Record<string, string>, options: Parameters<typeof skillHarness>[1] = {}) {
  const made = await skillHarness(workflows, options);
  roots.push(made.root);
  return made;
}

async function started(made: Awaited<ReturnType<typeof harness>>) {
  const answer = await made.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined });
  if (!('data' in answer) || !('turn' in answer.data)) throw new Error(JSON.stringify(answer));
  return answer.data.turn;
}

async function polledToDone(made: Awaited<ReturnType<typeof harness>>, run: RunId) {
  for (let poll = 0; poll < 5; poll += 1) {
    const answer = await made.call({ kind: 'next', run, wait: true });
    if ('data' in answer && 'turn' in answer.data && answer.data.turn.status === 'done') return answer.data.turn;
  }
  throw new Error('the run did not reach done in five polls');
}

/** The protocol with its first `next`, `report` or `prepare` answered by `script` instead. */
function scriptedOnce(script: (client: WorkflowClient) => Partial<Pick<WorkflowClient, 'next' | 'report' | 'prepare'>>) {
  return (client: WorkflowClient): WorkflowClient => {
    const first = script(client);
    let used = false;
    const once = <A extends unknown[], R>(scripted: ((...args: A) => R) | undefined, real: (...args: A) => R) => (...args: A): R => {
      if (!scripted || used) return real(...args);
      used = true;
      return scripted(...args);
    };
    return {
      ...client,
      next: once(first.next, (run, body) => client.next(run, body)),
      report: once(first.report, (run, body, options) => client.report(run, body, options)),
      prepare: once(first.prepare, (lock, lease) => client.prepare(lock, lease)),
    };
  };
}

/**
 * One case per group of rows. Each runs real calls through `runSkillCall` and asserts the rows it names were taken;
 * the last case checks the cases cover every row of `TRANSITIONS`.
 */
const CASES: Array<{ name: string; rows: string[]; run: () => Promise<string[]> }> = [
  {
    name: 'a command-only run, from describe to done and a next after it',
    rows: ['R4', 'R10', 'S1', 'S5', 'D1', 'D6', 'D15', 'D16', 'D18', 'D20', 'D21', 'D23', 'C1', 'C8', 'P7', 'X2'],
    run: async () => {
      const made = await harness({ check: CHECK });
      expect(await made.call({ kind: 'describe', name: 'check' })).toMatchObject({ data: { describe: { ask: { kind: 'start' } } } });
      const { run } = await started(made);
      await polledToDone(made, run);
      const after = await made.call({ kind: 'next', run, wait: false });
      expect(after).toMatchObject({ data: { turn: { status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] } } });
      expect(JSON.stringify(after)).not.toContain('"then"');
      return made.rows;
    },
  },
  {
    name: 'a workflow with a prompt step is routed to the local driver',
    rows: ['R2', 'R8'],
    run: async () => {
      const made = await harness({ draft: DRAFT });
      expect(await made.call({ kind: 'describe', name: 'draft' })).toMatchObject({ data: { describe: { ask: { kind: 'local', start: 'teamai workflow start draft --driver local' } } } });
      expect(await made.call({ kind: 'start', name: 'draft', answers: { confirmed: false }, inputs: undefined })).toMatchObject({ error: { code: 'needs_local_driver', next: null } });
      return made.rows;
    },
  },
  {
    name: 'an invoke: ask workflow asks first, and a start without the answer is refused',
    rows: ['R3', 'R9'],
    run: async () => {
      const made = await harness({ gated: GATED });
      expect(await made.call({ kind: 'describe', name: 'gated' })).toMatchObject({ data: { describe: { ask: {
        kind: 'ask', question: { text: 'The team asks that you agree before it starts. Start it?', options: [{ label: 'Start it', start: 'teamai workflow start gated --driver skill --confirmed' }] },
      } } } });
      expect(await made.call({ kind: 'start', name: 'gated', answers: { confirmed: false }, inputs: undefined }))
        .toMatchObject({ error: { code: 'confirm_needed', next: 'teamai workflow start --describe gated --driver skill' } });
      return made.rows;
    },
  },
  {
    name: 'a run the skill driver did not start answers not_skill_run',
    rows: ['R11'],
    run: async () => {
      const made = await harness({ check: CHECK });
      const other = await made.context.client.start('check', { checkout: made.work });
      if (!('data' in other) || typeof other.data.run !== 'string') throw new Error(JSON.stringify(other));
      expect(await made.call({ kind: 'next', run: RunIdSchema.parse(other.data.run), wait: false })).toMatchObject({ error: { code: 'not_skill_run', next: null } });
      return made.rows;
    },
  },
  {
    name: 'a second known session is refused',
    rows: ['S2'],
    run: async () => {
      const made = await harness({ check: CHECK });
      const { run } = await started(made);
      expect(await made.call({ kind: 'next', run, wait: false }, { session: 'session-b' })).toMatchObject({ error: { code: 'orchestrator_active', next: null } });
      return made.rows;
    },
  },
  {
    name: 'a busy run lock answers driver_running with the same literal',
    rows: ['D19'],
    run: async () => {
      const made = await harness({ check: CHECK });
      const { run } = await started(made);
      const busy = { take: async () => ({ error: { code: 'driver_running' as const, message: 'held' } }) };
      expect(await made.call({ kind: 'next', run, wait: false }, { locks: busy }))
        .toMatchObject({ error: { code: 'driver_running', next: `teamai workflow next ${run} --driver skill` } });
      return made.rows;
    },
  },
  {
    name: 'an engine error on next is relayed with the next literal',
    rows: ['D17'],
    run: async () => {
      const made = await harness({ check: CHECK }, { client: scriptedOnce(() => ({ next: async () => ({ error: { code: 'lease_conflict', message: 'scripted' } }) })) });
      const answer = await made.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined });
      expect(answer).toMatchObject({ error: { code: 'lease_conflict', message: 'scripted', next: expect.stringMatching(/^teamai workflow next r[0-9a-f]+ --driver skill$/) } });
      return made.rows;
    },
  },
  {
    name: 'a runner that never took its lock is started again',
    rows: ['C10'],
    run: async () => {
      let dropped = false;
      const dropFirst = (runners: Runners): Runners => ({
        ...runners,
        spawn: async (job) => { if (dropped) return runners.spawn(job); dropped = true; },
      });
      const made = await harness({ check: CHECK }, { runners: dropFirst });
      const { run } = await started(made);
      const done = await polledToDone(made, run);
      expect(done.actions).toMatchObject([{ kind: 'done', outcome: 'succeeded' }]);
      return made.rows;
    },
  },
  {
    name: 'a place that fails to prepare is reported failed',
    rows: ['C7'],
    run: async () => {
      const made = await harness({ check: CHECK }, { client: scriptedOnce(() => ({ prepare: async () => ({ kind: 'failed', failure: { code: 'workspace_base', message: 'scripted' } }) })) });
      const { run } = await started(made);
      const done = await polledToDone(made, run);
      expect(done.actions).toMatchObject([{ kind: 'done', outcome: 'failed' }]);
      return made.rows;
    },
  },
  {
    name: 'an agent report is refused: an unknown attempt, and one its runner reports',
    rows: ['P2', 'P3'],
    run: async () => {
      const made = await harness({ check: CHECK });
      const turn = await started(made);
      const open = turn.running[0];
      if (!open) throw new Error('no attempt running');
      expect(await made.call({ kind: 'report', run: turn.run, attempt: AttemptIdSchema.parse('a00000000'), role: 'agent' })).toMatchObject({ error: { code: 'unknown_attempt', next: `teamai workflow next ${turn.run} --driver skill` } });
      expect(await made.call({ kind: 'report', run: turn.run, attempt: open.attempt, role: 'agent' })).toMatchObject({ error: { code: 'not_dispatched', next: `teamai workflow next ${turn.run} --driver skill` } });
      return made.rows;
    },
  },
  {
    name: 'repeated_report settles the attempt',
    rows: ['P8'],
    run: async () => {
      const made = await harness({ check: CHECK }, { client: scriptedOnce((client) => ({ report: async (run, body, options) => {
        await client.report(run, body, options);
        return { error: { code: 'repeated_report', message: 'scripted' } };
      } })) });
      const { run } = await started(made);
      await polledToDone(made, run);
      return made.rows;
    },
  },
  {
    name: 'a refused report is kept and sent again by the next tick',
    rows: ['P10', 'P11'],
    run: async () => {
      const made = await harness({ check: CHECK }, { client: scriptedOnce(() => ({ report: async () => ({ error: { code: 'protocol_unavailable', message: 'scripted' } }) })) });
      const { run } = await started(made);
      const done = await polledToDone(made, run);
      expect(done.actions).toMatchObject([{ kind: 'done', outcome: 'succeeded' }]);
      return made.rows;
    },
  },
  {
    name: 'a poll with nothing to show ends at its bound with the same poll',
    rows: ['D24'],
    run: async () => {
      const held = (runners: Runners): Runners => ({ ...runners, spawn: async () => {}, alive: async () => true });
      const made = await harness({ check: CHECK }, { runners: held });
      const { run } = await started(made);
      expect(await made.call({ kind: 'next', run, wait: true })).toEqual({ data: { turn: expect.objectContaining({
        status: 'driving', actions: [], events: [],
        // oxlint-disable-next-line unicorn/no-thenable
        then: { kind: 'poll', run: `teamai workflow next ${run} --driver skill --wait` },
      }) } });
      return made.rows;
    },
  },
];

const COLUMNS = ['id', 'state', 'input', 'guard', 'effects', 'next', 'action'] as const;

function render(row: TransitionRow): string {
  return `| ${COLUMNS.map((column) => row[column]).join(' | ')} |`.replace(/ {2}\|/g, ' |');
}

/** Every table row under `## The skill driver` in the engine notes. */
function documentedRows(): TransitionRow[] {
  const doc = fs.readFileSync(path.join(import.meta.dirname, '../../docs/dev/workflow-engine.md'), 'utf8');
  const section = doc.split(/^## /m).find((part) => part.startsWith('The skill driver\n'));
  if (!section) throw new Error('docs/dev/workflow-engine.md has no "## The skill driver" section');
  return section.split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Row |'))
    .map((line) => {
      const [id = '', state = '', input = '', guard = '', effects = '', next = '', action = ''] = line.slice(1, -1).split('|').map((cell) => cell.trim());
      return { id, state, input, guard, effects, next, action };
    });
}

describe('skill driver transitions', () => {
  it('documents every row of TRANSITIONS, cell by cell, and no other', () => {
    const documented = documentedRows().map(render);
    const coded = TRANSITIONS.map(render);
    expect(new Set(documented).size, 'a row is documented twice').toBe(documented.length);
    expect([...documented].sort(), `Paste these rows under ## The skill driver in docs/dev/workflow-engine.md:\n${coded.join('\n')}`).toEqual([...coded].sort());
  });

  for (const { name, rows, run } of CASES) {
    it(`takes ${rows.join(', ')}: ${name}`, async () => {
      const taken = new Set(await run());
      expect(rows.filter((row) => !taken.has(row))).toEqual([]);
    });
  }

  it('has a case for every row', () => {
    const covered = new Set(CASES.flatMap(({ rows }) => rows));
    expect(TRANSITIONS.map(({ id }) => id).filter((id) => !covered.has(id))).toEqual([]);
    expect([...covered].filter((id) => !TRANSITIONS.some((row) => row.id === id))).toEqual([]);
  });
});
