import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runsDir } from '../workflow/store.js';
import { fakeJudge, skillHarness } from './helpers/skill-harness.js';

const RELEASE_DOCS = `schemaVersion: v1alpha1
name: release-docs
description: Draft the release notes, then sign them
invoke: allow
steps:
  - id: docs
    workspace: new
    workflow:
      steps:
        - id: draft
          prompt: Draft the release notes.
        - id: sign
          needs: [draft]
          prompt: Sign the notes.
          requires: { env: [SIGNING_KEY] }
`;

// Every fact describe states: inputs, width, an interactive step, a required and an optional approval, a delivery, env
// with no value here, a held step, a budget, a timeout, judging here, and invoke: ask.
const SHIP = `schemaVersion: v1alpha1
name: ship
description: Build, review and ship a change
invoke: ask
inputs:
  ticket: string
  count: number
timeout: 2h
steps:
  - id: api
    workspace: new
    prompt: Write the API.
  - id: ui
    needs: []
    workspace: new
    prompt: Write the UI.
  - id: plan-review
    needs: [api, ui]
    approve: Approve the plan?
    command: node -e "process.exit(0)"
  - id: notes
    needs: [plan-review]
    interactive: true
    prompt: Write the release notes with the person.
  - id: integrate
    needs: [notes]
    workspace: new
    deliver: pr
    prompt: Integrate the API and the UI.
    scorers: [review-quality]
  - id: publish
    needs: [integrate]
    requires: { env: [NPM_TOKEN] }
    command: node -e "process.exit(0)"
  - id: announce
    needs: [publish]
    budget: { tokens: 20000 }
    workflow:
      steps:
        - id: post
          prompt: Announce the release.
          requires: { env: [SLACK_TOKEN] }
  - id: go-live
    needs: [announce]
    approve: { message: Deploy?, required: true }
    command: node -e "process.exit(0)"
`;

// Nothing to ask, and two facts to tell: env with no value here, and a timeout.
const LINT = `schemaVersion: v1alpha1
name: lint
description: Lint the change
invoke: allow
timeout: 30m
steps:
  - id: lint
    requires: { env: [LINT_TOKEN] }
    command: node -e "process.exit(0)"
`;

// Two steps at once, then an optional approval: describe recommends running both at once, with the agent deciding.
const WIDE = `schemaVersion: v1alpha1
name: wide
description: Lint and test at once, then approve the results
invoke: allow
steps:
  - id: lint
    command: node -e "process.exit(0)"
  - id: test
    needs: []
    command: node -e "process.exit(0)"
  - id: review
    needs: [lint, test]
    approve: Approve the results?
    command: node -e "process.exit(0)"
`;

const DEPLOY = `schemaVersion: v1alpha1
name: deploy
description: Deploy once the person approves
invoke: allow
steps:
  - id: go-live
    approve: { message: Deploy to production?, required: true }
    command: node -e "process.exit(0)"
`;

const DRAFT = `schemaVersion: v1alpha1
name: draft
description: Draft the notes with the person
invoke: allow
steps:
  - id: write
    prompt: Write the notes.
    interactive: true
`;

const GATED = `schemaVersion: v1alpha1
name: gated
description: Lint once the person agrees
invoke: ask
steps:
  - id: lint
    command: node -e "process.exit(0)"
`;

const PICK = `schemaVersion: v1alpha1
name: pick
description: Pick a target, then lint
invoke: allow
steps:
  - id: target
    choose: { message: Which target?, options: [web, mobile] }
  - id: lint
    needs: [target]
    command: node -e "process.exit(0)"
`;

const GREET = `schemaVersion: v1alpha1
name: greet
description: Greet someone
invoke: allow
inputs: { who: string }
steps:
  - id: greet
    env: { NAME: "{{ inputs.who }}" }
    command: node -e "console.log(process.env.NAME)"
`;

