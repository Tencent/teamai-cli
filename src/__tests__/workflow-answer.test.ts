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
import { commandEnd, inProcessClient, type WorkflowClient } from '../workflow/protocol.js';
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

  it('reads workspace: new on an answer, so it answers in a worktree of its own', () => {
    const parsed = parseWorkflow(FILE, `schemaVersion: v1alpha1
name: ask
description: Ask.
steps:
  - id: color
    answer: Name one color.
    output: { text: string }
    workspace: new
`);

    expect(parsed.ok && parsed.definition.steps).toEqual([{ id: 'color', answer: 'Name one color.', output: { type: 'object', fields: { text: { type: 'string' } } }, workspace: 'new' }]);
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
    workspace: continue
    tool: claude
    session: continue
`)).toEqual([
      'workflows/ask.yaml:5: field "steps[0]": a step has exactly one action: command, prompt, prompt_file, answer, or workflow',
      'workflows/ask.yaml:11: field "steps[1].output": step "bare" answer needs output: { text: string } to take the reply as text, or the fields of the JSON object the reply holds',
      'workflows/ask.yaml:17: field "steps[2].tool": step "placed" answer takes no tool: the member\'s AI tool answers its prompt with text, in the checkout read-only',
      'workflows/ask.yaml:18: field "steps[2].session": step "placed" answer takes no session: the member\'s AI tool answers its prompt with text, in the checkout read-only',
      'workflows/ask.yaml:16: field "steps[2].workspace": step "placed" answer takes workspace only as new: a worktree of its own, which it reads and leaves as it found it',
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
    command: teamai recall maintenance promote-publish
    writes: ["skills/", "{{ inputs.category }}/"]
`);

    expect(parsed.ok && parsed.definition.steps).toEqual([{ id: 'publish', command: 'teamai recall maintenance promote-publish', writes: ['skills/', '{{ inputs.category }}/'] }]);
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
      'workflows/ask.yaml:15: field "steps[2].writes[0]": step "wide" writes must list paths relative to the checkout, such as docs/, none absolute and none leaving it; name a directory elsewhere with an input, such as "{{ inputs.dir }}"',
      'workflows/ask.yaml:15: field "steps[2].writes[1]": step "wide" writes must list paths relative to the checkout, such as docs/, none absolute and none leaving it; name a directory elsewhere with an input, such as "{{ inputs.dir }}"',
      'workflows/ask.yaml:15: field "steps[2].writes[2]": step "wide" writes must list paths relative to the checkout, such as docs/, none absolute and none leaving it; name a directory elsewhere with an input, such as "{{ inputs.dir }}"',
      'workflows/ask.yaml:15: field "steps[2].writes[3]": step "wide" writes must list paths relative to the checkout, such as docs/, none absolute and none leaving it; name a directory elsewhere with an input, such as "{{ inputs.dir }}"',
      'workflows/ask.yaml:15: field "steps[2].writes[4]": step "wide" writes template {{ steps.list.outputs.dir }}: a writes template reads only inputs',
      'workflows/ask.yaml:19: field "steps[3].writes": step "single" writes must be a list of paths, such as [docs/]',
    ]);
  });
});

