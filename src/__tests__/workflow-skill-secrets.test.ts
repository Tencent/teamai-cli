import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowClient } from '../workflow/protocol.js';
import type { Runners } from '../workflow/drivers/skill/skill-driver.js';
import { readRun, skillStatePath } from '../workflow/store.js';
import { skillHarness } from './helpers/skill-harness.js';

// A fake value, distinctive enough that finding it anywhere means it leaked.
const SECRET = 'fake-ship-token-1304-q7v9x2';

// A command that prints the value on stdout, as JSON its output carries, and on stderr; a prompt step whose prompt
// renders that output; and a prompt step that requires the value itself, which this driver holds back.
const SHIP = `schemaVersion: v1alpha1
name: ship
description: Publish the package, announce it, then sign it
invoke: allow
steps:
  - id: publish
    requires: { env: [SHIP_TOKEN] }
    output: { receipt: string }
    command: >-
      node -e "const token = process.env.SHIP_TOKEN; console.error('auth ' + token); console.log(JSON.stringify({ receipt: 'paid with ' + token }))"
  - id: announce
    needs: [publish]
    prompt: "Announce the receipt: {{ steps.publish.outputs.receipt }}"
  - id: sign
    needs: [announce]
    requires: { env: [SHIP_TOKEN] }
    prompt: Sign the release.
`;

// A command that fails, naming the value on stderr.
const REFUSED = `schemaVersion: v1alpha1
name: ship
description: Publish the package
invoke: allow
steps:
  - id: publish
    requires: { env: [SHIP_TOKEN] }
    command: node -e "console.error('auth ' + process.env.SHIP_TOKEN + ' refused'); process.exit(3)"
`;

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Every file under `dir` whose bytes hold `value`, by its path relative to `dir`. */
function filesHolding(dir: string, value: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && fs.readFileSync(path.join(entry.parentPath, entry.name)).includes(value))
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

/**
 * The harness with SHIP_TOKEN set; the value of SHIP_TOKEN in the env of each command its runners start; and the files
 * that held the value when each report reached the engine, which is when skill.json holds the report's body.
 */
async function shipping(workflow: string) {
  vi.stubEnv('SHIP_TOKEN', SECRET);
  const commandEnv: Array<string | undefined> = [];
  const whileReporting: string[] = [];
  let root: string | undefined;
  const made = await skillHarness({ ship: workflow }, {
    runners: (runners: Runners): Runners => ({ ...runners, command: (input) => { commandEnv.push(input.env.SHIP_TOKEN); return runners.command(input); } }),
    client: (client: WorkflowClient): WorkflowClient => ({
      ...client,
      report: async (run, body, options) => {
        if (root !== undefined) whileReporting.push(...filesHolding(root, SECRET));
        return client.report(run, body, options);
      },
    }),
  });
  root = made.root;
  roots.push(made.root);
  return { made, commandEnv, whileReporting };
}

type Made = Awaited<ReturnType<typeof shipping>>['made'];
type Answer = Awaited<ReturnType<Made['call']>>;

function turnOf(answer: Answer) {
  if (!('data' in answer) || !('turn' in answer.data)) throw new Error(JSON.stringify(answer));
  return answer.data.turn;
}

/** The settled event of `step` among the turns of `answers`. */
function settledOf(answers: Answer[], step: string) {
  return answers.flatMap((answer) => ('data' in answer && 'turn' in answer.data ? answer.data.turn.events : []))
    .find((event) => event.kind === 'settled' && event.step === step);
}

