import path from 'node:path';
import { autoDetectInit } from './config.js';
import { reconcileHooks, reconcileHooksToAllTools, reconcileTeamHooksForConfig, sweepLegacyProjectHooks, getHookStatus, hasInstalledCodexTrustGatedTool, codexTrustReminder, type HookStatus } from './hooks.js';
import { builtinHookDefs } from './builtin-hooks.js';
import { parseTeamHooks } from './resources/hooks.js';
import { log } from './utils/logger.js';
import type { GlobalOptions } from './types.js';
import {
    COPILOT_TOOL_ID,
    getManagedHooksPath,
    resolveHookScope,
    resolveToolBaseDir,
    scopedToolPaths,
} from './types.js';
import { getUserHome } from './utils/home.js';
import { pathExists } from './utils/fs.js';

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
    const { baseDir } = resolveHookScope(localConfig);
    await reconcileTeamHooksForConfig(teamConfig, localConfig, {
        auto: false,
        silent: options.silent,
    });
    let codexTrustGated = false;
    if (await hasInstalledCodexTrustGatedTool(teamConfig.toolPaths, baseDir)) {
        codexTrustGated = true;
    }

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

    for (const [tool, paths] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
        const hookPath = paths.hooks
            ? path.join(resolveToolBaseDir(tool, localConfig), paths.hooks)
            : paths.settings
                ? path.join(baseDir, paths.settings)
                : undefined;
        // OMP has no settings/hooks file to parse: its hooks are a single
        // generated extension under the user agent dir, so presence of the
        // file (with our marker) is the whole status.
        if (tool === 'omp') {
            const { resolveOmpExtensionsDir, OMP_HOOK_FILE } = await import('./omp-hooks.js');
            const extFile = path.join(resolveOmpExtensionsDir(), OMP_HOOK_FILE);
            rows.push({
                tool,
                status: await pathExists(extFile) ? 'installed' : 'missing',
                settingsPath: formatDisplayPath(extFile),
            });
            continue;
        }
        if (!hookPath) {
            rows.push({ tool, status: 'not configured', settingsPath: 'no settings configured' });
            continue;
        }
        rows.push({
            tool,
            status: await getHookStatus(hookPath, tool),
            settingsPath: formatDisplayPath(hookPath),
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
            const roles = d.roles ? `, roles: ${d.roles.length > 0 ? d.roles.join(',') : 'nobody'}` : '';
            console.log(`  [${d.key}] ${d.event}${matcher}  →  ${d.command}  (tools: ${tools}${roles})`);
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

    const copilotPaths = scopedToolPaths(teamConfig, localConfig)[COPILOT_TOOL_ID];
    if (copilotPaths?.hooks) {
        await reconcileHooks(
            path.join(resolveToolBaseDir(COPILOT_TOOL_ID, localConfig), copilotPaths.hooks),
            COPILOT_TOOL_ID,
            [],
            {
                manifestPath: getManagedHooksPath(localConfig.scope, localConfig.projectRoot),
                removeAll: true,
            },
        );
    }

    // Clean up the legacy <projectRoot> copy a pre-#370 CLI wrote alongside HOME
    // for a non-self project scope. Gated to a project-owned location that
    // differs from the primary target — never HOME (shared with user scope, and
    // the primary target itself when projectRoot IS the home dir), and never
    // re-running on the primary target in self mode.
    await sweepLegacyProjectHooks(teamConfig.toolPaths, localConfig);

    log.success('Hooks removed from all AI tool settings');
}