describe('steps.<id>.failure at pull', () => {
  it('reads why a step failed in an if and in a template', () => {
    expect(diagnostics(`  - id: content
    answer: Rewrite it.
    output: { text: string }
    continue_on_failure: true
  - id: fallback
    needs: [content]
    if: steps.content.outcome == 'failed' && steps.content.failure.code != 'tool_unconfigured'
    command: echo "$WHY"
    env: { WHY: "{{ steps.content.failure.message }}" }
`)).toEqual([]);
  });

  it('rejects it where outcome is rejected, and a field a failure does not have', () => {
    expect(diagnostics(`  - id: content
    answer: Rewrite it.
    output: { text: string }
    continue_on_failure: true
  - id: model
    needs: [content]
    prompt: Rewrite it again.
    model: "{{ steps.content.failure.code }}"
  - id: write
    needs: [content]
    command: echo
    writes: ["{{ steps.content.failure.code }}/"]
  - id: reason
    needs: [content]
    if: steps.content.failure.reason == 'x' || steps.content.failure[0] == 'x'
    command: echo
`)).toEqual([
      'workflows/ask.yaml:12: field "steps[1].model": step "model" model template {{ steps.content.failure.code }}: a model template reads only inputs, item and the outputs of steps the step needs',
      'workflows/ask.yaml:16: field "steps[2].writes[0]": step "write" writes template {{ steps.content.failure.code }}: a writes template reads only inputs',
      'workflows/ask.yaml:19: field "steps[3].if": step "reason" if reads steps.content.failure.reason, which is not in a failure: code, message',
      'workflows/ask.yaml:19: field "steps[3].if": step "reason" if reads steps.content.failure[0], which is not in a failure: code, message',
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
  it('checks an answer in the checkout even when its workflow works in a copy', async () => {
    const { config, checkout, client } = await fixture({ category: CATEGORY });
    const run = await started(client, 'category', checkout, { learning: 'Retry with backoff.' });
    const lease = await nextLease(client, run);

    expect(lease).toMatchObject({ step: 'category', prompt: 'Is this learning a skill, a rule or a doc? Retry with backoff.', answer: true, output: { type: 'object' } });
    expect(lease).not.toHaveProperty('workspace');
    expect(lease).not.toHaveProperty('session');

    const reported = await withRunLock(config, run, async (lock) => {
      expect(await client.prepare(lock, lease)).toEqual({ kind: 'prepared', dir: checkout, prompt: 'Is this learning a skill, a rule or a doc? Retry with backoff.' });
      fs.writeFileSync(path.join(checkout, 'README.md'), 'changed while it answered\n');

      return client.report(run, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, outputs: { category: 'rule' } }, { lock });
    }, { waitMs: 0 });

    expect(reported).toMatchObject({ data: { step: { id: 'category', status: 'failed', failure: { code: 'read_only_dirty' } } } });
    expect(await client.next(run, { driver })).toMatchObject({ data: { done: { outcome: 'failed' } } });
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

const DRAFT_ANYWHERE = `schemaVersion: v1alpha1
name: draft
description: Write drafts into a directory the caller names.
inputs: { dir: string }
steps:
  - id: write
    command: node -e "process.exit(0)"
    writes: ["{{ inputs.dir }}"]
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

  it('keeps a change under an absolute path a writes template renders inside the checkout, and runs a step whose path renders outside it', async () => {
    const { config, checkout, client } = await fixture({ draft: DRAFT_ANYWHERE });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-answer-elsewhere-')); dirs.push(elsewhere);
    const report = async (dir: string, change: () => void): Promise<unknown> => {
      const run = await started(client, 'draft', checkout, { dir });
      const lease = await nextLease(client, run);
      expect(lease).toMatchObject({ writes: [dir] });

      return withRunLock(config, run, async (lock) => {
        await client.prepare(lock, lease);
        change();

        return client.report(run, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver }, { lock });
      }, { waitMs: 0 });
    };

    const docs = path.join(checkout, 'docs');
    expect(await report(docs, () => fs.writeFileSync(path.join(docs, 'guide.md.draft.md'), 'draft\n'))).toMatchObject({ data: { step: { id: 'write', status: 'succeeded' } } });
    expect(await report(docs, () => fs.writeFileSync(path.join(checkout, 'README.md'), 'changed\n'))).toMatchObject({ data: { step: { id: 'write', status: 'failed' } } });
    expect(await report(elsewhere, () => fs.writeFileSync(path.join(elsewhere, 'page.md'), 'page\n'))).toMatchObject({ data: { step: { id: 'write', status: 'succeeded' } } });
  });

  it('keeps a commit the command adds on its branch when every path it changes is under writes, and fails any other move of HEAD', async () => {
    const { config, checkout, client } = await fixture({ draft: DRAFT });
    const report = async (change: (dir: string) => void): Promise<unknown> => {
      const run = await started(client, 'draft', checkout, { area: 'docs' });
      const lease = await nextLease(client, run);

      return withRunLock(config, run, async (lock) => {
        await client.prepare(lock, lease);
        change(checkout);

        return client.report(run, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver }, { lock });
      }, { waitMs: 0 });
    };

    const commit = (dir: string, file: string): void => {
      fs.writeFileSync(path.join(dir, file), `${file}\n`);
      git(dir, 'add', file);
      git(dir, 'commit', '-q', '-m', file);
    };

    expect(await report((dir) => commit(dir, 'docs/published.md'))).toMatchObject({ data: { step: { id: 'write', status: 'succeeded' } } });
    expect(await report((dir) => commit(dir, 'NOTES.md'))).toMatchObject({ data: { step: { id: 'write', status: 'failed' } } });
    git(checkout, 'reset', '-q', '--hard', 'HEAD~1');
    expect(await report((dir) => git(dir, 'switch', '-q', '-c', 'side'))).toMatchObject({ data: { step: { id: 'write', status: 'failed' } } });
  });

  it('fails a step whose writes renders a path outside the checkout before it runs', async () => {
    const { checkout, client } = await fixture({ draft: DRAFT });
    const run = await started(client, 'draft', checkout, { area: '../elsewhere' });

    expect(await client.next(run, { driver })).toMatchObject({ data: { done: { outcome: 'failed' } } });
  });
});

const FALLBACK = `schemaVersion: v1alpha1
name: fallback
description: Rewrite a learning, and keep it as written when the tool fails for any reason but a tool the member names.
steps:
  - id: content
    answer: Rewrite it.
    output: { text: string }
    timeout: 60s
    continue_on_failure: true
  - id: original
    needs: [content]
    if: steps.content.outcome == 'failed' && steps.content.failure.code != 'tool_unconfigured'
    command: echo "$WHY"
    env: { WHY: "{{ steps.content.failure.code }}: {{ steps.content.failure.message }}" }
`;

describe('steps.<id>.failure', () => {
  it('runs a fallback guarded on the code a step failed with, and skips it for the code it excludes', async () => {
    const { checkout, client } = await fixture({ fallback: FALLBACK });
    const failWith = async (failure: { code: string; message: string }): Promise<RunId> => {
      const run = await started(client, 'fallback', checkout);
      const lease = await nextLease(client, run);
      await client.report(run, { attempt: lease.attempt, revision: lease.revision, outcome: 'failed', driver, message: failure.message, failure });

      return run;
    };

    const failed = await failWith({ code: 'tool_failed', message: 'claude exited 1' });
    expect(await nextLease(client, failed)).toMatchObject({ step: 'original', env: { WHY: 'tool_failed: claude exited 1' } });

    const unconfigured = await failWith({ code: 'tool_unconfigured', message: 'TEAMAI_AI_TOOL is "gemini", which is not a tool teamai launches.' });
    expect(await client.next(unconfigured, { driver })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('gives a command step that exits non-zero, with any status but 65, the code command_failed', async () => {
    const { checkout, client } = await fixture({ checked: `schemaVersion: v1alpha1
name: checked
description: Check, and say why the check failed.
steps:
  - id: check
    command: npm test
    continue_on_failure: true
  - id: explain
    needs: [check]
    if: steps.check.failure.code == 'command_failed'
    command: echo "$WHY"
    env: { WHY: "{{ steps.check.failure.message }}" }
` });
    const run = await started(client, 'checked', checkout);
    const lease = await nextLease(client, run);
    await client.report(run, { attempt: lease.attempt, revision: lease.revision, driver, ...commandEnd({ exitCode: 1, stdout: '', stderr: '2 tests failed' }) });

    expect(await nextLease(client, run)).toMatchObject({ step: 'explain', env: { WHY: 'command exited with status 1: 2 tests failed' } });
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

const MODULES = `schemaVersion: v1alpha1
name: modules
description: Describe each module, as many at once as the member asks for.
inputs: { modules: [string], concurrency: number }
steps:
  - id: describe
    for_each: { items: inputs.modules, max_parallel: "{{ inputs.concurrency }}" }
    command: echo "$MODULE"
    env: { MODULE: "{{ item }}" }
`;

describe('a for_each max_parallel template', () => {
  it('leases at once as many items as the input it reads', async () => {
    const { checkout, client } = await fixture({ modules: MODULES });
    const run = await started(client, 'modules', checkout, { modules: ['api', 'cli', 'web'], concurrency: 2 });
    const first = await nextLease(client, run);
    const second = await client.next(run, { driver, running: [first.attempt] });
    const third = await client.next(run, { driver, running: [first.attempt, LeaseSchema.parse('data' in second && 'lease' in second.data ? second.data.lease : {}).attempt] });

    expect([first, second, third]).toMatchObject([{ step: 'describe[0]' }, { data: { lease: { step: 'describe[1]' } } }, { data: { wait: { reason: 'describe[0] is leased' } } }]);
  });

  it('refuses to start a run whose input renders it to anything but a whole number from 1', async () => {
    const { checkout, client } = await fixture({ modules: MODULES });

    expect(await client.start('modules', { inputs: { modules: ['api'], concurrency: 0 }, checkout, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' }, startedBy: 'person' })).toEqual({
      error: { code: 'invalid_inputs', message: 'Step "describe" for_each.max_parallel {{ inputs.concurrency }} renders 0, which is not a whole number from 1. Pass a whole number from 1 for the input it reads.' },
    });
  });
});
