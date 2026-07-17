import type { GitProvider } from './types.js';
import { TGitProvider } from './tgit/index.js';
import { GitHubProvider } from './github/index.js';
import { CNBProvider } from './cnb/index.js';
import { getCurrentPackageName } from '../package-info.js';

// ─── Provider Detection ──────────────────────────────────
//
//  Input URL / short format        Detected provider
//  ────────────────────────────    ──────────────────
//  https://github.com/o/r          github
//  git@github.com:o/r.git          github
//  https://git.woa.com/o/r         tgit
//  git@git.woa.com:o/r.git         tgit
//  owner/repo (bare)               <fallback — see getDefaultProvider>
//  https://<unknown-host>/o/r      <fallback>
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
};

/** Providers we are willing to accept as a default override. */
const KNOWN_PROVIDERS = new Set(['github', 'tgit', 'cnb']);

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
 * Returns provider name string ('github' | 'tgit').
 *
 * - Full URL (HTTPS or SSH): matched by host. Unknown hosts fall back to the
 *   distribution-based default (see {@link getDefaultProvider}).
 * - Bare `owner/repo`: uses the distribution-based default so `@tencent/`
 *   tnpm users get tgit automatically without having to type the full URL.
 */
export function detectProvider(input: string): string {
  const trimmed = input.trim();

  // HTTPS URL: extract host
  const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\//);
  if (httpsMatch) {
    const host = httpsMatch[1].toLowerCase();
    return HOST_MAP[host] ?? getDefaultProvider();
  }

  // SSH URL: extract host
  const sshMatch = trimmed.match(/^git@([^:]+):/);
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    return HOST_MAP[host] ?? getDefaultProvider();
  }

  // Bare owner/repo — use distribution-based default.
  return getDefaultProvider();
}

// ─── Provider Factory ────────────────────────────────────

/** Registry of available providers. */
const PROVIDERS: Record<string, () => GitProvider> = {
  tgit: () => new TGitProvider(),
  github: () => new GitHubProvider(),
  cnb: () => new CNBProvider(),
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
