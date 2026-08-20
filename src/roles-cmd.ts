import path from 'node:path';
import YAML from 'yaml';
import { autoDetectInit, loadLocalConfig, saveLocalConfig, loadTeamConfig, saveLocalConfigForScope, loadStateForScope, saveStateForScope } from './config.js';
import { loadRolesManifest, saveRolesManifest, findRole, describeRoles, listRoleIds } from './roles.js';
import type { RolesManifest, TeamRole } from './roles.js';
import { pullRepo, pushRepoBranch, checkoutMaster, generateBranchName } from './utils/git.js';
import { ensureDir, pathExists, writeFile, expandHome } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { createPrWithFallback } from './push.js';
import type { GlobalOptions, TeamaiConfig, LocalConfig } from './types.js';
import { askQuestion, askConfirmation } from './utils/prompt.js';

/**
 * Parse a comma-separated string into a trimmed, non-empty string array.
 */
function parseNamespaces(input: string): string[] {
    return input
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

// ─── Shared: pull latest + push branch + PR ──────────────

async function pullLatest(repoPath: string): Promise<void> {
    const pullSpin = spinner('Pulling latest changes...').start();
    try {
        await pullRepo(repoPath);
        pullSpin.succeed('Up to date');
    } catch (e) {
        pullSpin.warn(`Pull failed: ${(e as Error).message}`);
    }
}

/**
 * Run a roles-manifest admin edit (write manifest + open PR) against the right
 * repo. In single-repo mode the manifest is knowledge on main, so the edit runs
 * inside an isolated knowledge worktree (never the user's active tree). `fn`
 * receives the repoPath to read/write the manifest and the localConfig to use for
 * the PR — both already scoped to the worktree in self mode.
 */
async function runRolesEdit(
    localConfig: LocalConfig,
    fn: (repoPath: string, editConfig: LocalConfig) => Promise<void>,
): Promise<void> {
    if (localConfig.repo.kind === 'self') {
        const { withKnowledgeWorktree, EmptyRepoError } = await import('./utils/reports-branch.js');
        try {
            await withKnowledgeWorktree(localConfig, (wtConfig) => fn(wtConfig.repo.localPath, wtConfig));
        } catch (e) {
            if (e instanceof EmptyRepoError) {
                log.error(e.message);
            } else {
                log.error(`Roles update failed: ${(e as Error).message}`);
            }
        }
        return;
    }
    await fn(localConfig.repo.localPath, localConfig);
}

async function pushManifestChange(input: {
    repoPath: string;
    teamConfig: TeamaiConfig;
    localConfig: LocalConfig;
    commitMsg: string;
    prDescription: string;
}): Promise<void> {
    const { repoPath, teamConfig, localConfig, commitMsg, prDescription } = input;
    const branchName = generateBranchName(localConfig.username);

    try {
        const hasChanges = await pushRepoBranch(
            repoPath,
            commitMsg,
            ['manifest/'],
            branchName,
        );

        if (!hasChanges) {
            log.info('No changes to push (manifest unchanged)');
            return;
        }

        log.success(`Pushed branch ${branchName}`);

        await createPrWithFallback(
            teamConfig,
            localConfig,
            branchName,
            commitMsg,
            prDescription,
        );

        await checkoutMaster(repoPath);
    } catch (e) {
        log.error(`Push failed: ${(e as Error).message}`);
    }
}

// ─── roles init ─────────────────────────────────────────

export async function rolesInit(options: GlobalOptions): Promise<void> {
    const { localConfig, teamConfig } = await autoDetectInit();
    const repoPath = localConfig.repo.localPath;
    const selfMode = localConfig.repo.kind === 'self';

    // In self mode the manifest is knowledge on main; the on-disk .teamai already
    // reflects main, so we read the existence check from there and only run the
    // actual write+PR inside an isolated worktree (below). Non-self modes pull the
    // team repo clone first.
    if (!selfMode) await pullLatest(repoPath);

    // Check if manifest already exists
    const manifestPath = path.join(repoPath, 'manifest', 'roles.yaml');
    if (await pathExists(manifestPath)) {
        log.warn(`Roles manifest already exists at ${manifestPath}`);
        const overwrite = await askConfirmation('Overwrite existing manifest? [y/N] ');
        if (!overwrite) {
            log.info('Aborted. Existing manifest is unchanged.');
            return;
        }
    }

    // Interactive: collect roles
    log.info('Define team roles. Each role has an id, description, and resource namespaces.');
    log.info('Resource namespaces determine which subdirectories of skills/ and knowledge/ each role accesses.');
    log.info('Learnings are shared flat across the entire team (no namespace isolation).');
    log.info('');

    const roles: Array<{
        id: string;
        description: string;
        resources: { knowledge: string[]; skills: string[] };
    }> = [];

    let addMore = true;
    while (addMore) {
        const id = await askQuestion(`Role id (e.g. hai, pm, devops): `);
        if (!id) {
            log.warn('Role id is required. Skipping.');
            continue;
        }

        if (roles.some((r) => r.id === id)) {
            log.warn(`Role "${id}" already defined. Skipping.`);
            continue;
        }

        const description = await askQuestion(`Description for "${id}" (optional): `);

        const namespacesInput = await askQuestion(
            `Resource namespaces for "${id}" (comma-separated, e.g. common,${id}): `,
        );
        const namespaces = parseNamespaces(namespacesInput);

        if (namespaces.length === 0) {
            log.warn('At least one namespace is required. Using "common" as default.');
            namespaces.push('common');
        }

        roles.push({
            id,
            description,
            resources: {
                knowledge: namespaces,
                skills: namespaces,
            },
        });

        log.success(`Added role: ${id} (namespaces: ${namespaces.join(', ')})`);

        const more = await askConfirmation('Add another role? [y/N] ');
        addMore = more;
    }

    if (roles.length === 0) {
        log.error('No roles defined. Aborting.');
        return;
    }

    // Generate manifest
    const manifest: RolesManifest = {
        version: 1,
        roles: roles.map((r) => ({ ...r, description: r.description || '' })),
    };

    if (options.dryRun) {
        log.info('[dry-run] Would write manifest:');
        console.log(YAML.stringify(manifest));
        return;
    }

    // Show reminder about directory structure
    const allNamespaces = [...new Set(roles.flatMap((r) => r.resources.skills))];
    log.info('');
    log.info('Next step: organize your skills into namespace subdirectories:');
    for (const ns of allNamespaces) {
        log.info(`  skills/${ns}/`);
    }
    log.info('');
    log.info('Example: mv skills/hai-deploy-test skills/hai/hai-deploy-test');

    const commitMsg = `[teamai] Initialize roles manifest with ${roles.length} role(s)`;
    await runRolesEdit(localConfig, async (editRepoPath, editConfig) => {
        await saveRolesManifest(editRepoPath, manifest);
        log.success(`Manifest written to ${path.join(editRepoPath, 'manifest', 'roles.yaml')}`);
        await pushManifestChange({
            repoPath: editRepoPath,
            teamConfig,
            localConfig: editConfig,
            commitMsg,
            prDescription: `Initialize roles manifest:\n${roles.map((r) => `- ${r.id} (namespaces: ${r.resources.skills.join(', ')})`).join('\n')}`,
        });
    });
}

// ─── roles list ─────────────────────────────────────────

export async function rolesList(options: GlobalOptions): Promise<void> {
    const { localConfig } = await autoDetectInit();
    const repoPath = localConfig.repo.localPath;

    let manifest;
    try {
        manifest = await loadRolesManifest(repoPath);
    } catch (e) {
        log.error((e as Error).message);
        log.info('Run `teamai roles init` to create a roles manifest.');
        return;
    }

    console.log('');
    console.log(`Roles manifest (version ${manifest.version}):`);
    console.log('');

    for (const role of manifest.roles) {
        const desc = role.description ? ` — ${role.description}` : '';
        console.log(`  ${role.id}${desc}`);
        console.log(`    skills:    ${role.resources.skills.join(', ')}`);
        console.log(`    knowledge: ${role.resources.knowledge.join(', ')}`);
        console.log('');
    }

    // Show current user's role
    if (localConfig.primaryRole) {
        console.log(`Your primary role: ${localConfig.primaryRole}`);
        if (localConfig.additionalRoles && localConfig.additionalRoles.length > 0) {
            console.log(`Additional roles: ${localConfig.additionalRoles.join(', ')}`);
        }
    } else {
        console.log('You have no role configured. Run `teamai roles set <role>` to set one.');
    }
}

// ─── roles set ──────────────────────────────────────────

export async function rolesSet(
    primaryRole: string,
    options: GlobalOptions & { add?: string[] },
): Promise<void> {
    const { localConfig } = await autoDetectInit();
    const repoPath = localConfig.repo.localPath;

    let manifest;
    try {
        manifest = await loadRolesManifest(repoPath);
    } catch (e) {
        log.error((e as Error).message);
        log.info('Run `teamai roles init` to create a roles manifest first.');
        return;
    }

    const validIds = new Set(listRoleIds(manifest));

    // Validate primary role
    if (!validIds.has(primaryRole)) {
        log.error(`Unknown role "${primaryRole}". Valid roles: ${[...validIds].join(', ')}`);
        return;
    }

    // Validate additional roles
    const additionalRoles = (options.add ?? []).filter((id) => id !== primaryRole);
    for (const id of additionalRoles) {
        if (!validIds.has(id)) {
            log.error(`Unknown additional role "${id}". Valid roles: ${[...validIds].join(', ')}`);
            return;
        }
    }

    // Update local config
    const updatedConfig = {
        ...localConfig,
        primaryRole,
        additionalRoles,
        resourceProfileVersion: manifest.version,
    };

    if (localConfig.scope === 'project' && localConfig.projectRoot) {
        await saveLocalConfigForScope(updatedConfig, localConfig.scope, localConfig.projectRoot);
    } else {
        await saveLocalConfig(updatedConfig);
    }

    // Invalidate pull cache so next pull does full sync with cleanup
    try {
        const state = await loadStateForScope(localConfig.scope, localConfig.projectRoot);
        state.lastPullRev = null;
        await saveStateForScope(state, localConfig.scope, localConfig.projectRoot);
    } catch {
        // Non-critical: if state doesn't exist yet, next pull will do full sync anyway
    }

    log.success(`Primary role set to: ${primaryRole}`);
    if (additionalRoles.length > 0) {
        log.success(`Additional roles: ${additionalRoles.join(', ')}`);
    }
    log.info('Run `teamai pull` to sync resources for your new role.');
}

// ─── roles add ──────────────────────────────────────────

export async function rolesAdd(
    roleId: string,
    options: GlobalOptions & { namespaces: string; description?: string },
): Promise<void> {
    const namespaces = parseNamespaces(options.namespaces);
    if (namespaces.length === 0) {
        log.error('At least one namespace is required. Use --namespaces common,hai');
        return;
    }

    const { localConfig, teamConfig } = await autoDetectInit();

    await runRolesEdit(localConfig, async (repoPath, editConfig) => {
        if (editConfig.repo.kind !== 'self') await pullLatest(repoPath);

        let manifest: RolesManifest;
        try {
            manifest = await loadRolesManifest(repoPath);
        } catch (e) {
            log.error((e as Error).message);
            log.info('Run `teamai roles init` to create a roles manifest first.');
            return;
        }

        // Check duplicate
        if (findRole(manifest, roleId)) {
            log.error(`Role "${roleId}" already exists. Use \`teamai roles update ${roleId}\` to modify it.`);
            return;
        }

        const newRole: TeamRole = {
            id: roleId,
            description: options.description ?? '',
            resources: {
                knowledge: namespaces,
                skills: namespaces,
            },
        };

        const updatedManifest: RolesManifest = {
            ...manifest,
            roles: [...manifest.roles, newRole],
        };

        if (options.dryRun) {
            log.info(`[dry-run] Would add role "${roleId}" with namespaces: ${namespaces.join(', ')}`);
            return;
        }

        await saveRolesManifest(repoPath, updatedManifest);
        log.success(`Added role: ${roleId} (namespaces: ${namespaces.join(', ')})`);

        const commitMsg = `[teamai] Add role "${roleId}"`;
        await pushManifestChange({
            repoPath,
            teamConfig,
            localConfig: editConfig,
            commitMsg,
            prDescription: `Add role "${roleId}" with namespaces: ${namespaces.join(', ')}${options.description ? `\nDescription: ${options.description}` : ''}`,
        });
    });
}

// ─── roles remove ───────────────────────────────────────

export async function rolesRemove(
    roleId: string,
    options: GlobalOptions,
): Promise<void> {
    const { localConfig, teamConfig } = await autoDetectInit();

    await runRolesEdit(localConfig, async (repoPath, editConfig) => {
        if (editConfig.repo.kind !== 'self') await pullLatest(repoPath);

        let manifest: RolesManifest;
        try {
            manifest = await loadRolesManifest(repoPath);
        } catch (e) {
            log.error((e as Error).message);
            log.info('Run `teamai roles init` to create a roles manifest first.');
            return;
        }

        if (!findRole(manifest, roleId)) {
            log.error(`Role "${roleId}" not found. Valid roles: ${listRoleIds(manifest).join(', ')}`);
            return;
        }

        const remaining = manifest.roles.filter((r) => r.id !== roleId);
        if (remaining.length === 0) {
            log.error('Cannot remove the last role. The manifest requires at least one role.');
            return;
        }

        const updatedManifest: RolesManifest = {
            ...manifest,
            roles: remaining,
        };

        if (options.dryRun) {
            log.info(`[dry-run] Would remove role "${roleId}". Remaining: ${remaining.map((r) => r.id).join(', ')}`);
            return;
        }

        await saveRolesManifest(repoPath, updatedManifest);
        log.success(`Removed role: ${roleId}`);
        log.warn(`Members with primaryRole="${roleId}" will fall back to unfiltered sync on next pull.`);

        const commitMsg = `[teamai] Remove role "${roleId}"`;
        await pushManifestChange({
            repoPath,
            teamConfig,
            localConfig: editConfig,
            commitMsg,
            prDescription: `Remove role "${roleId}". Remaining roles: ${remaining.map((r) => r.id).join(', ')}`,
        });
    });
}

// ─── roles update ───────────────────────────────────────

export async function rolesUpdate(
    roleId: string,
    options: GlobalOptions & {
        addNamespaces?: string;
        removeNamespaces?: string;
        description?: string;
    },
): Promise<void> {
    const hasAddNs = options.addNamespaces !== undefined;
    const hasRemoveNs = options.removeNamespaces !== undefined;
    const hasDesc = options.description !== undefined;

    if (!hasAddNs && !hasRemoveNs && !hasDesc) {
        log.error('Nothing to update. Use --add-namespaces, --remove-namespaces, or --description.');
        return;
    }

    const { localConfig, teamConfig } = await autoDetectInit();

    await runRolesEdit(localConfig, async (repoPath, editConfig) => {
        if (editConfig.repo.kind !== 'self') await pullLatest(repoPath);

        let manifest: RolesManifest;
        try {
            manifest = await loadRolesManifest(repoPath);
        } catch (e) {
            log.error((e as Error).message);
            log.info('Run `teamai roles init` to create a roles manifest first.');
            return;
        }

        const existingRole = findRole(manifest, roleId);
        if (!existingRole) {
            log.error(`Role "${roleId}" not found. Valid roles: ${listRoleIds(manifest).join(', ')}`);
            return;
        }

        // Build updated namespaces (immutable)
        let updatedNamespaces = [...existingRole.resources.skills];

        if (hasAddNs) {
            const toAdd = parseNamespaces(options.addNamespaces!);
            const existing = new Set(updatedNamespaces);
            for (const ns of toAdd) {
                if (!existing.has(ns)) {
                    updatedNamespaces.push(ns);
                    existing.add(ns);
                }
            }
        }

        if (hasRemoveNs) {
            const toRemove = new Set(parseNamespaces(options.removeNamespaces!));
            updatedNamespaces = updatedNamespaces.filter((ns) => !toRemove.has(ns));
        }

        if (updatedNamespaces.length === 0) {
            log.error('Cannot remove all namespaces. A role must have at least one namespace.');
            return;
        }

        const updatedRole: TeamRole = {
            ...existingRole,
            description: hasDesc ? options.description! : existingRole.description,
            resources: {
                knowledge: updatedNamespaces,
                skills: updatedNamespaces,
            },
        };

        const updatedManifest: RolesManifest = {
            ...manifest,
            roles: manifest.roles.map((r) => (r.id === roleId ? updatedRole : r)),
        };

        if (options.dryRun) {
            log.info(`[dry-run] Would update role "${roleId}":`);
            log.info(`  namespaces: ${updatedNamespaces.join(', ')}`);
            if (hasDesc) log.info(`  description: ${options.description}`);
            return;
        }

        await saveRolesManifest(repoPath, updatedManifest);
        log.success(`Updated role: ${roleId} (namespaces: ${updatedNamespaces.join(', ')})`);

        const changes: string[] = [];
        if (hasAddNs) changes.push(`added namespaces: ${options.addNamespaces}`);
        if (hasRemoveNs) changes.push(`removed namespaces: ${options.removeNamespaces}`);
        if (hasDesc) changes.push(`description: ${options.description}`);

        const commitMsg = `[teamai] Update role "${roleId}"`;
        await pushManifestChange({
            repoPath,
            teamConfig,
            localConfig: editConfig,
            commitMsg,
            prDescription: `Update role "${roleId}": ${changes.join(', ')}`,
        });
    });
}
