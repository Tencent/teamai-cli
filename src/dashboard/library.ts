/**
 * Read-only Team Library data for the dashboard's Team Library page: the team
 * skills and MCP servers visible to one workspace's scope. Secret values are
 * never returned — only the names of the ${VAR} placeholders a server needs.
 */
import path from 'node:path';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { SkillsHandler } from '../resources/skills.js';
import { mcpEntryReader, teamMcpToDef } from '../resources/mcp.js';
import { describeEntryFailure, resolveEntriesFor } from '../namespaced-entries.js';
import { referencedVars } from '../resources/mcp-format.js';
import { splitFrontmatter } from '../utils/frontmatter.js';
import { pathExists, readFileSafe } from '../utils/fs.js';
import { loadPackageManifest, packageManifestPath } from '../pkg/manifest.js';
import type { ClaudeMarketplace, ClaudePluginSpec, NpmSpec } from '../pkg/types.js';

export interface TeamLibrarySkill {
  name: string;
  namespace?: string;
  description?: string;
  /** Repo-relative path, e.g. `skills/<name>` or `skills/<ns>/<name>`. */
  path: string;
}

export interface TeamLibraryMcpServer {
  name: string;
  description?: string;
  transport: 'stdio' | 'http' | 'sse';
  /** Command line (stdio) or URL (http/sse). */
  endpoint: string;
  /** Repo-relative file the entry comes from. */
  source: string;
  namespace: string | null;
  /** Names of the ${VAR} placeholders the definition references — never their values. */
  secrets: string[];
}

export interface TeamLibraryPackages {
  npm: NpmSpec[];
  claude: {
    marketplaces: ClaudeMarketplace[];
    plugins: ClaudePluginSpec[];
  };
}

export interface TeamLibrary {
  skills: TeamLibrarySkill[];
  mcpServers: TeamLibraryMcpServer[];
  packages: TeamLibraryPackages;
  /** Why the MCP list could not be resolved; the skills list is still served. */
  mcpError?: string;
  /** Why teamai.yaml could not be parsed; the other sections are still served. */
  packagesError?: string;
}

const EMPTY_PACKAGES: TeamLibraryPackages = { npm: [], claude: { marketplaces: [], plugins: [] } };

/** The skill's one-line description from its SKILL.md frontmatter, when readable. */
async function skillDescription(sourcePath: string): Promise<string | undefined> {
  const content = await readFileSafe(path.join(sourcePath, 'SKILL.md'));
  if (!content) return undefined;
  const description = splitFrontmatter(content).data.description;
  return typeof description === 'string' && description.length > 0 ? description : undefined;
}

/**
 * The `packages:` section of the team repo's teamai.yaml, passed through as
 * declared. A repo without teamai.yaml declares nothing (no error); one that
 * does not parse reports the reason in `packagesError`, like `mcpError`.
 */
async function teamPackages(
  repoPath: string,
): Promise<{ packages: TeamLibraryPackages; packagesError?: string }> {
  if (!await pathExists(packageManifestPath(repoPath))) return { packages: EMPTY_PACKAGES };
  try {
    const manifest = await loadPackageManifest(repoPath);
    return {
      packages: {
        npm: manifest.packages.npm ?? [],
        claude: {
          marketplaces: manifest.packages.claude?.marketplaces ?? [],
          plugins: manifest.packages.claude?.plugins ?? [],
        },
      },
    };
  } catch (error) {
    return {
      packages: EMPTY_PACKAGES,
      packagesError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Skills and MCP servers of the team repo this workspace's config points at.
 * A workspace without a config (unassigned sessions) has no team repo: all
 * sections are empty. An MCP file or teamai.yaml that does not parse does not
 * fail the whole response; the reason is reported in `mcpError`/`packagesError`
 * instead.
 */
export async function getTeamLibrary(config: LocalConfig | null): Promise<TeamLibrary> {
  if (!config) return { skills: [], mcpServers: [], packages: EMPTY_PACKAGES };

  // scanTeamForPull ignores its teamConfig argument; it scans the checkout only.
  const items = await new SkillsHandler().scanTeamForPull({} as TeamaiConfig, config);
  const skills: TeamLibrarySkill[] = await Promise.all(items.map(async (item) => ({
    name: item.name,
    namespace: item.namespace,
    description: await skillDescription(item.sourcePath),
    path: item.relativePath,
  })));

  const { packages, packagesError } = await teamPackages(config.repo.localPath);

  const resolution = await resolveEntriesFor(mcpEntryReader, config);
  if (resolution.kind === 'failed') {
    return { skills, mcpServers: [], packages, mcpError: describeEntryFailure(resolution.failure), packagesError };
  }
  const mcpServers: TeamLibraryMcpServer[] = resolution.entries.map((resolved) => {
    const def = teamMcpToDef(resolved.entry);
    const endpoint = def.transport === 'stdio'
      ? `${def.command ?? ''} ${(def.args ?? []).join(' ')}`.trim()
      : def.url ?? '';
    return {
      name: def.name,
      description: def.description,
      transport: def.transport,
      endpoint,
      source: resolved.source,
      namespace: resolved.namespace,
      secrets: referencedVars(def),
    };
  });
  return { skills, mcpServers, packages, packagesError };
}
