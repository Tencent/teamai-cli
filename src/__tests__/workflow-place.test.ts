import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkflowEnv } from '../env-resolution.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { runConformanceScenario, type ConformanceClient } from '../workflow/conformance-interpreter.js';
import { PLACE_CHECKOUT_FILES, workflowPlaceConformanceScenarios } from '../workflow/conformance.js';
import { inProcessClient } from '../workflow/protocol.js';
import { pendingRecords } from '../workflow/records.js';
import { findRunConfig } from '../workflow/run-location.js';
import { cancelRun } from '../workflow/run-controls.js';
import { readRun } from '../workflow/store.js';

vi.mock('../pull.js', () => ({ pull: vi.fn() }));
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
async function fixture(yaml?: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-place-'))); dirs.push(root);
  const home = path.join(root, 'home'); fs.mkdirSync(home); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  const work = path.join(root, 'work'); const repo = path.join(root, 'knowledge'); const remote = path.join(root, 'remote.git');
  fs.mkdirSync(work); fs.mkdirSync(path.join(repo, 'workflows'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main'); git(work, 'config', 'user.name', 'Test'); git(work, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(work, 'AGENTS.md'), 'Trusted base instructions.\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'fixture'); git(work, 'init', '-q', '--bare', '-b', 'main', remote);
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', '-q', 'origin', 'main');
  const config: LocalConfig = { repo: { kind: 'self', localPath: repo, remote }, username: 'test', scope: 'project', projectRoot: work, additionalRoles: [], dataHome: path.join(home, '.teamai', 'projects', 'fixture') };
  fs.mkdirSync(path.join(home, '.teamai', 'projects', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(home, '.teamai', 'projects', 'fixture', 'config.yaml'), YAML.stringify(config));
  fs.writeFileSync(path.join(repo, 'workflows', 'build.yaml'), yaml ?? `schemaVersion: v1alpha1
name: build
description: Session work.
invoke: allow
alias: ship
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          prompt: Edit the project.
        - id: polish
          needs: [write]
          prompt: Polish the project.
`);
  await syncWorkflowDefinitions(config);
  const env = await resolveWorkflowEnv(config);
  const client = inProcessClient({ config, env });
  const started = await client.start('ship', { checkout: work });
  if ('error' in started) throw new Error(started.error.message);
  return { config, env, client, work, remote, runId: String(started.data.run), driver: { kind: 'skill', machine: 'fixture', workspace: work } };
}
async function next(f: Awaited<ReturnType<typeof fixture>>) {
  const answer = await f.client.next(f.runId, { driver: { ...f.driver, can: { hitl: true, workspace: ['read-only', 'new', 'continue'] } } }, { prepare: true });
  if ('error' in answer || !answer.data.lease) throw new Error(JSON.stringify({ answer, run: await readRun(f.config, f.runId) }));
  return answer.data.lease as { attempt: string; revision: number; step: string; cwd: string; workspace: { branch: string } };
}

describe('prepared places through the workflow client', () => {
  it.each([false, true])('preserves interactive prompt write permissions with explicit read-only=%s', async (readOnly) => {
    const f = await fixture(`schemaVersion: v1alpha1\nname: build\ndescription: Interactive session.\nalias: ship\nsteps:\n  - id: pair\n    prompt: Pair on the code.\n    interactive: true\n${readOnly ? '    workspace: read-only\n' : ''}`);
    const lease = await next(f);
    fs.writeFileSync(path.join(lease.cwd, 'pair.txt'), 'human edits\n');
    expect(await f.client.report(f.runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: f.driver }))
      .toMatchObject({ data: { accepted: true, step: { status: readOnly ? 'failed' : 'succeeded' } } });
    expect(fs.readFileSync(path.join(f.work, 'pair.txt'), 'utf8')).toBe('human edits\n');
  });
  it('reuses a prepared lease without overwriting edits, restores base instructions, and reports committed changes', async () => {
    const f = await fixture(); const first = await next(f);
    expect(await findRunConfig(f.runId, { ...f.config, projectRoot: first.cwd })).toMatchObject({ config: { projectRoot: f.work } });
    fs.writeFileSync(path.join(first.cwd, 'code.txt'), 'first\n'); fs.writeFileSync(path.join(first.cwd, 'AGENTS.md'), 'Untrusted branch instructions.\n');
    expect((await next(f)).cwd).toBe(first.cwd);
    expect(fs.readFileSync(path.join(first.cwd, 'code.txt'), 'utf8')).toBe('first\n');
    const report = { attempt: first.attempt, revision: first.revision, outcome: 'success' as const, driver: f.driver };
    expect(await f.client.report(f.runId, report)).toMatchObject({ data: { accepted: true } });
    const committed = git(f.work, 'rev-parse', first.workspace.branch);
    expect(await f.client.report(f.runId, report)).toMatchObject({ error: { code: 'repeated_report' } });
    expect(git(f.work, 'rev-parse', first.workspace.branch)).toBe(committed);
    const second = await next(f);
    expect(fs.readFileSync(path.join(second.cwd, 'AGENTS.md'), 'utf8')).toBe('Trusted base instructions.\n');
    fs.appendFileSync(path.join(second.cwd, 'code.txt'), 'second\n');
    expect(await f.client.report(f.runId, { attempt: second.attempt, revision: second.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true, cleanup: true } });
    expect(git(f.remote, 'show', `${first.workspace.branch}:code.txt`)).toBe('first\nsecond');
    expect(fs.existsSync(second.cwd)).toBe(false);
    const attempts = path.join(f.config.dataHome ?? '', 'workflows', 'runs', f.runId, 'attempts');
    const stored = fs.readdirSync(attempts).map((attempt) => fs.readFileSync(path.join(attempts, attempt, 'place.json'), 'utf8')).join('\n');
    expect(stored).not.toContain('Edit the project.'); expect(stored).not.toContain('Untrusted branch instructions.');
  });
  it.each(['success', 'failed'] as const)('preserves a prepared writer when origin rejects a %s report push', async (outcome) => {
    const f = await fixture();
    const lease = await next(f);
    fs.writeFileSync(path.join(lease.cwd, 'code.txt'), 'keep this work');
    const hook = path.join(f.remote, 'hooks/pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const answer = await f.client.report(f.runId, { attempt: lease.attempt, revision: lease.revision, outcome, driver: f.driver,
      ...(outcome === 'failed' ? { failure: { code: 'tool_failed', message: 'Original tool failure' } } : {}) });
    expect(answer).toMatchObject({ data: { accepted: true, step: { status: 'failed' } } });
    const run = await readRun(f.config, f.runId);
    expect(run).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ id: 'change.write', status: 'failed', failure: { code: outcome === 'success' ? 'push_failed' : 'tool_failed', message: expect.stringContaining('push') } })]) });
    expect(fs.existsSync(lease.cwd)).toBe(true);
    expect(git(f.work, 'show', `${lease.workspace.branch}:code.txt`)).toBe('keep this work');
  });

  it('does not commit or push a cancelled attempt', async () => {
    const f = await fixture(); const lease = await next(f); fs.writeFileSync(path.join(lease.cwd, 'code.txt'), 'preserve me');
    const before = git(f.work, 'rev-parse', lease.workspace.branch);
    await cancelRun(f.config, f.runId, f.env.secrets);
    expect(await f.client.report(f.runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: f.driver })).toMatchObject({ error: { code: 'lease_cancelled' } });
    expect(git(f.work, 'rev-parse', lease.workspace.branch)).toBe(before);
    expect(fs.readFileSync(path.join(lease.cwd, 'code.txt'), 'utf8')).toBe('preserve me');
  });
});

