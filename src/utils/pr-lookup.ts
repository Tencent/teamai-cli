import { providerForRemote, type OriginProvider } from '../providers/registry.js';
import type { PullRequestRef } from '../providers/types.js';
import { sanitizePrUrl, type PrUrl } from './pr-url.js';
import { git } from './git-command.js';


/** How long a host may take to answer one lookup or one create. */
export const DELIVERY_TIMEOUT_MS = 30_000;


/**
 * Whether the host holds the open request `create` asked for, by lookup alone: nothing of the branch is read, and
 * nothing is opened. `failed` is a host that cannot answer or an origin no provider reads. `unsafe` is a URL that cannot be kept.
 */
export async function findDelivered(
  checkout: string, { branch, target }: { branch: string; target: string },
): Promise<{ kind: 'found'; pr: PrUrl } | { kind: 'none' } | { kind: 'failed' } | { kind: 'unsafe' }> {
  const origin = await originOf(checkout);
  if (origin.kind === 'transport') return { kind: 'failed' };
  return findOpen(origin, { repo: origin.repo, source: branch, target, timeoutMs: DELIVERY_TIMEOUT_MS });
}


/** The provider of the checkout's configured origin; git alone when the checkout has none. */
async function originOf(checkout: string): Promise<OriginProvider> {
  const remote = await git(checkout, ['config', '--get', 'remote.origin.url']);
  return remote.code === 0 ? providerForRemote(remote.stdout) : { kind: 'transport' };
}


/**
 * What a lookup said: the open request, sanitized; none; no answer; or a URL that cannot be kept, which a URL on another
 * host than the origin's pull requests is, whichever provider answered.
 */
async function findOpen(
  { pullRequests, hostname }: Extract<OriginProvider, { kind: 'provider' }>, ref: PullRequestRef,
): Promise<{ kind: 'found'; pr: PrUrl } | { kind: 'none' } | { kind: 'failed' } | { kind: 'unsafe' }> {
  let url: string | undefined;
  try {
    url = await pullRequests.findOpen(ref);
  } catch {
    return { kind: 'failed' };
  }
  if (url === undefined) return { kind: 'none' };
  const clean = sanitizePrUrl(url);
  return clean.url && new URL(clean.url).hostname === hostname ? { kind: 'found', pr: clean.url } : { kind: 'unsafe' };
}
