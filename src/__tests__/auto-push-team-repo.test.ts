import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { autoPushTeamRepo, createGit } from '../utils/git.js';

let root: string;
let remote: string;
let member: string;

async function clone(dir: string) {
  await createGit(root).clone(remote, dir);
  const git = createGit(dir);
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  return git;
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-push-team-repo-'));
  remote = path.join(root, 'team.git');
  const seed = path.join(root, 'seed');
  await createGit(root).raw(['init', '--bare', '-b', 'main', remote]);
  await fs.mkdir(seed);
  const seedGit = createGit(seed);
  await seedGit.init(['-b', 'main']);
  await seedGit.addConfig('user.name', 'Test');
  await seedGit.addConfig('user.email', 'test@example.com');
  await fs.writeFile(path.join(seed, 'teamai.yaml'), 'team: test\n');
  await seedGit.add('.');
  await seedGit.commit('team');
  await seedGit.push([remote, 'main']);
  member = path.join(root, 'member');
  await clone(member);
});

afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('autoPushTeamRepo', () => {
  it('throws with a next step when the push is rejected because main moved', async () => {
    const other = await clone(path.join(root, 'other'));
    await fs.writeFile(path.join(root, 'other', 'other.md'), 'other member\n');
    await other.add('.');
    await other.commit('other member pushed first');
    await other.push(['origin', 'main']);

    await fs.mkdir(path.join(member, 'svc'));
    await fs.writeFile(path.join(member, 'svc', 'index.md'), 'imported\n');

    await expect(autoPushTeamRepo(member, '[teamai] Import from local dir: svc')).rejects.toThrow(
      /^Push to the team repo failed: .*failed to push some refs.*Run `teamai pull`, then rerun this command\.$/s,
    );
  });
});