describe('workflow place conformance in process', () => {
  for (const scenario of workflowPlaceConformanceScenarios) {
    it(scenario.name, async () => {
      for (const [name, value] of Object.entries(scenario.env ?? {})) vi.stubEnv(name, value);
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-place-conformance-')));
      dirs.push(root);
      const knowledge = path.join(root, 'knowledge');
      const checkout = path.join(root, 'checkout');
      const origin = path.join(root, 'origin.git');
      fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
      git(root, 'init', '-q', '-b', 'main', checkout);
      git(checkout, 'config', 'user.name', 'Test');
      git(checkout, 'config', 'user.email', 'test@example.invalid');
      for (const [file, text] of Object.entries(PLACE_CHECKOUT_FILES)) fs.writeFileSync(path.join(checkout, file), text);
      git(checkout, 'add', '-A');
      git(checkout, 'commit', '-qm', 'initial');
      git(root, 'init', '-q', '--bare', '-b', 'main', origin);
      git(checkout, 'remote', 'add', 'origin', origin);
      git(checkout, 'push', '-q', 'origin', 'main');
      const config: LocalConfig = {
        repo: { localPath: knowledge, remote: 'local', kind: 'self' },
        username: 'tester',
        scope: 'project',
        additionalRoles: [],
        projectRoot: checkout,
        dataHome: path.join(root, 'data'),
      };
      fs.writeFileSync(path.join(knowledge, 'workflows', `${scenario.workflowName}.yaml`), scenario.yaml);
      for (const [name, yaml] of Object.entries(scenario.workflows ?? {})) fs.writeFileSync(path.join(knowledge, 'workflows', `${name}.yaml`), yaml);
      await syncWorkflowDefinitions(config);
      const inner = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
      // Every call gets a temporary directory of its own, gone once it returns, as a process of its own would.
      let calls = 0;
      const own = async <T>(call: () => Promise<T>): Promise<T> => {
        calls += 1;
        const tmp = path.join(root, `tmp-${calls}`);
        fs.mkdirSync(tmp);
        vi.stubEnv('TMPDIR', tmp);
        try {
          return await call();
        } finally {
          vi.stubEnv('TMPDIR', root);
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      };
      const client: ConformanceClient = {
        start: (name) => own(() => inner.start(name, { checkout })),
        next: (run, body, options) => own(() => inner.next(run, body, options)),
        report: (run, body) => own(() => inner.report(run, body)),
        respond: (run, step, choice, options) => own(() => inner.respond(run, step, choice, options)),
        retry: (run, step) => own(() => inner.retry(run, step)),
        cancel: (run, step) => own(() => inner.cancel(run, step)),
      };
      await runConformanceScenario(scenario, {
        client,
        readRun: async (runId) => {
          const stored = await readRun(config, runId);
          if (typeof stored !== 'object') throw new Error('run was not stored');
          return stored;
        },
        readEndRecord: async (runId) => (await pendingRecords(config)).find((record) => record.run === runId && record.phase === 'end'),
        advance: async (ms) => {
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(Date.now() + ms);
        },
        expect,
        place: { checkout, origin },
      });
    });
  }
});
