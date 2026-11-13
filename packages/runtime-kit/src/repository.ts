// ─── The repository a wake names ───
//
//  A wake names the run's repository by its origin URL, and a runtime finds a machine with a checkout of it by
//  comparing that URL's key with the key of each checkout's remote, as T3 keys a project's repository.
//

/**
 * The repository a git remote URL names: `host/path`, lowercased, with no scheme, user, port or `.git`. Undefined for
 * a URL it cannot read.
 */
export function repositoryKey(url: string): string | undefined {
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(url);
  let host: string;
  let repoPath: string;

  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      repoPath = parsed.pathname;
    } catch {
      return undefined;
    }
  }

  const trimmed = repoPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');

  return host !== '' && trimmed !== '' ? `${host}/${trimmed}`.toLowerCase() : undefined;
}
