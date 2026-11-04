import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveWorkflowEnv } from '../env-resolution.js';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';
import { formatDiagnostic, parseWorkflow } from '../workflow/parse.js';
import { inProcessClient, type WorkflowClient } from '../workflow/protocol.js';
import { RunIdSchema, withRunLock, type RunId } from '../workflow/store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' });
}

/** A self-mode team whose checkout holds `workflows`, and the client a driver of it calls. */
async function fixture(workflows: Record<string, string>): Promise<{ config: LocalConfig; checkout: string; client: WorkflowClient }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-answer-')); dirs.push(root);
  const checkout = path.join(root, 'work');
  fs.mkdirSync(path.join(checkout, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(checkout, 'docs', 'guide.md'), 'guide\n');
  git(checkout, 'init', '-q', '-b', 'main'); git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(root, 'knowledge', 'workflows'), { recursive: true });
  for (const [name, yaml] of Object.entries(workflows)) fs.writeFileSync(path.join(root, 'knowledge', 'workflows', `${name}.yaml`), yaml);
  const config: LocalConfig = { repo: { kind: 'self', localPath: path.join(root, 'knowledge'), remote: 'local' }, username: 'test', scope: 'project', additionalRoles: [], projectRoot: checkout, dataHome: path.join(root, 'data') };
  await syncScorersThenWorkflows(config);

  return { config, checkout, client: inProcessClient({ config, env: await resolveWorkflowEnv(config) }) };
}

const driver = { kind: 'ide', machine: 'test', workspace: '/work', can: { hitl: false, workspace: ['read-only', 'new', 'continue'] } };

const LeaseSchema = z.object({ attempt: z.string(), revision: z.number() }).passthrough();

async function started(client: WorkflowClient, name: string, checkout: string, inputs?: Record<string, unknown>): Promise<RunId> {
  const answer = await client.start(name, { inputs, checkout, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' }, startedBy: 'person' });

  if (!('data' in answer)) throw new Error(JSON.stringify(answer));

  return RunIdSchema.parse(answer.data.run);
}

async function nextLease(client: WorkflowClient, run: RunId): Promise<z.infer<typeof LeaseSchema>> {
  const next = await client.next(run, { driver });

  if (!('data' in next) || !('lease' in next.data)) throw new Error(JSON.stringify(next));

  return LeaseSchema.parse(next.data.lease);
}

const FILE = 'workflows/ask.yaml';

function diagnostics(steps: string): string[] {
  const parsed = parseWorkflow(FILE, `schemaVersion: v1alpha1\nname: ask\ndescription: Ask.\nsteps:\n${steps}`);

  return parsed.ok ? [] : parsed.diagnostics.map(formatDiagnostic);
}

describe('answer steps at pull', () => {
  it('reads an answer step: its prompt template, its output and its timeout', () => {
    const parsed = parseWorkflow(FILE, `schemaVersion: v1alpha1
name: ask
description: Ask.
inputs: { learning: string }
steps:
  - id: category
    answer: "Is this learning a skill, a rule or a doc? {{ inputs.learning }}"
    output: { category: skill | rule | doc, reason: string }
    timeout: 30s
`);

    expect(parsed.ok && parsed.definition.steps).toEqual([{
      id: 'category',
      answer: 'Is this learning a skill, a rule or a doc? {{ inputs.learning }}',
      output: { type: 'object', fields: { category: { type: 'enum', values: ['skill', 'rule', 'doc'] }, reason: { type: 'string' } } },
      timeout: 30_000,
    }]);
  });

  it('rejects an answer with another action, with no output, or with a key that names a tool, a place or a session', () => {
    expect(diagnostics(`  - id: both
    answer: Pick one.
    prompt: Pick one.
    output: { text: string }
  - id: bare
    needs: []
    answer: Say hello.
  - id: placed
    needs: []
    answer: Say hello.
    output: { text: string }
    workspace: new
    tool: claude
    session: continue
`)).toEqual([
      'workflows/ask.yaml:5: field "steps[0]": a step has exactly one action: command, prompt, prompt_file, answer, or workflow',
      'workflows/ask.yaml:11: field "steps[1].output": step "bare" answer needs output: { text: string } to take the reply as text, or the fields of the JSON object the reply holds',
      'workflows/ask.yaml:16: field "steps[2].workspace": step "placed" answer takes no workspace: the member\'s AI tool answers its prompt with text, in no workspace',
      'workflows/ask.yaml:17: field "steps[2].tool": step "placed" answer takes no tool: the member\'s AI tool answers its prompt with text, in no workspace',
      'workflows/ask.yaml:18: field "steps[2].session": step "placed" answer takes no session: the member\'s AI tool answers its prompt with text, in no workspace',
    ]);
  });
});

describe('writes at pull', () => {
  it('reads the paths a command step writes, templates of its inputs included', () => {
    const parsed = parseWorkflow(FILE, `schemaVersion: v1alpha1
name: ask
description: Ask.
inputs: { category: string }
steps:
  - id: publish
    command: teamai recall promote publish
    writes: ["skills/", "{{ inputs.category }}/"]
`);

    expect(parsed.ok && parsed.definition.steps).toEqual([{ id: 'publish', command: 'teamai recall promote publish', writes: ['skills/', '{{ inputs.category }}/'] }]);
  });

  it('rejects writes on a step that runs no command, a path outside the checkout, and a template that reads a step', () => {
    expect(diagnostics(`  - id: list
    command: echo '{}'
    output: { dir: string }
  - id: ask
    needs: []
    prompt: Edit the docs.
    writes: [docs/]
  - id: wide
    needs: [list]
    command: teamai recall maintenance write-draft
    writes: [/etc, ../outside, "", docs/../../up, "{{ steps.list.outputs.dir }}"]
  - id: single
    needs: []
    command: echo
    writes: docs/
`)).toEqual([
      'workflows/ask.yaml:11: field "steps[1].writes": step "ask" writes is only allowed on a command step',
      'workflows/ask.yaml:15: field "steps[2].writes[0]": step "wide" writes must list paths relative to the checkout, such as docs/, none absolute and none leaving it',
      'workflows/ask.yaml:15: field "steps[2].writes[1]": step "wide" writes must list paths relative to the checkout, such as docs/, none absolute and none leaving it',
      'workflows/ask.yaml:15: field "steps[2].writes[2]": step "wide" writes must list paths relative to the checkout, such as docs/, none absolute and none leaving it',
      'workflows/ask.yaml:15: field "steps[2].writes[3]": step "wide" writes must list paths relative to the checkout, such as docs/, none absolute and none leaving it',
      'workflows/ask.yaml:15: field "steps[2].writes[4]": step "wide" writes template {{ steps.list.outputs.dir }}: a writes template reads only inputs',
      'workflows/ask.yaml:19: field "steps[3].writes": step "single" writes must be a list of paths, such as [docs/]',
    ]);
  });
});

const CATEGORY = `schemaVersion: v1alpha1
name: category
description: Pick a category in a copy.
workspace: new
inputs: { learning: string }
steps:
  - id: category
    answer: "Is this learning a skill, a rule or a doc? {{ inputs.learning }}"
    output: { category: skill | rule | doc }
    timeout: 30s
outputs: { category: steps.category.outputs.category }
`;

describe('answer leases', () => {
  it('leases an answer with its prompt rendered and no place, even in a workflow that works in a copy, and takes its JSON', async () => {
    const { config, checkout, client } = await fixture({ category: CATEGORY });
    const run = await started(client, 'category', checkout, { learning: 'Retry with backoff.' });
    const lease = await nextLease(client, run);

    expect(lease).toMatchObject({ step: 'category', prompt: 'Is this learning a skill, a rule or a doc? Retry with backoff.', answer: true, output: { type: 'object' } });
    expect(lease).not.toHaveProperty('workspace');
    expect(lease).not.toHaveProperty('session');

    const reported = await withRunLock(config, run, async (lock) => {
      expect(await client.prepare(lock, lease)).toEqual({ kind: 'prepared', dir: checkout });
      fs.writeFileSync(path.join(checkout, 'README.md'), 'changed while it answered\n');

      return client.report(run, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, outputs: { category: 'rule' } }, { lock });
    }, { waitMs: 0 });

    expect(reported).toMatchObject({ data: { step: { id: 'category', status: 'succeeded' } } });
    expect(await client.next(run, { driver })).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { category: 'rule' } } } });
  });
});

