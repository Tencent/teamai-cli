import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { saveLocalConfig, loadTeamConfig, saveLocalConfigForScope, loadLocalConfigForScope, loadStateForScope, saveStateForScope } from './config.js';
import { reconcileTeamHooksForConfig } from './hooks.js';
import { configureGitUser, initRepo, isGitRepo, getRemoteUrl } from './utils/git.js';
import { pushRepoDirectly } from './utils/git.js';
import { getProvider, detectProvider, RepoNotFoundError } from './providers/index.js';
import { ensureDir, writeFile, pathExists, expandHome, readFileSafe, remove } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { TEAMAI_HOME, REPORTS_BRANCH, type GlobalOptions, type LocalConfig, type Scope, getTeamaiHome, getConfigPath } from './types.js';
import { getUserHome } from './utils/home.js';
import { describeRoles, loadRolesManifest } from './roles.js';
import { askQuestion, askConfirmation, askSelection, closePrompt } from './utils/prompt.js';
import {
  normalizeAgentList,
  detectHomeInstalledAgents,
  SELF_MODE_AGENT_CHOICES,
  KNOWN_AGENTS,
} from './known-agents.js';

/** Resolve + realpath so macOS /var → /private/var (and similar) compare equal. */
function resolveRealPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function parseRoleSelection(answer: string, max: number): number[] {
  if (!answer.trim()) return [];

  const selections = answer
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((value) => !Number.isNaN(value));

  if (selections.length === 0) {
    throw new Error('Please enter one or more role numbers, separated by commas.');
  }

  for (const selection of selections) {
    if (selection < 1 || selection > max) {
      throw new Error(`Role selection out of range. Choose numbers between 1 and ${max}.`);
    }
  }

  return [...new Set(selections)];
}

async function promptForRoleProfile(
  repoPath: string,
  roleFlag?: string,
): Promise<Pick<LocalConfig, 'primaryRole' | 'additionalRoles' | 'resourceProfileVersion'>> {
  const manifest = await loadRolesManifest(repoPath);
  const roleLabels = describeRoles(manifest.roles);

  // If --role flag provided, resolve it directly by ID
  if (roleFlag) {
    const match = manifest.roles.find((r) => r.id === roleFlag);
    if (!match) {
      throw new Error(
        `Unknown role "${roleFlag}". Available roles: ${manifest.roles.map((r) => r.id).join(', ')}`,
      );
    }
    return {
      primaryRole: match.id,
      additionalRoles: [],
      resourceProfileVersion: manifest.version,
    };
  }

  // Auto-select when only one role is available
  if (manifest.roles.length === 1) {
    const only = manifest.roles[0];
    log.info(`Role: ${roleLabels[0]} (auto-selected)`);
    return {
      primaryRole: only.id,
      additionalRoles: [],
      resourceProfileVersion: manifest.version,
    };
  }

  log.info('Available roles:');
  roleLabels.forEach((label, index) => {
    log.info(`  ${index + 1}. ${label}`);
  });

  const primaryAnswer = await askQuestion('Primary role (number): ');
  const [primaryIndex] = parseRoleSelection(primaryAnswer, manifest.roles.length);
  if (!primaryIndex) {
    throw new Error('A primary role is required.');
  }

  const primaryRole = manifest.roles[primaryIndex - 1];

  return {
    primaryRole: primaryRole.id,
    additionalRoles: [],
    resourceProfileVersion: manifest.version,
  };
}

/**
 * Resolve init install scope from `--scope` / default.
 *
 * - Explicit `user` / `project` → use as-is (`explicit: true`)
 * - Invalid value → throw
 * - Omitted → **project** (cwd), unless cwd === home (E1: fall back to user)
 *
 * Local install location is decided only by the CLI; remote `teamai.yaml.scope`
 * is ignored (see issue #250).
 */
export function resolveInitScope(
  rawScope: string | undefined,
  cwd: string,
  homeDir: string,
): { scope: Scope; projectRoot?: string; explicit: boolean; fallbackReason?: string } {
  const cwdResolved = resolveRealPath(cwd);
  const homeResolved = resolveRealPath(homeDir);
  const atHome = cwdResolved === homeResolved;

  if (rawScope !== undefined && rawScope !== '') {
    if (rawScope !== 'user' && rawScope !== 'project') {
      throw new Error(`Invalid scope "${rawScope}". Use "project" (default) or "user".`);
    }
    if (rawScope === 'project' && atHome) {
      throw new Error(
        'Cannot use --scope project in your home directory (paths would collide with user scope). ' +
        'cd to a project directory first, or omit --scope / use --scope user.',
      );
    }
    return {
      scope: rawScope,
      projectRoot: rawScope === 'project' ? cwdResolved : undefined,
      explicit: true,
    };
  }

  // Implicit default: project, with E1 fallback when cwd is $HOME
  if (atHome) {
    return {
      scope: 'user',
      projectRoot: undefined,
      explicit: false,
      fallbackReason:
        'cwd is your home directory; using user scope to avoid path collision with ~/.teamai',
    };
  }

  return {
    scope: 'project',
    projectRoot: cwdResolved,
    explicit: false,
  };
}

/**
 * Resolve the project-local user-scope inheritance setting.
 *
 * An omitted flag preserves an existing project setting so additive re-init
 * operations such as `init --agent` do not silently disable inheritance.
 */
export function resolveInheritUserScope(
  scope: Scope,
  requested: boolean | undefined,
  existing: boolean | undefined,
): boolean | undefined {
  if (requested === true && scope !== 'project') {
    throw new Error('--inherit-user-scope can only be used with project scope.');
  }
  if (scope !== 'project') return undefined;
  return requested ?? existing;
}

/**
 * Merge positional `teamai init <repo>` with `--repo` alias.
 * `--repo` is permanently kept as an equivalent alias (no deprecation warning).
 */
