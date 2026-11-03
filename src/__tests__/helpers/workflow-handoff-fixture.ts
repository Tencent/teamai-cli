import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import { AgentSession } from '../../session-flow/agent-session.js';
import { SyncManager, defaultSyncMeta, getRepoIdentity } from '../../session-flow/sync.js';
import type { LocalConfig } from '../../types.js';
import { syncScorersThenWorkflows } from '../../scorers/team-sync.js';
import { leaseNext, reportAttempt, startRun } from '../../workflow/engine.js';
import { updateRun } from '../../workflow/store.js';
import type { DriverIdentity, RunState } from '../../workflow/types.js';
import { ensureWorktree, fetchMissingCommits, headCommit } from '../../workflow/worktree.js';
import { knownSecrets } from '../../env-resolution.js';
import { fakeGh } from './fake-gh.js';

/** The version in the package manifest, which a run of teamai's default records. */
export const PACKAGE_VERSION: string = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')).version;

export const dirs: string[] = [];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
}

export const BUILD = `schemaVersion: v1alpha1
name: build
description: Two commands.
steps:
  - id: one
    command: echo one
  - id: two
    needs: [one]
    command: echo two
`;

export const SHIP = `schemaVersion: v1alpha1
name: ship
description: Three changes made one after another in one copy.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          workspace: continue
          command: echo write > write.txt
        - id: more
          needs: [write]
          workspace: continue
          command: echo more > more.txt
        - id: last
          needs: [more]
          workspace: continue
          command: echo last > last.txt
`;

export const PAIR = `schemaVersion: v1alpha1
name: pair
description: A change in a copy of its own, and one in a copy a workflow opens.
steps:
  - id: build
    workspace: new
    command: echo build > build.txt
  - id: change
    needs: []
    workspace: new
    workflow:
      steps:
        - id: write
          workspace: continue
          command: echo write > write.txt
`;

export const COPY = `schemaVersion: v1alpha1
name: copy
description: One change in a copy of its own.
steps:
  - id: change
    workspace: new
    command: echo change > change.txt
`;

export const STACK = `schemaVersion: v1alpha1
name: stack
description: A change, and one that starts from it.
steps:
  - id: a
    workspace: new
    command: echo a > a.txt
  - id: b
    needs: [a]
    workspace: new
    command: echo b > b.txt
`;

export const DELIVERED_STACK = `schemaVersion: v1alpha1
name: stack
description: A change delivered as a pull request, and one stacked on it.
steps:
  - id: a
    workspace: new
    command: echo a > a.txt
    deliver: pr
  - id: b
    needs: [a]
    workspace: new
    command: echo b > b.txt
    deliver: pr
`;

export const WORKSPACES = ['read-only', 'new', 'continue'] as const;

export interface Member {
  config: LocalConfig;
  /** The business checkout this member drives the run from. */
  checkout: string;
  driver: DriverIdentity;
}

/**
 * A team repository with `workflows` and the other `files`, and a business repository, each on a bare origin; a function
 * that makes a member's install: a team clone, a data home, and a business checkout the member drives runs from; and one
 * that pushes a team commit writing `files`, or deleting those set to null, and returns it.
 */
export function team(workflows: Record<string, string> = { build: BUILD }, files: Record<string, string> = {}): {
  origin: string;
  business: string;
  member(name: string): Promise<Member>;
  change(files: Record<string, string | null>): string;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-handoff-')));
  dirs.push(root);
  const seed = path.join(root, 'seed');
  const origin = path.join(root, 'team.git');
  const business = path.join(root, 'business.git');
  const product = path.join(root, 'product');
  git(root, 'init', '-q', '-b', 'main', product);
  fs.writeFileSync(path.join(product, 'README.md'), '# product\n');
  git(product, 'add', '-A');
  git(product, 'commit', '-qm', 'product');
  git(root, 'clone', '-q', '--bare', product, business);
  fs.mkdirSync(path.join(seed, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\nrepo: https://github.com/acme/team.git\nprovider: github\n');
  for (const [name, yaml] of Object.entries(workflows)) fs.writeFileSync(path.join(seed, 'workflows', `${name}.yaml`), yaml);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), text);
  }
  git(root, 'init', '-q', '-b', 'main', seed);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'team');
  git(root, 'clone', '-q', '--bare', seed, origin);
  return {
    origin,
    business,
    member: async (name) => {
      const home = path.join(root, name);
      const clone = path.join(home, 'team-repo');
      const checkout = path.join(home, 'work');
      fs.mkdirSync(home, { recursive: true });
      git(root, 'clone', '-q', business, checkout);
      git(root, 'clone', '-q', origin, clone);
      git(clone, 'config', 'user.name', name);
      git(clone, 'config', 'user.email', `${name}@example.com`);
      const config: LocalConfig = {
        repo: { localPath: clone, remote: origin, kind: 'git' },
        username: name,
        scope: 'user',
        additionalRoles: [],
        dataHome: path.join(home, 'data'),
      };
      await syncScorersThenWorkflows(config);
      return { config, checkout, driver: { kind: 'local', machine: name, workspace: checkout } };
    },
    change: (changes) => {
      const editor = fs.mkdtempSync(path.join(root, 'editor-'));
      git(root, 'clone', '-q', origin, editor);
      for (const [file, text] of Object.entries(changes)) {
        if (text === null) git(editor, 'rm', '-q', file);
        else fs.writeFileSync(path.join(editor, file), text);
      }
      git(editor, 'add', '-A');
      git(editor, 'commit', '-qm', 'team change');
      git(editor, 'push', '-q', 'origin', 'main');
      return git(editor, 'rev-parse', 'HEAD');
    },
  };
}

