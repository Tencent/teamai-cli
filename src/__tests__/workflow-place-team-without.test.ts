import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitWithout } from '../workflow/place/team-without.js';
import { git } from '../workflow/worktree.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A team repo whose one commit holds a rule, an agent, CLAUDE.md, a shared and a namespaced skill; and that commit. */
function team(): { source: string; revision: string } {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-team-without-'));
  dirs.push(source);
  const files = {
    'teamai.yaml': 'team: acme\n', 'CLAUDE.md': 'Be kind.\n', 'rules/commits.md': 'Small commits.\n', 'agents/reviewer.md': 'Review.\n',
    'skills/release/SKILL.md': 'Release.\n', 'skills/dev/deploy/SKILL.md': 'Deploy.\n', 'skills/dev/deploy/notes.md': 'Notes.\n',
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), text);
  }
  run(source, 'init', '-q', '-b', 'main');
  run(source, 'add', '-A');
  run(source, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'seed');
  return { source, revision: run(source, 'rev-parse', 'HEAD') };
}

/** A bare repo holding only `revision`, fetched from `source`, as a clone's team.git does. */
function bareAt(source: string, revision: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-team-without-bare-'));
  dirs.push(root);
  const bare = path.join(root, 'team.git');
  run(root, 'init', '-q', '--bare', bare);
  run(bare, 'fetch', '-q', '--no-tags', source, `${revision}:refs/heads/main`);
  return bare;
}

describe('commitWithout', () => {
  it("makes the revision's tree without the listed file and directories, with the revision as its parent", async () => {
    const { source, revision } = team();
    const bare = bareAt(source, revision);

    const made = await commitWithout(git, { repo: bare, revision, paths: ['agents/reviewer.md', 'rules/commits.md', 'skills/dev/deploy'] });

    if (!('commit' in made)) throw new Error(made.failed);
    expect(run(bare, 'ls-tree', '-r', '--name-only', made.commit).split('\n')).toEqual(['CLAUDE.md', 'skills/release/SKILL.md', 'teamai.yaml']);
    expect(run(bare, 'rev-parse', `${made.commit}^`)).toBe(revision);
  });

  it('makes the same commit of the same revision and paths in another repo, later', async () => {
    const { source, revision } = team();
    const paths = ['CLAUDE.md', 'skills/release'];

    const first = await commitWithout(git, { repo: bareAt(source, revision), revision, paths });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await commitWithout(git, { repo: bareAt(source, revision), revision, paths });

    expect('commit' in first && first.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(second).toEqual(first);
  });

  it('names the git step that failed for a revision the repo does not hold', async () => {
    const { source, revision } = team();

    const made = await commitWithout(git, { repo: bareAt(source, revision), revision: 'f'.repeat(40), paths: ['CLAUDE.md'] });

    expect(made).toEqual({ failed: expect.stringMatching(/^git ls-tree: .+/) });
  });
});