// The default session-close, as #1388 defines it.
const SESSION_CLOSE = `schemaVersion: v1alpha1
name: session-close
description: Close out this session with the person - share what it taught as a team learning, publish its transcript to the team, score it with the team's scorers. Use when the person asks to close the session, share a learning, publish or archive the session, or score or judge it.
invoke: ask
inputs: { session: string, source: string, publish: boolean, scorers: [string], judge: here | driver }
steps:
  - id: learning
    interactive: true
    prompt: "Run \`teamai skill get share\` and follow it with the person for the {{ inputs.source }} session {{ inputs.session }}. If the person finds nothing worth sharing, return verdict skip. Otherwise write the learning to a file outside the repository and return verdict share, its path, its title, and the learnings namespace (an empty string for the shared root)."
    output: { verdict: share | skip, title: string, file: string, namespace: string }
  - id: contribute
    needs: [learning]
    if: steps.learning.outputs.verdict == 'share'
    approve: Share "{{ steps.learning.outputs.title }}" with the team?
    command: teamai contribute --file "$FILE" --title "$TITLE" --namespace "$NS" --session-id "$SESSION"
    env: { FILE: "{{ steps.learning.outputs.file }}", TITLE: "{{ steps.learning.outputs.title }}", NS: "{{ steps.learning.outputs.namespace }}", SESSION: "{{ inputs.session }}" }
  - id: publish
    needs: []
    if: inputs.publish
    approve: { message: "Publish this session, scrubbed, to the team?", required: true }
    command: teamai session push --scrub --session "$SESSION" --source "$SOURCE"
    env: { SESSION: "{{ inputs.session }}", SOURCE: "{{ inputs.source }}" }
  - id: score
    needs: []
    if: inputs.judge == 'here'
    for_each: inputs.scorers
    command: teamai score --session "$SESSION" --source "$SOURCE" --scorer "$SCORER"
    env: { SESSION: "{{ inputs.session }}", SOURCE: "{{ inputs.source }}", SCORER: "{{ item }}" }
  - id: score-driver
    needs: []
    if: inputs.judge == 'driver'
    for_each: inputs.scorers
    prompt: |
      Judge the {{ inputs.source }} session {{ inputs.session }} with the scorer {{ item }}. Take the judge work with
      teamai score --scorer {{ item }} --session {{ inputs.session }} --source {{ inputs.source }} --json '{"driver":{"kind":"{{ inputs.source }}","machine":"local","workspace":".","can":{"judge":{"isolation":"best-effort","access":"read","tools":["<your tool>"]}}}}'
      Read only the lease's prompt file and evidence directory, answer with the lease's answer schema, and send the answer with the lease's submit command and the same driver. Return the label it stored.
      In tools, declare the id of your own tool (claude, codex, cursor, …), not the session's platform. If teamai answers isolation_unmet, judge_model_unavailable or busy, return an empty label.
    output: { label: string }
`;

const SCORERS = { 'review-quality': `---
labels:
  - { value: thorough, score: 1, description: Did the work it was asked for }
  - { value: shallow, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 100
---
Judge the change.
` };

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

/** How many runs this machine has. */
function runCount(made: Awaited<ReturnType<typeof harness>>): number {
  return fs.existsSync(runsDir(made.config)) ? fs.readdirSync(runsDir(made.config)).length : 0;
}

