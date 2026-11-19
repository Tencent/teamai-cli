import type { Provider } from '@teamai/provider-core/contract';
import type { MRData } from '../types.js';

export {
  endedRequest,
  mergedAs,
  OrganizationNotFoundError,
  RepoCreatePermissionError,
  RepoNotFoundError,
} from '@teamai/provider-core/contract';

export type {
  CiStatus,
  CommitRef,
  MergedAs,
  OrgRepoInfo,
  PrCreateOptions,
  PullRequestLookup,
  PullRequestRecord,
  PullRequestRef,
  RepoInfo,
} from '@teamai/provider-core/contract';

/** Compatibility name while concrete providers remain under src/providers/. */
export type GitProvider = Provider<MRData>;
