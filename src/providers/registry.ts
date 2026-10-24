import type { GitProvider, PullRequestLookup } from './types.js';
import { TGitProvider } from './tgit/index.js';
import { GitHubProvider } from './github/index.js';
import { CNBProvider } from './cnb/index.js';
import { GitLabProvider } from './gitlab/index.js';
import { GitCodeProvider } from './gitcode/index.js';
import { GenericGitProvider } from './git/index.js';
import { getCurrentPackageName } from '../package-info.js';
import { probeSelfHostedGitLab } from './gitlab/probe.js';

// ─── Provider Detection ──────────────────────────────────
//
//  Input URL / short format        Detected provider
//  ────────────────────────────    ──────────────────
//  https://github.com/o/r          github
//  git@github.com:o/r.git          github
//  https://git.woa.com/o/r         tgit
//  git@git.woa.com:o/r.git         tgit
//  owner/repo (bare)               <fallback — see getDefaultProvider>
//  https://<unknown-host>/o/r      git (transport-only generic provider)
//
// The fallback is based on which distribution channel the CLI was installed
// from:
//   - `teamai-cli`          (public npm)  → github
//   - `@tencent/teamai-cli` (internal tnpm) → tgit
// The tnpm publish pipeline rewrites the package name at build time (see
// `.coding-ci.yaml`), so reading `name` from the installed package.json at
// runtime is a reliable signal. `TEAMAI_DEFAULT_PROVIDER` can override for
// tests or special environments.
//

/** Known host → provider name mapping. */
const HOST_MAP: Record<string, string> = {
  'github.com': 'github',
  'git.woa.com': 'tgit',
  'cnb.cool': 'cnb',
  'gitlab.com': 'gitlab',
  'gitcode.com': 'gitcode',
};

/** Providers we are willing to accept as a default override. */
const KNOWN_PROVIDERS = new Set(['github', 'tgit', 'cnb', 'gitlab', 'gitcode']);

/**
 * Decide the fallback provider used when the input URL host is unknown or
 * when the user provides a bare `owner/repo`.
 *
 * Precedence:
 *   1. `TEAMAI_DEFAULT_PROVIDER` env var (must be a known provider)
 *   2. Current CLI package name — `@tencent/teamai-cli` → tgit, else github
 *   3. `github` as the ultimate safe default (open-source usage)
 */
export function getDefaultProvider(): string {
  const override = process.env.TEAMAI_DEFAULT_PROVIDER?.trim();
  if (override && KNOWN_PROVIDERS.has(override)) return override;

  try {
    const pkgName = getCurrentPackageName();
    if (pkgName.startsWith('@tencent/')) return 'tgit';
  } catch {
    // package.json is unavailable (rare — only unusual test harnesses hit
    // this). Fall through to github so the CLI remains usable.
  }
  return 'github';
}

/**
 * Detect which git provider to use based on a repo URL or short format.
 * Returns a registered provider name
 * ('github' | 'tgit' | 'cnb' | 'gitlab' | 'git').
 *
 * - Full URL (HTTPS or SSH): matched by host. Unknown hosts use the generic
 *   Git transport provider.
 * - Bare `owner/repo`: uses the distribution-based default so `@tencent/`
 *   tnpm users get tgit automatically without having to type the full URL.
 *
 * Self-hosted GitLab instances are detected when the URL host matches the host
 * of the `GITLAB_URL` env var (e.g. `GITLAB_URL=https://gitlab.example.com`),
 * or via the `TEAMAI_GITLAB_HOST` override (see providers/gitlab/repo-url.ts).
 */
export function detectProvider(input: string): string {
  const trimmed = input.trim();

  // HTTPS URL: extract host
  const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\//i);
  if (httpsMatch) {
    const host = httpsMatch[1].toLowerCase();
    return resolveHostProvider(host);
  }

  // ssh:// URL: extract host through URL parsing.
  if (/^ssh:\/\//i.test(trimmed)) {
    try {
      const host = new URL(trimmed).hostname.toLowerCase();
      return resolveHostProvider(host);
    } catch {
      return 'git';
    }
  }

  // SSH URL: extract host
  const sshMatch = trimmed.match(/^[^@\s]+@([^:\s]+):/);
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    return resolveHostProvider(host);
  }

  // Bare owner/repo — use distribution-based default.
  return getDefaultProvider();
}

/**
 * Interactive initialization can probe an otherwise unknown host. Do not just
 * return "gitlab": its API client needs an explicitly configured instance URL
 * on subsequent runs too, otherwise it would silently target gitlab.com.
 */
export async function detectProviderForInit(input: string): Promise<string> {
  const provider = detectProvider(input);
  if (provider !== 'git') return provider;
  const detected = await probeSelfHostedGitLab(input);
  if (detected) {
    throw new Error(
      `Detected self-hosted GitLab at ${detected.baseUrl}. `
      + `Set GITLAB_URL=${detected.baseUrl} (use the full instance base URL for a subpath deployment) `
      + 'and GITLAB_TOKEN (a Personal Access Token with api scope), then run teamai init again.',
    );
  }
  return provider;
}