describe('skill driver preflight', () => {
  it('states every fact in one question, and offers the recommended start first and at most four others', async () => {
    const made = await harness({ ship: SHIP }, { scorers: SCORERS });
    fakeJudge(made.root, 'thorough');
    const start = (flags: string) => `teamai workflow start ship --driver skill ${flags} --inputs '{inputs}'`;
    expect(await made.call({ kind: 'describe', name: 'ship' })).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: {
      text: [
        '- ship needs the inputs ticket (string) and count (number).',
        '- It can run up to 2 steps at once.',
        '- notes is interactive: you work in it here, with this session\'s agent.',
        '- Only you can answer the approval at go-live, from your own terminal or teamai dashboard.',
        '- Optional approval at plan-review: before `node -e "process.exit(0)"`.',
        '- The recommended start lets this session\'s agent answer optional approvals and say why; "answer optional approvals automatically" answers each approval yes.',
        '- It opens a pull request from integrate into main.',
        '- NPM_TOKEN and SLACK_TOKEN have no value on this machine: set them with teamai env set NPM_TOKEN and teamai env set SLACK_TOKEN before the steps that require them run, or those steps fail.',
        '- announce.post needs env SLACK_TOKEN, which a coding session keeps from its agents, and runs under a token budget, which no coding session meters for teamai, so you finish it in your own terminal with teamai workflow resume once the run reaches it.',
        '- announce may spend at most 20000 tokens each time it starts.',
        '- It stops after 2h.',
        '- claude judges integrate here, with one confined judge call per pass.',
        '- The team asks that you agree before it starts.',
        'Start it, and if so, how should it run?',
      ].join('\n'),
      inputs: [{ name: 'ticket', type: { type: 'string' } }, { name: 'count', type: { type: 'number' } }],
      options: [
        { label: 'Recommended: up to 2 steps at once, you decide optional approvals, with judging', start: start('--parallel 2 --confirmed --hitl recommend') },
        { label: 'Same, but ask me at optional approvals', start: start('--parallel 2 --confirmed --hitl person') },
        { label: 'Same, but answer optional approvals automatically', start: start('--parallel 2 --confirmed --auto-approve') },
        { label: 'Same, but one step at a time', start: start('--parallel 1 --confirmed --hitl recommend') },
        { label: 'Same, but without judging', start: start('--parallel 2 --confirmed --hitl recommend --no-judge') },
      ],
    } } } } });
  });

  it('refuses a start without the answers describe asked for, and creates no run', async () => {
    const made = await harness({ ship: SHIP }, { scorers: SCORERS });
    const before = runCount(made);
    expect(await made.call({ kind: 'start', name: 'ship', answers: { confirmed: false }, inputs: undefined }))
      .toMatchObject({ error: { code: 'confirm_needed', next: 'teamai workflow start --describe ship --driver skill' } });
    expect(runCount(made)).toBe(before);
  });

  it('starts a workflow with nothing to ask at once, and gives the facts to tell the person first', async () => {
    const made = await harness({ lint: LINT });
    expect(await made.call({ kind: 'describe', name: 'lint' })).toMatchObject({ data: { describe: { ask: {
      kind: 'start',
      say: [
        '- LINT_TOKEN has no value on this machine: set it with teamai env set LINT_TOKEN before the steps that require it run, or those steps fail.',
        '- It stops after 30m.',
      ].join('\n'),
      start: 'teamai workflow start lint --driver skill',
    } } } });
  });

  it('routes a run whose continue step needs env to the local driver', async () => {
    const made = await harness({ 'release-docs': RELEASE_DOCS });
    expect(await made.call({ kind: 'describe', name: 'release-docs' })).toMatchObject({ data: { describe: {
      workflow: { facts: { localRoute: { opener: 'docs', held: 'docs.sign', missing: 'env' } } },
      ask: { kind: 'local', start: 'teamai workflow start release-docs --driver local --tools default=claude' },
    } } });
    expect(await made.call({ kind: 'start', name: 'release-docs', answers: { confirmed: false }, inputs: undefined }))
      .toMatchObject({ error: { code: 'needs_local_driver', next: null } });
    expect(runCount(made)).toBe(0);
  });

  it('leaves the session tool out of a local start when TEAMAI_AI_TOOL names the tool steps run on', async () => {
    vi.stubEnv('TEAMAI_AI_TOOL', 'codex');
    const made = await harness({ 'release-docs': RELEASE_DOCS });
    expect(await made.call({ kind: 'describe', name: 'release-docs' })).toMatchObject({ data: { describe: {
      ask: { kind: 'local', start: 'teamai workflow start release-docs --driver local' },
    } } });
  });

  it("leaves the session tool out of a local start when the member's ai.tool names the tool steps run on", async () => {
    const made = await harness({ 'release-docs': RELEASE_DOCS }, { aiTool: 'codex' });
    expect(await made.call({ kind: 'describe', name: 'release-docs' })).toMatchObject({ data: { describe: {
      ask: { kind: 'local', start: 'teamai workflow start release-docs --driver local' },
    } } });
  });

  it('keeps the session tool in a local start when TEAMAI_AI_TOOL names a tool that runs no steps', async () => {
    vi.stubEnv('TEAMAI_AI_TOOL', 'pi');
    const made = await harness({ 'release-docs': RELEASE_DOCS });
    expect(await made.call({ kind: 'describe', name: 'release-docs' })).toMatchObject({ data: { describe: {
      ask: { kind: 'local', start: 'teamai workflow start release-docs --driver local --tools default=claude' },
    } } });
  });

  it('names the env keys of a local route as the held step facts do', async () => {
    const made = await harness({ 'release-docs': RELEASE_DOCS.replace('[SIGNING_KEY]', '[SIGNING_KEY, RELEASE_KEY]') });
    expect(await made.call({ kind: 'describe', name: 'release-docs' })).toMatchObject({ data: { describe: { ask: {
      kind: 'local', reason: expect.stringContaining('needs env SIGNING_KEY and RELEASE_KEY, which a coding session keeps from its agents.'),
    } } } });
  });
});

