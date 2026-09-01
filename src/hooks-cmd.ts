import path from 'node:path';
import { autoDetectInit } from './config.js';
import { reconcileHooksToAllTools, sweepLegacyProjectHooks, getHookStatus, hasInstalledCodexTrustGatedTool, codexTrustReminder, type HookStatus } from './hooks.js';
import { builtinHookDefs } from './builtin-hooks.js';
import { parseTeamHooks, resolveTeamHooks } from './resources/hooks.js';
import { log } from './utils/logger.js';
import type { GlobalOptions } from './types.js';
import { resolveHookScope, isSelfMode } from './types.js';
import { getUserHome } from './utils/home.js';

type HookListStatus = HookStatus | 'not configured';

interface HookListRow {
    tool: string;
    status: HookListStatus;
    settingsPath: string;
}

function formatDisplayPath(settingsPath: string): string {
    const home = getUserHome();

    if (settingsPath === home) return '~';
    if (settingsPath.startsWith(home + path.sep) || settingsPath.startsWith(home + '/')) {
        return `~${settingsPath.slice(home.length)}`;
    }
    return settingsPath;
}

function formatHooksList(rows: HookListRow[]): string {
    const toolWidth = Math.max('tool'.length, ...rows.map((row) => row.tool.length));
    const statusWidth = Math.max('status'.length, ...rows.map((row) => row.status.length));

    const lines = [
        `${'tool'.padEnd(toolWidth)}  ${'status'.padEnd(statusWidth)}  settings`,
        `${'-'.repeat(toolWidth)}  ${'-'.repeat(statusWidth)}  ${'-'.repeat('settings'.length)}`,
    ];

    for (const row of rows) {
        lines.push(
            `${row.tool.padEnd(toolWidth)}  ${row.status.padEnd(statusWidth)}  ${row.settingsPath}`,
        );
    }

    return lines.join('\n');
}

/**
 * Handler for `teamai hooks inject`.
 * Reconciles built-in (A) + team (B) hooks into all configured AI tool settings.
 */
export async function hooksInject(options: GlobalOptions): Promise<void> {
    const { localConfig, teamConfig } = await autoDetectInit();

    // Explicit user action → not gated by sharing.hooks.autoApply (auto: false).
    const { defs: teamDefs, builtin } = await resolveTeamHooks(teamConfig, localConfig.repo.localPath, {
        auto: false,
        silent: options.silent,
    });
    let codexTrustGated = false;
    const { baseDir, manifestPath } = resolveHookScope(localConfig);
    await reconcileHooksToAllTools(teamConfig.toolPaths, baseDir, teamDefs, manifestPath, {
        builtinOverride: builtin,
        teamHookProjectRoot: localConfig.scope === 'project' && !isSelfMode(localConfig)
            ? localConfig.projectRoot
            : undefined,
        installedBaseDir: localConfig.scope === 'project' ? (localConfig.projectRoot ?? baseDir) : undefined,
    });
    if (await hasInstalledCodexTrustGatedTool(teamConfig.toolPaths, baseDir)) {
        codexTrustGated = true;
    }

    // Sweep any legacy <projectRoot> copy a pre-#370 CLI left behind, so the
    // HOME copy this command just wrote is the only one that fires (#264/#370).
    await sweepLegacyProjectHooks(teamConfig.toolPaths, localConfig);

    if (!options.silent) {
        log.success('Hooks injected into all AI tool settings');
        // The public Codex gates non-managed hooks behind an explicit trust step;
        // remind the user to trust them in Codex. teamai never edits [hooks.state]
        // to auto-trust (constraint: reminder only, no bypass).
        if (codexTrustGated) {
            log.warn(codexTrustReminder());
        }
    }
}

/**
 * Handler for `teamai hooks list`.
 * Shows per-tool built-in install status, then audits the effective built-in (A)
 * and team (B) hook definitions.
 */
export async function hooksList(_options: GlobalOptions): Promise<void> {
    const { localConfig, teamConfig } = await autoDetectInit();
    const { baseDir } = resolveHookScope(localConfig);
    const rows: HookListRow[] = [];

    for (const [tool, paths] of Object.entries(teamConfig.toolPaths)) {
        if (!paths.settings) {
            rows.push({ tool, status: 'not configured', settingsPath: 'no settings configured' });
            continue;
        }
        const settingsPath = path.join(baseDir, paths.settings);
        rows.push({
            tool,
            status: await getHookStatus(settingsPath, tool),
            settingsPath: formatDisplayPath(settingsPath),
        });
    }

    console.log(formatHooksList(rows));

    const teamDefs = await parseTeamHooks(localConfig.repo.localPath);

    console.log('');
    console.log('Built-in hooks (A) — teamai operational (injected into every tool):');
    for (const d of builtinHookDefs('claude')) {
        const matcher = d.matcher && d.matcher !== '*' ? ` [${d.matcher}]` : '';
        console.log(`  ${d.event}${matcher}  →  ${d.command}`);
    }

    console.log('');
    console.log(`Team hooks (B) — hooks/hooks.yaml (${teamDefs.length}):`);
    if (teamDefs.length === 0) {
        console.log('  (none)');
    } else {
        for (const d of teamDefs) {
            const matcher = d.matcher ? ` [${d.matcher}]` : '';
            const tools = d.tools && d.tools.length > 0 ? d.tools.join(',') : 'all';
            console.log(`  [${d.key}] ${d.event}${matcher}  →  ${d.command}  (tools: ${tools})`);
        }
    }
    console.log('');
}

/**
 * Handler for `teamai hooks remove`.
 * Removes built-in (A) + team (B) teamai hooks from all configured AI tool settings.
 */
export async function hooksRemove(_options: GlobalOptions): Promise<void> {
    const { localConfig, teamConfig } = await autoDetectInit();

    const { baseDir, manifestPath } = resolveHookScope(localConfig);
    await reconcileHooksToAllTools(teamConfig.toolPaths, baseDir, [], manifestPath, { removeAll: true });

    // Clean up the legacy <projectRoot> copy a pre-#370 CLI wrote alongside HOME
    // for a non-self project scope. Gated to a project-owned location that
    // differs from the primary target — never HOME (shared with user scope, and
    // the primary target itself when projectRoot IS the home dir), and never
    // re-running on the primary target in self mode.
    await sweepLegacyProjectHooks(teamConfig.toolPaths, localConfig);

    log.success('Hooks removed from all AI tool settings');
}
