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
import { getMemberConfig, mergeMemberConfig } from './members.js';

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

type SelfModeMarker = NonNullable<Awaited<ReturnType<typeof readSelfModeMarker>>>;

/**
 * Where a bootstrap of `businessRepoRoot` would write, or why it would not run:
 * 'already' when a config exists (partition or legacy), 'skip' when the repo is
 * not a single-repo project.
 */
async function findPendingBootstrap(
  businessRepoRoot: string,
  dryRun: boolean,
): Promise<{ partitionHome: string; configPath: string; marker: SelfModeMarker } | 'already' | 'skip'> {
  // P2 (issue #374): a self install's machine config lives in the per-project
  // partition, not the repo. Resolve it up front and use it for the "already
  // initialized" check and as the write target. Also honor the legacy in-repo
  // location so a pre-P2 self install (config still under <repo>/.teamai) is
  // recognized as already initialized and not re-bootstrapped.
  const { resolveProjectDataHome } = await import('./config.js');
  const partitionHome = await resolveProjectDataHome(businessRepoRoot, { dryRun });
  const configPath = path.join(partitionHome, 'config.yaml');
  const legacyConfigPath = getConfigPath('project', businessRepoRoot);

  // Fast path: already initialized (partition or legacy).
  if ((await pathExists(configPath)) || (await pathExists(legacyConfigPath))) return 'already';

  // Only self-mode projects auto-bootstrap.
  const marker = await readSelfModeMarker(businessRepoRoot);
  if (!marker) return 'skip';
  return { partitionHome, configPath, marker };
}

/**
 * The config a bootstrap would write, worked out without writing anything.
 * Null when the bootstrap cannot finish non-interactively (no remote, not
 * authenticated, no team config). A dry run makes no provider auth call, so its
 * config carries no username.
 */
async function planSelfBootstrap(
  businessRepoRoot: string,
  partitionHome: string,
  marker: SelfModeMarker,
  silent: boolean,
  dryRun: boolean,
): Promise<{ localConfig: LocalConfig; teamConfig: TeamaiConfig; username: string; providerName: string } | null> {
  const localPath = path.join(businessRepoRoot, '.teamai');

  // Derive provider/remote: prefer the business repo origin, fall back to the
  // repo recorded in teamai.yaml.
  const remoteUrl = (await getRemoteUrl(businessRepoRoot)) ?? marker.repo ?? '';
  if (!remoteUrl) {
    log.debug('[bootstrap] no remote/repo to derive provider from; skipping');
    return null;
  }

  const { getProvider, detectProvider } = await import('./providers/index.js');
  const providerName = marker.provider ?? detectProvider(remoteUrl);
  const provider = getProvider(providerName);

  // A dry run skips both auth calls: isAuthenticated() only checks that a token
  // is present, so with a stale one authenticate() falls through to an
  // interactive login that stores credentials (`gh auth login --web`, GitCode's
  // token prompt).
  let username = '';
  if (!dryRun) {
    // Non-interactive gate: only proceed if already authenticated. Never trigger
    // an interactive login from a hook — degrade to skip and let an explicit
    // `teamai init .` handle first-time auth.
    if (!provider.isAuthenticated()) {
      if (!silent) {
        log.warn('This is a teamai single-repo project, but you are not authenticated yet.');
        log.warn(`Run \`teamai init .\` (or authenticate with your git provider) to finish setup.`);
      }
      return null;
    }

    try {
      username = await provider.authenticate();
    } catch {
      log.debug('[bootstrap] could not resolve username; skipping');
      return null;
    }
  }

  let repoInfo;
  try {
    repoInfo = provider.parseRepoInput(remoteUrl);
  } catch {
    log.debug('[bootstrap] could not parse remote; skipping');
    return null;
  }

  const { loadTeamConfig } = await import('./config.js');
  const teamConfig = await loadTeamConfig(localPath);
  if (!teamConfig) {
    log.debug('[bootstrap] teamai.yaml not loadable; skipping');
    return null;
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
    // P2: machine config/state land in the partition, not the repo. localPath
    // stays <repo>/.teamai (the class-B knowledge anchor); dataHome routes the
    // class-A1 writes (config/state) out of the workspace.
    dataHome: partitionHome,
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
  } catch (error) {
    // No manifest: leave the role unset, as a repo without roles intends. A
    // manifest that exists and does not parse is different — swallowing it
    // would leave the role unset too, and a member with no role and no project
    // gets an unfiltered sync, which is the opposite of what the broken
    // manifest asked for.
    const { RolesManifestNotFoundError } = await import('./roles.js');
    if (!(error instanceof RolesManifestNotFoundError)) throw error;
  }

  return { localConfig, teamConfig, username, providerName };
}

