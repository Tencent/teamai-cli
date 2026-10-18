import type { OrgRepoInfo } from '../types.js';
import { GiteaApiError, giteaGetSync, giteaList } from './gitea-api.js';
import { parseGiteaRepoInput } from './repo-url.js';

// Organization → paginated REST repositories → provider-neutral metadata.

interface GiteaRepo {
  name: string;
  full_name: string;
  clone_url: string;
  description?: string;
  language?: string;
  archived?: boolean;
  stars_count?: number;
  updated_at?: string;
}

function orgName(org: string): string {
  return parseGiteaRepoInput(`${org}/validation`).owner;
}

export async function giteaListOrgRepos(org: string, options?: { maxRepos?: number }): Promise<OrgRepoInfo[]> {
  const repos = await giteaList<GiteaRepo>(`/orgs/${encodeURIComponent(orgName(org))}/repos`, options?.maxRepos ?? 200);
  return repos.map((repo) => {
    // Validate API-supplied clone URLs before another command attaches a PAT.
    const info = parseGiteaRepoInput(repo.clone_url);
    return {
      url: info.httpsUrl, fullName: repo.full_name, name: repo.name,
      description: repo.description || undefined, primaryLanguage: repo.language || undefined,
      archived: repo.archived ?? false, stars: repo.stars_count, pushedAt: repo.updated_at,
    };
  });
}

export function giteaOrganizationExists(org: string): boolean {
  try {
    giteaGetSync(`/orgs/${encodeURIComponent(orgName(org))}`);
    return true;
  } catch (error) {
    if (error instanceof GiteaApiError && error.status === 404) return false;
    throw error;
  }
}
