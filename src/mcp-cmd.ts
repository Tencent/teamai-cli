import path from 'node:path';
import { autoDetectInit } from './config.js';
import { parseTeamMcpServers } from './resources/mcp.js';
import {
  reconcileMcpForConfig,
  resolveMcpTargets,
  buildVarTable,
  type McpChange,
} from './mcp-reconcile.js';
import { referencedVars } from './resources/mcp-format.js';
import { log } from './utils/logger.js';
import type { GlobalOptions } from './types.js';
import { managedMcpManifestPath } from './types.js';
import { readJson } from './utils/fs.js';
import type { ManagedMcpManifest } from './types.js';

function displayPath(p: string): string {
  const home = process.env.HOME;
  if (home && (p === home || p.startsWith(home + path.sep))) return `~${p.slice(home.length)}`;
  return p;
}

/** Print team MCP servers, their secret requirements, and where they are installed. */
export async function mcpList(_options: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit();
  const servers = await parseTeamMcpServers(localConfig.repo.localPath);

  if (servers.length === 0) {
    log.info('No team MCP servers defined (mcp/mcp.yaml not found or empty)');
    return;
  }

  const targets = await resolveMcpTargets(teamConfig, localConfig);
  const vars = await buildVarTable(localConfig);
  const manifest = (await readJson<ManagedMcpManifest>(
    managedMcpManifestPath(localConfig.scope, localConfig.projectRoot),
  )) ?? {};

  console.log(`Team MCP servers — mcp/mcp.yaml (${servers.length}):`);
  console.log('');
  for (const s of servers) {
    const endpoint = s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}`.trim() : s.url;
    console.log(`  ${s.name}  [${s.transport}]`);
    if (s.description) console.log(`    ${s.description}`);
    console.log(`    endpoint: ${endpoint}`);

    const needed = referencedVars(s);
    if (needed.length > 0) {
      const missing = needed.filter((v) => !vars[v]);
      const state = missing.length === 0 ? 'all set' : `MISSING: ${missing.join(', ')}`;
      console.log(`    secrets:  ${needed.join(', ')} (${state})`);
    }

    const installedIn = targets
      .filter((t) => (manifest[`${t.tool}${t.projectScope ? ':project' : ''}`] ?? []).some((r) => r.name === s.name))
      .map((t) => t.tool);
    console.log(`    installed: ${installedIn.length > 0 ? installedIn.join(', ') : '(none)'}`);
    console.log('');
  }

  console.log('MCP-capable tools detected:');
  if (targets.length === 0) {
    console.log('  (none)');
  } else {
    for (const t of targets) console.log(`  ${t.tool.padEnd(16)} ${displayPath(t.file)}`);
  }
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
  const { localConfig, teamConfig } = await autoDetectInit();
  const { changes, wrote } = await reconcileMcpForConfig(teamConfig, localConfig, {
    dryRun: options.dryRun,
    force: options.force,
  });

  console.log(options.dryRun ? 'MCP inject (dry run):' : 'MCP inject:');
  reportChanges(changes);

  if (wrote) log.success('MCP servers updated. Restart your AI tool session to load them.');
  else if (!options.dryRun) log.info('Already up to date.');
}

export async function mcpRemove(_options: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit();
  const { changes, wrote } = await reconcileMcpForConfig(teamConfig, localConfig, { removeAll: true });

  console.log('MCP remove:');
  reportChanges(changes);

  if (wrote) log.success('teamai-managed MCP servers removed.');
  else log.info('Nothing to remove.');
}