describe('a secret value through a skill run', () => {
  it('reaches the command that requires it, and no turn, tail, brief, skill state or run file', async () => {
    const { made, commandEnv, whileReporting } = await shipping(SHIP);
    const answers: Answer[] = [];
    const call = async (input: Parameters<Made['call']>[0]): Promise<Answer> => {
      const answer = await made.call(input);
      answers.push(answer);
      return answer;
    };
    const { run } = turnOf(await call({ kind: 'start', name: 'ship', answers: { confirmed: false }, inputs: undefined }));
    let turn = turnOf(await call({ kind: 'choose', run, choice: 'h1' }));
    for (let poll = 0; poll < 10 && !turn.actions.some((action) => action.kind === 'dispatch'); poll += 1) {
      turn = turnOf(await call({ kind: 'next', run, wait: turn.then?.kind === 'poll' }));
    }
    const announce = turn.actions.find((action) => action.kind === 'dispatch');
    if (announce?.kind !== 'dispatch') throw new Error(JSON.stringify(turn));
    await call({ kind: 'ack', run, attempt: announce.attempt });
    const brief = fs.readFileSync(announce.brief, 'utf8');
    const result = /Write `([^`]+result\.json)`/.exec(brief)?.[1];
    if (!result) throw new Error(brief);
    fs.writeFileSync(result, JSON.stringify({ kind: 'output', output: 'Announced it.' }));
    await call({ kind: 'report', run, attempt: announce.attempt, role: 'agent', modelUnavailable: false });
    const handed = turnOf(await call({ kind: 'next', run, wait: false }));

    expect(commandEnv).toEqual([SECRET]);
    expect(settledOf(answers, 'publish')).toMatchObject({ outcome: 'success', tail: expect.stringContaining('paid with <REDACTED:SHIP_TOKEN>') });
    expect(brief).toContain('Announce the receipt: paid with <REDACTED:SHIP_TOKEN>');
    expect(handed.actions).toEqual([expect.objectContaining({ kind: 'person', why: 'handoff', held: [{ step: 'sign', missing: ['env'] }] })]);
    expect(await readRun(made.config, run)).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ id: 'publish', outputs: { receipt: 'paid with <REDACTED:SHIP_TOKEN>' } })]) });
    expect(answers.filter((answer) => JSON.stringify(answer).includes(SECRET))).toEqual([]);
    expect(whileReporting).toEqual([]);
    expect(filesHolding(made.root, SECRET)).toEqual([]);
  });

  it('keeps it out of the failure of a command that names it on stderr', async () => {
    const { made, commandEnv, whileReporting } = await shipping(REFUSED);
    const started = await made.call({ kind: 'start', name: 'ship', answers: { confirmed: false }, inputs: undefined });
    const answers: Answer[] = [started];
    for (let poll = 0, turn = turnOf(started); poll < 10 && turn.status !== 'done'; poll += 1) {
      const answer = await made.call({ kind: 'next', run: turn.run, wait: true });
      answers.push(answer);
      turn = turnOf(answer);
    }

    expect(commandEnv).toEqual([SECRET]);
    expect(settledOf(answers, 'publish')).toMatchObject({ outcome: 'failed', exitCode: 3, tail: 'auth <REDACTED:SHIP_TOKEN> refused' });
    expect(await readRun(made.config, turnOf(started).run)).toMatchObject({ steps: [expect.objectContaining({ id: 'publish', status: 'failed', message: 'command exited with status 3: auth <REDACTED:SHIP_TOKEN> refused' })] });
    expect(answers.filter((answer) => JSON.stringify(answer).includes(SECRET))).toEqual([]);
    expect(whileReporting).toEqual([]);
    expect(filesHolding(made.root, SECRET)).toEqual([]);
  });

  it('keeps it out of the journal of a call that passed it as an argument, with the run lock free or busy', async () => {
    const { made } = await shipping(REFUSED);
    const { run } = turnOf(await made.call({ kind: 'start', name: 'ship', answers: { confirmed: false }, inputs: undefined }));
    const respond = { kind: 'respond', run, step: SECRET, choice: SECRET, pass: 1 } as const;
    expect(await made.call(respond)).toMatchObject({ error: { code: 'step_not_found' } });
    const busy: Parameters<Made['call']>[1] = { locks: { take: async () => ({ kind: 'busy', error: { code: 'driver_running', message: 'busy' } }) } };
    expect(await made.call(respond, busy)).toMatchObject({ error: { code: 'driver_running' } });

    const journal = fs.readFileSync(path.join(path.dirname(skillStatePath(made.config, run)), 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(journal.filter((line) => line.call === 'respond')).toEqual([
      expect.objectContaining({ step: '<REDACTED:SHIP_TOKEN>', choice: '<REDACTED:SHIP_TOKEN>', answer: 'step_not_found' }),
      expect.objectContaining({ step: '<REDACTED:SHIP_TOKEN>', choice: '<REDACTED:SHIP_TOKEN>', answer: 'driver_running' }),
    ]);
    expect(filesHolding(made.root, SECRET)).toEqual([]);
  });
});