describe('skill driver preflight of optional gates', () => {
  /** A workflow named `gates`, invoke: allow, whose steps are `steps`, with the top-level fields `head` before them. */
  const gates = (steps: string, head = '') => `schemaVersion: v1alpha1\nname: gates\ndescription: Gate some steps\ninvoke: allow\n${head}steps:\n${steps}`;
  const approvalsAnswer = '- The recommended start lets this session\'s agent answer optional approvals and say why; "answer optional approvals automatically" answers each approval yes.';
  const questionOf = async (workflows: Record<string, string>, name = 'gates') => {
    const made = await harness(workflows);
    return made.call({ kind: 'describe', name });
  };

  it('names the command an optional approval comes before: its first line, whitespace collapsed, cut after 80 characters', async () => {
    const long = `teamai contribute --file "$FILE" --title "$TITLE" --namespace "$NS" --session-id "$SESSION"`;
    expect(await questionOf({ gates: gates(`  - id: build
    approve: Build?
    command: |
      npm   run    build
      npm test
  - id: share
    needs: [build]
    approve: Share?
    command: ${long}
`) })).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: { text: [
      '- Optional approval at build: before `npm run build`.',
      '- Optional approval at share: before `teamai contribute --file "$FILE" --title "$TITLE" --namespace "$NS" --session-id…`.',
      approvalsAnswer,
      'How should it run?',
    ].join('\n') } } } } });
  });

  it('says who works the prompt step an optional approval comes before, an interactive one with the person here', async () => {
    expect(await questionOf({ gates: gates(`  - id: draft
    approve: Draft?
    prompt: Draft the notes.
  - id: polish
    needs: [draft]
    approve: Polish?
    interactive: true
    prompt: Polish the notes with the person.
`) })).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: { text: [
      '- polish is interactive: you work in it here, with this session\'s agent.',
      '- Optional approval at draft: before a prompt step, which a child agent works.',
      '- Optional approval at polish: before an interactive step, which you work here with this session\'s agent.',
      approvalsAnswer,
      'How should it run?',
    ].join('\n') } } } } });
  });

  it('names the workflow an optional approval comes before, or says it is inline', async () => {
    const announce = 'schemaVersion: v1alpha1\nname: announce\ndescription: Announce it\nsteps:\n  - id: post\n    command: echo posted\n';
    expect(await questionOf({ announce, gates: gates(`  - id: announce
    approve: Announce?
    workflow: announce
  - id: tidy
    needs: [announce]
    approve: Tidy?
    workflow:
      steps:
        - id: sweep
          command: echo swept
`) })).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: { text: [
      '- Optional approval at announce: before workflow announce.',
      '- Optional approval at tidy: before an inline workflow.',
      approvalsAnswer,
      'How should it run?',
    ].join('\n') } } } } });
  });

  it('names the end an optional approval comes before, and the workflow step it ends inside a nested workflow', async () => {
    expect(await questionOf({ gates: gates(`  - id: wrap
    workflow:
      ends: { wrapped: succeeded }
      steps:
        - id: close
          approve: Close the wrap?
          end: wrapped
  - id: done
    needs: [wrap]
    approve: Close the run?
    end: shipped
`, 'ends: { shipped: succeeded }\n') })).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: { text: [
      '- Optional approval at wrap.close: before wrap ends wrapped.',
      '- Optional approval at done: before the run ends shipped.',
      approvalsAnswer,
      'How should it run?',
    ].join('\n') } } } } });
  });

  it('names the steps that wait for an optional approval with no action, in file order', async () => {
    expect(await questionOf({ gates: gates(`  - id: ship-ok
    approve: Ship it?
  - id: deploy
    needs: [ship-ok]
    command: echo deployed
  - id: notify
    needs: [ship-ok]
    command: echo notified
  - id: wrap-ok
    needs: [deploy, notify]
    approve: Wrap up?
`) })).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: { text: [
      '- It can run up to 2 steps at once.',
      '- Optional approval at ship-ok: no action; deploy and notify wait for it.',
      '- Optional approval at wrap-ok: no action; no step waits for it.',
      approvalsAnswer,
      'How should it run?',
    ].join('\n') } } } } });
  });

  it('names the options of an optional choice and what answering automatically picks, and lets the agent answer choices too', async () => {
    expect(await questionOf({ gates: gates(`  - id: target
    choose: { message: Where?, options: [staging, prod], default: staging }
  - id: region
    needs: [target]
    choose: { message: Which region?, options: [eu, us] }
  - id: ship-ok
    needs: [region]
    approve: Ship it?
    command: echo shipped
`) })).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: { text: [
      '- Optional choice at target: one of staging, prod; "answer automatically" picks staging.',
      '- Optional choice at region: one of eu, us; no default, so "answer automatically" leaves it to you.',
      '- Optional approval at ship-ok: before `echo shipped`.',
      '- The recommended start lets this session\'s agent answer optional approvals and choices and say why; "answer optional approvals and choices automatically" answers each approval yes and each choice with its default, if it has one.',
      'How should it run?',
    ].join('\n') } } } } });
  });

  it('says an optional approval comes before a step that then opens a pull request', async () => {
    expect(await questionOf({ gates: gates(`  - id: integrate
    approve: Integrate?
    workspace: new
    deliver: pr
    prompt: Integrate the change.
`) })).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: { text: expect.stringContaining(
      '- Optional approval at integrate: before a prompt step, which a child agent works, then opens a pull request.\n',
    ) } } } } });
  });

  it('names each optional gate inside a workflow a for_each step runs by its path', async () => {
    expect(await questionOf({ gates: gates(`  - id: each
    for_each: { items: inputs.items, max_parallel: 1 }
    workflow:
      steps:
        - id: check
          approve: Check it?
          command: echo "$ITEM"
          env: { ITEM: "{{ item }}" }
        - id: tag
          needs: [check]
          command: echo tagged
`, 'inputs: { items: [string] }\n') })).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: { text: [
      '- gates needs the input items (list of string).',
      '- Optional approval at each.check: before `echo "$ITEM"`.',
      approvalsAnswer,
      'How should it run?',
    ].join('\n') } } } } });
  });

  it('names the contribute command session-close asks to share a learning before', async () => {
    expect(await questionOf({ 'session-close': SESSION_CLOSE }, 'session-close')).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: { text: expect.stringContaining([
      '- Only you can answer the approval at publish, from your own terminal or teamai dashboard.',
      '- Optional approval at contribute: before `teamai contribute --file "$FILE" --title "$TITLE" --namespace "$NS" --session-id…`.',
      approvalsAnswer,
      '- The team asks that you agree before it starts.',
    ].join('\n')) } } } } });
  });
});

