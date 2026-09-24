import path from 'node:path';
import { autoDetectInit } from './config.js';
import { reconcileHooks, reconcileHooksToAllTools, reconcileTeamHooksForConfig, sweepLegacyProjectHooks, getHookStatus, hasInstalledCodexTrustGatedTool, codexTrustReminder, type HookStatus } from './hooks.js';
import { applyBuiltinOverride, installedBuiltinHookDefs } from './builtin-hooks.js';
import { parseTeamHooksConfig } from './resources/hooks.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, HookDef } from './types.js';
import {
    COPILOT_TOOL_ID,
    getManagedHooksPath,
    isAgentExcluded,
    resolveHookScope,
    resolveToolBaseDir,
    scopedToolPaths,
} from './types.js';
import { getUserHome } from './utils/home.js';
import { pathExists } from './utils/fs.js';
import { hasPiHooks, removePiHooks, resolvePiExtensionsDir, PI_HOOK_FILE } from './pi-hooks.js';

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
        const { resolveOmpExtensionsDir, OMP_HOOK_FILE } = await import('./omp-hooks.js');
        return [path.join(resolveOmpExtensionsDir(), OMP_HOOK_FILE)];
    }
    if (tool === 'opencode') {
        // reconcileOpencodePlugin always installs the single plugin under the
        // user path, whatever the config scope, so probe there.
        const { resolveOpencodePluginDir, OPENCODE_HOOK_FILE } = await import('./opencode-hooks.js');
        return [path.join(resolveOpencodePluginDir(getUserHome(), 'user'), OPENCODE_HOOK_FILE)];
    }
    if (tool === 'hermes') {
        const { getReportScriptPath } = await import('./hermes-hooks.js');
        return [getReportScriptPath()];
    }
    if (tool === 'openclaw') {
        const { resolveOpenclawWorkspaceDir, OPENCLAW_HOOK_DIR } = await import('./openclaw-hooks.js');
        const workspace = await resolveOpenclawWorkspaceDir();
        if (!workspace) return null;
        // The engine needs both halves: the HOOK.md descriptor and the handler
        // it points at.
        const dir = path.join(workspace, 'hooks', OPENCLAW_HOOK_DIR);
        return [path.join(dir, 'HOOK.md'), path.join(dir, 'handler.ts')];
    }
    return null;
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
    const { baseDir, scope: hookScope } = resolveHookScope(localConfig);
    // The settings file must be resolved at the scope hooks were injected into,
    // not at the config's scope: a non-self project scope injects into HOME, and a
    // tool whose user-scope prefix differs from its project-scope one (Qoder CN:
    // `~/.qoder-cn` vs `<root>/.qoder`) would otherwise be probed in the *other*
    // build's file and always reported missing.
    const hookScopedPaths = scopedToolPaths(teamConfig, { ...localConfig, scope: hookScope });
    // The team's `builtin:` block can disable built-in hooks (§4.8); the
    // reconcile engine applies it, so the listing must too or it shows hooks
    // that were just removed from the settings files.
    const { defs: teamDefs, builtin: builtinOverride } = await parseTeamHooksConfig(localConfig.repo.localPath);
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

    for (const [tool, paths] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
        if (isAgentExcluded(localConfig, tool)) continue;
        if (tool === 'pi') {
            const hookPath = path.join(resolvePiExtensionsDir(), PI_HOOK_FILE);
            rows.push({
                tool,
                status: await hasPiHooks() ? 'installed' : 'missing',
                settingsPath: formatDisplayPath(hookPath),
                builtinDefs: installedBuiltinHookDefs(tool, false),
            });
            continue;
        }
        const hookPath = paths.hooks
            ? path.join(resolveToolBaseDir(tool, localConfig), paths.hooks)
            : hookScopedPaths[tool]?.settings
                ? path.join(baseDir, hookScopedPaths[tool].settings)
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
    console.log(`Team hooks (B) — hooks/hooks.yaml (${teamDefs.length}):`);
    if (teamDefs.length === 0) {
        console.log('  (none)');
    } else {
        for (const d of teamDefs) {
            const matcher = d.matcher ? ` [${d.matcher}]` : '';
            const tools = d.tools && d.tools.length > 0 ? d.tools.join(',') : 'all';
            const roles = d.roles ? `, roles: ${d.roles.length > 0 ? d.roles.join(',') : 'nobody'}` : '';
            const projects = d.projects ? `, projects: ${d.projects.length > 0 ? d.projects.join(',') : 'nobody'}` : '';
            console.log(`  [${d.key}] ${d.event}${matcher}  →  ${d.command}  (tools: ${tools}${roles}${projects})`);
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

    const { baseDir, manifestPath, scope: hookScope } = resolveHookScope(localConfig);
    // Removal must target the same paths injection used. A non-self project
    // scope injects into HOME, so resolving the project-scope paths here would
    // miss (and leave behind) every tool whose user-scope prefix differs.
    await reconcileHooksToAllTools(scopedToolPaths(teamConfig, { ...localConfig, scope: hookScope }), baseDir, [], manifestPath, {
        removeAll: true,
        scope: localConfig.scope,
        installedBaseDir: localConfig.scope === 'project' ? localConfig.projectRoot : undefined,
    });

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

    // Pi has one shared user extension. `hooks remove` is an explicit global
    // hook-disable action even when invoked from a project; project uninstall
    // follows scope ownership separately and preserves this file.
    if (teamConfig.toolPaths.pi) {
        await removePiHooks();
    }

    log.success('Hooks removed from all AI tool settings');
}
