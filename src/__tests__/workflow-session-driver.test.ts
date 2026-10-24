import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkflowEnv } from '../env-resolution.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, startRun } from '../workflow/engine.js';
import { findRunConfig } from '../workflow/run-location.js';
import { cancelRun } from '../workflow/run-controls.js';
import { prepareSessionLease, reportSessionLease } from '../workflow/session-driver.js';
import { readRun, runFilePath } from '../workflow/store.js';

vi.mock('../pull.js', () => ({ pull: vi.fn() }));
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
async function fixture(yaml?: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-driver-'))); dirs.push(root);
  const home = path.join(root, 'home'); fs.mkdirSync(home); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  const work = path.join(root, 'work'); const repo = path.join(root, 'knowledge'); const remote = path.join(root, 'remote.git');
  fs.mkdirSync(work); fs.mkdirSync(path.join(repo, 'workflows'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main'); git(work, 'config', 'user.name', 'Test'); git(work, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(work, 'AGENTS.md'), 'Trusted base instructions.\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'fixture'); git(work, 'init', '-q', '--bare', '-b', 'main', remote);
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', '-q', 'origin', 'main');
  const config: LocalConfig = { repo: { kind: 'self', localPath: repo, remote }, username: 'test', scope: 'project', projectRoot: work, additionalRoles: [], dataHome: path.join(home, '.teamai', 'projects', 'fixture') };
  fs.mkdirSync(config.dataHome!, { recursive: true }); fs.writeFileSync(path.join(config.dataHome!, 'config.yaml'), YAML.stringify(config));
  fs.writeFileSync(path.join(repo, 'workflows', 'build.yaml'), yaml ?? `schemaVersion: v1alpha1
name: build
description: Session work.
invocable: true
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
  const started = await startRun(config, 'ship', {}, { secrets: env.secrets, checkout: work, base: { ref: 'main', commit: git(work, 'rev-parse', 'HEAD') } });
  if ('error' in started) throw new Error(started.error.message);
  return { config, env, work, repo, remote, root, runId: String(started.data.run), driver: { kind: 'skill', machine: 'fixture', workspace: work } };
}
async function next(f: Awaited<ReturnType<typeof fixture>>) {
  const answer = await leaseNext(f.config, f.runId, f.driver, { can: { hitl: true, workspace: ['read-only', 'new', 'continue'] } });
  if ('error' in answer || !answer.data.lease) throw new Error(JSON.stringify({ answer, run: await readRun(f.config, f.runId) }));
  const raw = answer.data.lease as { attempt: string; revision: number; step: string };
  const prepared = await prepareSessionLease(f.config, f.runId, f.driver, raw, f.env);
  if ('error' in prepared) throw new Error(prepared.error.message);
  return prepared.data.lease as typeof raw & { cwd: string; workspace: { branch: string } };
}

describe('session driver public workspace operations (#1086)', () => {
  it.each([false, true])('preserves interactive prompt write permissions with explicit read-only=%s', async (readOnly) => {
    const f = await fixture(`schemaVersion: v1alpha1\nname: build\ndescription: Interactive session.\nalias: ship\nsteps:\n  - id: pair\n    prompt: Pair on the code.\n    interactive: true\n${readOnly ? '    workspace: read-only\n' : ''}`);
    const lease = await next(f);
    fs.writeFileSync(path.join(lease.cwd, 'pair.txt'), 'human edits\n');
    expect(await reportSessionLease(f.config, f.runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: f.driver }, f.env))
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
    expect(await reportSessionLease(f.config, f.runId, report, f.env)).toMatchObject({ data: { accepted: true } });
    const committed = git(f.work, 'rev-parse', first.workspace.branch);
    expect(await reportSessionLease(f.config, f.runId, report, f.env)).toMatchObject({ error: { code: 'repeated_report' } });
    expect(git(f.work, 'rev-parse', first.workspace.branch)).toBe(committed);
    const second = await next(f);
    expect(fs.readFileSync(path.join(second.cwd, 'AGENTS.md'), 'utf8')).toBe('Trusted base instructions.\n');
    fs.appendFileSync(path.join(second.cwd, 'code.txt'), 'second\n');
    expect(await reportSessionLease(f.config, f.runId, { attempt: second.attempt, revision: second.revision, outcome: 'success', driver: f.driver }, f.env)).toMatchObject({ data: { accepted: true, cleanup: true } });
    expect(git(f.remote, 'show', `${first.workspace.branch}:code.txt`)).toBe('first\nsecond');
    expect(fs.existsSync(second.cwd)).toBe(false);
    const markers = path.join(f.config.dataHome!, 'workflows', 'runs', f.runId, 'attempts');
    const stored = fs.readdirSync(markers).map((attempt) => fs.readFileSync(path.join(markers, attempt, 'workspace.json'), 'utf8')).join('\n');
    expect(stored).not.toContain('Edit the project.'); expect(stored).not.toContain('Untrusted branch instructions.');
  });
  it.each(['success', 'failed'] as const)('preserves a prepared writer when origin rejects a %s report push', async (outcome) => {
    const f = await fixture();
    const lease = await next(f);
    fs.writeFileSync(path.join(lease.cwd, 'code.txt'), 'keep this work');
    const hook = path.join(f.remote, 'hooks/pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const answer = await reportSessionLease(f.config, f.runId, { attempt: lease.attempt, revision: lease.revision, outcome, driver: f.driver,
      ...(outcome === 'failed' ? { failure: { code: 'tool_failed', message: 'Original tool failure' } } : {}) }, f.env);
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
    expect(await reportSessionLease(f.config, f.runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: f.driver }, f.env)).toMatchObject({ error: { code: 'lease_cancelled' } });
    expect(git(f.work, 'rev-parse', lease.workspace.branch)).toBe(before);
    expect(fs.readFileSync(path.join(lease.cwd, 'code.txt'), 'utf8')).toBe('preserve me');
  });
  it('finds a run without a current scope and rejects duplicate ids across scopes', async () => {
    const f = await fixture();
    expect(await findRunConfig(f.runId)).toMatchObject({ config: { projectRoot: f.work }, run: { id: f.runId } });
    const other = path.join(f.root, 'home', '.teamai', 'projects', 'duplicate'); fs.mkdirSync(path.join(other, 'workflows', 'runs'), { recursive: true });
    fs.copyFileSync(path.join(f.config.dataHome!, 'config.yaml'), path.join(other, 'config.yaml'));
    const run = await readRun(f.config, f.runId);
    fs.writeFileSync(path.join(other, 'workflows', 'runs', `${f.runId}.json`), JSON.stringify(run));
    expect(await findRunConfig(f.runId)).toMatchObject({ error: { code: 'ambiguous_run' } });
    expect(fs.existsSync(runFilePath(f.config, f.runId))).toBe(true);
  });
});