describe('skill driver preflight in an unattended run', () => {
  const unattended = { mode: 'unattended' } as const;
  const needsPerson = (name: string, needs: string) => `Workflow ${name} needs a person, and this run is unattended (TEAMAI_MODE or CI says so): ${needs}. Start it from a session a person attends, or set TEAMAI_MODE=attended where one does.`;

  it('starts a workflow with nothing to ask with --auto-approve, asking nothing', async () => {
    const made = await harness({ lint: LINT });
    const answer = await made.call({ kind: 'describe', name: 'lint' }, unattended);
    expect(answer).toMatchObject({ data: { describe: { ask: { kind: 'start', start: 'teamai workflow start lint --driver skill --auto-approve' } } } });
    expect(answer).not.toMatchObject({ data: { describe: { ask: { question: expect.anything() } } } });
  });

  it('answers the start of the recommended option, with optional gates auto-approved', async () => {
    const made = await harness({ wide: WIDE });
    expect(await made.call({ kind: 'describe', name: 'wide' })).toMatchObject({ data: { describe: { ask: { kind: 'ask' } } } });
    expect(await made.call({ kind: 'describe', name: 'wide' }, unattended)).toMatchObject({ data: { describe: { ask: {
      kind: 'start',
      say: [
        '- It can run up to 2 steps at once.',
        '- Optional approval at review: before `node -e "process.exit(0)"`.',
        '- It answers optional approvals automatically: each approval yes.',
      ].join('\n'),
      start: 'teamai workflow start wide --driver skill --parallel 2 --auto-approve',
    } } } });
  });

  it.each([
    ['a required approval', 'deploy', { deploy: DEPLOY }, 'only a person can answer the approval at go-live'],
    ['an interactive step', 'draft', { draft: DRAFT }, 'write is interactive, worked with a person'],
    ['invoke: ask', 'gated', { gated: GATED }, 'the team asks that a person agree before it starts (invoke: ask)'],
    ['a choice without a default', 'pick', { pick: PICK }, 'the choice at target has no default, so --auto-approve leaves it to a person'],
  ])('denies a workflow with %s, naming what needs the person', async (_case, name, workflows, needs) => {
    const made = await harness(workflows);
    expect(await made.call({ kind: 'describe', name }, unattended)).toEqual({ data: { describe: expect.objectContaining({
      ask: { kind: 'denied', reason: needsPerson(name, needs) },
    }) } });
  });

  it('keeps the {inputs} slot for the agent to fill from its task, and lists the inputs', async () => {
    const made = await harness({ greet: GREET });
    expect(await made.call({ kind: 'describe', name: 'greet' }, unattended)).toMatchObject({ data: { describe: { ask: {
      kind: 'start', start: "teamai workflow start greet --driver skill --auto-approve --inputs '{inputs}'", inputs: [{ name: 'who', type: { type: 'string' } }],
    } } } });
  });
});
