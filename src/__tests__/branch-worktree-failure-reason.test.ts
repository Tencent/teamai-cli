import { describe, expect, it } from 'vitest';
import { failureReason } from '../utils/branch-worktree.js';

const REJECTED_PUSH = [
  'To /tmp/acme/team.git',
  '!\trefs/heads/teamai-reports:refs/heads/teamai-reports\t[remote rejected] (pre-receive hook declined)',
  'Done',
  'Pushing to /tmp/acme/team.git',
  'Enumerating objects: 19, done.',
  'Counting objects:   5% (1/19)Counting objects: 100% (19/19), done.',
  'Delta compression using up to 12 threads',
  'Compressing objects: 100% (14/14), done.',
  'Writing objects: 100% (19/19), 2.03 KiB | 2.03 MiB/s, done.',
  'Total 19 (delta 2), reused 0 (delta 0), pack-reused 0 (from 0)',
  'remote: push refused        ',
  "error: failed to push some refs to '/tmp/acme/team.git'",
  '',
].join('\n');

describe('failureReason', () => {
  it('keeps only what git said went wrong in a rejected push, not its progress', () => {
    expect(failureReason(new Error(REJECTED_PUSH))).toBe(
      "! refs/heads/teamai-reports:refs/heads/teamai-reports [remote rejected] (pre-receive hook declined); remote: push refused; error: failed to push some refs to '/tmp/acme/team.git'",
    );
  });

  it('keeps the cause ssh gives for a push it could not make, as a clause the caller ends', () => {
    const denied = [
      'git@example.invalid: Permission denied (publickey).',
      'fatal: Could not read from remote repository.',
      '',
      'Please make sure you have the correct access rights',
      'and the repository exists.',
      '',
    ].join('\n');

    expect(failureReason(new Error(denied))).toBe(
      'git@example.invalid: Permission denied (publickey).; fatal: Could not read from remote repository.; Please make sure you have the correct access rights; and the repository exists',
    );
  });

  it('keeps every line of a failure that is not git, on one line', () => {
    const message = "EACCES: permission denied, open '/tmp/acme/teamai-reports/stats/tester.yaml'\nwhile writing the stats";

    expect(failureReason(new Error(message))).toBe("EACCES: permission denied, open '/tmp/acme/teamai-reports/stats/tester.yaml'; while writing the stats");
  });
});
