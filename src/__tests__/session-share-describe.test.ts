import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillHarness } from './helpers/skill-harness.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SESSION_CALL = { evidence: { kind: 'session', variable: 'CLAUDE_CODE_SESSION_ID' }, session: '7c1e-session', tool: 'claude' } as const;
// It names its tool, which the judge step of teamai-score runs on, but no session.
const NO_SESSION = { evidence: { kind: 'session', variable: 'CLAUDE_CODE_SESSION_ID' }, session: undefined, tool: 'claude' } as const;

/** A team override of teamai-share-learnings with `inputs` and one step that reads none of them. */
const override = (inputs: string) => `schemaVersion: v1alpha1
name: teamai-share-learnings
description: Share the session our way.
invoke: ask
inputs: { ${inputs} }
steps:
  - id: note
    command: node -e "console.log('closed')"
`;

/** The inputs describe's question lists for `name`, from a session or `NO_SESSION`. */
async function proposedInputs(workflows: Record<string, string>, caller: typeof SESSION_CALL | typeof NO_SESSION = SESSION_CALL, name = 'teamai-share-learnings'): Promise<unknown[]> {
  const harness = await skillHarness(workflows);
  roots.push(harness.root);
  const described = await harness.call({ kind: 'describe', name }, caller);
  if (!('data' in described) || !('describe' in described.data) || described.data.describe.ask.kind !== 'ask') throw new Error(JSON.stringify(described));
  return described.data.describe.ask.question.inputs;
}

describe('describe of teamai-share-learnings and teamai-share-session', () => {
  it('proposes a value and why for each input of the contract, for the calling session, for both defaults', async () => {
    expect(await proposedInputs({}, SESSION_CALL, 'teamai-share-session')).toEqual([...await proposedInputs({}), {
      name: 'demand', type: { type: 'enum', values: ['auto', 'named'] }, value: 'named',
      why: 'This session asks to be judged, so every scorer named judges it, sampled or not, and it counts toward daily_limit. auto samples it, as a background pass does.',
    }]);
    expect(await proposedInputs({})).toEqual([
      { name: 'session', type: { type: 'string' }, value: '7c1e-session', why: 'The session to share: this one.' },
      { name: 'source', type: { type: 'string' }, value: 'claude-code', why: 'This session\'s tool, as teamai session list names it.' },
      {
        name: 'publish', type: { type: 'boolean' }, value: true,
        why: 'Archive this session\'s transcript, scrubbed, for the team. Proposed because the attended publish policy (the default) is ask. It publishes once the run starts, with no other approval. Set it false to skip publishing.',
      },
      {
        name: 'scorers', type: { type: 'array', items: { type: 'string' } }, value: [],
        why: 'Scorers that judge this session now. None proposed: the attended scoring policy (the default) is off. Name any scorer to judge with it.',
      },
    ]);
  });

  it('proposes no value when no agent session calls, and asks for the session and its tool', async () => {
    expect(await proposedInputs({}, NO_SESSION)).toEqual([
      { name: 'session', type: { type: 'string' }, why: 'No agent session found: give the session and its tool.' },
      { name: 'source', type: { type: 'string' }, why: 'No agent session found: give the session and its tool.' },
      { name: 'publish', type: { type: 'boolean' } },
      { name: 'scorers', type: { type: 'array', items: { type: 'string' } } },
    ]);
  });

  it('fills the contract inputs a team override keeps by name and type, and leaves the others to the person', async () => {
    const inputs = await proposedInputs({ 'teamai-share-learnings': override('sessionId: string, source: string, scorers: string, ticket: string') });

    expect(inputs).toEqual([
      { name: 'sessionId', type: { type: 'string' } },
      { name: 'source', type: { type: 'string' }, value: 'claude-code', why: 'This session\'s tool, as teamai session list names it.' },
      { name: 'scorers', type: { type: 'string' } },
      { name: 'ticket', type: { type: 'string' } },
    ]);
  });

  it('proposes nothing for a team workflow of another name with the same inputs', async () => {
    const harness = await skillHarness({ 'close-out': override('session: string, source: string').replace('name: teamai-share-learnings', 'name: close-out') });
    roots.push(harness.root);

    const described = await harness.call({ kind: 'describe', name: 'close-out' }, SESSION_CALL);

    expect(described).toMatchObject({ data: { describe: { ask: { question: { inputs: [{ name: 'session', type: { type: 'string' } }, { name: 'source', type: { type: 'string' } }] } } } } });
    expect(JSON.stringify(described)).not.toContain('"why"');
  });
});