const DRAFT = `schemaVersion: v1alpha1
name: draft
description: Write a draft beside a doc.
inputs: { area: string }
steps:
  - id: write
    command: node -e "process.exit(0)"
    writes: ["{{ inputs.area }}/"]
`;

describe('writes in the checkout', () => {
  it('keeps a change under the paths a command writes, rendered from its inputs, and fails one outside them read_only_dirty', async () => {
    const { config, checkout, client } = await fixture({ draft: DRAFT });
    const report = async (change: (dir: string) => void): Promise<unknown> => {
      const run = await started(client, 'draft', checkout, { area: 'docs' });
      const lease = await nextLease(client, run);
      expect(lease).toMatchObject({ writes: ['docs/'] });

      return withRunLock(config, run, async (lock) => {
        await client.prepare(lock, lease);
        change(checkout);

        return client.report(run, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver }, { lock });
      }, { waitMs: 0 });
    };

    expect(await report((dir) => fs.writeFileSync(path.join(dir, 'docs', 'guide.md.draft.md'), 'draft\n'))).toMatchObject({ data: { step: { id: 'write', status: 'succeeded' } } });
    expect(await report((dir) => fs.writeFileSync(path.join(dir, 'README.md'), 'changed\n'))).toMatchObject({
      data: { step: { id: 'write', status: 'failed' } },
    });
  });

  it('fails a step whose writes renders a path outside the checkout before it runs', async () => {
    const { checkout, client } = await fixture({ draft: DRAFT });
    const run = await started(client, 'draft', checkout, { area: '../elsewhere' });

    expect(await client.next(run, { driver })).toMatchObject({ data: { done: { outcome: 'failed' } } });
  });
});

describe('progress lines', () => {
  it('keeps the progress lines a report sends and answers them with the run\'s end', async () => {
    const { checkout, client } = await fixture({ draft: DRAFT });
    const run = await started(client, 'draft', checkout, { area: 'docs' });
    const lease = await nextLease(client, run);
    await client.report(run, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, progress: ['Found 2 entries.', 'Generating drafts...'] });

    expect(await client.next(run, { driver })).toMatchObject({ data: { done: { outcome: 'succeeded', progress: [{ step: 'write', lines: ['Found 2 entries.', 'Generating drafts...'] }] } } });
  });
});
