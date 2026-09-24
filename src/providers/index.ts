export type { GitProvider, RepoInfo, PrCreateOptions } from './types.js';
export { RepoNotFoundError, OrganizationNotFoundError, RepoCreatePermissionError } from './types.js';
export { getProvider, getProviderFromUrl, detectProvider, detectProviderForInit } from './registry.js';

// ─── Resource delivery providers (issue #404) ────────────
export type {
  ResourceProvider,
  ResourceProviderType,
  ProviderCapabilities,
  ProviderSummary,
  ProviderResult,
  SyncContext,
  HttpBackendAdapter,
  HttpProviderConfig,
} from './types.js';
export { syncResourceProviders } from './resource-registry.js';
export { TGitProvider } from './tgit/index.js';
export { GitHubProvider } from './github/index.js';
export { GitLabProvider } from './gitlab/index.js';
export { GitCodeProvider } from './gitcode/index.js';
export { GenericGitProvider } from './git/index.js';
