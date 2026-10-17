import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveStateForScope } from '../config.js';
import { checkoutRecordKey, teamDelivery, type CheckoutRecord } from '../pull.js';
import { StateSchema, type LocalConfig } from '../types.js';
import { commitFile, initRepo } from './helpers/delivered-checkout.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A project checkout, a team clone with two commits, and the config that pulls one into the other. */
function fixture(): { config: LocalConfig; first: string; second: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-team-delivery-'));
  dirs.push(root);
  const team = path.join(root, 'team');
  const project = path.join(root, 'project');
  initRepo(team);
  initRepo(project);
  commitFile(project, 'README.md');
  const first = commitFile(team, 'one.md');
  const second = commitFile(team, 'two.md');
  const config: LocalConfig = {
    repo: { localPath: team, remote: 'local', kind: 'git' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: project,
    dataHome: path.join(root, 'data'),
  };
  return { config, first, second };
}

async function record(config: LocalConfig, entry: CheckoutRecord | undefined, lastPullRev: string | null = 'x'): Promise<void> {
  const key = await checkoutRecordKey(config);
  await saveStateForScope(StateSchema.parse({
    lastPullRev,
    ...(entry && key ? { lastPullByWorkspace: { [key]: entry } } : {}),
  }), config);
}

describe('teamDelivery (#1176)', () => {
  it('is complete for a delivered tool and names the full commit of rev', async () => {
    const { config, first } = fixture();
    await record(config, { rev: first.slice(0, 7), targets: ['claude'], delivered: {} });

    expect(await teamDelivery(config, 'claude')).toMatchObject({
      complete: true,
      key: await checkoutRecordKey(config),
      commit: first,
    });
  });

  it('has no record for a checkout no pull wrote', async () => {
    const { config } = fixture();
    await record(config, undefined);

    expect(await teamDelivery(config, 'claude')).toMatchObject({ complete: false, gap: 'no_record' });
  });

  it('fails on a pending forced full sync before reading the team clone', async () => {
    const { config, first } = fixture();
    await record(config, { rev: first.slice(0, 7), targets: ['claude'], delivered: {} }, null);
    // A team clone that cannot resolve anything: a git read would report unresolved_revision.
    fs.rmSync(config.repo.localPath, { recursive: true, force: true });

    expect(await teamDelivery(config, 'claude')).toMatchObject({ complete: false, gap: 'pending_full_sync' });
  });

  it('fails on a record a forced full sync elsewhere reset', async () => {
    const { config } = fixture();
    await record(config, { rev: '', targets: ['claude'], delivered: {} });

    expect(await teamDelivery(config, 'claude')).toMatchObject({ complete: false, gap: 'awaiting_full_sync' });
  });

  it('fails on a record without a delivered baseline', async () => {
    const { config, first } = fixture();
    await record(config, { rev: first.slice(0, 7), targets: ['claude'] });

    expect(await teamDelivery(config, 'claude')).toMatchObject({ complete: false, gap: 'no_baseline' });
  });

  it('fails for a tool the record does not target', async () => {
    const { config, first } = fixture();
    await record(config, { rev: first.slice(0, 7), targets: ['codex'], delivered: {} });

    expect(await teamDelivery(config, 'claude')).toMatchObject({ complete: false, gap: 'tool_not_delivered' });
  });

  it('fails on a rev the team clone does not have', async () => {
    const { config } = fixture();
    await record(config, { rev: 'deadbee', targets: ['claude'], delivered: {} });

    expect(await teamDelivery(config, 'claude')).toMatchObject({ complete: false, gap: 'unresolved_revision' });
  });

  it('stays complete when every push base is rev, short or full', async () => {
    const { config, first } = fixture();
    await record(config, { rev: first.slice(0, 7), targets: ['claude'], delivered: {}, pushBaseRevs: [first, first.slice(0, 7)] });

    expect(await teamDelivery(config, 'claude')).toMatchObject({ complete: true, commit: first });
  });

  it('fails when a push base resolves to another commit', async () => {
    const { config, first, second } = fixture();
    await record(config, { rev: first.slice(0, 7), targets: ['claude'], delivered: {}, pushBaseRevs: [second, first] });

    expect(await teamDelivery(config, 'claude')).toMatchObject({ complete: false, gap: 'mixed_revisions' });
  });
});