/** Brings the member's team clone up to origin and syncs its workflow cache, as a pull does. */
export async function pull({ config }: Member): Promise<void> {
  git(config.repo.localPath, 'pull', '-q', '--ff-only');
  await syncScorersThenWorkflows(config);
}

/** Every file of the member's workflow cache, with its content. */
export function cacheFiles({ config }: Member): Record<string, string> {
  const dir = path.join(config.dataHome ?? '', 'workflows', 'cache');
  return Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

/** A file on origin's `teamai-reports`, or null when origin has none. */
export function originFile(origin: string, rel: string): string | null {
  try {
    return execFileSync('git', ['--git-dir', origin, 'show', `teamai-reports:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

export function reportsHead(origin: string): string {
  return execFileSync('git', ['--git-dir', origin, 'rev-parse', 'teamai-reports'], { encoding: 'utf8' }).trim();
}

/**
 * Holds every push of a run's base pin to business origin `business` until `release` is called. `held` resolves once a
 * publish is waiting there, past its check of the business origin.
 */
export function holdBasePin(business: string): { held: () => Promise<void>; release: () => void } {
  const held = path.join(path.dirname(business), 'pin-held');
  const release = path.join(path.dirname(business), 'pin-release');
  receiveHook(business, `while read old new ref; do case "$ref" in */base) touch '${held}'; while [ ! -f '${release}' ]; do sleep 0.05; done;; esac; done; exit 0`);
  return {
    held: async () => {
      for (let waited = 0; !fs.existsSync(held) && waited < 200; waited += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(held)).toBe(true);
    },
    release: () => fs.writeFileSync(release, ''),
  };
}

/** Installs a pre-receive hook on `origin`; `exit 0` lets every push through again. */
export function receiveHook(origin: string, script: string): void {
  fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

/** Archives Claude Code session `session` of the member's checkout on the team repo's default branch, as teamai did before sessions moved to teamai-reports. */
export async function archiveOnDefaultBranch({ config, checkout }: Member, session: string): Promise<void> {
  const found = await AgentSession.find({ platform: 'claude-code', sessionId: session });
  if (found.status !== 'done') throw new Error(found.failure.message);
  const archive = new SyncManager(config.repo.localPath);
  await archive.saveSession(found.session, defaultSyncMeta({
    platform: 'claude-code', author: config.username, cwd: checkout, sessionId: session, repoIdentity: getRepoIdentity(checkout), title: found.session.title,
  }, found.session.createdAt));
  archive.gitCommit('sync: archive 1 session(s)');
  archive.gitPush();
}

export async function editRun(config: LocalConfig, runId: string, edit: (run: RunState) => RunState): Promise<void> {
  await updateRun(config, runId, {}, async (run) => (run === 'missing' ? { value: undefined } : { value: undefined, write: edit(run) }));
}

/** Settles a run whose steps all reported: the next `next` ends it and publishes its end record. */
export async function settle(member: Member, runId: string): Promise<void> {
  expect(await leaseNext(member.config, runId, member.driver)).toMatchObject({ data: { done: {} } });
}

/** Starts `workflow` in the member's business checkout, which fixes the run's base. */
export async function startIn({ config, checkout }: Member, workflow: string): Promise<string> {
  const base = await headCommit(checkout);
  const started = await startRun(config, workflow, {}, { secrets: await knownSecrets(config), ...(base ? { base } : {}), checkout });
  if ('error' in started) throw new Error(started.error.message);
  return String(started.data.run);
}

/**
 * Does what a driver does with the next lease: open the leased copy at its start, commit `file` there, push the branch to
 * the business origin, and report the change.
 */
export async function work(
  member: Member,
  runId: string,
  file: string,
  driver = member.driver,
  { push = true }: { push?: boolean } = {},
): Promise<{ step: string; branch: string; commit: string }> {
  const next = await leaseNext(member.config, runId, driver, { can: { workspace: [...WORKSPACES] } });
  if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
  const lease = next.data.lease as {
    step: string; attempt: string; revision: number; workspace: { branch: string; base: { commit: string }; start: { commit: string } };
  };
  const { branch, base, start: startCommit } = lease.workspace;
  await fetchMissingCommits(member.checkout, { run: runId, commits: [base.commit, startCommit.commit] });
  const opened = await ensureWorktree(member.checkout, branch, startCommit.commit);
  if ('error' in opened) throw new Error(opened.error);
  fs.writeFileSync(path.join(opened.dir, file), `${file}\n`);
  git(opened.dir, 'add', file);
  git(opened.dir, 'commit', '-qm', file);
  const commit = git(opened.dir, 'rev-parse', 'HEAD');
  if (push) git(opened.dir, 'push', '-q', 'origin', branch);
  const reported = await reportAttempt(member.config, runId, {
    attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver,
    changes: { branch, base: base.commit, from: startCommit.commit, to: commit, commits: [commit] },
  });
  if ('error' in reported) throw new Error(reported.error.message);
  return { step: lease.step, branch, commit };
}

/** The commit `ref` points at on bare repository `origin`, or undefined when it has no such ref. */
export function originRef(origin: string, ref: string): string | undefined {
  try {
    return execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

/** Deletes every branch of run `runId` on bare repository `business`, as a merge that deletes a run's branches does. */
export function deleteRunBranches(business: string, runId: string): void {
  const refs = git(business, '--git-dir', business, 'for-each-ref', '--format=%(refname)', `refs/heads/teamai/${runId}/`).split('\n').filter(Boolean);
  for (const ref of refs) git(business, '--git-dir', business, 'update-ref', '-d', ref);
}

/** Commits a file on `branch` of bare repository `business`, as a push from another checkout of the copy does. */
export function pushCommitTo(business: string, branch: string): void {
  const editor = fs.mkdtempSync(path.join(path.dirname(business), 'editor-'));
  git(path.dirname(business), 'clone', '-q', '--branch', branch, business, editor);
  fs.writeFileSync(path.join(editor, 'later.txt'), 'later\n');
  git(editor, 'add', '-A');
  git(editor, 'commit', '-qm', 'later');
  git(editor, 'push', '-q', 'origin', `HEAD:${branch}`);
}

export function hasCommit(dir: string, commit: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function start({ config }: Member): Promise<string> {
  const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  return String(started.data.run);
}

/** Leases the next step to `member` and reports it succeeded; returns its id. */
export async function runStep(member: Member, runId: string, outputs?: Record<string, unknown>): Promise<string> {
  const next = await leaseNext(member.config, runId, member.driver);
  if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
  const lease = next.data.lease as { step: string; attempt: string; revision: number };
  const reported = await reportAttempt(member.config, runId, {
    attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: member.driver, ...(outputs ? { outputs } : {}),
  });
  if ('error' in reported) throw new Error(reported.error.message);
  return lease.step;
}

/** Gives each member's business checkout a GitHub origin that git reaches as `business`, so delivery opens pull requests there. */
export function onGitHub(business: string, members: Member[]): void {
  for (const { checkout } of members) {
    git(checkout, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
    git(checkout, 'config', `url.${business}.insteadOf`, 'https://github.com/acme/app.git');
  }
}

/** An open pull request as GitHub lists it. */
export function openPull(number: number, head: string, base = 'main') {
  const repo = { full_name: 'acme/app' };
  return { state: 'open', html_url: `https://github.com/acme/app/pull/${number}`, head: { ref: head, repo }, base: { ref: base, repo } };
}

/** The head and target branch of each pull request the fake gh was asked to open, in order. */
export function creates(gh: ReturnType<typeof fakeGh>): string[][] {
  return gh.calls().filter((call) => call.args[0] === 'pr').map((call) => ['-H', '-B'].map((flag) => call.args[call.args.indexOf(flag) + 1] ?? ''));
}

/**
 * Starts the delivered stack on `alice`, delivers `a` and reports `b`, so `b` is delivering when the run is published.
 * The fake host keeps `a`'s pull request.
 */
export async function deliveringStack(acme: ReturnType<typeof team>, alice: Member, bob: Member) {
  onGitHub(acme.business, [alice, bob]);
  const gh = fakeGh(path.join(path.dirname(acme.origin), 'gh'));
  const runId = await startIn(alice, 'stack');
  const a = await work(alice, runId, 'a.txt');
  const b = await work(alice, runId, 'b.txt');
  return { gh, runId, a, b };
}
