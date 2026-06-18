import path from 'node:path';
import { autoDetectInit } from './config.js';
import { injectHooksToAllTools, removeHooks } from './hooks.js';
import { log } from './utils/logger.js';
import type { GlobalOptions } from './types.js';
import { resolveBaseDir } from './types.js';

/**
 * Handler for `teamai hooks inject`.
 * Loads config and injects teamai hooks into all configured AI tool settings.
 */
export async function hooksInject(options: GlobalOptions): Promise<void> {
    const { localConfig, teamConfig } = await autoDetectInit();

    const baseDir = resolveBaseDir(localConfig);
    await injectHooksToAllTools(teamConfig.toolPaths, baseDir);

    // Project scope: also inject into user scope (~/) so hooks work from subdirectories
    if (localConfig.scope === 'project') {
        const userBaseDir = process.env.HOME ?? '';
        await injectHooksToAllTools(teamConfig.toolPaths, userBaseDir);
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

    const baseDir = resolveBaseDir(localConfig);
    for (const [tool, paths] of Object.entries(teamConfig.toolPaths)) {
        if (paths.settings) {
            const settingsPath = path.join(baseDir, paths.settings);
            try {
                await removeHooks(settingsPath, tool);
            } catch (e) {
                log.warn(`Failed to remove hooks from ${tool}: ${(e as Error).message}`);
            }
        }
    }

    log.success('Hooks removed from all AI tool settings');
}