/**
 * What `bootstrapSelfRepo` would set up, for a --dry-run: the config it would
 * write, kept in memory, and one line saying what it would do. Writes, locks,
 * registers and authenticates nothing, so the config has no username. Null when
 * it would not bootstrap.
 */
export async function previewSelfBootstrap(dir?: string): Promise<LocalConfig | null> {
  const businessRepoRoot = dir ?? process.cwd();
  const pending = await findPendingBootstrap(businessRepoRoot, true);
  if (typeof pending === 'string') return null;
  const plan = await planSelfBootstrap(businessRepoRoot, pending.partitionHome, pending.marker, true, true);
  if (!plan) return null;
  log.info(
    `[dry-run] Would bootstrap this single-repo project if you are authenticated with ${plan.providerName} ` +
      `(not checked in a dry run): look up your username, write its config and state to ` +
      `${pending.partitionHome}, seed tool dirs, inject hooks and register you as a member`,
  );
  return plan.localConfig;
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

  const pending = await findPendingBootstrap(businessRepoRoot, false);
  if (typeof pending === 'string') return pending;
  const { configPath } = pending;

  const lockPath = path.join(businessRepoRoot, '.teamai', BOOTSTRAP_LOCK_FILENAME);
  const locked = await acquireLock(lockPath);
  if (!locked) {
    log.debug('[bootstrap] another bootstrap is in progress; skipping');
    return 'skip';
  }

  try {
    // Re-check under the lock — a concurrent run may have finished.
    if (await pathExists(configPath)) return 'already';

    const plan = await planSelfBootstrap(businessRepoRoot, pending.partitionHome, pending.marker, silent, false);
    if (!plan) return 'skip';
    const { localConfig, teamConfig, username } = plan;
    const localPath = localConfig.repo.localPath;

    info('Detected a teamai single-repo project — finishing local setup...');

    const { saveLocalConfigForScope, loadStateForScope, saveStateForScope } = await import('./config.js');

    await ensureDir(localPath);
    await saveLocalConfigForScope(localConfig, 'project', businessRepoRoot);

    // Invalidate pull cache so the next pull does a full sync.
    try {
      const state = await loadStateForScope(localConfig);
      state.lastPullRev = null;
      await saveStateForScope(state, localConfig);
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
      const { describeUnappliedTeamHooks, reconcileTeamHooksForConfig, reportCodexTrust, trustCodexForScope } = await import('./hooks.js');
      try {
        const reconciled = await reconcileTeamHooksForConfig(teamConfig, localConfig, {});
        if (!reconciled.ok) {
          // A session-start bootstrap is silent, so debug.log is the only trace.
          const message = describeUnappliedTeamHooks(reconciled);
          if (silent) log.persist(message);
          else log.warn(message);
        }
      } finally {
        // Git-hook installation can fail after the Codex hooks were written.
        const codexTrust = await trustCodexForScope(teamConfig, localConfig);
        if (!silent) reportCodexTrust(codexTrust, 'all');
        else if (codexTrust) log.debug(`[bootstrap] Codex trust: ${codexTrust.kind}`);
      }
    } catch (e) {
      log.debug(`[bootstrap] hook injection failed (non-blocking): ${(e as Error).message}`);
    }

    // Register member on the reports orphan branch. Best-effort: no write access
    // just means the member isn't listed — they still get the knowledge.
    try {
      const { updateReports } = await import('./utils/reports-branch.js');
      await updateReports(localConfig, async (wt) => {
        const memberDir = path.join(wt, 'members');
        await ensureDir(memberDir);
        const memberPath = path.join(memberDir, `${username}.yaml`);
        if (await pathExists(memberPath)) {
          return { files: [], message: `[teamai] Register member: ${username}` };
        }
        // Absorb the member's pre-switch file from the clone (inherited root):
        // its displayName/registeredAt/projects survive the re-registration.
        const inherited = await getMemberConfig(localConfig.repo.localPath, username);
        const config = inherited
          ? mergeMemberConfig(inherited, { username }).config
          : { username, displayName: username, registeredAt: new Date().toISOString() };
        await writeFile(memberPath, YAML.stringify(config));
        return { files: ['members/'], message: `[teamai] Register member: ${username}` };
      });
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
