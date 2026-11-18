/**
 * Remote URL identification and formatting for hosts Git reaches but a
 * provider does not own, kept apart from `utils/git.ts` so tests that mock the
 * whole git module (and push.ts, which imports it) still get the real helpers.
 */

/**
 * Whether `remoteUrl` is a Gerrit code-review server. Gerrit has no distinct
 * protocol: it is a normal Git server whose review magic lives in `refs/for`.
 * Recognized by its usual hallmarks — a host starting with `gerrit`, the
 * standard 29418 review port, or a `/gerrit/` path segment.
 *
 * `provider` is the team's configured provider: one that owns its host
 * (GitHub, GitLab, ...) is never a Gerrit review target, even when its path
 * happens to contain `gerrit` (an org or group of that name).
 */
export function isGerritRemote(remoteUrl: string | null | undefined, provider?: string): boolean {
  if (!remoteUrl) return false;

  if (provider !== undefined && provider !== 'git') return false;

  if (/^https?:\/\//i.test(remoteUrl)) {
    try {
      const url = new URL(remoteUrl);

      if (url.port === '29418') return true;

      if (url.pathname.split('/').includes('gerrit')) return true;

      return /(^|\.)gerrit[^:/]*$/i.test(url.hostname);
    } catch {
      return false;
    }
  }

  // scp-style (git@host:path) and ssh:// forms. The host is the part after
  // `user@`, so the hallmark below is tested on the host alone.
  const host = /^ssh:\/\/([^/]+)/i.exec(remoteUrl)?.[1]?.replace(/^[^@]*@/, '').replace(/:\d+$/, '')
    ?? /^[^@\s]+@([^:\s/]+):/.exec(remoteUrl)?.[1];

  if (!host) return false;

  const port = /^ssh:\/\/(?:[^@/]*@)?[^/:]+:(\d+)(?:\/|$)/i.exec(remoteUrl)?.[1]
    ?? /^[^@\s]+@[^:\s/]+:(\d+)(?:\/|$)/.exec(remoteUrl)?.[1];

  if (port === '29418') return true;

  if (/\/gerrit\//.test(remoteUrl)) return true;

  return /(^|\.)gerrit[^:/]*$/i.test(host);
}

/**
 * The ref a push to a Gerrit server must go to to become a change for review,
 * rather than a direct push that bypasses review. Pushing `refs/for/<branch>`
 * creates or updates the change whose commits carry the Change-Id the repo's
 * commit-msg hook writes.
 */
export function gerritReviewRef(targetBranch: string): string {
  return `refs/for/${targetBranch}`;
}

/**
 * The web URL of a Gerrit change, from a remote in its https, ssh or scp form.
 * Gerrit's change listing is at `/<repo>/`; the exact change only exists after
 * the push, so this names the repository. Null when no recognizably Gerrit
 * remote is present. Any userinfo (`user@`, or `oauth2:TOKEN@`) is dropped:
 * this URL is printed, and a token must never reach a log.
 */
export function gerritWebUrl(remote: string | undefined): string | null {
  if (!remote || !isGerritRemote(remote)) return null;

  const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(remote);

  if (scp) {
    const repoPath = scp[2].replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '');

    return `https://${scp[1]}/${repoPath}/`;
  }

  const url = /^(ssh|https?):\/\/([^/]+)\/(.+)$/i.exec(remote);

  // Gerrit-shaped but without a path (e.g. `https://gerrit.example.com`): no
  // repository to link to.
  if (!url) return null;

  const authority = url[2].replace(/^[^@/]*@/, '');
  const port = /:(\d+)$/.exec(authority)?.[1];
  const host = authority.replace(/:\d+$/, '');
  const repoPath = url[3].replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const scheme = url[1].toLowerCase() === 'https' ? 'https' : 'http';

  return `${scheme}://${host}${port === '29418' ? '' : port ? `:${port}` : ''}/${repoPath}/`;
}
