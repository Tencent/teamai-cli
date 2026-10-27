import { hookToolPathsForConfig } from './types.js';
import { hookAdapterDir, hookSettingsFile, installOf, locate, openclawWorkspaceDir, ownOf, workspaceHooksOf } from './locate.js';
import path from 'node:path';
import { autoDetectInit } from './config.js';
import { codexTrustPolicy, migrateLegacyManagedHooks, reconcileHooks, reconcileHooksToAllTools, reconcileTeamHooksForConfig, removeCopilotGlobalBuiltins, sweepLegacyProjectHooks, getHookStatus, reportCodexTrust, resolveMainCheckoutHooks, teamHookHistory, trustCodexForScope, type HookStatus } from './hooks.js';
import { applyBuiltinOverride, installedBuiltinHookDefs } from './builtin-hooks.js';
import { resolveTeamHookEntries } from './resources/hooks.js';
import { describeEntryFailure, describeOrigin, reportUndeliveredEntryNotices } from './namespaced-entries.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, HookDef } from './types.js';
import type { HookAdapterId } from './tools.js';
import {
    COPILOT_TOOL_ID,
    getManagedHooksPath,
    isAgentExcluded,
    isSelfMode,
    resolveHookScope,
    scopedToolPaths,
} from './types.js';
import { getUserHome } from './utils/home.js';
import { pathExists } from './utils/fs.js';
import { hasPiHooks, removePiHooks, PI_HOOK_FILE } from './pi-hooks.js';
import { hasKiroHooks, kiroHookFile, removeKiroHooks } from './kiro-hooks.js';

type HookListStatus = HookStatus | 'not configured';

interface HookListRow {
    tool: string;
    status: HookListStatus;
    settingsPath: string;
    /** Built-in hooks this tool really receives (empty = no hook surface). */
    builtinDefs: HookDef[];
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
 * Generated files an adapter-driven tool's built-in hooks live in, or null when
 * the tool is reconciled through a settings file (or its target location cannot
 * be resolved, e.g. no OpenClaw workspace on this machine). The tool counts as
 * installed only when every one of them is present, so a half-written
 * installation does not read as `installed`.
 */
async function adapterHookArtifacts(tool: string): Promise<string[] | null> {
    if (tool === 'omp') {
        const { OMP_HOOK_FILE } = await import('./omp-hooks.js');
        return [path.join(hookAdapterDir('omp-extension'), OMP_HOOK_FILE)];
    }
    if (tool === 'opencode') {
        // reconcileOpencodePlugin always installs the single plugin under the
        // user path, whatever the config scope, so probe there.
        const { OPENCODE_HOOK_FILE } = await import('./opencode-hooks.js');
        return [path.join(hookAdapterDir('opencode-plugin'), OPENCODE_HOOK_FILE)];
    }
    if (tool === 'hermes') {
        const { getReportScriptPath } = await import('./hermes-hooks.js');
        return [getReportScriptPath()];
    }
    if (tool === 'openclaw') {
        const { OPENCLAW_HOOK_DIR } = await import('./openclaw-hooks.js');
        const workspace = await openclawWorkspaceDir();
        if (!workspace) return null;
        // The engine needs both halves: the HOOK.md descriptor and the handler
        // it points at.
        const dir = path.join(workspace, 'hooks', OPENCLAW_HOOK_DIR);
        return [path.join(dir, 'HOOK.md'), path.join(dir, 'handler.ts')];
    }
    return null;
}

/** Remove teamai's hook adapter files from `dir`, a directory `locate` retired. */
async function removeAdapterHooks(adapter: HookAdapterId, dir: string): Promise<void> {
    switch (adapter) {
        case 'opencode-plugin': {
            const { removeOpencodePlugin } = await import('./opencode-hooks.js');
            return removeOpencodePlugin(dir);
        }
        case 'pi-extension':
            return removePiHooks(dir);
        // These adapters' homes have no default-home leftovers (`Home.moves.defaultHomeLeftovers`).
        case 'omp-extension':
        case 'hermes-plugin':
        case 'openclaw-hook':
        case 'dsh-hooks':
        case 'kiro-hooks':
            return;
        default: {
            const unhandled: never = adapter;
            return unhandled;
        }
    }
}

/**
 * Handler for `teamai hooks inject`.
 * Reconciles built-in (A) + team (B) hooks into all configured AI tool settings.
 */
export async function hooksInject(options: GlobalOptions): Promise<void> {
    const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: options.dryRun });

    // Explicit user action → not gated by sharing.hooks.autoApply (auto: false).
    let reconciled: Awaited<ReturnType<typeof reconcileTeamHooksForConfig>>;
    try {
        reconciled = await reconcileTeamHooksForConfig(teamConfig, localConfig, {
            auto: false,
            silent: options.silent,
            dryRun: options.dryRun,
        });
    } finally {
        // Git-hook installation can fail after the Codex hooks were written.
        if (!options.dryRun) {
            const codexTrust = await trustCodexForScope(teamConfig, localConfig, { force: true });
            if (!options.silent) reportCodexTrust(codexTrust, 'all');
        }
    }
    // The reason is already reported; the installed team hooks were left as they were.
    if (!reconciled.ok || reconciled.unwritten?.length) {
        process.exitCode = 1;
        return;
    }
    if (options.dryRun) {
        if (!options.silent) log.info('[dry-run] Would inject hooks into configured AI tool settings.');
        return;
    }
    if (!options.silent && reconciled.ok) log.success('Hooks injected into all AI tool settings');
}

