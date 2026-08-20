/**
 * Self-heal bootstrap for single-repo mode (issue #198).
 *
 * When an admin runs `teamai init .`, the knowledge skeleton and
 * `.teamai/teamai.yaml` (carrying `mode: self`) are committed to main and travel
 * with `git clone`. But the machine-local `config.yaml` / `token` / `state.json`
 * are gitignored and do NOT travel. So a teammate who clones the repo has the
 * team knowledge on disk but no local config — teamai would otherwise treat the
 * project as uninitialized.
 *
 * `bootstrapSelfRepo` fills that gap: on any teamai command or session-start
 * hook, when `.teamai/teamai.yaml` says `mode: self` but there is no local
 * config, it non-interactively writes the local config, injects hooks, and
 * registers the member — no need to re-type repo/role. Best-effort and locked so
 * concurrent hooks don't race.
 */
import path from 'node:path';
import YAML from 'yaml';
import {
  BOOTSTRAP_LOCK_FILENAME,
  getConfigPath,
  type LocalConfig,
  type TeamaiConfig,
} from './types.js';
import { readFileSafe, pathExists, ensureDir, writeFile } from './utils/fs.js';
import { getRemoteUrl } from './utils/git.js';
import { log } from './utils/logger.js';
import { acquireLock, releaseLock } from './update.js';

export type BootstrapResult = 'bootstrapped' | 'already' | 'skip';

/**
 * Read `.teamai/teamai.yaml` at dir and return it iff it declares `mode: self`.
 * Returns null otherwise (not a single-repo project). Purely a marker read — no
 * schema validation beyond the mode field so a partial/older file still triggers.
 */
async function readSelfModeMarker(dir: string): Promise<{ repo?: string; provider?: string } | null> {
  const yamlPath = path.join(dir, '.teamai', 'teamai.yaml');
  const content = await readFileSafe(yamlPath);
  if (!content) return null;
  try {
    const raw = YAML.parse(content) as Partial<TeamaiConfig> | null;
    if (raw && raw.mode === 'self') {
      return { repo: raw.repo, provider: raw.provider };
    }
  } catch {
    // malformed yaml — not our concern here
  }
  return null;
}

/**
 * If `dir` is a single-repo teamai project (teamai.yaml has `mode: self`) but has
 * no local config yet, non-interactively bootstrap the machine side. Idempotent.
 *
 * @param dir business repo root (defaults to cwd)
 * @param opts.silent suppress user-facing logs (session-start hook path)
 */
