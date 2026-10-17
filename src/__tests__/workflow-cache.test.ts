import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow, syncWorkflowDefinitions } from '../workflow/cache.js';
import type { SyncWorkflowResult } from '../workflow/cache.js';
import { formatDiagnostic } from '../workflow/parse.js';
import { leaseNext, startRun } from '../workflow/engine.js';
import { readRun } from '../workflow/store.js';

const dirs: string[] = [];

function testConfig(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-cache-'));
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

function cacheFiles(config: LocalConfig): string[] {
  const home = config.dataHome ?? '';
  if (!fs.existsSync(home)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(home);
  return files;
}

function cachedText(config: LocalConfig): string {
  return cacheFiles(config).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

const VALID = `schemaVersion: v1alpha1
name: build
description: Compile the project.
steps:
  - id: compile
    command: node compile.js
`;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow cache', () => {
  it.each([
    ['fan-out pass outputs', "steps.build.passes[0].outputs.ok", '    output: { ok: boolean }\n'],
    ['fan-out pass outputs without an output schema', "steps.build.passes[0].outputs.ok", ''],
    ['undeclared item output in a pass', "steps.build.passes[0].results[0].outputs.missing", '    output: { ok: boolean }\n'],
    ['ordinary pass results', "steps.leaf.passes[0].results", ''],
    ['typed pass result outcome', "steps.build.passes[0].results[0].outcome > 1", ''],
    ['typed pass result predicate', "any(steps.build.passes, .results[0].outcome > 1)", ''],
  ])('rejects %s during workflow sync', async (_name, read, output) => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Validate pass fields.
steps:
  - id: build
    for_each: "[]"
    command: echo build
${output}  - id: leaf
    needs: [build]
    command: echo leaf
  - id: summary
    needs: [leaf]
    if: ${JSON.stringify(read)}
    command: echo summary
`);
    const synced = await syncWorkflowDefinitions(config);
    expect(synced.invalid).not.toEqual([]);
    expect(synced.cached).toEqual([]);
  });

  it.each([
    ['an output', 'steps.build.outputs.ok', 'output "value" reads steps.build.outputs, but step "build" has for_each'],
    ['an output', 'steps.leaf.results', 'output "value" reads steps.leaf.results, but step "leaf" has no for_each'],
    ['an output', 'steps.build.passes[0].outputs.ok', 'output "value" reads steps.build.passes[0].outputs, but step "build" has for_each'],
    ['an output', 'steps.leaf.passes[0].results', 'output "value" reads steps.leaf.passes[0].results, but step "leaf" has no for_each'],
    ['an if', 'steps.build.outputs.ok', 'step "summary" if reads steps.build.outputs, but step "build" has for_each'],
    ['an if', 'steps.build.passes[0].outputs.ok', 'step "summary" if reads steps.build.passes[0].outputs, but step "build" has for_each'],
    ['an if', 'any(steps.build.passes, .outputs.ok)', 'step "summary" if reads .outputs.ok, which is not in an item of steps.build.passes'],
    ['an if', 'steps.leaf.passes[0].results', 'step "summary" if reads steps.leaf.passes[0].results, but step "leaf" has no for_each'],
  ])('keeps the last valid version when %s reads the unavailable %s', async (site, read, message) => {
    const config = testConfig();
    const body = `schemaVersion: v1alpha1
name: build
description: Read a field a step no longer has.
steps:
  - id: group
    workflow:
${site === 'an output' ? `      outputs:\n        value: ${read}\n` : ''}      steps:
        - id: build
          for_each: "[]"
          command: echo build
          output: { ok: boolean }
        - id: leaf
          needs: [build]
          command: echo leaf
        - id: summary
          needs: [leaf]
${site === 'an if' ? `          if: ${JSON.stringify(read)}\n` : ''}          command: echo summary
`;
    writeWorkflow(config, 'build', body.replace('          for_each: "[]"\n', '').replace('        - id: leaf\n', '        - id: leaf\n          for_each: "[]"\n'));
    expect((await syncWorkflowDefinitions(config)).cached).toEqual(['build']);
    const valid = await loadCachedWorkflow(config, 'build');
    expect(valid).not.toBeNull();
    writeWorkflow(config, 'build', body);
    const synced = await syncWorkflowDefinitions(config);
    expect(synced.invalid).toEqual([expect.objectContaining({ message: expect.stringContaining(message) })]);
    expect(synced.invalid[0]).not.toHaveProperty('code');
    expect(synced.kept).toEqual(['build']);
    expect(await loadCachedWorkflow(config, 'build')).toEqual(valid);
  });

  it('accepts declared item outputs in fan-out pass results and workflow outputs', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Read item outputs in passes.
outputs:
  ok: steps.build.passes[0].results[0].outputs.ok
  results: steps.build.results
steps:
  - id: build
    for_each: "[]"
    command: echo build
    output: { ok: boolean }
  - id: summary
    needs: [build]
    if: steps.build.passes[0].results[0].outputs.ok && all(steps.build.passes, .results[0].outputs.ok)
    command: echo summary
`);
    const synced = await syncWorkflowDefinitions(config);
    expect(synced.invalid).toEqual([]);
    expect(synced.cached).toEqual(['build']);
  });

  it.each(['ok', 'missing'])('checks the child output %s inside a fan-out pass result', async (field) => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Read workflow item outputs in passes.
steps:
  - id: build
    for_each: "[]"
    workflow:
      outputs: { ok: steps.run.outputs.ok }
      steps:
        - id: run
          command: echo run
          output: { ok: boolean }
  - id: summary
    needs: [build]
    if: steps.build.passes[0].results[0].outputs.${field}
    command: echo summary
`);
    const synced = await syncWorkflowDefinitions(config);
    if (field === 'ok') {
      expect(synced.invalid).toEqual([]);
      expect(synced.cached).toEqual(['build']);
    } else {
      expect(synced.invalid).toEqual([expect.objectContaining({ code: 'undeclared_output' })]);
      expect(synced.cached).toEqual([]);
    }
  });

  it('caches prompt_file bytes and snapshots them into a run', async () => {
    const config = testConfig();
    fs.mkdirSync(path.join(config.repo.localPath, 'prompts'));
    const promptFile = path.join(config.repo.localPath, 'prompts', 'review.md');
    fs.writeFileSync(promptFile, 'first prompt');
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt_file: prompts/review.md
`);
    await syncWorkflowDefinitions(config);
    const first = await loadCachedWorkflow(config, 'build');
    expect(first?.definition.steps[0]).toMatchObject({ promptFile: 'prompts/review.md', prompt: 'first prompt' });

    const started = await startRun(config, 'build');
    if ('error' in started) throw new Error(started.error.message);
    fs.writeFileSync(promptFile, 'second prompt');
    const changed = await syncWorkflowDefinitions(config);
    const second = await loadCachedWorkflow(config, 'build');
    expect(second?.sourceHash).not.toBe(first?.sourceHash);
    expect(changed.cached).toContain('build');
    fs.rmSync(promptFile);

    const run = await readRun(config, String(started.data.run));
    if (typeof run !== 'object') throw new Error('run was not stored');
    expect(run.definition.steps[0]).toMatchObject({ prompt: 'first prompt', promptFile: 'prompts/review.md' });

    const invalid = await syncWorkflowDefinitions(config);
    expect(invalid.kept).toEqual(['build']);
    expect((await loadCachedWorkflow(config, 'build'))?.definition.steps[0]?.prompt).toBe('second prompt');
  });

  it('rejects symlinked prompt files that escape the team repo', async () => {
    const config = testConfig();
    const outside = path.join(path.dirname(config.repo.localPath), 'outside-prompt.md');
    fs.writeFileSync(outside, 'secret');
    const prompts = path.join(config.repo.localPath, 'prompts');
    fs.mkdirSync(prompts);
    fs.symlinkSync(outside, path.join(prompts, 'prompt.md'));
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt_file: prompts/prompt.md
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).toEqual([]);
    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid[0]).toMatchObject({
      file: 'workflows/build.yaml',
      line: 6,
      field: 'steps[0].prompt_file',
      message: expect.stringContaining('prompts/'),
    });
  });

  it('does not cache a prompt_file outside prompts/', async () => {
    const config = testConfig();
    fs.mkdirSync(path.join(config.repo.localPath, '.git'));
    fs.writeFileSync(path.join(config.repo.localPath, '.git', 'config'), 'oauth2:token@host');
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt_file: .git/config
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).toEqual([]);
    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(await loadCachedWorkflow(config, 'build')).toBeNull();
  });

  it('caches a valid workflow and leaves a new invalid file unrunnable', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    writeWorkflow(config, 'broken', 'schemaVersion: v1alpha1\nname: nope\ndescription: x\nsteps: []\n');

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).toEqual(['build']);
    expect(result.unrunnable).toEqual(['workflows/broken.yaml']);
    expect(result.invalid.some((diagnostic) => diagnostic.file === 'workflows/broken.yaml' && diagnostic.line > 0)).toBe(true);
    const started = await startRun(config, 'broken');
    expect(started).toMatchObject({ error: { code: 'workflow_not_found' } });
    const runnable = await startRun(config, 'build');
    expect(runnable).toMatchObject({ data: { name: 'build', status: 'running' } });
  });

  it('keeps the last valid version when a file becomes invalid', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    await syncWorkflowDefinitions(config);
    const first = await startRun(config, 'build');
    if ('error' in first) throw new Error(first.error.message);
    const before = await readRun(config, String(first.data.run));
    if (typeof before !== 'object') throw new Error('run was not stored');

    writeWorkflow(config, 'build', 'schemaVersion: [\n');
    const again = await syncWorkflowDefinitions(config);

    expect(again.kept).toEqual(['build']);
    expect(again.cached).not.toContain('build');
    expect(again.invalid[0]).toMatchObject({ file: 'workflows/build.yaml', field: '(document)' });
    const second = await startRun(config, 'build');
    if ('error' in second) throw new Error(second.error.message);
    const after = await readRun(config, String(second.data.run));
    if (typeof after !== 'object') throw new Error('run was not stored');
    expect(after.sourceHash).toBe(before.sourceHash);
    expect(after.definition.steps[0]?.command).toBe('node compile.js');
    const leased = await leaseNext(config, after.id, { kind: 'local', machine: 'test', workspace: '/work' });
    expect(leased).toMatchObject({ data: { lease: { command: 'node compile.js' } } });
  });

  it('keeps a runnable cache when dry-run sees a deleted source file', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    await syncWorkflowDefinitions(config);
    fs.rmSync(path.join(config.repo.localPath, 'workflows', 'build.yaml'));

    await syncWorkflowDefinitions(config, { dryRun: true });

    const started = await startRun(config, 'build');
    expect(started).toMatchObject({ data: { name: 'build', status: 'running' } });
  });

  it('does not read a symlinked workflows directory', async () => {
    const config = testConfig();
    const workflows = path.join(config.repo.localPath, 'workflows');
    fs.rmSync(workflows, { recursive: true, force: true });
    const outside = path.join(path.dirname(config.repo.localPath), 'outside-workflows');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'build.yaml'), VALID.replace('command: node compile.js', 'command: node outside-dir.js'));
    fs.symlinkSync(outside, workflows);

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).toEqual([]);
    expect(cachedText(config)).not.toContain('outside-dir.js');
    const started = await startRun(config, 'build');
    expect(started).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('drops every cached workflow once the workflows directory is a symlink', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    expect((await syncWorkflowDefinitions(config)).cached).toEqual(['build']);
    const workflows = path.join(config.repo.localPath, 'workflows');
    const outside = path.join(path.dirname(config.repo.localPath), 'outside-workflows');
    fs.renameSync(workflows, outside);
    fs.symlinkSync(outside, workflows);

    const result = await syncWorkflowDefinitions(config);

    expect(result).toEqual({ cached: [], kept: [], invalid: [], unrunnable: [] });
    expect(await startRun(config, 'build')).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('does not read or cache a symlinked yaml outside workflows', async () => {
    const config = testConfig();
    const outside = path.join(path.dirname(config.repo.localPath), 'outside-build.yaml');
    const body = VALID.replace('command: node compile.js', 'command: node outside-only.js');
    fs.writeFileSync(outside, body);
    fs.symlinkSync(outside, path.join(config.repo.localPath, 'workflows', 'build.yaml'));

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).not.toContain('build');
    expect(result.invalid).toEqual([]);
    expect(result.unrunnable).toEqual([]);
    expect(cachedText(config)).not.toContain('outside-only.js');
    const started = await startRun(config, 'build');
    expect(started).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('drops the last valid version when a revision uses a key this version does not know', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    await syncWorkflowDefinitions(config);
    expect(await loadCachedWorkflow(config, 'build')).not.toBeNull();

    writeWorkflow(config, 'build', VALID.replace('command: node compile.js', 'command: node compile.js\n    timeout: 10m'));
    const synced = await syncWorkflowDefinitions(config);

    expect(synced.unrunnable).toContain('workflows/build.yaml');
    expect(synced.kept).not.toContain('build');
    expect(await loadCachedWorkflow(config, 'build')).toBeNull();
    expect(await startRun(config, 'build')).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('keeps each self-mode checkout on its own cache', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-cache-'));
    dirs.push(root);
    const dataHome = path.join(root, 'data');
    const checkout = (name: string, command: string): LocalConfig => {
      const business = path.join(root, name);
      const knowledge = path.join(business, 'knowledge');
      fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
      const config: LocalConfig = {
        repo: { localPath: knowledge, remote: 'local', kind: 'self', businessRepoRoot: business },
        username: 'tester',
        scope: 'project',
        additionalRoles: [],
        projectRoot: business,
        dataHome,
      };
      writeWorkflow(config, 'build', VALID.replace('command: node compile.js', `command: ${command}`));
      return config;
    };

    const first = checkout('a', 'echo main-command');
    const second = checkout('b', 'echo second-command');
    await syncWorkflowDefinitions(first);
    await syncWorkflowDefinitions(second);

    const started = await startRun(first, 'build');
    if ('error' in started) throw new Error(started.error.message);
    const leased = await leaseNext(first, String(started.data.run), { kind: 'local', machine: 'test', workspace: '/work' });
    expect(leased).toMatchObject({ data: { lease: { command: 'echo main-command' } } });

    writeWorkflow(first, 'build', 'schemaVersion: [\n');
    const kept = await syncWorkflowDefinitions(first);
    expect(kept.kept).toEqual(['build']);
    const afterInvalid = await startRun(first, 'build');
    if ('error' in afterInvalid) throw new Error(afterInvalid.error.message);
    const stillFirst = await leaseNext(first, String(afterInvalid.data.run), { kind: 'local', machine: 'test', workspace: '/work' });
    expect(stillFirst).toMatchObject({ data: { lease: { command: 'echo main-command' } } });

    fs.rmSync(path.join(second.repo.localPath, 'workflows', 'build.yaml'));
    await syncWorkflowDefinitions(second);
    const afterDelete = await startRun(first, 'build');
    expect(afterDelete).toMatchObject({ data: { name: 'build', status: 'running' } });
  });

  it('reports a step after the first that does not declare needs', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Compile, then test.
steps:
  - id: compile
    command: node compile.js
  - id: test
    command: node test.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[1].needs": step "test" must declare needs; use needs: [] for another root',
    ]);
  });

  it('reports a needs id that names no step', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Compile, then test.
steps:
  - id: compile
    command: node compile.js
  - id: test
    needs: [compile, lint]
    command: node test.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:8: field "steps[1].needs": step "test" needs "lint", which is not a step in this workflow',
    ]);
  });

  it('reports a needs cycle with the steps that form it', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Two steps wait for each other.
steps:
  - id: compile
    command: node compile.js
  - id: test
    needs: [compile, publish]
    command: node test.js
  - id: publish
    needs: [test]
    command: node publish.js
  - id: lint
    needs: [lint]
    command: node lint.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:8: field "steps[1].needs": step "test" is in a needs cycle: test -> publish -> test',
      'workflows/build.yaml:14: field "steps[3].needs": step "lint" is in a needs cycle: lint -> lint',
    ]);
  });

  it('reports needs that is not a list of step ids', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Compile, then test.
steps:
  - id: compile
    command: node compile.js
  - id: test
    needs: compile
    command: node test.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:8: field "steps[1].needs": step "test" needs must be a list of step ids',
    ]);
  });

  it('drops a cached copy from before needs when the file still has no needs', async () => {
    const config = testConfig();
    const linear = `schemaVersion: v1alpha1
name: build
description: Compile, then test.
steps:
  - id: compile
    command: node compile.js
  - id: test
    command: node test.js
`;
    // Stand in for the cache an older teamai wrote under the linear rules: same file, no needs.
    writeWorkflow(config, 'build', linear.replace('  - id: test\n', '  - id: test\n    needs: [compile]\n'));
    await syncWorkflowDefinitions(config);
    const cacheFile = cacheFiles(config).find((file) => file.endsWith(`${path.sep}build.json`));
    if (!cacheFile) throw new Error('cache missing');
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { definition: { steps: Array<{ needs?: string[] }> } };
    for (const step of cached.definition.steps) delete step.needs;
    fs.writeFileSync(cacheFile, JSON.stringify(cached));
    writeWorkflow(config, 'build', linear);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid).toEqual([expect.objectContaining({ code: 'missing_needs', field: 'steps[1].needs' })]);
    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.kept).toEqual([]);
    expect(await startRun(config, 'build')).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('reports only the broken step when a step numbered 10 or higher is valid', async () => {
    const config = testConfig();
    const steps = Array.from({ length: 12 }, (_, index) => [
      `  - id: s${index}`,
      // Nothing needs the broken step, so the only reference that can go wrong is the one to s10.
      ...(index === 0 ? [] : [`    needs: [${index === 11 ? 's10' : index === 2 ? 's0' : `s${index - 1}`}]`]),
      index === 1 ? "    prompt: ''" : `    command: node s${index}.js`,
    ].join('\n')).join('\n');
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Many steps.
steps:
${steps}
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map((diagnostic) => `${diagnostic.field}: ${diagnostic.message}`)).toEqual([
      'steps[1].prompt: prompt must be a non-empty string',
    ]);
  });

  it('reports an end that is not declared in ends', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Stop early.
ends:
  dropped: succeeded
steps:
  - id: compile
    command: node compile.js
    end: dropped
  - id: stop
    needs: []
    end: droped
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:12: field "steps[1].end": step "stop" ends with "droped", which is not declared in ends',
    ]);
  });

  it('reports an end in a workflow that declares no ends', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Stop early.
steps:
  - id: compile
    command: node compile.js
  - id: stop
    needs: [compile]
    end: dropped
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[1].end": step "stop" ends with "dropped", but the workflow declares no ends',
    ]);
  });

  it('reports a declared end that no step reaches', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Stop early.
ends:
  dropped: succeeded
  stuck: failed
steps:
  - id: compile
    command: node compile.js
  - id: stop
    needs: [compile]
    end: dropped
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:6: field "ends.stuck": end "stuck" is declared in ends, but no step ends with it',
    ]);
  });

  it('reports a step that needs a step that only ends the workflow', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Stop early.
ends:
  dropped: succeeded
steps:
  - id: compile
    command: node compile.js
  - id: stop
    needs: [compile]
    end: dropped
  - id: test
    needs: [compile, stop]
    command: node test.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:13: field "steps[2].needs": step "test" needs "stop", which only ends the workflow, so "test" can never run',
    ]);
  });

  it('reports output on a step that only ends the workflow', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Stop early.
ends:
  dropped: succeeded
steps:
  - id: stop
    end: dropped
    output: string
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[0].output": step "stop" has no action, so it carries only id, needs, if, and end',
    ]);
  });

  it('reports an end whose outcome is not succeeded or failed', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Stop early.
ends:
  dropped: done
steps:
  - id: stop
    end: dropped
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:5: field "ends.dropped": ends must map each end name to succeeded or failed',
    ]);
  });

  it('keeps the last valid version when a revision ends with an undeclared end', async () => {
    const config = testConfig();
    const valid = `schemaVersion: v1alpha1
name: build
description: Stop early.
ends:
  dropped: succeeded
steps:
  - id: compile
    command: node compile.js
  - id: stop
    needs: [compile]
    end: dropped
`;
    writeWorkflow(config, 'build', valid);
    await syncWorkflowDefinitions(config);
    writeWorkflow(config, 'build', valid.replace('end: dropped', 'end: droped'));

    const result = await syncWorkflowDefinitions(config);

    expect(result.kept).toEqual(['build']);
    expect(await loadCachedWorkflow(config, 'build')).toMatchObject({
      definition: { ends: { dropped: 'succeeded' }, steps: [{ id: 'compile' }, { id: 'stop', end: 'dropped' }] },
    });
  });
  it('reports an if that does not parse with its column', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Label the issue when the check fails.
steps:
  - id: check
    command: node check.js
  - id: label
    needs: [check]
    if: steps.check.outcome = 'failed'
    command: node label.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[1].if": step "label" if does not parse at column 21: unexpected "="',
    ]);
  });

  it('reports an if that reads a step it does not need', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Label the issue when the check fails.
steps:
  - id: check
    command: node check.js
  - id: docs
    needs: []
    command: node docs.js
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed' && steps.docs.outcome == 'success' || steps.nope.end == null
    command: node label.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:12: field "steps[2].if": step "label" if reads steps.docs, which is not a step it needs, directly or through its needs',
      'workflows/build.yaml:12: field "steps[2].if": step "label" if reads steps.nope, which is not a step it needs, directly or through its needs',
    ]);
  });

  it('reports an if that reads an output field the step does not declare', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Fix what the review asks for.
steps:
  - id: review
    command: node review.js
    output:
      verdict: pass | fix
      notes:
        summary: string
  - id: free
    needs: []
    command: node free.js
  - id: fix
    needs: [review, free]
    if: steps.review.outputs.verdcit == 'fix' || steps.review.outputs.notes.summary == '' || steps.review.outputs.verdict.text || steps.free.outputs.anything
    command: node fix.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:16: field "steps[2].if": step "fix" if reads steps.review.outputs.verdcit, which is not in the output step "review" declares',
      'workflows/build.yaml:16: field "steps[2].if": step "fix" if reads steps.review.outputs.verdict.text, which is not in the output step "review" declares',
    ]);
  });

  it('reports a literally false if and drops the version that would still run the step', async () => {
    const config = testConfig();
    const body = `schemaVersion: v1alpha1
name: build
description: Publish after the build.
steps:
  - id: compile
    command: node compile.js
  - id: publish
    needs: [compile]
    command: node publish.js
  - id: notify
    needs: [compile]
    command: node notify.js
`;
    writeWorkflow(config, 'build', body);
    await syncWorkflowDefinitions(config);
    writeWorkflow(config, 'build', body
      .replace('command: node publish.js', 'if: false\n    command: node publish.js')
      .replace('command: node notify.js', "if: \"!(1 == 1) || ''\"\n    command: node notify.js"));

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[1].if": step "publish" if is always false, so the step never runs',
      'workflows/build.yaml:13: field "steps[2].if": step "notify" if is always false, so the step never runs',
    ]);
    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.kept).toEqual([]);
    expect(await startRun(config, 'build')).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('reports a template in a command and points to env', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Label the issue.
inputs:
  title: string
steps:
  - id: label
    command: node label.js "{{inputs.title}}"
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:8: field "steps[0].command": step "label" command contains {{inputs.title}}; command strings are not templated; pass the value through env:',
    ]);
  });

  it('reports env on a step that does not run a command', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Review the change.
steps:
  - id: review
    prompt: Review the change.
    env:
      TITLE: fixed
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].env": step "review" env is only allowed on a command step',
    ]);
  });

  it('reports an env name that is not a valid variable name', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Label the issue.
steps:
  - id: label
    command: node label.js
    env:
      GOOD_1: fine
      1BAD: one
      BAD-NAME: two
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[0].env.1BAD": step "label" env name "1BAD" must match ^[A-Za-z_][A-Za-z0-9_]*$',
      'workflows/build.yaml:10: field "steps[0].env.BAD-NAME": step "label" env name "BAD-NAME" must match ^[A-Za-z_][A-Za-z0-9_]*$',
    ]);
  });

  it('reports a template in a prompt or env that reads a bad path', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Fix the issue.
inputs:
  title: string
steps:
  - id: plan
    command: node plan.js
    output:
      task: string
  - id: free
    needs: []
    command: node free.js
  - id: fix
    needs: [plan]
    prompt: "{{ inputs.titel }} {{ steps.plan.outputs.tsk }} {{ steps.free.outcome }} {{ inputs.title }}"
  - id: label
    needs: [plan]
    command: node label.js
    env:
      TASK: "{{ steps.plan.outputs.task }}"
      FREE: "{{ steps.free.outputs.y }}"
      SAME: "{{ inputs.title = 'x' }}"
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:23: field "steps[3].env.SAME": step "label" env.SAME template {{ inputs.title = \'x\' }}: unexpected "="',
      'workflows/build.yaml:16: field "steps[2].prompt": step "fix" prompt reads inputs.titel, which is not an input the workflow declares',
      'workflows/build.yaml:16: field "steps[2].prompt": step "fix" prompt reads steps.plan.outputs.tsk, which is not in the output step "plan" declares',
      'workflows/build.yaml:16: field "steps[2].prompt": step "fix" prompt reads steps.free, which is not a step it needs, directly or through its needs',
      'workflows/build.yaml:22: field "steps[3].env.FREE": step "label" env.FREE reads steps.free, which is not a step it needs, directly or through its needs',
    ]);
    expect(result.invalid.map((diagnostic) => diagnostic.code)).toEqual(Array(5).fill('bad_template'));
  });

  it('accepts a function call in a template, drops the last valid version for a call with a mistake in it, and leaves other braces as text', async () => {
    const config = testConfig();
    fs.mkdirSync(path.join(config.repo.localPath, 'prompts'));
    const promptFile = path.join(config.repo.localPath, 'prompts', 'review.md');
    const body = (env: string, value: string, prompt: string): string => `schemaVersion: v1alpha1
name: build
description: Report the failed builds.
inputs:
  targets: [string]
steps:
  - id: build
    for_each: inputs.targets
    command: node build.js
  - id: notify
    needs: [build]
    command: node notify.js
    env:
      FAILED: "${env}"
  - id: fix
    needs: [build]
    with:
      failed: "${value}"
    prompt: "${prompt} {{ with.failed }}"
`;
    fs.writeFileSync(promptFile, 'Review the builds.');
    writeWorkflow(config, 'build', body('{{ steps.build.results }}', '{{ steps.build.outcome }}', 'Fix the failed builds.'));
    writeWorkflow(config, 'review', `schemaVersion: v1alpha1
name: review
description: Review the builds.
inputs:
  targets: [string]
steps:
  - id: build
    for_each: inputs.targets
    command: node build.js
  - id: review
    needs: [build]
    prompt_file: prompts/review.md
`);
    expect((await syncWorkflowDefinitions(config)).cached).toEqual(['build', 'review']);
    fs.writeFileSync(promptFile, 'Review {{ length(steps.build.results) }} builds.');
    writeWorkflow(config, 'build', body(
      "{{ filter(steps.build.results, .outcome == 'failed') }}",
      "{{ any(steps.build.results, .outcome == 'failed') }}",
      'Fix {{ length(steps.build.results) }} builds.',
    ));
    writeWorkflow(config, 'jinja', `schemaVersion: v1alpha1
name: jinja
description: Explain a Jinja template.
steps:
  - id: explain
    prompt: "Explain {{ items | length }} and {{ name }} in this Jinja template."
`);

    const accepted = await syncWorkflowDefinitions(config);

    expect(accepted.invalid.map(formatDiagnostic)).toEqual([]);
    expect(accepted.cached).toEqual(['build', 'jinja', 'review']);
    expect((await loadCachedWorkflow(config, 'build'))?.definition.steps[1]?.env).toEqual({ FAILED: "{{ filter(steps.build.results, .outcome == 'failed') }}" });
    expect((await loadCachedWorkflow(config, 'jinja'))?.definition.steps[0]?.prompt).toBe('Explain {{ items | length }} and {{ name }} in this Jinja template.');

    fs.writeFileSync(promptFile, 'Review {{ length(steps.build.result) }} builds.');
    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/review.yaml:12: field "steps[1].prompt_file": step "review" prompt_file template {{ length(steps.build.result) }}: "steps.build.result" must read steps.<id>.outcome, steps.<id>.end, steps.<id>.outputs, steps.<id>.passes or steps.<id>.results',
    ]);
    expect(result.invalid.map((diagnostic) => diagnostic.code)).toEqual(['bad_template']);
    expect(result.unrunnable).toEqual(['workflows/review.yaml']);
    expect(result.kept).toEqual([]);
    expect(await startRun(config, 'review', { targets: [] })).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('reports a bad template in prompt_file text and drops the version that rendered it as text', async () => {
    const config = testConfig();
    fs.mkdirSync(path.join(config.repo.localPath, 'prompts'));
    const promptFile = path.join(config.repo.localPath, 'prompts', 'review.md');
    fs.writeFileSync(promptFile, 'Review the issue.');
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Review the issue.
steps:
  - id: review
    prompt_file: prompts/review.md
`);
    await syncWorkflowDefinitions(config);
    // Stand in for the cache an older teamai wrote: the braces reached the agent as written.
    const cacheFile = cacheFiles(config).find((file) => file.endsWith(`${path.sep}build.json`));
    if (!cacheFile) throw new Error('cache missing');
    const text = 'Review issue {{ inputs.issue }}.';
    fs.writeFileSync(cacheFile, fs.readFileSync(cacheFile, 'utf8').replace('Review the issue.', text));
    fs.writeFileSync(promptFile, text);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:6: field "steps[0].prompt_file": step "review" prompt_file reads inputs.issue, which is not an input the workflow declares',
    ]);
    expect(result.invalid[0]?.code).toBe('bad_template');
    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.kept).toEqual([]);
    expect(await startRun(config, 'build')).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('lets a prompt_file read item where a for_each binds it, and keeps item as written elsewhere', async () => {
    const config = testConfig();
    fs.mkdirSync(path.join(config.repo.localPath, 'prompts'));
    fs.writeFileSync(path.join(config.repo.localPath, 'prompts', 'review.md'), 'Review {{ item.path }}.');
    const quote = 'Quote {{ item }}, {{ item.path }}, {{ item[0] }} and {{ length(item.xs) }} from a playbook.';
    fs.writeFileSync(path.join(config.repo.localPath, 'prompts', 'quote.md'), quote);
    writeWorkflow(config, 'fan', `schemaVersion: v1alpha1
name: fan
description: Review each file.
inputs:
  files: [{ path: string }]
steps:
  - id: review
    for_each: inputs.files
    prompt_file: prompts/review.md
  - id: check
    needs: [review]
    for_each: inputs.files
    workflow:
      steps:
        - id: recheck
          prompt_file: prompts/review.md
  - id: summary
    needs: [check]
    prompt_file: prompts/quote.md
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([]);
    expect(result.cached).toEqual(['fan']);
    expect((await loadCachedWorkflow(config, 'fan'))?.definition.steps[2]?.prompt).toBe(quote);
  });

  it('reports a with read outside the prompt of a step whose with declares it', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Fix the issue.
steps:
  - id: plan
    prompt: "Plan {{ with.task }}."
  - id: fix
    needs: [plan]
    prompt: "Fix {{ with.task.title }} and {{ with.tsk }}."
    with:
      task: "{{ steps.plan.outcome }}"
      again: "{{ with.task }}"
  - id: label
    needs: [plan]
    command: node label.js
    env:
      TASK: "{{ with.task }}"
  - id: list
    needs: [plan]
    prompt: "List {{ with.task }}."
    with: [1]
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:6: field "steps[0].prompt": step "plan" prompt reads with.task, but the step has no with',
      'workflows/build.yaml:12: field "steps[1].with.again": step "fix" with.again reads with.task; only a prompt reads with',
      'workflows/build.yaml:9: field "steps[1].prompt": step "fix" prompt reads with.tsk, which is not a name its with declares',
      'workflows/build.yaml:17: field "steps[2].env.TASK": step "label" env.TASK reads with.task; only a prompt reads with',
      'workflows/build.yaml:21: field "steps[3].with": step "list" with must map names to values',
    ]);
    expect(result.invalid.map((diagnostic) => diagnostic.code)).toEqual([...Array(4).fill('bad_template'), undefined]);
  });

  it('reports a with read in prompt_file text of a step with no with and drops the version that sent it as text', async () => {
    const config = testConfig();
    fs.mkdirSync(path.join(config.repo.localPath, 'prompts'));
    const promptFile = path.join(config.repo.localPath, 'prompts', 'review.md');
    fs.writeFileSync(promptFile, 'Review the issue.');
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Review the issue.
steps:
  - id: review
    prompt_file: prompts/review.md
`);
    await syncWorkflowDefinitions(config);
    // Stand in for the cache an older teamai wrote: it did not know with, so the braces reached the agent as written.
    const cacheFile = cacheFiles(config).find((file) => file.endsWith(`${path.sep}build.json`));
    if (!cacheFile) throw new Error('cache missing');
    const text = 'Review {{ with.task }}.';
    fs.writeFileSync(cacheFile, fs.readFileSync(cacheFile, 'utf8').replace('Review the issue.', text));
    fs.writeFileSync(promptFile, text);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:6: field "steps[0].prompt_file": step "review" prompt_file reads with.task, but the step has no with',
    ]);
    expect(result.invalid[0]?.code).toBe('bad_template');
    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(await startRun(config, 'build')).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('reports an if that reads an input the workflow does not declare', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Ship when asked.
inputs:
  ship: boolean
  issue:
    number: number
steps:
  - id: build
    command: node build.js
  - id: ship
    needs: [build]
    if: inputs.shipp || inputs.issue.numbr == 1 || inputs.issue.number == 1 || inputs.ship
    command: node ship.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:13: field "steps[1].if": step "ship" if reads inputs.shipp, which is not an input the workflow declares',
      'workflows/build.yaml:13: field "steps[1].if": step "ship" if reads inputs.issue.numbr, which is not an input the workflow declares',
    ]);
  });

  it('reports a dot in a step id or a field name and drops the version that has one', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    await syncWorkflowDefinitions(config);
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Compile the project.
inputs:
  issue.number: number
steps:
  - id: compile.all
    command: node compile.js
    output:
      result.ok: boolean
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:5: field "inputs": field name "issue.number" cannot contain "."; a path reads "." as a separator',
      'workflows/build.yaml:7: field "steps[0].id": step id "compile.all" cannot contain "."; a path reads "." as a separator',
      'workflows/build.yaml:10: field "steps[0].output": field name "result.ok" cannot contain "."; a path reads "." as a separator',
    ]);
    expect(result.invalid.map((diagnostic) => diagnostic.code)).toEqual(['dotted_name', 'dotted_name', 'dotted_name']);
    expect(result.kept).toEqual([]);
    expect(await startRun(config, 'build')).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('reads env numbers and booleans as text and reports a value that is not a scalar', async () => {
    const config = testConfig();
    const body = `schemaVersion: v1alpha1
name: build
description: Label the issue.
steps:
  - id: label
    command: node label.js
    env:
      RETRIES: 3
      DRY: true
`;
    writeWorkflow(config, 'build', body);
    await syncWorkflowDefinitions(config);
    expect((await loadCachedWorkflow(config, 'build'))?.definition.steps[0]?.env).toEqual({ RETRIES: '3', DRY: 'true' });
    writeWorkflow(config, 'build', `${body}      EMPTY:
      LIST: [a]
      MAP: { a: 1 }
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:10: field "steps[0].env.EMPTY": step "label" env.EMPTY must be a string, number, or boolean',
      'workflows/build.yaml:11: field "steps[0].env.LIST": step "label" env.LIST must be a string, number, or boolean',
      'workflows/build.yaml:12: field "steps[0].env.MAP": step "label" env.MAP must be a string, number, or boolean',
    ]);
  });

  it('reports only a malformed inputs header, not every read of it', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Fix the issue.
inputs:
  issue: integer
steps:
  - id: fix
    if: inputs.issue == 1
    prompt: "Fix {{ inputs.issue }}."
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:5: field "inputs.issue": unknown output type "integer"',
    ]);
  });

  it('reports outputs that are not paths reading a step of the workflow, or read an undeclared field', async () => {
    const config = testConfig();
    writeWorkflow(config, 'check', `schemaVersion: v1alpha1
name: check
description: Classify the issue.
outputs:
  verdict: steps.classify.outputs.verdcit
  missing: steps.clasify.outputs.verdict
  text: "{{ steps.classify.outputs.verdict }}"
  input: inputs.issue
  ok: steps.classify.outputs.verdict
  outcome: steps.classify.outcome
steps:
  - id: classify
    command: node classify.js
    output:
      verdict: fix | drop
`);
    writeWorkflow(config, 'list', `schemaVersion: v1alpha1
name: list
description: Outputs as a list.
outputs: [steps.classify.outputs.verdict]
steps:
  - id: classify
    command: node classify.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/check.yaml', 'workflows/list.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/check.yaml:7: field "outputs.text": output "text" must be a path that reads a step, such as steps.<id>.outputs.<field>',
      'workflows/check.yaml:8: field "outputs.input": output "input" must be a path that reads a step, such as steps.<id>.outputs.<field>',
      'workflows/check.yaml:5: field "outputs.verdict": output "verdict" reads steps.classify.outputs.verdcit, which is not in the output step "classify" declares',
      'workflows/check.yaml:6: field "outputs.missing": output "missing" reads steps.clasify, which is not a step in this workflow',
      'workflows/list.yaml:4: field "outputs": outputs must map each name to a path such as steps.<id>.outputs.<field>',
    ]);
  });

  it('reports a workflow step that names no workflow, carries agent or output, or passes with values it may not read', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Run sub-workflows.
steps:
  - id: plan
    command: node plan.js
    with:
      issue: 1
  - id: check
    needs: [plan]
    workflow: "../check"
  - id: review
    needs: [plan]
    workflow: check
    agent: reviewer
    output:
      ok: boolean
  - id: list
    needs: [plan]
    workflow: check
    with: [1]
  - id: read
    needs: []
    workflow: check
    with:
      task: "{{ steps.plan.outputs.task }}"
      deep:
        title: "{{ inputs.titel }}"
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].with": step "plan" with is not allowed on a command step; pass values through env:',
      'workflows/build.yaml:11: field "steps[1].workflow": step "check" workflow must be the name of a workflow in workflows/',
      'workflows/build.yaml:15: field "steps[2].agent": agent is only allowed on a prompt or prompt_file step',
      'workflows/build.yaml:16: field "steps[2].output": step "review" output is not allowed on a workflow step; declare outputs in the workflow it runs',
      'workflows/build.yaml:21: field "steps[3].with": step "list" with must map the workflow\'s inputs to values',
      'workflows/build.yaml:26: field "steps[4].with.task": step "read" with.task reads steps.plan, which is not a step it needs, directly or through its needs',
      'workflows/build.yaml:28: field "steps[4].with.deep": step "read" with.deep reads inputs.titel, which is not an input the workflow declares',
    ]);
  });

  it('caches, hashes, and checks the prompt_file of a step inside an inline workflow like a top-level one', async () => {
    const config = testConfig();
    fs.mkdirSync(path.join(config.repo.localPath, 'prompts'));
    const promptFile = path.join(config.repo.localPath, 'prompts', 'fix.md');
    fs.writeFileSync(promptFile, 'Fix {{ inputs.title }} after {{ steps.plan.outcome }}, {{ with.note }}.');
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Fix inside an inline workflow.
inputs:
  title: string
steps:
  - id: plan
    command: node plan.js
  - id: check
    needs: [plan]
    workflow:
      steps:
        - id: fix
          prompt_file: prompts/fix.md
          with:
            note: "plan {{ steps.plan.outcome }}"
`);
    await syncWorkflowDefinitions(config);
    const first = await loadCachedWorkflow(config, 'build');
    const inline = first?.definition.steps[1]?.workflow;
    expect(typeof inline === 'object' && inline.steps[0]).toMatchObject({
      promptFile: 'prompts/fix.md',
      prompt: 'Fix {{ inputs.title }} after {{ steps.plan.outcome }}, {{ with.note }}.',
    });

    fs.writeFileSync(promptFile, 'Fix {{ steps.free.outcome }}.');
    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:14: field "steps[1].workflow.steps[0].prompt_file": step "fix" prompt_file reads steps.free, which is not a step it needs, or one the step that runs its workflow needs, directly or through their needs',
    ]);

    fs.writeFileSync(promptFile, 'Fix it.');
    await syncWorkflowDefinitions(config);
    expect((await loadCachedWorkflow(config, 'build'))?.sourceHash).not.toBe(first?.sourceHash);
  });

  it('reports inline outputs that do not read a step of the inline workflow, and a key an inline workflow does not know', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Return values from an inline workflow.
steps:
  - id: plan
    command: node plan.js
  - id: check
    needs: [plan]
    workflow:
      outputs:
        verdict: steps.classify.outputs.verdcit
        planned: steps.plan.outcome
        text: "{{ steps.classify.outputs.verdict }}"
      steps:
        - id: classify
          command: node classify.js
          output:
            verdict: fix | drop
`);
    writeWorkflow(config, 'loop', `schemaVersion: v1alpha1
name: loop
description: An inline workflow with a key from a later teamai.
steps:
  - id: check
    workflow:
      for_each: [1, 2]
      steps:
        - id: classify
          command: node classify.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map((diagnostic) => [formatDiagnostic(diagnostic), diagnostic.code])).toEqual([
      ['workflows/build.yaml:13: field "steps[1].workflow.outputs.text": output "text" must be a path that reads a step, such as steps.<id>.outputs.<field>', undefined],
      ['workflows/build.yaml:11: field "steps[1].workflow.outputs.verdict": output "verdict" reads steps.classify.outputs.verdcit, which is not in the output step "classify" declares', undefined],
      ['workflows/build.yaml:12: field "steps[1].workflow.outputs.planned": output "planned" reads steps.plan, which is not a step in this workflow', undefined],
      ['workflows/loop.yaml:7: field "steps[0].workflow.for_each": workflows/loop.yaml uses `for_each`, which this teamai does not know. Update teamai.', 'unknown_key'],
    ]);
  });

  it('checks a read from a nested inline workflow against every enclosing level', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Nested inline workflows.
steps:
  - id: plan
    command: node plan.js
  - id: free
    needs: []
    command: node free.js
  - id: outer
    needs: [plan]
    workflow:
      steps:
        - id: prepare
          command: node prepare.js
        - id: inner
          needs: [prepare]
          workflow:
            steps:
              - id: note
                if: steps.prepare.outcome == 'success' && steps.plan.outcome == 'success' && steps.free.outcome == 'success'
                command: node note.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:21: field "steps[2].workflow.steps[1].workflow.steps[0].if": step "note" if reads steps.free, which is not a step it needs, or one the step that runs its workflow needs, directly or through their needs',
    ]);
  });

  it('reports inputs and with on an inline workflow, and an inline read of an enclosing step the enclosing step does not need', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Run an inline workflow.
inputs:
  title: string
steps:
  - id: plan
    command: node plan.js
  - id: free
    needs: []
    command: node free.js
  - id: check
    needs: [plan]
    with:
      title: x
    workflow:
      inputs:
        title: string
      name: check
      steps:
        - id: classify
          prompt: "Classify {{ inputs.title }} after {{ steps.plan.outcome }} and {{ steps.free.outcome }}."
        - id: comment
          needs: [classify]
          if: steps.free.outcome == 'success' && steps.classify.outcome == 'success'
          command: node comment.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map((diagnostic) => [formatDiagnostic(diagnostic), diagnostic.code])).toEqual([
      ['workflows/build.yaml:17: field "steps[2].workflow.inputs": step "check" runs an inline workflow, which declares no inputs; its steps read the enclosing workflow\'s inputs', undefined],
      ['workflows/build.yaml:19: field "steps[2].workflow.name": step "check" runs an inline workflow, which carries only steps, outputs, ends, and loop', undefined],
      ['workflows/build.yaml:14: field "steps[2].with": step "check" with is not allowed on an inline workflow; its steps read the enclosing inputs and steps', undefined],
      ['workflows/build.yaml:22: field "steps[2].workflow.steps[0].prompt": step "classify" prompt reads steps.free, which is not a step it needs, or one the step that runs its workflow needs, directly or through their needs', 'bad_template'],
      ['workflows/build.yaml:25: field "steps[2].workflow.steps[1].if": step "comment" if reads steps.free, which is not a step it needs, or one the step that runs its workflow needs, directly or through their needs', undefined],
    ]);
  });
});

