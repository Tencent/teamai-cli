/**
 * `providerOpensPullRequests` decides whether a null from `createPrWithFallback`
 * is a failure. Each of its "no pull request here" answers is a configuration a
 * real checkout has — a member who chose `--provider git`, a scratch remote, a
 * team whose repo line is a path — and a caller that misses one reports every
 * run of an unfinished command as broken.
 *
 * The helper mirrors what the fallback parses, so these cases track it: the
 * team's `repo` first, then the checkout's remote.
 *
 * The provider's `pullRequests` is not the signal, however tempting: it marks
 * whether delivery can look up a branch's open request before it opens one, so
 * `cnb` leaves it null while `createPullRequest` still runs `cnb pulls
 * post-pull`. Reading that null as "opens none" left a failed `cnb` push of a
 * removal reporting success.
 */
import { describe, expect, it } from 'vitest';
import { providerOpensPullRequests } from '../push.js';

function team(repo: string, provider?: string) {
  return provider === undefined ? { repo } : { repo, provider };
}

function local(remote: string, provider?: string) {
  return provider === undefined ? { repo: { remote } } : { repo: { remote }, provider };
}

describe('providerOpensPullRequests', () => {
  it('says no for a provider that reaches only git', () => {
    expect(providerOpensPullRequests(team('acme/team', 'git'), local('https://github.com/acme/team.git'))).toBe(false);
  });

  it('says no when neither the team repo nor the remote names a repository', () => {
    expect(providerOpensPullRequests(team('/tmp/teamai-remote', 'github'), local('/tmp/teamai-remote'))).toBe(false);
  });

  it('says no when the team names no repo and the remote is a path', () => {
    expect(providerOpensPullRequests(team('', 'github'), local('/tmp/teamai-remote'))).toBe(false);
  });

  it('says yes for a bare owner/repo, which the fallback parses', () => {
    expect(providerOpensPullRequests(team('acme/team', 'github'), local('/tmp/teamai-remote'))).toBe(true);
  });

  it('says yes for a hosted remote when the team names no repo', () => {
    expect(providerOpensPullRequests(team('', 'github'), local('https://github.com/acme/team.git'))).toBe(true);
  });

  it('says yes for cnb, which opens a request it cannot list', () => {
    expect(providerOpensPullRequests(team('acme/team', 'cnb'), local('https://cnb.cool/acme/team.git'))).toBe(true);
  });

  it('says no when no input names a repository, whichever provider', () => {
    expect(providerOpensPullRequests(team('', 'cnb'), local(''))).toBe(false);
  });

  it('takes the member provider over the team one', () => {
    expect(providerOpensPullRequests(team('acme/team', 'github'), local('https://github.com/acme/team.git', 'git'))).toBe(false);
  });
});
