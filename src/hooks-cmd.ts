import path from 'node:path';
import { autoDetectInit } from './config.js';
import { injectHooksToAllTools, removeHooks } from './hooks.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, LocalConfig } from './types.js';
import { resolveBaseDir } from './types.js';

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