/**
 * Syncs, then starts every workflow the sync cached or kept, so a cache that start cannot run, through a missing
 * child or a cycle among cached copies, fails the test that wrote it.
 */
async function syncAndStart(config: LocalConfig): Promise<SyncWorkflowResult> {
  const result = await syncWorkflowDefinitions(config);
  for (const name of [...result.cached, ...result.kept]) {
    expect(await startRun(config, name), name).not.toMatchObject({ error: { code: expect.stringMatching(/^workflow_(recursion|not_found)$/) } });
  }
  return result;
}

describe('workflow references across files', () => {
  it('reports a step that runs a workflow with no runnable version, and still syncs the others', async () => {
    const config = testConfig();
    writeWorkflow(config, 'ship', `schemaVersion: v1alpha1
name: ship
description: Ship the issue.
steps:
  - id: check
    workflow: check-issue
`);
    writeWorkflow(config, 'build', VALID);

    const result = await syncAndStart(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/ship.yaml:6: field "steps[0].workflow": step "check" runs workflow "check-issue", which has no runnable version; fix or add workflows/check-issue.yaml',
    ]);
    expect(result.unrunnable).toEqual(['workflows/ship.yaml']);
    expect(result.cached).toEqual(['build']);
  });

  it('reports recursion in every file of the cycle', async () => {
    const config = testConfig();
    const runs = (name: string, id: string, child: string): string => `schemaVersion: v1alpha1
name: ${name}
description: Run ${child}.
steps:
  - id: ${id}
    workflow: ${child}
`;
    writeWorkflow(config, 'ship', runs('ship', 'check', 'check'));
    writeWorkflow(config, 'check', runs('check', 'again', 'ship'));
    writeWorkflow(config, 'loop', runs('loop', 'self', 'loop'));
    writeWorkflow(config, 'build', VALID);

    const result = await syncAndStart(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/check.yaml:6: field "steps[0].workflow": step "again" runs workflow "ship" in a cycle: check -> ship -> check',
      'workflows/loop.yaml:6: field "steps[0].workflow": step "self" runs workflow "loop" in a cycle: loop -> loop',
      'workflows/ship.yaml:6: field "steps[0].workflow": step "check" runs workflow "check" in a cycle: ship -> check -> ship',
    ]);
    expect(result.cached).toEqual(['build']);
  });

  it('keeps a parent while its child keeps a runnable version, and drops it when the child has none', async () => {
    const config = testConfig();
    const runs = (name: string, child: string): string => `schemaVersion: v1alpha1
name: ${name}
description: Run ${child}.
steps:
  - id: run
    workflow: ${child}
`;
    writeWorkflow(config, 'ship', runs('ship', 'check'));
    writeWorkflow(config, 'check', VALID.replace(/build/g, 'check'));
    await syncAndStart(config);
    writeWorkflow(config, 'check', runs('check', 'gone'));
    writeWorkflow(config, 'build', VALID);

    const result = await syncAndStart(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/check.yaml:6: field "steps[0].workflow": step "run" runs workflow "gone", which has no runnable version; fix or add workflows/gone.yaml',
    ]);
    expect(result.kept).toEqual(['check']);
    expect(result.cached).toEqual(['build', 'ship']);

    fs.rmSync(path.join(config.repo.localPath, 'workflows', 'check.yaml'));
    const second = await syncAndStart(config);

    expect(second.invalid.map(formatDiagnostic)).toEqual([
      'workflows/ship.yaml:6: field "steps[0].workflow": step "run" runs workflow "check", which has no runnable version; fix or add workflows/check.yaml',
    ]);
    expect(second.kept).toEqual([]);
    expect(second.unrunnable).toEqual(['workflows/ship.yaml']);
    expect(second.cached).toEqual(['build']);
    expect(await startRun(config, 'ship')).toMatchObject({ error: { code: 'workflow_not_found', message: expect.stringContaining('Workflow "ship" has no runnable version') } });
  });

  it('reports a parent whose child has no runnable version because of its own references', async () => {
    const config = testConfig();
    const runs = (name: string, child: string): string => `schemaVersion: v1alpha1
name: ${name}
description: Run ${child}.
steps:
  - id: run
    workflow: ${child}
`;
    writeWorkflow(config, 'ship', runs('ship', 'check'));
    writeWorkflow(config, 'check', runs('check', 'gone'));

    const result = await syncAndStart(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/check.yaml:6: field "steps[0].workflow": step "run" runs workflow "gone", which has no runnable version; fix or add workflows/gone.yaml',
      'workflows/ship.yaml:6: field "steps[0].workflow": step "run" runs workflow "check", which has no runnable version; fix or add workflows/check.yaml',
    ]);
    expect(result.unrunnable).toEqual(['workflows/check.yaml', 'workflows/ship.yaml']);
  });

  it('reports with keys that do not match the inputs of the workflow a step runs', async () => {
    const config = testConfig();
    writeWorkflow(config, 'check', `schemaVersion: v1alpha1
name: check
description: Classify the issue.
inputs:
  issue: number
  title: string
steps:
  - id: classify
    command: node classify.js
`);
    writeWorkflow(config, 'build', VALID);
    writeWorkflow(config, 'ship', `schemaVersion: v1alpha1
name: ship
description: Ship the issue.
steps:
  - id: check
    workflow: check
    with:
      issue: 42
      titel: Fix it
  - id: bare
    needs: []
    workflow: check
  - id: compile
    needs: []
    workflow: build
    with:
      issue: 42
  - id: good
    needs: []
    workflow: check
    with:
      issue: 42
      title: Fix it
`);

    const result = await syncAndStart(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/ship.yaml:7: field "steps[0].with": step "check" with does not pass input "title", which workflow "check" declares',
      'workflows/ship.yaml:9: field "steps[0].with.titel": step "check" with.titel is not an input workflow "check" declares',
      'workflows/ship.yaml:12: field "steps[1].with": step "bare" with does not pass input "issue", which workflow "check" declares',
      'workflows/ship.yaml:12: field "steps[1].with": step "bare" with does not pass input "title", which workflow "check" declares',
      'workflows/ship.yaml:17: field "steps[2].with.issue": step "compile" with.issue is not an input workflow "build" declares',
    ]);
    expect(result.cached).toEqual(['build', 'check']);
  });

  it('reports a read of an output the workflow a step runs does not declare, and drops the parent that read it', async () => {
    const config = testConfig();
    fs.mkdirSync(path.join(config.repo.localPath, 'prompts'));
    fs.writeFileSync(path.join(config.repo.localPath, 'prompts', 'ask.md'), 'Fix {{ steps.check.outputs.verdict }}');
    const check = (name: string): string => `schemaVersion: v1alpha1
name: check
description: Classify the issue.
outputs:
  ${name}: steps.classify.outputs.verdict
steps:
  - id: classify
    command: node classify.js
    output:
      verdict: fix | drop
`;
    writeWorkflow(config, 'check', check('verdict'));
    writeWorkflow(config, 'ship', `schemaVersion: v1alpha1
name: ship
description: Ship the issue.
outputs:
  v: steps.check.outputs.verdict
steps:
  - id: check
    workflow: check
  - id: fix
    needs: [check]
    if: steps.check.outputs.verdict == 'fix'
    command: node fix.js
    env:
      V: "{{ steps.check.outputs.verdict }}"
  - id: ask
    needs: [check]
    prompt_file: prompts/ask.md
`);
    expect((await syncAndStart(config)).cached).toEqual(['check', 'ship']);
    writeWorkflow(config, 'check', check('decision'));

    const result = await syncAndStart(config);

    const undeclared = 'reads steps.check.outputs.verdict, which is not an output workflow "check" declares';
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      `workflows/ship.yaml:14: field "steps[1].env.V": step "fix" env.V ${undeclared}`,
      `workflows/ship.yaml:11: field "steps[1].if": step "fix" if ${undeclared}`,
      `workflows/ship.yaml:5: field "outputs.v": output "v" ${undeclared}`,
      `workflows/ship.yaml:17: field "steps[2].prompt_file": step "ask" prompt_file ${undeclared}`,
    ]);
    expect(result.unrunnable).toEqual(['workflows/ship.yaml']);
    expect(await loadCachedWorkflow(config, 'ship')).toBeNull();
  });

  it('drops the last valid version of an invalid parent that reads an output its child no longer declares', async () => {
    const config = testConfig();
    const check = (name: string): string => `schemaVersion: v1alpha1
name: check
description: Classify the issue.
outputs:
  ${name}: steps.classify.outputs.verdict
steps:
  - id: classify
    command: node classify.js
    output:
      verdict: fix | drop
`;
    const ship = (description: string): string => `schemaVersion: v1alpha1
name: ship
description: ${description}
steps:
  - id: check
    workflow: check
  - id: fix
    needs: [check]
    if: steps.check.outputs.verdict == 'fix'
    command: node fix.js
`;
    writeWorkflow(config, 'check', check('verdict'));
    writeWorkflow(config, 'ship', ship('Ship the issue.'));
    expect((await syncAndStart(config)).cached).toEqual(['check', 'ship']);
    writeWorkflow(config, 'check', check('decision'));
    writeWorkflow(config, 'ship', ship('[not text]'));

    const result = await syncAndStart(config);

    expect(result.cached).toEqual(['check']);
    expect(result.kept).toEqual([]);
    expect(result.unrunnable).toEqual(['workflows/ship.yaml']);
    expect(await loadCachedWorkflow(config, 'ship')).toBeNull();
  });

  it('keeps a last valid version and rejects the revision that would run it in a cycle', async () => {
    const config = testConfig();
    const runs = (name: string, child: string): string => `schemaVersion: v1alpha1
name: ${name}
description: Run ${child}.
steps:
  - id: run
    workflow: ${child}
`;
    writeWorkflow(config, 'a', runs('a', 'b'));
    writeWorkflow(config, 'b', VALID.replace(/build/g, 'b'));
    expect((await syncAndStart(config)).cached).toEqual(['a', 'b']);
    writeWorkflow(config, 'a', runs('a', 'missing'));
    writeWorkflow(config, 'b', runs('b', 'a'));

    const result = await syncAndStart(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/a.yaml:6: field "steps[0].workflow": step "run" runs workflow "missing", which has no runnable version; fix or add workflows/missing.yaml',
      'workflows/b.yaml:6: field "steps[0].workflow": step "run" runs workflow "a" in a cycle: b -> a -> b',
    ]);
    expect(result.cached).toEqual([]);
    expect(result.kept).toEqual(['a', 'b']);
    expect(result.unrunnable).toEqual([]);
    expect(await startRun(config, 'a')).toMatchObject({ data: { name: 'a' } });
  });

  describe('checks every version against the versions the other files settle to', () => {
    type ParentRevision = 'runs child' | 'runs missing' | 'invalid' | 'unreadable' | 'deleted' | 'symlink';
    type ChildRevision = 'command' | 'renames output' | 'runs parent' | 'invalid' | 'unreadable' | 'deleted' | 'symlink';
    type Outcome = 'cached' | 'kept' | 'unrunnable' | 'gone';
    // Before the sync under test, the parent runs the child and reads its verdict, and the child is a command.
    const settles: Array<[ParentRevision, ChildRevision, Outcome, Outcome]> = [
      ['runs child', 'command', 'cached', 'cached'],
      ['runs child', 'renames output', 'unrunnable', 'cached'],
      ['runs child', 'runs parent', 'kept', 'kept'],
      ['runs child', 'invalid', 'cached', 'kept'],
      ['runs child', 'deleted', 'unrunnable', 'gone'],
      ['runs missing', 'command', 'kept', 'cached'],
      ['runs missing', 'renames output', 'unrunnable', 'cached'],
      ['runs missing', 'runs parent', 'kept', 'kept'],
      ['runs missing', 'invalid', 'kept', 'kept'],
      ['runs missing', 'deleted', 'unrunnable', 'gone'],
      ['invalid', 'command', 'kept', 'cached'],
      ['invalid', 'renames output', 'unrunnable', 'cached'],
      ['invalid', 'runs parent', 'kept', 'kept'],
      ['invalid', 'invalid', 'kept', 'kept'],
      ['invalid', 'deleted', 'unrunnable', 'gone'],
      ['deleted', 'command', 'gone', 'cached'],
      ['deleted', 'renames output', 'gone', 'cached'],
      ['deleted', 'runs parent', 'gone', 'kept'],
      ['deleted', 'invalid', 'gone', 'kept'],
      ['deleted', 'deleted', 'gone', 'gone'],
    ];
    // A file that cannot be read is an invalid revision, and a symlink is not a workflow file.
    const sameAs: Record<string, string> = { unreadable: 'invalid', symlink: 'deleted' };
    const canHideFiles = process.platform !== 'win32' && process.getuid?.() !== 0;
    const revisions = [...new Set([...settles.flatMap(([parent, child]) => [parent, child]), ...Object.keys(sameAs)])];
    const cases = [['ship', 'check'], ['alpha', 'beta']].flatMap(([parent, child]) => revisions.flatMap((parentRevision) => revisions.flatMap((childRevision) => {
      const row = settles.find(([p, c]) => p === (sameAs[parentRevision] ?? parentRevision) && c === (sameAs[childRevision] ?? childRevision));
      if (!row || (!canHideFiles && [parentRevision, childRevision].includes('unreadable'))) return [];
      return [{ parent, child, parentRevision: parentRevision as ParentRevision, childRevision: childRevision as ChildRevision, outcome: { [parent]: row[2], [child]: row[3] } }];
    })));
    const parentFile = (name: string, child: string, revision: ParentRevision): string => `schemaVersion: v1alpha1
name: ${name}
description: ${revision === 'invalid' ? '[not text]' : 'Ship the issue.'}
steps:
  - id: check
    workflow: ${child}
  - id: fix
    needs: [check]
    if: steps.check.outputs.verdict == 'fix'
    command: node fix.js
${revision === 'runs missing' ? '  - id: other\n    needs: []\n    workflow: missing\n' : ''}`;
    const childFile = (name: string, parent: string, revision: ChildRevision): string => `schemaVersion: v1alpha1
name: ${name}
description: ${revision === 'invalid' ? '[not text]' : 'Classify the issue.'}
outputs:
  ${revision === 'renames output' ? 'decision' : 'verdict'}: steps.classify.outputs.verdict
steps:
  - id: classify
    command: node classify.js
    output:
      verdict: fix | drop
${revision === 'runs parent' ? `  - id: again\n    needs: [classify]\n    workflow: ${parent}\n` : ''}`;
    const revise = (config: LocalConfig, name: string, revision: string, body: string): void => {
      const file = path.join(config.repo.localPath, 'workflows', `${name}.yaml`);
      fs.rmSync(file);
      if (revision === 'deleted') return;
      if (revision === 'symlink') {
        const outside = path.join(path.dirname(config.repo.localPath), `${name}.yaml`);
        fs.writeFileSync(outside, body);
        fs.symlinkSync(outside, file);
        return;
      }
      fs.writeFileSync(file, body);
      if (revision === 'unreadable') fs.chmodSync(file, 0o000);
    };
    const outcomeOf = (result: SyncWorkflowResult, name: string): Outcome => (result.cached.includes(name) ? 'cached'
      : result.kept.includes(name) ? 'kept' : result.unrunnable.includes(`workflows/${name}.yaml`) ? 'unrunnable' : 'gone');

    it.each(cases)('$parent runs $child: parent $parentRevision, child $childRevision', async ({ parent, child, parentRevision, childRevision, outcome }) => {
      const config = testConfig();
      writeWorkflow(config, parent, parentFile(parent, child, 'runs child'));
      writeWorkflow(config, child, childFile(child, parent, 'command'));
      expect((await syncAndStart(config)).cached).toEqual([parent, child].sort());
      revise(config, parent, parentRevision, parentFile(parent, child, parentRevision));
      revise(config, child, childRevision, childFile(child, parent, childRevision));

      const result = await syncAndStart(config);

      expect({ [parent]: outcomeOf(result, parent), [child]: outcomeOf(result, child) }).toEqual(outcome);
      for (const name of [parent, child]) {
        const runnable = outcome[name] === 'cached' || outcome[name] === 'kept';
        expect(await loadCachedWorkflow(config, name) !== null, `${name} has a cached version`).toBe(runnable);
      }
    });
  });

  it('reports an if that compares a sub-workflow end with a name the workflow does not declare in ends', async () => {
    const config = testConfig();
    writeWorkflow(config, 'check', `schemaVersion: v1alpha1
name: check
description: Classify the issue.
ends:
  ready: succeeded
steps:
  - id: classify
    command: node classify.js
    end: ready
`);
    writeWorkflow(config, 'build', VALID);
    writeWorkflow(config, 'ship', `schemaVersion: v1alpha1
name: ship
description: Ship the issue.
steps:
  - id: check
    workflow: check
  - id: compile
    needs: []
    workflow: build
  - id: fix
    needs: [check, compile]
    if: steps.check.end == 'redy' || (steps.compile.end != 'done' && 'ready' == steps.check.end)
    command: node fix.js
`);

    const result = await syncAndStart(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/ship.yaml:12: field "steps[2].if": step "fix" if compares steps.check.end with \'redy\', which is not an end workflow "check" declares',
      'workflows/ship.yaml:12: field "steps[2].if": step "fix" if compares steps.compile.end with \'done\', which is not an end workflow "build" declares',
    ]);
    expect(result.unrunnable).toEqual(['workflows/ship.yaml']);
  });

  it('reports recursion through a workflow file run from an inline workflow in every file of the cycle', async () => {
    const config = testConfig();
    writeWorkflow(config, 'inline-a', `schemaVersion: v1alpha1
name: inline-a
description: Runs inline-b from an inline workflow.
steps:
  - id: group
    workflow:
      steps:
        - id: run-b
          workflow: inline-b
`);
    writeWorkflow(config, 'inline-b', `schemaVersion: v1alpha1
name: inline-b
description: Runs inline-a.
steps:
  - id: run-a
    workflow: inline-a
`);

    const result = await syncAndStart(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/inline-a.yaml:9: field "steps[0].workflow.steps[0].workflow": step "run-b" runs workflow "inline-b" in a cycle: inline-a -> inline-b -> inline-a',
      'workflows/inline-b.yaml:6: field "steps[0].workflow": step "run-a" runs workflow "inline-a" in a cycle: inline-b -> inline-a -> inline-b',
    ]);
    expect(result.unrunnable).toEqual(['workflows/inline-a.yaml', 'workflows/inline-b.yaml']);
  });

  it('checks what an inline step reads of an enclosing workflow step against the workflow file that step runs', async () => {
    const config = testConfig();
    writeWorkflow(config, 'inline-check', `schemaVersion: v1alpha1
name: inline-check
description: Classify the issue.
ends:
  ready: succeeded
outputs:
  verdict: steps.classify.outputs.verdict
steps:
  - id: classify
    command: node classify.js
    output:
      verdict: fix | drop
  - id: done
    needs: [classify]
    end: ready
`);
    writeWorkflow(config, 'inline-ship', `schemaVersion: v1alpha1
name: inline-ship
description: Read a sub-workflow from an inline workflow.
steps:
  - id: check
    workflow: inline-check
  - id: group
    needs: [check]
    workflow:
      steps:
        - id: note
          if: steps.check.end == 'redy' && steps.check.outputs.verdcit == 'fix'
          command: node note.js
`);

    const result = await syncAndStart(config);

    expect(result.invalid.map((diagnostic) => [formatDiagnostic(diagnostic), diagnostic.code])).toEqual([
      ['workflows/inline-ship.yaml:12: field "steps[1].workflow.steps[0].if": step "note" if reads steps.check.outputs.verdcit, which is not an output workflow "inline-check" declares', 'undeclared_output'],
      ['workflows/inline-ship.yaml:12: field "steps[1].workflow.steps[0].if": step "note" if compares steps.check.end with \'redy\', which is not an end workflow "inline-check" declares', 'undeclared_end'],
    ]);
  });

  it('reports a read of an output an inline workflow does not declare', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Read an inline workflow's outputs.
steps:
  - id: grp
    workflow:
      outputs:
        verdict: steps.classify.outputs.verdict
      steps:
        - id: classify
          command: node classify.js
          output:
            verdict: fix | drop
  - id: use
    needs: [grp]
    if: steps.grp.outputs.verdict == 'fix' && steps.grp.outputs.nope == 'x'
    command: node use.js
`);

    const result = await syncAndStart(config);

    expect(result.invalid.map((diagnostic) => [formatDiagnostic(diagnostic), diagnostic.code])).toEqual([
      ['workflows/build.yaml:16: field "steps[1].if": step "use" if reads steps.grp.outputs.nope, which is not an output the inline workflow of step "grp" declares', 'undeclared_output'],
    ]);
  });

  it('reports an if that compares an inline workflow end with a name it does not declare in ends', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Read an inline workflow's end.
steps:
  - id: grp
    workflow:
      ends:
        ready: succeeded
      steps:
        - id: classify
          command: node classify.js
          end: ready
  - id: use
    needs: [grp]
    if: steps.grp.end == 'ready' || steps.grp.end == 'unknown'
    command: node use.js
`);

    const result = await syncAndStart(config);

    expect(result.invalid.map((diagnostic) => [formatDiagnostic(diagnostic), diagnostic.code])).toEqual([
      ['workflows/build.yaml:15: field "steps[1].if": step "use" if compares steps.grp.end with \'unknown\', which is not an end the inline workflow of step "grp" declares', 'undeclared_end'],
    ]);
  });

  it('reports a model on a command or workflow step with the file and step, and does not cache that version', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: compile
    command: npm run build
  - id: check
    needs: [compile]
    workflow:
      steps:
        - id: lint
          command: npm run lint
`);
    expect((await syncWorkflowDefinitions(config)).cached).toEqual(['build']);
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: compile
    command: npm run build
    model: strong
  - id: check
    needs: [compile]
    workflow:
      steps:
        - id: lint
          command: npm run lint
    model: fast
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).toEqual([]);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].model": model is only allowed on a prompt or prompt_file step',
      'workflows/build.yaml:14: field "steps[1].model": model is only allowed on a prompt or prompt_file step',
    ]);
    expect((await loadCachedWorkflow(config, 'build'))?.definition.steps.some((step) => step.model !== undefined)).toBe(false);
  });
});
