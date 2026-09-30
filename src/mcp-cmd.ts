import path from 'node:path';
import { autoDetectInit } from './config.js';
import { mcpEntryReader, teamMcpToDef } from './resources/mcp.js';
import { describeEntryFailure, describeOrigin, reportUndeliveredEntryNotices, resolveEntriesFor } from './namespaced-entries.js';
import {
  reconcileMcpForConfig,
  releaseCleanMcpGitExcludes,
  resolveMcpTargets,
  buildDesiredMcpContext,
  desiredMcpForTarget,
  mcpTargetExcluded,
  type McpChange,
  type McpTarget,
} from './mcp-reconcile.js';
import { placeholderValue, referencedVars } from './resources/mcp-format.js';
import { reportMissingSecrets } from './env-advisories.js';
import { resolveTeamEnv } from './env-resolution.js';
import { carriesResolvedValue, ensureExcludedFromGit } from './mcp-git-exclude.js';
import { log } from './utils/logger.js';
import type { GlobalOptions } from './types.js';
import { managedMcpManifestPath, managedMcpManifestKey, getDataHome } from './types.js';
import { readJson } from './utils/fs.js';
import type { ManagedMcpManifest } from './types.js';
import { getUserHome } from './utils/home.js';

function displayPath(p: string): string {
  const home = getUserHome();
  if (p === home || p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
  return p;
}

/** Print team MCP servers, their secret requirements, and where they are installed. */
export async function mcpList(_options: GlobalOptions): Promise<void> {
  // Read-only: the load never persists a migration (#893).
  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: true });
  const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
  if (resolution.kind === 'failed') {
    reportUndeliveredEntryNotices(resolution);
    log.error(describeEntryFailure(resolution.failure));
    process.exitCode = 1;
    return;
  }
  // A server an unknown or removed key takes out of the delivered set never
  // appears in the list below, so say why it is missing (#822).
  reportUndeliveredEntryNotices(resolution);
  const servers = resolution.entries;

  // HTTP mode has no repo tree to declare secrets in.
  const teamEnv = localConfig.repo.kind === 'http' ? undefined : await resolveTeamEnv(localConfig);
  // A failed declaration is not "no secrets" (#879 Conflict 14): nothing says
  // which of a server's variables are secrets, so none is called set.
  const declarationsFailed = teamEnv?.declarations.kind === 'failed';
  if (teamEnv?.declarations.kind === 'failed') {
    log.error(describeEntryFailure(teamEnv.declarations.failure));
    process.exitCode = 1;
  }

  if (servers.length === 0) {
    log.info('No team MCP servers reach this directory (mcp/mcp.yaml and active mcp/<ns>/mcp.yaml files are absent or empty)');
    await reportMissingSecrets(localConfig, teamEnv);
    return;
  }

  const targets = await resolveMcpTargets(teamConfig, localConfig);
  // The team env already resolved above: resolving it again repeats its warnings.
  const desiredContext = await buildDesiredMcpContext(teamConfig, localConfig, { teamEnv });
  const { vars } = desiredContext;
  // Project scope reads THIS worktree's own per-worktree manifest; user the global file.
  const manifest = (await readJson<ManagedMcpManifest>(
    managedMcpManifestPath(
      getDataHome(localConfig),
      localConfig.scope === 'project' ? localConfig.projectRoot : undefined,
    ),
  )) ?? {};

  console.log(`Team MCP servers — mcp/ (${servers.length}):`);
  console.log('');
  for (const resolved of servers) {
    const s = teamMcpToDef(resolved.entry);
    const endpoint = s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}`.trim() : s.url;
    console.log(`  ${s.name}  [${s.transport}]`);
    if (s.description) console.log(`    ${s.description}`);
    console.log(`    endpoint: ${endpoint}`);
    console.log(`    from:     ${resolved.source} (${describeOrigin(resolved)})`);
    const roles = resolved.entry.roles;
    if (roles) console.log(`    roles:    ${roles.length > 0 ? roles.join(', ') : 'nobody'} (deprecated)`);

    const needed = referencedVars(s);
    if (needed.length > 0) {
      const missing = needed.filter((v) => !placeholderValue(vars, v));
      const state = declarationsFailed ? 'not resolved' : missing.length === 0 ? 'all set' : `MISSING: ${missing.join(', ')}`;
      console.log(`    secrets:  ${needed.join(', ')} (${state})`);
    }

    const installed = (t: McpTarget): boolean =>
      (manifest[managedMcpManifestKey(t.tool, t.projectScope)] ?? []).some((r) => r.name === s.name);
    const installedIn = targets.filter(installed).map((t) => t.tool);
    console.log(`    installed: ${installedIn.length > 0 ? installedIn.join(', ') : '(none)'}`);
    // Pull writes a resolved value only into a file git leaves out of a commit
    // (#882); an entry an earlier pull wrote there stays as it was. Only where
    // delivery would write it: its tools, transport, policy and requirements.
    for (const t of targets) {
      if (mcpTargetExcluded(localConfig, t)) continue;
      if (!carriesResolvedValue(t, [s], desiredMcpForTarget(t, [s], desiredContext).desired.keys())) continue;
      const exclusion = await ensureExcludedFromGit(t.file, { dryRun: true });
      if (exclusion.kind === 'failed') console.log(`    withheld: ${t.tool} — ${exclusion.reason}. ${exclusion.fix}`);
    }
    console.log('');
  }

  console.log('MCP-capable tools detected:');
  if (targets.length === 0) {
    console.log('  (none)');
  } else {
    for (const t of targets) console.log(`  ${t.tool.padEnd(16)} ${displayPath(t.file)}`);
  }
  await reportMissingSecrets(localConfig, teamEnv);
}

function reportChanges(changes: McpChange[]): void {
  const applied = changes.filter((c) => c.action !== 'skipped');
  const skipped = changes.filter((c) => c.action === 'skipped');

  for (const c of applied) console.log(`  ${c.action.padEnd(8)} ${c.tool}/${c.server}`);
  for (const c of skipped) console.log(`  skipped  ${c.tool}/${c.server} — ${c.reason}`);

  if (applied.length === 0 && skipped.length === 0) console.log('  (no changes)');
}

export async function mcpInject(
  options: GlobalOptions & { dryRun?: boolean; force?: boolean },
): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: options.dryRun });
  const { changes, wrote, unresolved } = await reconcileMcpForConfig(teamConfig, localConfig, {
    dryRun: options.dryRun,
    force: options.force,
  });
  // The reason is already reported, and every installed server left as it was.
  if (unresolved) {
    process.exitCode = 1;
    return;
  }

  console.log(options.dryRun ? 'MCP inject (dry run):' : 'MCP inject:');
  reportChanges(changes);

  if (wrote) log.success('MCP servers updated. Restart your AI tool session to load them.');
  else if (!options.dryRun) log.info('Already up to date.');
}

export async function mcpRemove(options: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: options.dryRun });
  const { changes, wrote } = await reconcileMcpForConfig(teamConfig, localConfig, {
    removeAll: true,
    dryRun: options.dryRun,
  });
  // Nothing of teamai's is left for .git/info/exclude to protect (#882).
  if (!options.dryRun) await releaseCleanMcpGitExcludes(teamConfig, localConfig);

  console.log(options.dryRun ? 'MCP remove (dry run):' : 'MCP remove:');
  reportChanges(changes);

  if (wrote) log.success('teamai-managed MCP servers removed.');
  else if (!options.dryRun) log.info('Nothing to remove.');
}