export function resolveInitRepo(
  positional: string | undefined,
  repoFlag: string | undefined,
): string | undefined {
  const pos = positional?.trim() || undefined;
  const flag = repoFlag?.trim() || undefined;
  if (pos && flag && pos !== flag) {
    throw new Error(
      `Conflicting repo values: positional "${pos}" vs --repo "${flag}". Pass only one.`,
    );
  }
  return pos ?? flag;
}

function printScopeSummary(
  scope: Scope,
  projectRoot: string | undefined,
  explicit: boolean,
): void {
  const configPath = getConfigPath(scope, projectRoot);
  const baseDir = scope === 'project' ? (projectRoot ?? process.cwd()) : getUserHome();
  log.info(`Scope: ${scope}${scope === 'project' ? ` (${projectRoot})` : ''}`);
  log.info(`  config    → ${configPath}`);
  log.info(`  resources → ${baseDir}/.claude/skills, ...`);
  if (!explicit && scope === 'project') {
    log.info('  Tip: run with `--scope user` to install under your home directory (~/)');
  }
}

/** Walk up from dir looking for a `.git` entry (file or directory). */
async function isInsideGitRepo(dir: string): Promise<boolean> {
  let current = path.resolve(dir);
  for (;;) {
    if (await pathExists(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Git-free HTTP onboarding (issue #1). A read-only consumer only needs an API
 * key: no git auth, no clone, no member/reviewer push. Skills/rules/CLAUDE.md are
 * delivered on each session via the report/sync/ack lifecycle (the local-agent
 * bypass), not by cloning a repo.
 */
export async function initHttp(
  url: string,
  options: GlobalOptions & { scope?: string; role?: string; agent?: string | string[]; force?: boolean; token?: string; inheritUserScope?: boolean },
): Promise<void> {
  const { resolveApiKey, saveApiKey, getApiKeyPath } = await import('./api-key.js');

  log.info('Initializing teamai (HTTP read-only consumer)...');

  // Step 0: scope (same rules as git init — default project)
  let scope: Scope;
  let projectRoot: string | undefined;
  let explicit: boolean;
  let fallbackReason: string | undefined;
  try {
    ({ scope, projectRoot, explicit, fallbackReason } = resolveInitScope(
      options.scope,
      process.cwd(),
      getUserHome(),
    ));
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  const existingLocalConfig = await loadLocalConfigForScope(scope, projectRoot);
  let inheritUserScope: boolean | undefined;
  try {
    inheritUserScope = resolveInheritUserScope(
      scope,
      options.inheritUserScope,
      existingLocalConfig?.inheritUserScope,
    );
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  if (fallbackReason) {
    log.warn(fallbackReason);
  }
  const teamaiHome = getTeamaiHome(scope, projectRoot);
  printScopeSummary(scope, projectRoot, explicit);

  if (scope === 'project' && !(await isInsideGitRepo(process.cwd()))) {
    log.warn(`cwd is not inside a git repository; will create ${teamaiHome}/`);
  }

  // Re-init guard
  const existingConfigPath = getConfigPath(scope, projectRoot);
  if (await pathExists(existingConfigPath) && !options.force) {
    const confirmed = await askConfirmation(`teamai already initialized at ${existingConfigPath}. Overwrite? [y/N] `);
    if (!confirmed) {
      log.info('Aborted. Existing config is unchanged.');
      return;
    }
  }

  // Step 1: API key. Persist --token when given (one command sets endpoint+key),
  // otherwise fall back to TEAMAI_API_TOKEN / an existing ~/.teamai/apikey.
  if (options.token && options.token.trim()) {
    await saveApiKey(options.token.trim());
    log.success(`API key saved to ${getApiKeyPath()}`);
  }
  const apiKey = resolveApiKey();
  if (!apiKey) {
    log.error('No API key found. Pass --token <key> to `teamai init --http`, or set TEAMAI_API_TOKEN.');
    process.exit(1);
  }

  // Step 2: write a minimal local teamai.yaml stub (default toolPaths) to drive
  // hook injection + the reporter. Skills/rules/CLAUDE.md are not cloned; they
  // are delivered on each session via report/sync/ack (see Step 6).
  const localPath = expandHome(path.join(teamaiHome, 'team-repo'));
  await ensureDir(localPath);
  const stubPath = path.join(localPath, 'teamai.yaml');
  if (!(await pathExists(stubPath))) {
    await writeFile(stubPath, YAML.stringify({ team: 'http-reporting', repo: url, sharing: {} }));
  }
  const teamConfig = await loadTeamConfig(localPath);
  if (!teamConfig) {
    log.error('Failed to write a valid teamai.yaml stub. Check filesystem permissions.');
    process.exit(1);
  }

  // Step 4: save local config (kind: http; only the URL is stored, never the key)
  const localConfig: LocalConfig = {
    repo: { localPath, remote: url, kind: 'http', url },
    username: 'http-consumer',
    scope,
    projectRoot,
    additionalRoles: [],
    ...(inheritUserScope !== undefined ? { inheritUserScope } : {}),
  };
  try {
    Object.assign(localConfig, await promptForRoleProfile(localPath, options.role));
  } catch (error) {
    const msg = (error as Error).message;
    if (!msg.includes('Roles manifest not found')) {
      log.debug(`Role selection skipped: ${msg}`);
    }
  }

  // Persist --agent into enabledAgents (additive across runs)
  const requestedAgents = normalizeAgentList(options.agent);
  if (requestedAgents.length > 0) {
    const existing = await loadLocalConfigForScope(scope, projectRoot);
    const prev = existing?.enabledAgents ?? [];
    localConfig.enabledAgents = [...new Set([...prev, ...requestedAgents])];
    localConfig.disabledAgents = (existing?.disabledAgents ?? []).filter((t) => !requestedAgents.includes(t));
  }

  await ensureDir(teamaiHome);
  if (scope === 'project') {
    await saveLocalConfigForScope(localConfig, scope, projectRoot);
  } else {
    await ensureDir(TEAMAI_HOME);
    await saveLocalConfig(localConfig);
  }
  log.success(`Local config saved to ${teamaiHome}/config.yaml`);

  // Invalidate cache so the next pull does a full sync.
  try {
    const state = await loadStateForScope(scope, projectRoot);
    state.lastPullRev = null;
    await saveStateForScope(state, scope, projectRoot);
  } catch {
    // state may not exist yet
  }

  // Step 5: inject hooks (built-in dispatch incl. the reporter) via the same
  // authoritative path the git init uses, so HTTP consumers behave identically.
  const filterAgents = requestedAgents.length > 0 ? requestedAgents : undefined;
  await reconcileTeamHooksForConfig(teamConfig, localConfig, { filterAgents });

  // Step 6: also initialize local-agent config so the new hook-dispatch --stdin
  // path can deliver rules/claudemd (not just skills).
  const { initLocalAgentHttp } = await import('./local-agent.js');
  try {
    await initLocalAgentHttp({ endpoint: url, token: options.token, force: options.force, filterAgents });
  } catch (e) {
    log.debug(`Local agent init: ${(e as Error).message}`);
  }

  log.success('teamai initialized (HTTP read-only)!');
  log.info('Skills/rules will auto-sync on each session start via report/sync. This team is read-only (no push).');
  closePrompt();
}

/**
 * Build the .teamai/.gitignore for single-repo mode. Unlike the standalone
 * project-scope gitignore, knowledge (skills/rules/docs/learnings) is COMMITTED
 * to main here, so it must NOT be ignored. Only machine-local state, worktrees,
 * and orphan-branch report data are ignored.
 */
export function buildSelfModeGitignore(): string {
  return [
    '# teamai single-repo mode — machine-local state (never commit)',
    'config.yaml',
    'state.json',
    'token',
    '.update-lock',
    '.reports-lock',
    '.bootstrap-lock',
    // NB: env/ is intentionally NOT ignored in single-repo mode — team env vars
    // (.teamai/env/env.yaml) are committed to main so `teamai push` can carry them
    // and teammates get them on clone. env.yaml holds plaintext key/value pairs, so
    // only put non-secret config there; keep real secrets out of the repo.
    'env.sh',
    // env.local is the machine-local KEY=value backup pull writes for ${VAR}
    // resolution (self mode uses this name to avoid colliding with the env/ dir).
    'env.local',
    'usage.jsonl',
    'known-skills.json',
    'search-index.json',
    'dashboard/',
    '# git worktrees for reports (orphan branch) and knowledge PRs',
    'reports-wt/',
    'knowledge-wt/',
    '# report data lives on the teamai-reports orphan branch, not on main',
    'members/',
    'sessions/',
    'votes/',
    'stats/',
    'pending-review.jsonl',
    '',
    '# Knowledge (skills/, rules/, docs/, learnings/) is intentionally committed to main.',
    '',
  ].join('\n');
}

/**
 * Migrate an existing single-repo `.teamai/.gitignore` written by an older teamai
 * (≤ beta.4), which ignored `env` — that hid `.teamai/env/env.yaml` from push and
 * kept it off main. Pure (no I/O) so it can be unit-tested.
 *
 * Removes a standalone `env` ignore line (NOT `env.sh` / `env.local` / `env/`, and
 * not commented lines), and ensures `env.local` is ignored (the machine-local
 * backup pull now writes). Returns whether anything changed plus the new content.
 */
export function migrateSelfModeGitignoreContent(content: string): { changed: boolean; content: string } {
  const lines = content.split('\n');
  let changed = false;

  // Drop a bare `env` ignore line (trimmed exact match). Keep env.sh/env.local/env/.
  const filtered = lines.filter((line) => {
    if (line.trim() === 'env') {
      changed = true;
      return false;
    }
    return true;
  });

  // Ensure env.local is present (older files predate it). Insert next to env.sh if
  // found, else append before the trailing blank/knowledge comment.
  const hasEnvLocal = filtered.some((l) => l.trim() === 'env.local');
  if (!hasEnvLocal) {
    const envShIdx = filtered.findIndex((l) => l.trim() === 'env.sh');
    if (envShIdx >= 0) {
      filtered.splice(envShIdx + 1, 0, 'env.local');
    } else {
      // Append at a sensible spot: before a trailing empty line if any.
      const lastNonEmpty = filtered.reduce((acc, l, i) => (l.trim() ? i : acc), -1);
      filtered.splice(lastNonEmpty + 1, 0, 'env.local');
    }
    changed = true;
  }

  return { changed, content: filtered.join('\n') };
}

/**
 * Self-heal an older single-repo `.teamai/.gitignore` in place (see
 * migrateSelfModeGitignoreContent). Best-effort: rewrites the ACTIVE tree's file
 * and logs a one-line hint to commit it — teamai never commits it for the user
 * here (the file is on main; the user owns that commit). No-op for non-self mode,
 * a missing file, or an already-current file. Safe to call on every pull/push.
 */
export async function migrateSelfModeGitignore(localConfig: LocalConfig): Promise<void> {
  if (localConfig.repo.kind !== 'self' || !localConfig.projectRoot) return;
  const gitignorePath = path.join(localConfig.projectRoot, '.teamai', '.gitignore');
  try {
    const current = await readFileSafe(gitignorePath);
    if (current === null) return; // no gitignore to migrate
    const { changed, content } = migrateSelfModeGitignoreContent(current);
    if (!changed) return;
    await writeFile(gitignorePath, content);
    log.info(
      'Updated .teamai/.gitignore so team env vars (.teamai/env/env.yaml) can be shared — '
      + 'please `git add .teamai/.gitignore` and commit it.',
    );
  } catch (e) {
    log.debug(`[self-mode] gitignore migration skipped: ${(e as Error).message}`);
  }
}

/**
 * Map an interactive selection to a concrete agent-id list. Pure (no I/O) so it
 * can be unit-tested. The picker's option order is:
 *   index 0            → "Auto" (mirror the tools detected under HOME)
 *   index 1..N         → SELF_MODE_AGENT_CHOICES[index - 1] (a specific tool)
 *
 * Picking Auto expands to `detected`; picking Auto with nothing detected falls
 * back to ['claude'] so the "clone = initialized" loop is never left with zero
 * tools. Auto and specific tools can be combined; the result is deduped in the
 * choice order (detected first, then any explicitly-picked tools).
 */
export function resolveSelfModeSelection(indices: number[], detected: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => { if (id && !seen.has(id)) { seen.add(id); out.push(id); } };

  const pickedAuto = indices.includes(0);
  if (pickedAuto) {
    if (detected.length > 0) detected.forEach(add);
    else add('claude'); // Auto but nothing installed → keep the guarantee.
  }
  for (const i of indices) {
    if (i === 0) continue; // Auto handled above
    const id = SELF_MODE_AGENT_CHOICES[i - 1];
    if (id) add(id);
  }
  return out;
}

/**
 * Decide which AI tools single-repo init should set up (seed skills dir, inject
 * hooks, commit their settings). Priority:
 *   1. `--agent` given → use exactly that (explicit wins, no prompt).
 *   2. Non-interactive (no TTY / --silent / --force) → mirror the tools already
 *      installed under the user's HOME; if none, return [] (create nothing).
 *   3. Interactive → multi-select. Option 1 is "Auto" (the tools detected under
 *      HOME, listed inline) and is the Enter default; options 2+ are the specific
 *      tools. Empty/cancelled falls back to Auto/[claude].
 */
export async function promptForSelfModeAgents(options: {
  agent?: string | string[];
  silent?: boolean;
  force?: boolean;
}): Promise<string[]> {
  const explicit = normalizeAgentList(options.agent);
  if (explicit.length > 0) return explicit;

  // Non-interactive when there's no TTY, or when the caller opted out of prompts
  // (--silent / --force, matching the convention in init()): mirror HOME-installed
  // tools rather than blocking on the picker.
  if (options.silent || options.force || !process.stdin.isTTY) {
    return detectHomeInstalledAgents();
  }

  const detected = await detectHomeInstalledAgents();
  const tools = SELF_MODE_AGENT_CHOICES.map((id) => {
    const meta = KNOWN_AGENTS.find((a) => a.id === id);
    const root = meta?.skillsPath.split('/')[0] ?? `.${id}`;
    return { id, label: meta?.displayName ?? id, root };
  });

  const detectedLabels = detected
    .map((id) => tools.find((t) => t.id === id)?.label ?? id)
    .join(', ');
  const autoLabel = detected.length > 0
    ? `Auto — the AI tools already installed here: ${detectedLabels}`
    : 'Auto — none detected (will set up Claude Code)';

  console.log('');
  console.log('Which AI tools should teamai set up in this repo?');
  console.log('(creates the skills dir, injects hooks, commits settings to main)');
  console.log('');
  console.log(`  1. ${autoLabel}`);
  tools.forEach((t, i) => {
    console.log(`  ${i + 2}. ${t.label}  (${t.root})`);
  });
  console.log('');

  const optionCount = tools.length + 1; // +1 for the Auto row
  // defaultAll=false: a bare Enter returns null (not "everything"). We map Enter /
  // cancel / empty to Auto (option 1). Explicit "all" still works via the parser.
  const indices = await askSelection(
    `Select [1-${optionCount}, comma/range, or "all"] (default: 1 = Auto): `,
    optionCount,
    false,
  );
  if (!indices || indices.length === 0) {
    // Enter / cancelled → Auto.
    return resolveSelfModeSelection([0], detected);
  }
  return resolveSelfModeSelection(indices, detected);
}

/**
 * Single-repo mode init (`teamai init .` / `--self`). The current git repo IS
 * the team repo. No clone: knowledge lives on main under <repo>/.teamai/, and
 * report data (members/sessions/votes/stats) goes to the `teamai-reports` orphan
 * branch via an isolated worktree so the user's active tree is never touched.
 */
export async function initSelfRepo(options: GlobalOptions & {
  repo?: string;
  repoPositional?: string;
  role?: string;
  agent?: string | string[];
  force?: boolean;
  inheritUserScope?: boolean;
}): Promise<void> {
  log.info('Initializing teamai (single-repo mode)...');

  const cwd = process.cwd();

  // Step 0: single-repo mode is always project scope, rooted at the business repo.
  if (!(await isInsideGitRepo(cwd))) {
    log.error('Single-repo mode requires a git repository. Run `teamai init .` inside your project repo.');
    process.exit(1);
    return;
  }
  const businessRepoRoot = cwd;
  const teamaiHome = path.join(businessRepoRoot, '.teamai');
  const localPath = teamaiHome; // knowledge lives under <repo>/.teamai (localPath convention)

  let inheritUserScope: boolean | undefined;
  try {
    const existing = await loadLocalConfigForScope('project', businessRepoRoot);
    inheritUserScope = resolveInheritUserScope('project', options.inheritUserScope, existing?.inheritUserScope);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }

  log.info(`Scope: project (${businessRepoRoot})`);
  log.info(`  knowledge → ${localPath}/{skills,rules,docs,learnings} (committed to main)`);
  log.info(`  reports   → ${REPORTS_BRANCH} orphan branch (members/sessions/votes/stats)`);

  // Re-init guard
  const existingConfigPath = getConfigPath('project', businessRepoRoot);
  if (await pathExists(existingConfigPath)) {
    log.warn(`teamai is already initialized (project scope) at ${existingConfigPath}`);
    if (options.force) {
      log.info('Overwriting existing config (--force)');
    } else {
      const confirmed = await askConfirmation('Overwrite existing config? [y/N] ');
      if (!confirmed) {
        log.info('Aborted. Existing config is unchanged.');
        return;
      }
    }
  }

  // Step 1: derive provider + remote from the business repo's origin.
  const remoteUrl = await getRemoteUrl(businessRepoRoot);
  if (!remoteUrl) {
    log.error('Could not read the business repo `origin` remote. Add a remote first, then re-run `teamai init .`.');
    process.exit(1);
    return;
  }
  const providerName = detectProvider(remoteUrl);
  const provider = getProvider(providerName);
  log.debug(`Detected provider: ${providerName} (from ${remoteUrl})`);

  let repoInfo;
  try {
    repoInfo = provider.parseRepoInput(remoteUrl);
  } catch (e) {
    log.error(`Could not parse the business repo remote "${remoteUrl}": ${(e as Error).message}`);
    process.exit(1);
    return;
  }

  // Step 2: authenticate (needed to push reports + open knowledge PRs).
  await provider.ensureInstalled();
  const authSpin = spinner('Checking authentication...').start();
  let username: string;
  try {
    username = await provider.authenticate();
    authSpin.succeed(`Authenticated as ${username}`);
  } catch (e) {
    authSpin.fail(`Authentication failed: ${(e as Error).message}`);
    process.exit(1);
    return;
  }

  // Step 3: build the .teamai/ knowledge skeleton on the active tree (committed to main).
  // Includes hooks/ and mcp/ too: in single-repo mode those are contributed by
  // editing .teamai/{hooks/hooks.yaml,mcp/mcp.yaml} directly and committing (they
  // don't go through `teamai push`), so seeding the dirs makes that path obvious.
  await ensureDir(localPath);
  for (const dir of ['skills', 'rules', 'docs', 'learnings', 'env', 'agents', 'hooks', 'mcp']) {
    await ensureDir(path.join(localPath, dir));
    const gitkeep = path.join(localPath, dir, '.gitkeep');
    if (!await pathExists(gitkeep)) {
      await writeFile(gitkeep, '');
    }
  }

  // teamai.yaml carries `mode: self` so teammates auto-bootstrap after clone.
  const teamaiYamlPath = path.join(localPath, 'teamai.yaml');
  if (!await pathExists(teamaiYamlPath)) {
    const defaultConfig = YAML.stringify({
      team: repoInfo.repo,
      mode: 'self',
      description: 'TeamAI single-repo (knowledge on main, reports on teamai-reports)',
      repo: repoInfo.httpsUrl,
      provider: providerName,
      sharing: {
        rules: { enforced: [] },
        docs: { localDir: './.teamai/docs' },
        env: { injectShellProfile: true },
      },
    });
    await writeFile(teamaiYamlPath, defaultConfig);
    log.success('Created .teamai/teamai.yaml (mode: self)');
  }
  const teamConfig = await loadTeamConfig(localPath);
  if (!teamConfig) {
    log.error('Failed to write a valid .teamai/teamai.yaml. Check filesystem permissions.');
    process.exit(1);
    return;
  }

  // Step 4: assemble local config (kind: self).
  const localConfig: LocalConfig = {
    repo: { localPath, remote: repoInfo.httpsUrl, kind: 'self', businessRepoRoot },
    username,
    scope: 'project',
    projectRoot: businessRepoRoot,
    additionalRoles: [],
    ...(inheritUserScope !== undefined ? { inheritUserScope } : {}),
  };
  try {
    Object.assign(localConfig, await promptForRoleProfile(localPath, options.role));
  } catch (error) {
    const msg = (error as Error).message;
    if (!msg.includes('Roles manifest not found')) {
      log.debug(`Role selection skipped: ${msg}`);
    }
  }
  // Which AI tools to set up in this repo (create skills dir + inject hooks +
  // commit their settings.json). Resolved from --agent, else HOME detection
  // (non-interactive), else an interactive picker. Written to enabledAgents,
  // which drives seedSelfModeToolDirs and hook injection alike.
  const selectedAgents = await promptForSelfModeAgents(options);
  if (selectedAgents.length > 0) {
    const existing = await loadLocalConfigForScope('project', businessRepoRoot);
    const prev = existing?.enabledAgents ?? [];
    localConfig.enabledAgents = [...new Set([...prev, ...selectedAgents])];
    localConfig.disabledAgents = (existing?.disabledAgents ?? []).filter((t) => !selectedAgents.includes(t));
  }

  // Step 5: write local config + single-repo gitignore.
  await ensureDir(teamaiHome);
  await saveLocalConfigForScope(localConfig, 'project', businessRepoRoot);
  log.success(`Local config saved to ${teamaiHome}/config.yaml`);

  const gitignorePath = path.join(teamaiHome, '.gitignore');
  await writeFile(gitignorePath, buildSelfModeGitignore());
  log.debug('Generated single-repo .teamai/.gitignore');

  // Step 5.3: seed the selected tools' skills dir so first-run hook + skill
  // injection lands. Single-repo mode must inject into the project even on a
  // brand-new clone where no <repo>/.claude exists yet (isToolInstalled would
  // otherwise skip everything).
  const filterAgents = selectedAgents.length > 0 ? selectedAgents : undefined;
  try {
    const { seedSelfModeToolDirs } = await import('./known-agents.js');
    const seeded = await seedSelfModeToolDirs(localConfig, teamConfig);
    if (seeded.length > 0) log.debug(`Seeded tool dirs for: ${seeded.join(', ')}`);
  } catch (e) {
    log.debug(`Tool-dir seeding skipped: ${(e as Error).message}`);
  }

  // Step 5.4: inject hooks BEFORE the skeleton commit, so each selected tool's
  // settings file exists on disk and can be committed to main below. This is what
  // makes a teammate's fresh clone carry the session-start hook that triggers the
  // self-heal bootstrap — the core of "clone = initialized".
  await reconcileTeamHooksForConfig(teamConfig, localConfig, { filterAgents });

  // Step 5.5: commit the .teamai/ knowledge skeleton + selected tools' hook
  // settings to the current branch. Single-repo mode keeps knowledge on main, and
  // knowledge PRs branch off a base commit — a freshly `git init`'d repo has none,
  // so `teamai push` would fail. Committing here (a) seeds that base commit,
  // (b) makes `mode: self` + hooks travel with `git clone` so teammates
  // auto-bootstrap, (c) is exactly what the mode intends. We commit but never
  // push — the user pushes their business repo themselves.
  if (!options.dryRun) {
    try {
      const { commitPaths, hasCommits } = await import('./utils/git.js');
      const hadCommits = await hasCommits(businessRepoRoot);
      // Only the committable, portable knowledge parts of .teamai/. Machine-local
      // items (config.yaml, token, state.json, env, worktrees, report dirs) are
      // gitignored via buildSelfModeGitignore and must NOT be listed here — adding
      // an explicitly-gitignored path makes `git add` error out.
      const skeletonPaths = [
        '.teamai/skills', '.teamai/rules', '.teamai/docs', '.teamai/learnings', '.teamai/env',
        '.teamai/agents', '.teamai/hooks', '.teamai/mcp',
        '.teamai/teamai.yaml', '.teamai/.gitignore',
      ];
      // Each selected tool's settings file (path varies: claude/codebuddy use
      // settings.json, codex/cursor use hooks.json), resolved from toolPaths so
      // teammates get the hooks on clone. Tools without a settings path are seeded
      // (skills dir) but have nothing to commit.
      for (const id of selectedAgents) {
        const settingsPath = teamConfig.toolPaths?.[id]?.settings;
        if (settingsPath) skeletonPaths.push(settingsPath);
      }
      const committed = await commitPaths(
        businessRepoRoot,
        '[teamai] Initialize single-repo mode (skills/rules/docs/learnings skeleton)',
        skeletonPaths,
      );
      if (committed) {
        log.success(
          hadCommits
            ? 'Committed .teamai/ skeleton to the current branch'
            : 'Created initial commit with the .teamai/ skeleton',
        );
      }
    } catch (e) {
      log.warn(`Could not commit the .teamai/ skeleton (do it manually before \`teamai push\`): ${(e as Error).message}`);
    }
  }

  // Step 6: register member on the reports orphan branch (never touches main / active tree).
  if (!options.dryRun) {
    try {
      const { ensureReportsWorktree, commitAndPushReports } = await import('./utils/reports-branch.js');
      const wt = await ensureReportsWorktree(localConfig);
      const memberDir = path.join(wt, 'members');
      await ensureDir(memberDir);
      const memberPath = path.join(memberDir, `${username}.yaml`);
      if (!await pathExists(memberPath)) {
        await writeFile(memberPath, YAML.stringify({
          username,
          displayName: username,
          registeredAt: new Date().toISOString(),
        }));
        const pushed = await commitAndPushReports(localConfig, `[teamai] Register member: ${username}`, ['members/']);
        if (pushed) {
          log.success('Member registered on the teamai-reports branch');
        } else {
          log.warn('Member registration could not be pushed (no write access?). You are still set up locally.');
        }
      }
    } catch (e) {
      log.warn(`Member registration skipped (non-blocking): ${(e as Error).message}`);
    }
  }

  // Step 6.5: invalidate pull cache so next pull does a full sync.
  try {
    const state = await loadStateForScope('project', businessRepoRoot);
    state.lastPullRev = null;
    await saveStateForScope(state, 'project', businessRepoRoot);
  } catch {
    // state may not exist yet
  }

  log.success('teamai initialized (single-repo mode)!');
  log.info('Next steps:');
  log.info('  1. Add team resources by dropping them into .teamai/ (or author them in your AI tool as usual):');
  log.info('       .teamai/skills/    team skills');
  log.info('       .teamai/rules/     shared rules');
  log.info('       .teamai/agents/    subagent definitions (<name>.yaml)');
  log.info('       .teamai/env/env.yaml   shared env vars — committed to main, so keep real secrets out');
  log.info('  2. Run `teamai push` for the above — it scans .teamai/{skills,rules,agents,env} plus your AI tool dirs and opens a PR against your repo, without touching your working tree.');
  log.info('  3. docs / hooks / mcp are edited directly and shipped with a normal commit — no push needed:');
  log.info('       .teamai/docs/          team docs');
  log.info('       .teamai/hooks/hooks.yaml   team hooks');
  log.info('       .teamai/mcp/mcp.yaml       shared MCP servers');
  log.info('  4. Push your business repo (e.g. `git push -u origin HEAD`) so teammates get the .teamai/ knowledge and are auto-initialized on clone.');
  closePrompt();
}

export async function init(options: GlobalOptions & {
  repo?: string;
  repoPositional?: string;
  scope?: string;
  role?: string;
  agent?: string | string[];
  force?: boolean;
  http?: string;
  token?: string;
  inheritUserScope?: boolean;
  self?: boolean;
}): Promise<void> {
  if (options.http) {
    return initHttp(options.http, options);
  }
  // Single-repo mode: `teamai init .` or `teamai init --self`. The current git
  // repo IS the team repo; knowledge lives on main under .teamai/, reports go to
  // the teamai-reports orphan branch. No separate team repo is cloned.
  const repoArg = (options.repoPositional ?? options.repo ?? '').trim();
  if (options.self || repoArg === '.') {
    return initSelfRepo(options);
  }
  log.info('Initializing teamai...');

  // Step 0: Resolve scope (default project; only explicit --scope user → ~/ )
  let scope: Scope;
  let projectRoot: string | undefined;
  let explicit: boolean;
  let fallbackReason: string | undefined;
  try {
    ({ scope, projectRoot, explicit, fallbackReason } = resolveInitScope(
      options.scope,
      process.cwd(),
      getUserHome(),
    ));
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  const existingLocalConfig = await loadLocalConfigForScope(scope, projectRoot);
  let inheritUserScope: boolean | undefined;
  try {
    inheritUserScope = resolveInheritUserScope(
      scope,
      options.inheritUserScope,
      existingLocalConfig?.inheritUserScope,
    );
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  if (fallbackReason) {
    log.warn(fallbackReason);
  }
  const teamaiHome = getTeamaiHome(scope, projectRoot);
  printScopeSummary(scope, projectRoot, explicit);

  if (scope === 'project' && !(await isInsideGitRepo(process.cwd()))) {
    log.warn(`cwd is not inside a git repository; will create ${teamaiHome}/`);
  }

  // Step 0.5: Re-init guard — warn if config already exists
  const existingConfigPath = getConfigPath(scope, projectRoot);
  if (await pathExists(existingConfigPath)) {
    log.warn(`teamai is already initialized for ${scope} scope at ${existingConfigPath}`);
    if (options.force) {
      log.info('Overwriting existing config (--force)');
    } else {
      const confirmed = await askConfirmation('Overwrite existing config? [y/N] ');
      if (!confirmed) {
        log.info('Aborted. Existing config is unchanged.');
        return;
      }
    }
  }

  // Step 1: Get repo input (positional or --repo alias; prompt if neither)
  let repoInput = '';
  try {
    repoInput = resolveInitRepo(options.repoPositional, options.repo) ?? '';
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  if (!repoInput) {
    repoInput = await askQuestion('Team repo (e.g. yourteam/yourproject or https://github.com/org/repo): ');
  }
  if (!repoInput) {
    log.error('Repo is required');
    process.exit(1);
  }

  // Step 1b: Detect and initialize provider from URL
  const providerName = detectProvider(repoInput);
  const provider = getProvider(providerName);
  log.debug(`Detected provider: ${providerName}`);

  let repoInfo;
  try {
    repoInfo = provider.parseRepoInput(repoInput);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
  }

  // Step 2: Ensure provider tools are installed and authenticate
  await provider.ensureInstalled();

  const isGenericGit = provider.name === 'git';
  const authSpin = spinner(isGenericGit ? 'Checking Git identity...' : 'Checking authentication...').start();
  let username: string;
  try {
    if (provider.isAuthenticated()) {
      username = await provider.authenticate();
      authSpin.succeed(isGenericGit ? `Using Git identity ${username}` : `Authenticated as ${username}`);
    } else {
      authSpin.info(isGenericGit ? 'Resolving Git identity' : 'Not logged in — starting authentication');
      username = await provider.authenticate();
      log.success(isGenericGit ? `Using Git identity ${username}` : `Authenticated as ${username}`);
    }
  } catch (e) {
    authSpin.fail(`Authentication failed: ${(e as Error).message}`);
    process.exit(1);
  }

  // Step 3: Clone or link repo
  const defaultLocalPath = path.join(teamaiHome, 'team-repo');
  const localPath = expandHome(defaultLocalPath);

  if (await pathExists(localPath)) {
    if (await isGitRepo(localPath)) {
      log.info(`Repo already exists at ${localPath}, using existing clone`);
    } else {
      // The path exists but isn't a git repo — typically a leftover from a
      // previous non-git source (e.g. an HTTP repo). Reusing it would make the
      // subsequent git commands fail ("not a git repository"). Remove it so we
      // fall through to a fresh clone below.
      log.warn(`Existing ${localPath} is not a git repository, re-cloning`);
      await remove(localPath);
    }
  } else {
    log.info(`Clone path: ${localPath}`);
  }

  if (!await pathExists(localPath)) {
    const cloneSpin = spinner('Cloning team repo...').start();
    const cloneTarget = provider.name === 'git'
      ? repoInfo.httpsUrl
      : `${repoInfo.owner}/${repoInfo.repo}`;
    try {
      provider.cloneRepo(cloneTarget, localPath);
      cloneSpin.succeed('Team repo cloned');
    } catch (e) {
      if (e instanceof RepoNotFoundError) {
        cloneSpin.info(`Repo ${repoInfo.owner}/${repoInfo.repo} does not exist`);
        const confirmed = await askConfirmation(
          `Create repo ${repoInfo.owner}/${repoInfo.repo}? [Y/n] `,
          true,
        );
        if (!confirmed) {
          log.error('Aborted. Please provide an existing repo or confirm creation.');
          process.exit(1);
        }
        const createSpin = spinner(`Creating repo ${repoInfo.owner}/${repoInfo.repo}...`).start();
        try {
          await provider.createRepo(repoInfo.owner, repoInfo.repo);
          createSpin.succeed(`Repo ${repoInfo.owner}/${repoInfo.repo} created`);
        } catch (ce) {
          const msg = (ce as Error).message;
          if (/already been taken|already exists/i.test(msg)) {
            // Repo already exists — not fatal; fall through to retry the clone.
            createSpin.info(`Repo ${repoInfo.owner}/${repoInfo.repo} already exists, retrying clone`);
          } else {
            createSpin.fail(`Failed to create repo: ${msg}`);
            process.exit(1);
          }
        }
        // Retry clone after creation
        const retryCloneSpin = spinner('Cloning newly created repo...').start();
        try {
          provider.cloneRepo(cloneTarget, localPath);
          retryCloneSpin.succeed('Team repo cloned');
        } catch (ce) {
          retryCloneSpin.fail(`Clone failed: ${(ce as Error).message}`);
          process.exit(1);
        }
      } else {
        cloneSpin.fail(`Clone failed: ${(e as Error).message}`);
        process.exit(1);
      }
    }

    // Cloning an empty remote repo may succeed without creating the local directory.
    // Fall back to git init + add remote so subsequent steps can proceed.
    if (!await pathExists(localPath)) {
      const initSpin = spinner('Initializing empty repo...').start();
      try {
        await initRepo(repoInfo.httpsUrl, localPath);
        initSpin.succeed('Empty repo initialized');
      } catch (e) {
        initSpin.fail(`Init failed: ${(e as Error).message}`);
        process.exit(1);
      }
    }
  }

  // Step 3.5: Configure git user for the team repo
  const emailDomain = provider.getDefaultEmailDomain() ?? undefined;
  await configureGitUser(localPath, username, username, undefined, emailDomain);

  // Step 4: Load team config
  // Remote teamai.yaml.scope (if present) is ignored — local install location
  // is decided only by --scope / default (issue #250).
  const teamConfig = await loadTeamConfig(localPath);
  if (!teamConfig) {
    log.warn('teamai.yaml not found in repo. Creating default config...');
    const defaultConfig = YAML.stringify({
      team: 'my-team',
      description: 'TeamAI shared resources',
      repo: repoInfo.httpsUrl,
      provider: providerName,
      sharing: {
        rules: { enforced: [] },
        docs: { localDir: scope === 'project' ? './.teamai/docs' : '~/.teamai/docs' },
        env: { injectShellProfile: true },
      },
    });
    await writeFile(path.join(localPath, 'teamai.yaml'), defaultConfig);

    // Create standard directories
    for (const dir of ['members', 'skills', 'rules', 'docs', 'env']) {
      await ensureDir(path.join(localPath, dir));
      const gitkeep = path.join(localPath, dir, '.gitkeep');
      if (!await pathExists(gitkeep)) {
        await writeFile(gitkeep, '');
      }
    }
  }

  // Step 5: Create member file
  const memberPath = path.join(localPath, 'members', `${username}.yaml`);
  const isNewMember = !await pathExists(memberPath);
  if (isNewMember) {
    const memberYaml = YAML.stringify({
      username,
      displayName: username,
      registeredAt: new Date().toISOString(),
    });
    await writeFile(memberPath, memberYaml);
    log.success(`Registered as team member: ${username}`);

    if (!options.dryRun) {
      try {
        await pushRepoDirectly(localPath, `[teamai] Register member: ${username}`, [
          'members/',
          'teamai.yaml',
          'skills/.gitkeep',
          'rules/.gitkeep',
          'docs/.gitkeep',
          'env/.gitkeep',
        ]);
        log.success('Member registration pushed to team repo');
      } catch (e) {
        log.warn(`Push failed (you can push manually later): ${(e as Error).message}`);
      }
    }
  } else {
    log.info(`Member ${username} already registered`);
  }

  // Step 5.5: Configure default MR reviewers (only for fresh setup with no reviewers yet).
  // --force implies non-interactive: skip reviewer prompts entirely (can be configured later).
  const currentConfig = await loadTeamConfig(localPath);
  const hasReviewers = currentConfig?.reviewers && currentConfig.reviewers.length > 0;
  if (isNewMember && !hasReviewers && !options.force) {
    const wantReviewers = await askConfirmation(
      '\nWould you like to configure default MR reviewers? [y/N] ',
    );
    if (wantReviewers) {
      const reviewerInput = await askQuestion('Reviewers (comma-separated usernames): ', '');
      const reviewers = reviewerInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      if (reviewers.length > 0) {
        const configPath = path.join(localPath, 'teamai.yaml');
        const configContent = await readFileSafe(configPath);
        if (configContent) {
          const configData = YAML.parse(configContent) as Record<string, unknown>;
          configData.reviewers = reviewers;
          await writeFile(configPath, YAML.stringify(configData));
          log.success(`Configured ${reviewers.length} reviewer(s): ${reviewers.join(', ')}`);

          if (!options.dryRun) {
            try {
              await pushRepoDirectly(localPath, `[teamai] Configure reviewers: ${reviewers.join(', ')}`, [
                'teamai.yaml',
              ]);
              log.success('Reviewer config pushed to team repo');
            } catch (e) {
              log.warn(`Push failed (you can push manually later): ${(e as Error).message}`);
            }
          }
        }
      }
    }
  }

  // Step 6: Save local config
  const localConfig: LocalConfig = {
    repo: { localPath, remote: repoInfo.httpsUrl },
    username,
    scope,
    projectRoot,
    additionalRoles: [],
    ...(inheritUserScope !== undefined ? { inheritUserScope } : {}),
  };

  try {
    Object.assign(localConfig, await promptForRoleProfile(localPath, options.role));
  } catch (error) {
    const msg = (error as Error).message;
    if (msg.includes('Roles manifest not found')) {
      log.debug('No roles manifest found — skipping role selection');
    } else {
      log.error(msg);
      process.exit(1);
    }
  }

  // Persist --agent into enabledAgents (additive across runs)
  const requestedAgents = normalizeAgentList(options.agent);
  if (requestedAgents.length > 0) {
    const existing = await loadLocalConfigForScope(scope, projectRoot);
    const prev = existing?.enabledAgents ?? [];
    localConfig.enabledAgents = [...new Set([...prev, ...requestedAgents])];
    localConfig.disabledAgents = (existing?.disabledAgents ?? []).filter((t) => !requestedAgents.includes(t));
  }

  await ensureDir(teamaiHome);

  if (scope === 'project') {
    await saveLocalConfigForScope(localConfig, scope, projectRoot);
    log.success(`Local config saved to ${teamaiHome}/config.yaml`);

    // Generate .gitignore for project scope to prevent local config from being committed
    const gitignorePath = path.join(teamaiHome, '.gitignore');
    if (!await pathExists(gitignorePath)) {
      const gitignoreContent = [
        '# teamai local config (do not commit)',
        'config.yaml',
        'state.json',
        'token',
        '.update-lock',
        'env',
        'env.sh',
        'sessions/',
        'dashboard/',
        'usage.jsonl',
        'known-skills.json',
        'learnings/',
        'search-index.json',
        'votes/',
        '',
      ].join('\n');
      await writeFile(gitignorePath, gitignoreContent);
      log.debug('Generated .teamai/.gitignore for project scope');
    }
  } else {
    await ensureDir(TEAMAI_HOME);
    await saveLocalConfig(localConfig);
    log.success(`Local config saved to ${TEAMAI_HOME}/config.yaml`);
  }

  // Step 6.5: Invalidate pull cache so next pull does full sync with cleanup
  // This handles re-init scenarios where the user changes their role
  try {
    const state = await loadStateForScope(scope, projectRoot);
    state.lastPullRev = null;
    await saveStateForScope(state, scope, projectRoot);
  } catch {
    // Non-critical: state file may not exist yet on first init
  }

  // Step 7: Inject built-in + team hooks into AI tools
  const reloadedTeamConfig = await loadTeamConfig(localPath);
  if (reloadedTeamConfig) {
    const filterAgents = requestedAgents.length > 0 ? requestedAgents : undefined;
    await reconcileTeamHooksForConfig(reloadedTeamConfig, localConfig, { filterAgents });
  }

  log.success('teamai initialized successfully!');
  log.info('Skills, rules, env and docs will auto-sync on each session start (via hooks).');
  log.info('Run `teamai status` to check current config.');

  // Close the readline singleton so the process can exit cleanly.
  closePrompt();
}
