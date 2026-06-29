import path from 'node:path';
import { autoDetectInit } from './config.js';
import { reconcileHooksToAllTools, getHookStatus, type HookStatus } from './hooks.js';
import { builtinHookDefs } from './builtin-hooks.js';
import { parseTeamHooks, resolveTeamHooks } from './resources/hooks.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, LocalConfig } from './types.js';
import { resolveBaseDir, getManagedHooksPath } from './types.js';

type HookListStatus = HookStatus | 'not configured';

interface HookListRow {
    tool: string;
    status: HookListStatus;
    settingsPath: string;
}

function resolveHookBaseDirs(localConfig: LocalConfig): string[] {
    const baseDir = resolveBaseDir(localConfig) ?? '';
    if (localConfig.scope !== 'project') {
        return [baseDir];
    }

    const userBaseDir = process.env.HOME ?? '';
    if (!userBaseDir || userBaseDir === baseDir) {
        return [baseDir];
    }

    return [baseDir, userBaseDir];
}

function formatDisplayPath(settingsPath: string): string {
    const home = process.env.HOME;
    if (!home) return settingsPath;

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
    const manifestPath = getManagedHooksPath(localConfig.scope, localConfig.projectRoot);
    for (const baseDir of resolveHookBaseDirs(localConfig)) {
        await reconcileHooksToAllTools(teamConfig.toolPaths, baseDir, teamDefs, manifestPath, { builtinOverride: builtin });
    }

    if (!options.silent) {
        log.success('Hooks injected into all AI tool settings');
    }
}

/**
 * Handler for `teamai hooks list`.
 * Shows per-tool built-in install status, then audits the effective built-in (A)
 * and team (B) hook definitions.
 */
export async function hooksList(_options: GlobalOptions): Promise<void> {
    const { localConfig, teamConfig } = await autoDetectInit();
    const baseDirs = resolveHookBaseDirs(localConfig);
    const rows: HookListRow[] = [];

    for (const [tool, paths] of Object.entries(teamConfig.toolPaths)) {
        if (!paths.settings) {
            rows.push({ tool, status: 'not configured', settingsPath: 'no settings configured' });
            continue;
        }
        for (const baseDir of baseDirs) {
            const settingsPath = path.join(baseDir, paths.settings);
            rows.push({
                tool,
                status: await getHookStatus(settingsPath, tool),
                settingsPath: formatDisplayPath(settingsPath),
            });
        }
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

    const manifestPath = getManagedHooksPath(localConfig.scope, localConfig.projectRoot);
    for (const baseDir of resolveHookBaseDirs(localConfig)) {
        await reconcileHooksToAllTools(teamConfig.toolPaths, baseDir, [], manifestPath, { removeAll: true });
    }

    log.success('Hooks removed from all AI tool settings');
}
