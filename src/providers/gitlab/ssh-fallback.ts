/**
 * SSH-first fallbacks for the GitLab provider.
 *
 * The upstream provider is token-only (REST + PAT). On intranet deployments
 * where members have SSH keys but no Personal Access Token, these helpers
 * keep the full flow working without any token:
 *   - authentication: `ssh -T git@<host>` banner carries the username
 *   - clone/push: plain git over SSH (scp-style URL)
 *   - merge requests: prefilled web form URL (branch is already pushed)
 */
import { execFileSync } from 'node:child_process';

/** Extract the ssh hostname (no port) from a GitLab web base URL. */
export function sshHostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  }
}

/**
 * Probe SSH authentication. GitLab answers `ssh -T` with exit code 1 and a
 * banner `Welcome to GitLab, @<username>!` on stderr (no shell is granted).
 * BatchMode guarantees the probe never blocks on a password prompt.
 */
export function sshProbeUsername(host: string): string | null {
  const bannerFor = (s: string): string | null => {
    const m = s.match(/Welcome to GitLab, @([^!\s]+)!/);
    return m ? m[1] : null;
  };
  try {
    const out = execFileSync(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=8',
        '-T',
        'git@' + host,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
    ).toString();
    return bannerFor(out);
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    return bannerFor((err.stderr ?? '') + ' ' + (err.stdout ?? ''));
  }
}

/** scp-style SSH clone URL: git@host:owner/repo.git */
export function sshCloneUrl(host: string, repo: string): string {
  return `git@${host}:${repo}.git`;
}

/**
 * Prefilled "new merge request" URL — the no-token MR fallback. GitLab renders
 * a ready-to-submit form when query params use merge_request[...] keys.
 */
export function mrPrefillUrl(
  baseUrl: string,
  repo: string,
  source: string,
  target: string,
  title: string,
): string {
  const params = new URLSearchParams();
  params.set('merge_request[source_branch]', source);
  params.set('merge_request[target_branch]', target);
  params.set('merge_request[title]', title);
  return `${baseUrl.replace(/\/+$/, '')}/${repo}/-/merge_requests/new?${params.toString()}`;
}