/**
 * Resolve a URL host to a provider name: a known platform host wins, then a
 * configured self-hosted GitLab instance, then the transport-only generic
 * provider for arbitrary hosts.
 */
function resolveHostProvider(host: string): string {
  return HOST_MAP[host] ?? detectSelfHostedGitLabHost(host) ?? 'git';
}

/**
 * Map a host to 'gitlab' when it matches the configured self-hosted GitLab
 * instance, otherwise return null.
 *
 * The configured host comes from (in priority order):
 *   1. `TEAMAI_GITLAB_HOST` — explicit override
 *   2. host parsed from `GITLAB_URL` — standard GitLab env var
 *
 * Callers extract the host differently per URL form: the HTTPS branch keeps any
 * `:port`, while `ssh://` (URL.hostname) and scp-style `git@host:path` never
 * carry one. Both the port-qualified and bare forms of the configured host are
 * therefore compared, so `GITLAB_URL=https://gl.example.com:8443` still matches
 * `git@gl.example.com:group/repo.git`.
 */
function detectSelfHostedGitLabHost(host: string): string | null {
  for (const configured of configuredGitLabHosts()) {
    if (configured === host) return 'gitlab';
    // Strip a port from the configured host so the bare-host URL forms match.
    const withoutPort = configured.replace(/:\d+$/, '');
    if (withoutPort === host) return 'gitlab';
  }
  return null;
}

/** Configured self-hosted GitLab hosts, highest precedence first. */
function configuredGitLabHosts(): string[] {
  const hosts: string[] = [];

  const override = process.env.TEAMAI_GITLAB_HOST?.trim().toLowerCase();
  if (override) hosts.push(override);

  const gitlabUrl = process.env.GITLAB_URL?.trim();
  if (gitlabUrl) {
    try {
      hosts.push(new URL(gitlabUrl).host.toLowerCase());
    } catch {
      // ignore malformed GITLAB_URL — resolveGitLabBaseUrl reports it instead
    }
  }
  return hosts;
}

// ─── Provider Factory ────────────────────────────────────

/** Registry of available providers. */
const PROVIDERS: Record<string, () => GitProvider> = {
  tgit: () => new TGitProvider(),
  github: () => new GitHubProvider(),
  cnb: () => new CNBProvider(),
  gitlab: () => new GitLabProvider(),
  gitcode: () => new GitCodeProvider(),
  git: () => new GenericGitProvider(),
};

/**
 * Get a provider instance by name.
 * Defaults to the distribution-based default provider when no name is given.
 */
export function getProvider(providerName?: string): GitProvider {
  const name = providerName ?? getDefaultProvider();
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new Error(
      `Unknown git provider: "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return factory();
}

/**
 * Get a provider instance by detecting the platform from a repo URL.
 */
export function getProviderFromUrl(repoUrl: string): GitProvider {
  const name = detectProvider(repoUrl);
  return getProvider(name);
}

// ─── Workflow delivery ───────────────────────────────────

/**
 * A checkout's origin as workflow delivery reaches it: through a provider that can look up its pull requests, or git
 * alone. `hostname` is the host the origin's pull requests are on: its web host, which an ssh or scp remote shares, since
 * a self-hosted GitLab refuses a GITLAB_URL on another host than TEAMAI_GITLAB_HOST.
 */
export type OriginProvider =
  | { kind: 'provider'; provider: GitProvider; pullRequests: PullRequestLookup; repo: string; hostname: string }
  | { kind: 'transport' };

/**
 * The provider of a checkout's configured origin URL, `remote.origin.url` as written before `insteadOf` rewrites it, and
 * the repository on it. Credentials, query and fragment are dropped first. A filesystem path, a file:// URL, a host no
 * provider owns, a provider with no pull request lookup, or a URL its provider cannot parse is reached through git alone.
 * The bare `owner/repo` default is for user input, never for a remote.
 */
export function providerForRemote(remoteUrl: string): OriginProvider {
  const hosted = hostingUrl(remoteUrl.trim());
  if (!hosted) return { kind: 'transport' };
  const provider = getProviderFromUrl(hosted.href);
  if (!provider.pullRequests) return { kind: 'transport' };
  try {
    const { owner, repo } = provider.parseRepoInput(hosted.href);
    return { kind: 'provider', provider, pullRequests: provider.pullRequests, repo: `${owner}/${repo}`, hostname: hosted.hostname };
  } catch {
    return { kind: 'transport' };
  }
}

/** The web URL of a remote in its https, ssh or scp form, without credentials, query or fragment; undefined for any other form. */
function hostingUrl(remote: string): URL | undefined {
  const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(remote);
  if (scp) {
    const [, host, repoPath] = scp;
    return host && repoPath ? parsedUrl(`https://${host}/${repoPath}`) : undefined;
  }
  if (!/^(https?|ssh):\/\//i.test(remote)) return undefined;
  const url = parsedUrl(remote);
  if (!url) return undefined;
  return parsedUrl(url.protocol === 'ssh:' ? `https://${url.hostname}${url.pathname}` : `${url.protocol}//${url.host}${url.pathname}`);
}

function parsedUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
