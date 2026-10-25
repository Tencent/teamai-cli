import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { resolveWorkflowEnv } from '../env-resolution.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { inProcessClient } from '../workflow/protocol.js';
import { readRun, RunIdSchema } from '../workflow/store.js';
import { githubOrigin } from './helpers/skill-harness.js';

// Three roots: `a`, the report under test; `ship`, which opens a pull request, so it waits in `delivering` for the next
// `next` to deliver it; and `c`, which stays leased.
const THREE = `schemaVersion: v1alpha1
name: three
description: A command, a change that opens a pull request, and another command
steps:
  - id: a
    command: echo a
  - id: ship
    needs: []
    workspace: new
    command: echo ship
    deliver: pr
  - id: c
    needs: []
    command: echo c
`;

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' });
}

async function fixture(workflows: Record<string, string>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-protocol-report-')));
  dirs.push(root);
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'README.md'), 'hello\n');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  githubOrigin({ root, work });
  fs.mkdirSync(path.join(root, 'knowledge', 'workflows'), { recursive: true });
  for (const [name, yaml] of Object.entries(workflows)) fs.writeFileSync(path.join(root, 'knowledge', 'workflows', `${name}.yaml`), yaml);
  const config: LocalConfig = { repo: { kind: 'self', localPath: path.join(root, 'knowledge'), remote: 'local' }, username: 'test', scope: 'project', additionalRoles: [], projectRoot: work, dataHome: path.join(root, 'data') };
  await syncWorkflowDefinitions(config);
  return { config, work, client: inProcessClient({ config, env: await resolveWorkflowEnv(config) }) };
}

const LeaseSchema = z.object({ data: z.object({ lease: z.object({ attempt: z.string(), revision: z.number(), step: z.string(), cwd: z.string().optional() }) }) });

describe('a report through the protocol', () => {
  it('changes only its own attempt: a sibling that waits to be delivered and one still leased stay as they were, and the revision moves by one', async () => {
    const { config, work, client } = await fixture({ three: THREE });
    const driver = { kind: 'external', machine: 'test', workspace: work, can: { workspace: ['read-only', 'new', 'continue'] } };
    const started = await client.start('three', { checkout: work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
    if (!('data' in started)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.run);
    const a = LeaseSchema.parse(await client.next(run, { driver, running: [] })).data.lease;
    const ship = LeaseSchema.parse(await client.next(run, { driver, running: [a.attempt] }, { prepare: true })).data.lease;
    const c = LeaseSchema.parse(await client.next(run, { driver, running: [a.attempt, ship.attempt] })).data.lease;
    expect([a.step, ship.step, c.step]).toEqual(['a', 'ship', 'c']);
    if (ship.cwd === undefined) throw new Error('ship was prepared without a place');
    fs.writeFileSync(path.join(ship.cwd, 'shipped.txt'), 'shipped\n');
    // No next comes after this report, so ship waits in delivering for the next one to open its pull request.
    expect(await client.report(run, { attempt: ship.attempt, revision: ship.revision, outcome: 'success', driver })).toMatchObject({ data: { accepted: true, step: { id: 'ship', status: 'delivering' } } });
    const before = await readRun(config, run);
    if (typeof before !== 'object') throw new Error(String(before));

    expect(await client.report(run, { attempt: a.attempt, revision: a.revision, outcome: 'success', driver })).toMatchObject({ data: { accepted: true, step: { id: 'a', status: 'succeeded' } } });

    const after = await readRun(config, run);
    if (typeof after !== 'object') throw new Error(String(after));
    expect(after.revision).toBe(before.revision + 1);
    expect(after.steps.filter((step) => step.id !== 'a')).toEqual(before.steps.filter((step) => step.id !== 'a'));
    expect(after.steps.find((step) => step.id === 'ship')).toMatchObject({ status: 'delivering' });
  });
});