export async function bootstrapSelfRepo(
  dir?: string,
  opts?: { silent?: boolean },
): Promise<BootstrapResult> {
  const businessRepoRoot = dir ?? process.cwd();
  const silent = opts?.silent ?? false;
  const info = (msg: string) => { if (!silent) log.info(msg); };

  // Fast path: already initialized.
  const configPath = getConfigPath('project', businessRepoRoot);
  if (await pathExists(configPath)) return 'already';

  // Only self-mode projects auto-bootstrap.
  const marker = await readSelfModeMarker(businessRepoRoot);
  if (!marker) return 'skip';

  const lockPath = path.join(businessRepoRoot, '.teamai', BOOTSTRAP_LOCK_FILENAME);
  const locked = await acquireLock(lockPath);
  if (!locked) {
    log.debug('[bootstrap] another bootstrap is in progress; skipping');
    return 'skip';
  }

  try {
    // Re-check under the lock — a concurrent run may have finished.
    if (await pathExists(configPath)) return 'already';

    const localPath = path.join(businessRepoRoot, '.teamai');

    // Derive provider/remote: prefer the business repo origin, fall back to the
    // repo recorded in teamai.yaml.
    const remoteUrl = (await getRemoteUrl(businessRepoRoot)) ?? marker.repo ?? '';
    if (!remoteUrl) {
      log.debug('[bootstrap] no remote/repo to derive provider from; skipping');
      return 'skip';
    }

    const { getProvider, detectProvider } = await import('./providers/index.js');
    const providerName = marker.provider ?? detectProvider(remoteUrl);
    const provider = getProvider(providerName);

    // Non-interactive gate: only proceed if already authenticated. Never trigger
    // an interactive login from a hook — degrade to skip and let an explicit
    // `teamai init .` handle first-time auth.
    if (!provider.isAuthenticated()) {
      if (!silent) {
        log.warn('This is a teamai single-repo project, but you are not authenticated yet.');
        log.warn(`Run \`teamai init .\` (or authenticate with your git provider) to finish setup.`);
      }
      return 'skip';
    }

    let username: string;
    try {
      username = await provider.authenticate();
    } catch {
      log.debug('[bootstrap] could not resolve username; skipping');
      return 'skip';
    }

    let repoInfo;
    try {
      repoInfo = provider.parseRepoInput(remoteUrl);
    } catch {
      log.debug('[bootstrap] could not parse remote; skipping');
      return 'skip';
    }

    info('Detected a teamai single-repo project — finishing local setup...');

    const { loadTeamConfig, saveLocalConfigForScope, loadStateForScope, saveStateForScope } = await import('./config.js');
    const teamConfig = await loadTeamConfig(localPath);
    if (!teamConfig) {
      log.debug('[bootstrap] teamai.yaml not loadable; skipping');
      return 'skip';
    }

    // Bootstrap is fully non-interactive (clone-time self-heal), so we can't ask
    // which tools to set up. Mirror whatever this developer already uses under
    // their HOME (~/.claude, ~/.codex, ...). Empty means "seed nothing" — they
    // get the knowledge, and can run `teamai init .` to pick tools explicitly.
    const { detectHomeInstalledAgents } = await import('./known-agents.js');
    const enabledAgents = await detectHomeInstalledAgents();

    const localConfig: LocalConfig = {
      repo: { localPath, remote: repoInfo.httpsUrl, kind: 'self', businessRepoRoot },
      username,
      scope: 'project',
      projectRoot: businessRepoRoot,
      additionalRoles: [],
      ...(enabledAgents.length > 0 ? { enabledAgents } : {}),
    };

    // Role (non-interactive): auto-select when the repo defines exactly one role.
    // Multi-role repos leave role unset — the member can set it later with
    // `teamai roles set`. A repo without a manifest just skips this.
    try {
      const { loadRolesManifest } = await import('./roles.js');
      const manifest = await loadRolesManifest(localPath);
      if (manifest.roles.length === 1) {
        localConfig.primaryRole = manifest.roles[0].id;
        localConfig.resourceProfileVersion = manifest.version;
      }
    } catch {
      // no roles manifest — leave role unset
    }

    await ensureDir(localPath);
    await saveLocalConfigForScope(localConfig, 'project', businessRepoRoot);

    // Invalidate pull cache so the next pull does a full sync.
    try {
      const state = await loadStateForScope('project', businessRepoRoot);
      state.lastPullRev = null;
      await saveStateForScope(state, 'project', businessRepoRoot);
    } catch {
      // state may not exist yet
    }

    // Seed the tool skills-dir so hooks + skills inject on this fresh clone
    // (isToolInstalled would otherwise skip everything — no <repo>/.claude yet).
    try {
      const { seedSelfModeToolDirs } = await import('./known-agents.js');
      await seedSelfModeToolDirs(localConfig, teamConfig);
    } catch (e) {
      log.debug(`[bootstrap] tool-dir seeding skipped: ${(e as Error).message}`);
    }

    // Inject hooks so session-start pull/report fire from now on.
    try {
      const { reconcileTeamHooksForConfig } = await import('./hooks.js');
      await reconcileTeamHooksForConfig(teamConfig, localConfig, {});
    } catch (e) {
      log.debug(`[bootstrap] hook injection failed (non-blocking): ${(e as Error).message}`);
    }

    // Register member on the reports orphan branch. Best-effort: no write access
    // just means the member isn't listed — they still get the knowledge.
    try {
      const { ensureReportsWorktree, commitAndPushReports } = await import('./utils/reports-branch.js');
      const wt = await ensureReportsWorktree(localConfig);
      const memberDir = path.join(wt, 'members');
      await ensureDir(memberDir);
      const memberPath = path.join(memberDir, `${username}.yaml`);
      if (!(await pathExists(memberPath))) {
        await writeFile(memberPath, YAML.stringify({
          username,
          displayName: username,
          registeredAt: new Date().toISOString(),
        }));
        await commitAndPushReports(localConfig, `[teamai] Register member: ${username}`, ['members/']);
      }
    } catch (e) {
      log.debug(`[bootstrap] member registration skipped (non-blocking): ${(e as Error).message}`);
    }

    info('teamai single-repo project initialized locally. Team skills/rules are now active.');
    return 'bootstrapped';
  } catch (e) {
    log.debug(`[bootstrap] failed (non-blocking): ${(e as Error).message}`);
    return 'skip';
  } finally {
    await releaseLock(lockPath);
  }
}
