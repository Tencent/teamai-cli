import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { listCachedWorkflows, loadCachedWorkflow, loadWorkflowTree } from '../workflow/cache.js';
import { renderWorkflowSkill } from '../workflow/discovery/render.js';
import { startRun } from '../workflow/engine.js';
import { formatDiagnostic } from '../workflow/parse.js';
import { buildStartRecord } from '../workflow/records.js';
import { readRun } from '../workflow/store.js';
import { knownSecrets } from '../env-resolution.js';

/** The version in the package manifest, which a default run records. */
const PACKAGE_VERSION: string = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')).version;

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function testConfig(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-default-workflows-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  return {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: root,
    dataHome: path.join(root, 'data'),
  };
}

function writeWorkflow(config: LocalConfig, name: string, body: string): void {
  fs.writeFileSync(path.join(config.repo.localPath, 'workflows', `${name}.yaml`), body);
}

const workflow = (name: string) => `schemaVersion: v1alpha1
name: ${name}
description: Compile the project.
steps:
  - id: compile
    command: node compile.js
`;

const sources = async (config: LocalConfig) => (await listCachedWorkflows(config)).map(({ definition, source }) => [definition.name, source]);

describe('default workflows', () => {
  it('resolve teamai-share-session and teamai-share-learnings to the teamai defaults until the team adds a file of that name', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', workflow('build'));
    await syncScorersThenWorkflows(config);

    const shipped = await loadCachedWorkflow(config, 'teamai-share-session');
    expect(shipped).toMatchObject({ source: 'default', relativePath: 'workflows/teamai-share-session.yaml', definition: { name: 'teamai-share-session', invoke: 'ask' } });
    expect(shipped?.teamRevision).toBeUndefined();
    expect(await sources(config)).toEqual([['build', 'team'], ['teamai-benchmark', 'default'], ['teamai-ci-extract-mr', 'default'], ['teamai-codebase-deep-enrich', 'default'], ['teamai-codebase-enrich', 'default'], ['teamai-draft-learning-updates', 'default'], ['teamai-finished-sessions', 'default'], ['teamai-import-from-iwiki', 'default'], ['teamai-import-from-mr', 'default'], ['teamai-import-from-repo', 'default'], ['teamai-import-learnings', 'default'], ['teamai-import-rules', 'default'], ['teamai-new-scorer', 'default'], ['teamai-promote-learning', 'default'], ['teamai-score', 'default'], ['teamai-self-improvement', 'default'], ['teamai-session-to-task', 'default'], ['teamai-share-learnings', 'default'], ['teamai-share-learnings-from-sessions', 'default'], ['teamai-share-session', 'default'], ['teamai-try-scorer', 'default']]);
    expect(await loadCachedWorkflow(config, 'session-close')).toBeNull();

    writeWorkflow(config, 'teamai-share-session', workflow('teamai-share-session'));
    await syncScorersThenWorkflows(config);

    expect(await loadCachedWorkflow(config, 'teamai-share-session')).toMatchObject({ source: 'team', definition: { steps: [{ command: 'node compile.js' }] } });
    expect(await sources(config)).toEqual([['build', 'team'], ['teamai-benchmark', 'default'], ['teamai-ci-extract-mr', 'default'], ['teamai-codebase-deep-enrich', 'default'], ['teamai-codebase-enrich', 'default'], ['teamai-draft-learning-updates', 'default'], ['teamai-finished-sessions', 'default'], ['teamai-import-from-iwiki', 'default'], ['teamai-import-from-mr', 'default'], ['teamai-import-from-repo', 'default'], ['teamai-import-learnings', 'default'], ['teamai-import-rules', 'default'], ['teamai-new-scorer', 'default'], ['teamai-promote-learning', 'default'], ['teamai-score', 'default'], ['teamai-self-improvement', 'default'], ['teamai-session-to-task', 'default'], ['teamai-share-learnings', 'default'], ['teamai-share-learnings-from-sessions', 'default'], ['teamai-share-session', 'team'], ['teamai-try-scorer', 'default']]);
  });

  it('resolve teamai-session-to-task to the teamai default, interactive and asked before it starts, until the team adds a file of that name', async () => {
    const config = testConfig();
    await syncScorersThenWorkflows(config);

    expect(await loadCachedWorkflow(config, 'teamai-session-to-task')).toMatchObject({
      source: 'default',
      definition: {
        invoke: 'ask',
        steps: [
          { id: 'draft', interactive: true, output: { type: 'object', fields: { verdict: { type: 'enum', values: ['draft', 'skip'] }, file: { type: 'string' }, id: { type: 'string' } } } },
          { id: 'check', if: "steps.draft.outputs.verdict == 'draft'" },
          { id: 'propose', if: "steps.draft.outputs.verdict == 'draft'", hitl: { kind: 'approve', required: false }, workspace: { team: { branch: 'teamai/session-to-task/{{ inputs.suite }}/{{ steps.draft.outputs.id }}' } }, deliver: 'pr' },
        ],
      },
    });

    writeWorkflow(config, 'teamai-session-to-task', workflow('teamai-session-to-task'));
    await syncScorersThenWorkflows(config);

    expect(await loadCachedWorkflow(config, 'teamai-session-to-task')).toMatchObject({ source: 'team', definition: { steps: [{ command: 'node compile.js' }] } });
  });

  it('share several learnings with one approval, then share the session with teamai-share-session', async () => {
    const config = testConfig();
    await syncScorersThenWorkflows(config);

    const learnings = await loadCachedWorkflow(config, 'teamai-share-learnings');
    if (!learnings) throw new Error('teamai-share-learnings is not runnable');
    expect(learnings.definition.steps.find(({ id }) => id === 'learning')?.output).toEqual({
      type: 'object',
      fields: { learnings: { type: 'array', items: { type: 'object', fields: { title: { type: 'string' }, file: { type: 'string' }, namespace: { type: 'string' } } } } },
    });
    const tree = await loadWorkflowTree(config, learnings);
    expect('failed' in tree ? tree.failed : Object.keys(tree.workflows)).toEqual(['teamai-share-session', 'teamai-score']);
  });

  it('ask about each finished session to share learnings from, then run teamai-share-learnings on each picked one', async () => {
    const config = testConfig();
    await syncScorersThenWorkflows(config);

    const fromSessions = await loadCachedWorkflow(config, 'teamai-share-learnings-from-sessions');
    if (!fromSessions) throw new Error('teamai-share-learnings-from-sessions is not runnable');
    expect(fromSessions.definition).toMatchObject({ invoke: 'ask', steps: [{ id: 'sessions', command: 'teamai session list --finished --all --within "$WITHIN" --json', env: { WITHIN: '{{ inputs.within }}' } }, { id: 'pick' }, { id: 'share' }] });
    const tree = await loadWorkflowTree(config, fromSessions);
    expect('failed' in tree ? tree.failed : Object.keys(tree.workflows)).toEqual(['teamai-share-learnings', 'teamai-share-session', 'teamai-score']);
  });

  it('keep the whole description of each one an agent may start in the skill teamai pull generates for it', async () => {
    const config = testConfig();
    await syncScorersThenWorkflows(config);
    const advertised = (await listCachedWorkflows(config)).flatMap(({ definition: { name, alias, description, invoke } }) => (invoke === 'ask' || invoke === 'allow' ? [{ name, alias, description, invoke }] : []));

    expect(advertised.map(({ name }) => name)).toContain('teamai-import-from-mr');
    for (const { name, alias, description, invoke } of advertised) {
      const skill = renderWorkflowSkill({ name, alias, description, invoke, source: 'default', skill: name }, 'claude');
      const kept = JSON.parse(skill.split('\n').find((line) => line.startsWith('description: '))?.slice('description: '.length) ?? '""');

      expect(kept, `${name}: shorten its description so the generated skill keeps all of it`).toContain(description.replace(/\s+/g, ' ').trim().replace(/\.$/, ''));
    }
  });

  it('are never written to the workflow cache', async () => {
    const config = testConfig();
    await syncScorersThenWorkflows(config);
    await loadCachedWorkflow(config, 'teamai-share-session');

    const home = config.dataHome ?? '';
    expect(fs.existsSync(home) ? fs.readdirSync(home, { recursive: true }).map(String).filter((file) => file.includes('teamai-share')) : []).toEqual([]);
  });

  it('refuse to start teamai-share-learnings while the team\'s teamai-share-session does not take the inputs it passes', async () => {
    const config = testConfig();
    writeWorkflow(config, 'teamai-share-session', `schemaVersion: v1alpha1
name: teamai-share-session
alias: wrap-up
description: Publish this session our way.
inputs: { session: string, source: string }
steps:
  - id: note
    command: echo wrapped
`);
    const warn = vi.spyOn(log, 'warn');
    await syncScorersThenWorkflows(config);

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[workflows] teamai\'s default teamai-finished-sessions cannot start: step "share" with.publish is not an input workflow "teamai-share-session" declares',
      '[workflows] teamai\'s default teamai-finished-sessions cannot start: step "share" with.scorers is not an input workflow "teamai-share-session" declares',
      '[workflows] teamai\'s default teamai-finished-sessions cannot start: step "share" with.demand is not an input workflow "teamai-share-session" declares',
      '[workflows] teamai\'s default teamai-share-learnings cannot start: step "share-session" with.publish is not an input workflow "teamai-share-session" declares',
      '[workflows] teamai\'s default teamai-share-learnings cannot start: step "share-session" with.scorers is not an input workflow "teamai-share-session" declares',
      '[workflows] teamai\'s default teamai-share-learnings cannot start: step "share-session" with.demand is not an input workflow "teamai-share-session" declares',
    ]);
    const started = await startRun(config, 'teamai-share-learnings', { session: 's1', source: 'claude', publish: false, scorers: [] }, { secrets: await knownSecrets(config) });

    expect(started).toMatchObject({ error: {
      code: 'invalid_inputs',
      message: 'Workflow "teamai-share-learnings" step "share-session" passes publish, scorers, demand to workflow "teamai-share-session", which does not declare them. Make the two agree, then pull again.',
    } });
  });

  it('warn at pull while a team workflow whose alias replaces teamai-share-session does not take the inputs teamai-share-learnings passes it', async () => {
    const config = testConfig();
    writeWorkflow(config, 'wrap-up', `schemaVersion: v1alpha1
name: wrap-up
alias: teamai-share-session
description: Publish this session our way.
inputs: { session: string, source: string }
steps:
  - id: note
    command: echo wrapped
`);
    const warn = vi.spyOn(log, 'warn');
    await syncScorersThenWorkflows(config);

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[workflows] teamai\'s default teamai-finished-sessions cannot start: step "share" with.publish is not an input workflow "teamai-share-session" declares',
      '[workflows] teamai\'s default teamai-finished-sessions cannot start: step "share" with.scorers is not an input workflow "teamai-share-session" declares',
      '[workflows] teamai\'s default teamai-finished-sessions cannot start: step "share" with.demand is not an input workflow "teamai-share-session" declares',
      '[workflows] teamai\'s default teamai-share-learnings cannot start: step "share-session" with.publish is not an input workflow "teamai-share-session" declares',
      '[workflows] teamai\'s default teamai-share-learnings cannot start: step "share-session" with.scorers is not an input workflow "teamai-share-session" declares',
      '[workflows] teamai\'s default teamai-share-learnings cannot start: step "share-session" with.demand is not an input workflow "teamai-share-session" declares',
    ]);
  });

  it('warn at pull, and refuse to start teamai-share-learnings, while the team\'s teamai-share-session takes one of its inputs as another type', async () => {
    const config = testConfig();
    writeWorkflow(config, 'wrap-up', `schemaVersion: v1alpha1
name: wrap-up
alias: teamai-share-session
description: Publish this session our way.
inputs: { session: string, source: string, publish: string, scorers: [string], demand: auto | named }
steps:
  - id: note
    command: echo wrapped
`);
    const warn = vi.spyOn(log, 'warn');
    await syncScorersThenWorkflows(config);

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[workflows] teamai\'s default teamai-finished-sessions cannot start: step "share" passes publish, which workflow "wrap-up" declares as another type than teamai\'s default teamai-share-session',
      '[workflows] teamai\'s default teamai-share-learnings cannot start: step "share-session" passes publish, which workflow "wrap-up" declares as another type than teamai\'s default teamai-share-session',
    ]);
    const started = await startRun(config, 'teamai-share-learnings', { session: 's1', source: 'claude', publish: false, scorers: [] }, { secrets: await knownSecrets(config) });
    expect(started).toMatchObject({ error: {
      code: 'invalid_inputs',
      message: 'Workflow "teamai-share-learnings" step "share-session" passes publish, which workflow "wrap-up" declares as another type than teamai\'s default teamai-share-session. Make the two agree, then pull again.',
    } });
  });

  it('start teamai-share-learnings with a team teamai-share-session that lists demand\'s values in another order', async () => {
    const config = testConfig();
    writeWorkflow(config, 'teamai-share-session', `schemaVersion: v1alpha1
name: teamai-share-session
description: Publish this session our way.
inputs: { session: string, source: string, publish: boolean, scorers: [string], demand: named | auto }
steps:
  - id: note
    command: echo wrapped
`);
    const warn = vi.spyOn(log, 'warn');
    await syncScorersThenWorkflows(config);

    expect(warn).not.toHaveBeenCalled();
    const started = await startRun(config, 'teamai-share-learnings', { session: 's1', source: 'claude', publish: false, scorers: [] }, { secrets: await knownSecrets(config) });
    expect(started).toMatchObject({ data: { run: expect.any(String) } });
  });

  it('warn at pull while the team\'s teamai-share-session repeats one of demand\'s values in place of another', async () => {
    const config = testConfig();
    writeWorkflow(config, 'teamai-share-session', `schemaVersion: v1alpha1
name: teamai-share-session
description: Publish this session our way.
inputs: { session: string, source: string, publish: boolean, scorers: [string], demand: auto | auto }
steps:
  - id: note
    command: echo wrapped
`);
    const warn = vi.spyOn(log, 'warn');
    await syncScorersThenWorkflows(config);

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[workflows] teamai\'s default teamai-finished-sessions cannot start: step "share" passes demand, which workflow "teamai-share-session" declares as another type than teamai\'s default teamai-share-session',
      '[workflows] teamai\'s default teamai-share-learnings cannot start: step "share-session" passes demand, which workflow "teamai-share-session" declares as another type than teamai\'s default teamai-share-session',
    ]);
  });

  it('run as a sub-workflow of a team workflow', async () => {
    const config = testConfig();
    writeWorkflow(config, 'wrap-up', `schemaVersion: v1alpha1
name: wrap-up
description: Run the checks, then share the session.
inputs: { session: string, source: string, publish: boolean, scorers: [string] }
steps:
  - id: share
    workflow: teamai-share-session
    with: { session: "{{ inputs.session }}", source: "{{ inputs.source }}", publish: "{{ inputs.publish }}", scorers: "{{ inputs.scorers }}", demand: named }
`);

    const result = await syncScorersThenWorkflows(config);

    expect(result.cached).toEqual(['wrap-up']);
    const wrap = await loadCachedWorkflow(config, 'wrap-up');
    if (!wrap) throw new Error('wrap-up is not runnable');
    const tree = await loadWorkflowTree(config, wrap);
    expect('failed' in tree ? tree.failed : Object.keys(tree.workflows)).toEqual(['teamai-share-session', 'teamai-score']);
  });

  it('refuse at pull a team workflow that runs teamai-share-session without demand, and name the values it takes', async () => {
    const config = testConfig();
    writeWorkflow(config, 'wrap-up', `schemaVersion: v1alpha1
name: wrap-up
description: Run the checks, then share the session.
inputs: { session: string, source: string, publish: boolean, scorers: [string] }
steps:
  - id: share
    workflow: teamai-share-session
    with: { session: "{{ inputs.session }}", source: "{{ inputs.source }}", publish: "{{ inputs.publish }}", scorers: "{{ inputs.scorers }}" }
`);

    const result = await syncScorersThenWorkflows(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/wrap-up.yaml:8: field "steps[0].with": step "share" with does not pass input "demand", which workflow "teamai-share-session" declares as auto | named',
    ]);
  });

  it('record on the run and its start record that it ran teamai\'s default at this version, and a team run that it ran the team\'s', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', workflow('build'));
    await syncScorersThenWorkflows(config);
    const secrets = await knownSecrets(config);
    const runOf = async (name: string, inputs: unknown) => {
      const started = await startRun(config, name, inputs, { secrets });
      if ('error' in started) throw new Error(started.error.message);
      const run = await readRun(config, String(started.data.run));
      if (typeof run !== 'object') throw new Error('the run was not stored');
      return run;
    };

    const shared = await runOf('teamai-share-session', { session: 's1', source: 'claude', publish: false, scorers: [], demand: 'named' });
    const built = await runOf('build', {});

    expect(shared).toMatchObject({ origin: { source: 'default', teamaiVersion: PACKAGE_VERSION } });
    expect(shared).not.toHaveProperty('teamRevision');
    expect(buildStartRecord(shared, undefined, 'tester')).toMatchObject({ origin: { source: 'default', teamaiVersion: PACKAGE_VERSION } });
    expect(built.origin).toEqual({ source: 'team' });
    expect(buildStartRecord(built, undefined, 'tester').origin).toEqual({ source: 'team' });
  });

  it('stay in effect while a team override was never valid', async () => {
    const config = testConfig();
    writeWorkflow(config, 'teamai-share-session', 'schemaVersion: v1alpha1\nname: teamai-share-session\ndescription: x\nsteps: []\n');

    const warn = vi.spyOn(log, 'warn');

    const result = await syncScorersThenWorkflows(config);

    expect(result.unrunnable).toEqual(['workflows/teamai-share-session.yaml']);
    expect(warn).toHaveBeenCalledWith('[workflows] workflows/teamai-share-session.yaml has no runnable version, so teamai\'s default teamai-share-session stays in effect');
    expect(await loadCachedWorkflow(config, 'teamai-share-session')).toMatchObject({ source: 'default' });
  });
});