/**
 * Handler for `teamai hooks list`.
 * Shows per-tool built-in install status, then audits the effective built-in (A)
 * and team (B) hook definitions.
 */
export async function hooksList(_options: GlobalOptions): Promise<void> {
    // Read-only: the load never persists a migration (#893).
    const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: true });
    const { baseDir } = resolveHookScope(localConfig);
    // The settings file must be resolved at the scope hooks were injected into,
    // not at the config's scope: a non-self project scope injects into HOME, and a
    // tool whose user-scope prefix differs from its project-scope one (Qoder CN:
    // `~/.qoder-cn` vs `<root>/.qoder`) would otherwise be probed in the *other*
    // build's file and always reported missing.
    const hookScopedPaths = hookToolPathsForConfig(teamConfig, localConfig);
    // The team's `builtin:` block can disable built-in hooks (§4.8); the
    // reconcile engine applies it, so the listing must too or it shows hooks
    // that were just removed from the settings files.
    const { resolution: teamHooks, builtin } = await resolveTeamHookEntries(localConfig);
    // A hook an unknown or removed key takes out of the delivered set never
    // appears in the team-hooks section below, so say why it is missing (#822).
    reportUndeliveredEntryNotices(teamHooks);
    const builtinOverride = builtin.known ? builtin.override : undefined;
    const install = installOf(teamConfig, localConfig);
    const rows: HookListRow[] = [];
    // One settings file is one install, so list it once, for the target that owns
    // it — the same rule the write path applies. Qoder CN shares Qoder's project
    // file, and probing it as its own identity there would report a healthy
    // install as `missing`.
    //
    // Ownership follows the enabled set, not the shipped table: the write path
    // only ever renders the file for an enabled target, so a target the user
    // disabled must not claim it here either. Otherwise a self-scope install that
    // enabled Qoder CN alone would have `qoder` (off, but earlier in the table)
    // claim `<root>/.qoder/settings.json`, probe it for Qoder's dispatch identity,
    // and report `missing` while the enabled `qoder-cn` was never listed at all.
    // `isAgentExcluded` is the same filter `doctor` applies to this path table.
    const seenSettingsFiles = new Set<string>();

    for (const tool of Object.keys(scopedToolPaths(teamConfig, localConfig))) {
        if (isAgentExcluded(localConfig, tool)) continue;
        if (tool === 'kiro') {
            if (!await pathExists(path.join(getUserHome(), '.kiro'))) continue;
            rows.push({ tool, status: await hasKiroHooks() ? 'installed' : 'missing', settingsPath: formatDisplayPath(kiroHookFile()), builtinDefs: installedBuiltinHookDefs(tool, false) });
            continue;
        }
        if (tool === 'pi') {
            const hookPath = path.join(hookAdapterDir('pi-extension'), PI_HOOK_FILE);
            rows.push({
                tool,
                status: await hasPiHooks() ? 'installed' : 'missing',
                settingsPath: formatDisplayPath(hookPath),
                builtinDefs: installedBuiltinHookDefs(tool, false),
            });
            continue;
        }
        const hookPath = hookScopedPaths[tool]?.hooks
            ? ownOf(await locate(tool, 'hooks', install))?.path
            : hookScopedPaths[tool]?.settings
                ? hookSettingsFile(tool, baseDir, hookScopedPaths[tool].settings)
                : undefined;
        if (hookPath) {
            if (seenSettingsFiles.has(hookPath)) continue;
            seenSettingsFiles.add(hookPath);
        }
        // The adapter-driven tools have no settings/hooks file to parse: each
        // installs a single generated artifact, so its presence is the whole
        // status.
        const artifacts = await adapterHookArtifacts(tool);
        if (artifacts) {
            const present = await Promise.all(artifacts.map((file) => pathExists(file)));
            rows.push({
                tool,
                status: present.every(Boolean) ? 'installed' : 'missing',
                settingsPath: formatDisplayPath(artifacts[0] as string),
                builtinDefs: installedBuiltinHookDefs(tool, false),
            });
            continue;
        }
        if (!hookPath) {
            rows.push({
                tool,
                status: 'not configured',
                settingsPath: 'no settings configured',
                builtinDefs: installedBuiltinHookDefs(tool, false),
            });
            continue;
        }
        rows.push({
            tool,
            status: await getHookStatus(hookPath, tool, builtinOverride),
            settingsPath: formatDisplayPath(hookPath),
            // The override is applied to the settings-driven defs only: the
            // standalone adapters generate a fixed handler and ignore it, so
            // filtering their rows would hide hooks they still install.
            builtinDefs: applyBuiltinOverride(installedBuiltinHookDefs(tool, true), builtinOverride),
        });
    }

    console.log(formatHooksList(rows));

    console.log('');
    console.log('Built-in hooks (A) — teamai operational, per tool:');
    // The built-in set is per tool, not universal: Copilot carries an extra
    // SessionEnd entry, the dispatch command differs for ZCode (raw) and the
    // shell-dependent GUI tools (PATH wrapper), and the standalone adapters
    // (Hermes, OMP, OpenClaw) install only part of the set. Rendering one
    // hardcoded tool's set both hid hooks that `hooks inject` really installs
    // and advertised hooks tools without that surface never receive (#717), so
    // tools with no built-in hooks at all are omitted here. Tools whose set is
    // identical once the tool id is folded out share one block, so the listing
    // stays short instead of repeating the same rows per tool.
    const builtinGroups = new Map<string, { tools: string[]; lines: string[] }>();
    for (const { tool, builtinDefs } of rows) {
        if (builtinDefs.length === 0) continue;
        const lines = builtinDefs.map((d) => {
            const matcher = d.matcher && d.matcher !== '*' ? ` [${d.matcher}]` : '';
            const command = d.command.split(`--tool ${tool}`).join('--tool <tool>');
            return `    ${d.event}${matcher}  →  ${command}`;
        });
        const key = lines.join('\n');
        const group = builtinGroups.get(key);
        if (group) group.tools.push(tool);
        else builtinGroups.set(key, { tools: [tool], lines });
    }
    if (builtinGroups.size === 0) {
        console.log('  (none)');
    }
    for (const group of builtinGroups.values()) {
        console.log(`  ${group.tools.join(', ')}:`);
        for (const line of group.lines) console.log(line);
    }

    console.log('');
    if (teamHooks.kind === 'failed') {
        console.log('Team hooks (B) — hooks/:');
        console.log(`  ${describeEntryFailure(teamHooks.failure)}`);
    } else {
        console.log(`Team hooks (B) — hooks/ (${teamHooks.entries.length}):`);
        if (teamHooks.entries.length === 0) console.log('  (none)');
        for (const resolved of teamHooks.entries) {
            const h = resolved.entry;
            const matcher = h.matcher ? ` [${h.matcher}]` : '';
            const tools = h.tools && h.tools.length > 0 ? h.tools.join(',') : 'all';
            const roles = h.roles ? `, roles: ${h.roles.length > 0 ? h.roles.join(',') : 'nobody'} (deprecated)` : '';
            console.log(`  [${h.id}] ${h.event}${matcher}  →  ${h.command}  (tools: ${tools}${roles})  from ${describeOrigin(resolved)}`);
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
    // An index an older release left in the tree still owns Copilot's team hooks (#993).
    await migrateLegacyManagedHooks(localConfig);

    const { baseDir, manifestPath, scope: hookScope } = resolveHookScope(localConfig);
    const teamHookProjectRoot = localConfig.scope === 'project' && !isSelfMode(localConfig)
        ? localConfig.projectRoot
        : undefined;

    // Earlier releases wrote these hooks under the default home, which the tool
    // reads again once its home stops moving (#1221). The records describe the
    // moved copy, so these go first and leave them for its pass below; a copy
    // that fails keeps them there too, for the retry.
    const install = installOf(teamConfig, localConfig);
    const history = teamHookHistory(localConfig);
    const keepRecordsFor = new Set<string>();
    for (const tool of Object.keys(scopedToolPaths(teamConfig, localConfig))) {
        const where = await locate(tool, 'hooks', install);
        for (const { place } of where.retired) {
            if (!await pathExists(place.path)) continue;
            try {
                if (place.kind === 'entry') {
                    await reconcileHooks(place.path, tool, [], { manifestPath, removeAll: true, keepRecords: true, teamHookHistory: history, teamHookProjectRoot });
                } else if (where.channel === 'files' && 'adapter' in where) {
                    await removeAdapterHooks(where.adapter, place.path);
                }
            } catch (e) {
                keepRecordsFor.add(tool);
                log.warn(`Failed to remove hooks from ${place.path}: ${(e as Error).message}`);
            }
        }
    }

    // Removal must target the same paths injection used. A non-self project
    // scope injects into HOME, so resolving the project-scope paths here would
    // miss (and leave behind) every tool whose user-scope prefix differs.
    const unwritten: string[] = [];
    const reconciledMainTools = await reconcileHooksToAllTools(hookToolPathsForConfig(teamConfig, localConfig), baseDir, [], manifestPath, {
        removeAll: true,
        scope: localConfig.scope,
        toolRoots: localConfig.toolRoots,
        installedBaseDir: localConfig.scope === 'project' ? localConfig.projectRoot : undefined,
        teamHookProjectRoot,
        // The project's Claude and Codex team hooks live in the main checkout.
        mainCheckout: await resolveMainCheckoutHooks(localConfig, teamConfig.toolPaths),
        // Self mode: and the team hooks in each tool's settings.local.json (#915).
        ...(isSelfMode(localConfig) ? { selfLocalTeamHooks: { relocate: false } } : {}),
        codexTrust: codexTrustPolicy(localConfig),
        keepRecordsFor,
        unwritten,
    });

    const copilotHooks = await locate(COPILOT_TOOL_ID, 'hooks', install);
    const copilotFile = scopedToolPaths(teamConfig, localConfig)[COPILOT_TOOL_ID]?.hooks === undefined
        ? undefined
        : (workspaceHooksOf(copilotHooks) ?? ownOf(copilotHooks))?.path;
    if (copilotFile !== undefined) {
        await reconcileHooks(
            copilotFile,
            COPILOT_TOOL_ID,
            [],
            {
                manifestPath: getManagedHooksPath(localConfig),
                removeAll: true,
                teamOnly: localConfig.scope === 'project' && hookScope === 'user',
            },
        );
    }

    // Copilot loads every user hook file, so built-ins another project's filename
    // installed would take over the dispatch.
    if (teamConfig.toolPaths[COPILOT_TOOL_ID]) {
        await removeCopilotGlobalBuiltins();
    }

    // Clean up the legacy <projectRoot> copy a pre-#370 CLI wrote alongside HOME
    // for a non-self project scope. Gated to a project-owned location that
    // differs from the primary target — never HOME (shared with user scope, and
    // the primary target itself when projectRoot IS the home dir), and never
    // re-running on the primary target in self mode.
    await sweepLegacyProjectHooks(teamConfig.toolPaths, localConfig, reconciledMainTools, unwritten);

    // Pi has one shared user extension. `hooks remove` is an explicit global
    // hook-disable action even when invoked from a project; project uninstall
    // follows scope ownership separately and preserves this file.
    if (teamConfig.toolPaths.pi) {
        await removePiHooks();
    }
    if (teamConfig.toolPaths.kiro) await removeKiroHooks();

    const left = new Set([...keepRecordsFor, ...unwritten]);
    if (left.size > 0) {
        log.warn(`Hooks remove incomplete: teamai hooks are left for ${[...left].join(', ')}. Fix what the warnings above name, then run \`teamai hooks remove\` again.`);
        process.exitCode = 1;
        return;
    }
    log.success('Hooks removed from all AI tool settings');
}
