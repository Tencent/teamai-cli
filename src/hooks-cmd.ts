import path from 'node:path';
import { autoDetectInit } from './config.js';
import { getHookStatus, injectHooksToAllTools, removeHooks, type HookStatus } from './hooks.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, LocalConfig } from './types.js';
import { resolveBaseDir } from './types.js';

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

async function removeHooksFromAllTools(
    toolPaths: Record<string, { settings?: string }>,
    baseDir: string,
): Promise<void> {
    for (const [tool, paths] of Object.entries(toolPaths)) {
        if (paths.settings) {
            const settingsPath = path.join(baseDir, paths.settings);
            try {
                await removeHooks(settingsPath, tool);
            } catch (e) {
                log.warn(`Failed to remove hooks from ${tool}: ${(e as Error).message}`);
            }
        }
    }
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
 * Loads config and injects teamai hooks into all configured AI tool settings.
 */
export async function hooksInject(options: GlobalOptions): Promise<void> {
    const { localConfig, teamConfig } = await autoDetectInit();

    for (const baseDir of resolveHookBaseDirs(localConfig)) {
        await injectHooksToAllTools(teamConfig.toolPaths, baseDir);
    }

    if (!options.silent) {
        log.success('Hooks injected into all AI tool settings');
    }
}

/**
 * Handler for `teamai hooks remove`.
 * Removes teamai hooks from all configured AI tool settings.
 */
export async function hooksRemove(_options: GlobalOptions): Promise<void> {
    const { localConfig, teamConfig } = await autoDetectInit();

    for (const baseDir of resolveHookBaseDirs(localConfig)) {
        await removeHooksFromAllTools(teamConfig.toolPaths, baseDir);
    }

    log.success('Hooks removed from all AI tool settings');
}

/**
 * Handler for `teamai hooks list`.
 * Lists hook installation status for each configured AI tool.
 */
export async function hooksList(_options: GlobalOptions): Promise<void> {
    const { localConfig, teamConfig } = await autoDetectInit();
    const baseDirs = resolveHookBaseDirs(localConfig);
    const rows: HookListRow[] = [];

    for (const [tool, paths] of Object.entries(teamConfig.toolPaths)) {
        if (!paths.settings) {
            rows.push({
                tool,
                status: 'not configured',
                settingsPath: 'no settings configured',
            });
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
}
