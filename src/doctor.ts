import path from 'node:path';
import { detectProjectConfig, loadLocalConfig, loadTeamConfig } from './config.js';
import fs from 'node:fs';
import { expandHome, listFilesRecursive, pathExists, readFileSafe } from './utils/fs.js';
import { log, setStderrOnly } from './utils/logger.js';
import type { GlobalOptions, ResourceItem } from './types.js';
import {
  COPILOT_TOOL_ID,
  TEAMAI_ENV_START,
  resolveHookScope,
  resolveToolBaseDir,
  getDataHome,
  isAgentExcluded,
  scopedToolPaths,
  type LocalConfig,
  type TeamaiConfig,
} from './types.js';
import { isToolInstalledForConfig } from './resources/base.js';
import { skillsReachTool } from './resources/skills.js';
import { splitFrontmatter } from './utils/frontmatter.js';
import { TEAMAI_HOOK_SUBCOMMANDS, isCodexTrustGatedTool, codexTrustReminder } from './hooks.js';
import { getUserHome } from './utils/home.js';

/**
 * Where a check gets its answer. `provider` checks shell out to a provider CLI
 * or the network; `local` checks only read this machine. Callers that run the
 * registry outside `teamai doctor` filter on it — see the post-pull pass in
 * `pull()`, which has just used the provider successfully and must not pay for
 * an auth probe on every sync.
 */
export type CheckSource = 'local' | 'provider';

export interface Check {
  name: string;
  source: CheckSource;
  /**
   * Names something `teamai pull` says in its own words, better than a static
   * `fix` can: the queue warning carries the push error, which `doctor` cannot
   * learn without attempting a push of its own, and a read-only diagnostic must
   * not. The post-pull pass drops a check whose topic that run actually
   * reported. Not every run does: a scope whose team repo fails to refresh
   * returns before the publish step, and a publish that throws is swallowed
   * into a debug line. On those paths nobody has spoken, so the check is the
   * only voice left and must be heard.
   */
  reportedByPull?: string;
  check: () => Promise<boolean>;
  fix?: string;
}

/**
 * Everything the check registry needs to describe this machine. Resolved once
 * by `resolveDoctorContext`, then passed to `buildChecks` — so any caller
 * (doctor, and later a post-pull run) builds the same checks the same way.
 */
export interface DoctorContext {
  localConfig: LocalConfig;
  teamConfig: TeamaiConfig | null;
  /** Tool paths already narrowed to the enabled, non-excluded agents. */
  toolPaths: TeamaiConfig['toolPaths'];
  /** Where hooks are actually injected — see `resolveHookScope` (#264). */
  baseDir: string;
}

export interface DoctorOptions extends GlobalOptions {
  /** Emit the report as JSON on stdout instead of the human rendering. */
  json?: boolean;
}

/** One check after it ran. */
export interface CheckResult {
  name: string;
  ok: boolean;
  fix?: string;
}

/** What `doctor --json` prints. One object, one place that builds it. */
export interface DoctorReport {
  ok: boolean;
  /** null before initialization, when there is no config to scope. */
  scope: string | null;
  checks: CheckResult[];
  /** Present only when the team repo declares packages. Human text, not checks. */
  packages?: { ok: boolean; lines: string[] };
  /** Advisories that are not checks — today, the Codex trust-gate reminder. */
  notes?: string[];
}

/**
 * Check that every tool the team declares and the user enabled is actually here.
 * Scope note: the loop is over `ctx.toolPaths`, already narrowed to the enabled,
 * non-excluded agents, so a name in `enabledAgents` that `teamai.yaml` declares
 * no paths for is out of scope — nothing would be written to it either way.
 *
 * That list is the user's own claim that they use the tool, and every writer —
 * skills, rules, agents, hooks — silently skips a tool whose root is missing.
 * Answering the claim with silence reproduces inside `doctor` the skip #574
 * reports in `pull`: "Synced N" while the tool receives nothing. Without
 * `enabledAgents` the team's tool list is aspirational, so an absent tool stays
 * silent, as it always has.
 *
 * The probe uses a resource path rather than the settings path: resources land
 * under `resolveToolBaseDir` (the project root in project scope), which is the
 * root a pull would have to write into.
 */
async function buildEnabledToolChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, toolPaths } = ctx;
  if (!localConfig.enabledAgents) return [];

  const checks: Check[] = [];
  for (const [tool, paths] of Object.entries(toolPaths)) {
    // Copilot counts itself installed as soon as enabledAgents names it
    // (isToolInstalledForConfig), so this check could never fail for it. Its
    // delivery check still reports what did not arrive.
    if (tool === COPILOT_TOOL_ID) continue;

    const probePath = paths.skills ?? paths.rules ?? paths.agents ?? paths.settings ?? paths.hooks;
    if (!probePath) continue;

    // A tool that receives skills is asked the way the skills write path asks:
    // OpenClaw lives at its workspace directory, not at the tool root, so the
    // generic probe passes for a `~/.openclaw` with no workspace while delivery
    // silently skips it — the same "reported success, received nothing" this
    // check exists to catch. A tool with no skills path (rules only) has no
    // such resolver, so it keeps the generic probe.
    const skillsPath = paths.skills;
    const isInstalled = skillsPath
      ? (): Promise<boolean> => skillsReachTool(tool, skillsPath, localConfig)
      : (): Promise<boolean> => isToolInstalledForConfig(tool, probePath, localConfig);

    // Pushed whether or not it passes. Every other check in the registry
    // reports both ways, and `doctor --json` is consumed by hooks and CI, where
    // a missing entry cannot be told apart from one that passed.
    checks.push({
      name: `${tool} is installed`,
      source: 'local',
      check: isInstalled,
      fix: `enabledAgents lists ${tool}, but it has no directory under `
        + `${resolveToolBaseDir(tool, localConfig)}, so a pull delivers nothing to it. `
        + `Install ${tool} (in project scope, opening a session there creates its root), `
        + `or run \`teamai uninstall --agent ${tool}\` to stop syncing to it.`,
    });
  }

  return checks;
}

/**
 * Build hook checks for tools whose settings parent directory already exists
 * (i.e. the tool is installed). Tools that are not installed are skipped.
 */
async function buildHookChecks(
  toolPaths: TeamaiConfig['toolPaths'],
  baseDir: string,
  localConfig: LocalConfig,
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [tool, paths] of Object.entries(toolPaths)) {
    const hookPath = paths.hooks
      ? path.join(resolveToolBaseDir(tool, localConfig), paths.hooks)
      : paths.settings
        ? path.join(baseDir, paths.settings)
        : undefined;
    if (!hookPath) continue;
    const settingsPath = hookPath;
    const parentDir = path.dirname(settingsPath);
    const installed = tool === COPILOT_TOOL_ID
      ? await isToolInstalledForConfig(tool, paths.hooks ?? paths.settings ?? '', localConfig)
      : await pathExists(parentDir);
    // An uninstalled tool has no hooks to check. Whether it should be installed
    // at all is a different question — see buildEnabledToolChecks.
    if (!installed) continue;
    checks.push({
      name: `teamai hooks in ${tool} settings`,
      source: 'local',
      check: async () => {
        if (!await pathExists(settingsPath)) return false;
        const content = await readFileSafe(settingsPath);
        if (!content) return false;

        const missing = TEAMAI_HOOK_SUBCOMMANDS.filter(
          (sub) => !content.includes(`teamai ${sub}`),
        );
        return missing.length === 0;
      },
      fix: 'Run `teamai hooks inject` to inject/update hooks',
    });
  }
  return checks;
}

/**
 * Whether a delivered skill directory is one an agent can actually discover:
 * SKILL.md present, frontmatter parses, and its `name` is the directory's own.
 * A copy that fails this landed successfully — no write-time gate can see it.
 */
async function skillIsDiscoverable(skillDir: string, skillName: string): Promise<boolean> {
  const content = await readFileSafe(path.join(skillDir, 'SKILL.md'));
  if (!content) return false;

  const { data, valid } = splitFrontmatter(content);
  if (!valid) return false;
  return data.name === skillName;
}

/**
 * Whether `filePath` is a file something can actually read. `pathExists`
 * follows symlinks but says yes to a directory too, so on its own it cannot
 * tell a delivered document from a name occupied by something else.
 */
async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(expandHome(filePath))).isFile();
  } catch {
    return false;
  }
}

/** At most this many names in a fix string; the rest are counted. */
const MAX_NAMED_IN_FIX = 5;

/** `a, b, c and 4 more` — a fix a human reads, not a wall of paths. */
function nameList(names: string[]): string {
  if (names.length <= MAX_NAMED_IN_FIX) return names.join(', ');
  const shown = names.slice(0, MAX_NAMED_IN_FIX).join(', ');
  return `${shown} and ${names.length - MAX_NAMED_IN_FIX} more`;
}

/**
 * Build one delivery check per installed tool: every skill the member should
 * have, against what is actually on disk for that tool.
 *
 * This is the only check that looks at the payload rather than the plumbing. A
 * write-time gate cannot cover it — `SkillsHandler.pullItem` skips each
 * uninstalled tool on its own, and a directory deleted by hand after a correct
 * pull leaves every gate happy (#598).
 *
 * The scan runs here rather than inside `check()` because the fix names the
 * skills that are missing, and a `Check`'s fix is read as it was built.
 */
async function buildDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig, toolPaths } = ctx;
  if (!teamConfig) return [];

  // Dynamic: pull.ts imports this module for its post-pull pass, and the desired
  // set is policy that must not be restated here.
  const { buildRolePullContext, resolveDesiredSkills } = await import('./pull.js');
  const { skillTargetForTool } = await import('./resources/skills.js');

  let items: ResourceItem[];
  try {
    const roleContext = await buildRolePullContext(localConfig);
    ({ items } = await resolveDesiredSkills(teamConfig, localConfig, roleContext));
  } catch (e) {
    // A team repo whose active namespaces collide cannot say what should be
    // delivered — `pull` aborts the scope with this same message. The command
    // whose job is explaining bad state must report it, not stack-trace on it.
    return [{
      name: 'Skills to deliver can be resolved',
      source: 'local',
      check: async () => false,
      fix: `${(e as Error).message}. Until the team repo is fixed, `
        + 'pull cannot sync skills for this role.',
    }];
  }
  if (items.length === 0) return [];

  const checks: Check[] = [];
  for (const [tool, paths] of Object.entries(toolPaths)) {
    const skillsPath = paths.skills;
    if (!skillsPath) continue;

    const missing: string[] = [];
    const unreadable: string[] = [];
    let installed = true;
    for (const item of items) {
      const dest = await skillTargetForTool(tool, skillsPath, localConfig, item.name);
      if (!dest) {
        // Not installed. Nothing was promised to this tool, so nothing is owed;
        // a tool the user listed in enabledAgents is caught by its own check.
        installed = false;
        break;
      }
      if (!await pathExists(dest)) missing.push(item.name);
      else if (!await skillIsDiscoverable(dest, item.name)) unreadable.push(item.name);
    }
    if (!installed) continue;

    const problems: string[] = [];
    if (missing.length > 0) problems.push(`not delivered: ${nameList(missing)}`);
    if (unreadable.length > 0) problems.push(`delivered but unreadable: ${nameList(unreadable)}`);

    checks.push({
      name: `Skills delivered to ${tool}`,
      source: 'local',
      check: async () => problems.length === 0,
      fix: `In ${tool}, ${problems.join('; ')}. Run \`teamai pull --force\`: a plain pull `
        + 'skips a scope whose team repo has not changed, so it cannot restore this. '
        + 'If a skill stays unreadable, fix its SKILL.md in the team repo — the '
        + 'frontmatter needs a `name` matching the directory, or the agent never '
        + 'discovers it.',
    });
  }

  return checks;
}

/**
 * The docs bundle has one destination rather than one per tool: `DocsHandler`
 * copies the whole `docs/` tree into `sharing.docs.localDir`. So this check
 * compares the two trees, file by file, rather than asking each tool.
 */
async function buildDocsCheck(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { DocsHandler, resolveDocsDestination } = await import('./resources/docs.js');
  const handler = new DocsHandler();
  const [item] = await handler.scanTeamForPull(teamConfig, localConfig);
  if (!item) return [];

  const dest = resolveDocsDestination(teamConfig, localConfig);
  const teamFiles = (await listFilesRecursive(item.sourcePath))
    // Same filter DocsHandler.pullItem copies with: dotfiles never travel.
    .filter((file) => file.split('/').every((segment) => !segment.startsWith('.')));

  // isFile, not merely "something is there": a directory sitting on the
  // expected name, or a symlink with nothing behind it, would satisfy a plain
  // existence check while the doc is no more readable than a missing one.
  const missing: string[] = [];
  for (const file of teamFiles) {
    if (!await isReadableFile(path.join(dest, file))) missing.push(file);
  }

  return [{
    name: 'Team docs delivered',
    source: 'local',
    check: async () => missing.length === 0,
    fix: `Missing from ${dest}: ${nameList(missing)}. Run \`teamai pull --force\`: a plain `
      + 'pull skips a scope whose team repo has not changed, so it cannot restore these.',
  }];
}

/**
 * True if a trust-gated Codex tool (the public `codex`) already has teamai hooks
 * installed on disk (settings file exists and contains the hook-dispatch
 * command). Used to emit a lightweight reminder that Codex may still require the
 * user to trust them. Read-only — never inspects or modifies Codex's
 * [hooks.state] trust store. Internal variants are excluded (no trust gate).
 */
async function hasInstalledCodexHooks(toolPaths: TeamaiConfig['toolPaths'], baseDir: string): Promise<boolean> {
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (!isCodexTrustGatedTool(tool) || !paths.settings) continue;
    const settingsPath = path.join(baseDir, paths.settings);
    if (!await pathExists(settingsPath)) continue;
    const content = await readFileSafe(settingsPath);
    if (content?.includes('teamai hook-dispatch')) return true;
  }
  return false;
}

/**
 * Resolve the local/team configuration the checks run against. Returns null
 * when TeamAI is not initialized here — the caller decides how to report that.
 */
export async function resolveDoctorContext(): Promise<DoctorContext | null> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await loadLocalConfig());
  if (!localConfig) return null;

  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  const toolPaths: TeamaiConfig['toolPaths'] = teamConfig
    ? Object.fromEntries(
      Object.entries(scopedToolPaths(teamConfig, localConfig))
        .filter(([tool]) => !isAgentExcluded(localConfig, tool)),
    )
    : {};
  // Hook checks must look where hooks are actually injected. resolveHookScope
  // maps a non-self project scope to HOME (#264), matching the injection path in
  // init/pull/hooks-cmd — otherwise doctor checks <projectRoot>/.claude while the
  // hooks live in ~/.claude and always reports them missing.
  const baseDir = resolveHookScope(localConfig).baseDir;

  return { localConfig, teamConfig, toolPaths, baseDir };
}

/**
 * The check registry. Exported so callers other than `teamai doctor` can run
 * the same diagnostics and act on the result.
 */
export async function buildChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig, toolPaths, baseDir } = ctx;
  const providerName = teamConfig?.provider;
  const checks: Check[] = [];

  // Provider-specific checks: gf CLI only needed for TGit, gh CLI for GitHub
  if (providerName === 'tgit') {
    // Dynamic import to avoid loading gf-cli code when not needed
    const { isGfInstalled, gfIsAuthenticated } = await import('./providers/tgit/index.js');
    checks.push(
      {
        name: 'gf CLI is installed',
        source: 'provider',
        check: async () => isGfInstalled(),
        fix: 'Run `teamai init` to install gf CLI automatically',
      },
      {
        name: 'gf CLI is authenticated',
        source: 'provider',
        check: async () => gfIsAuthenticated(),
        fix: 'Run `teamai init` to authenticate via gf auth login',
      },
    );
  } else if (providerName === 'github') {
    // Dynamic import to avoid loading gh-cli code when not needed
    const { isGhInstalled, ghIsAuthenticated } = await import('./providers/github/index.js');
    checks.push(
      {
        name: 'gh CLI is installed',
        source: 'provider',
        check: async () => isGhInstalled(),
        fix: 'Install from https://cli.github.com/ or run `brew install gh`',
      },
      {
        name: 'gh CLI is authenticated',
        source: 'provider',
        check: async () => ghIsAuthenticated(),
        fix: 'Run `gh auth login` to authenticate',
      },
    );
  } else if (providerName === 'gitlab') {
    // GitLab needs no CLI — only a Personal Access Token.
    const { gitlabIsAuthenticated } = await import('./providers/gitlab/index.js');
    checks.push({
      name: 'GitLab token is configured',
      source: 'provider',
      check: async () => gitlabIsAuthenticated(),
      fix: 'Export GITLAB_TOKEN (a Personal Access Token with `api` scope). '
        + 'GITLAB_PRIVATE_TOKEN and GITLAB_PAT are accepted as aliases.',
    });
  } else if (providerName === 'gitcode') {
    // GitCode needs no CLI — only a Personal Access Token (env or ~/.netrc).
    const { gitcodeIsAuthenticated } = await import('./providers/gitcode/index.js');
    checks.push({
      name: 'GitCode token is configured',
      source: 'provider',
      check: async () => gitcodeIsAuthenticated(),
      fix: 'Export GITCODE_TOKEN (a GitCode Personal Access Token), or run `teamai init` '
        + 'to paste one interactively. GC_TOKEN is accepted as an alias.',
    });
  }

  checks.push(
    {
      name: 'Team repo exists locally',
      source: 'local',
      check: async () => pathExists(localConfig.repo.localPath),
      fix: 'Run `teamai init` to clone the team repo',
    },
    {
      name: 'Team config (teamai.yaml) is valid',
      source: 'local',
      check: async () => {
        const config = await loadTeamConfig(localConfig.repo.localPath);
        return config !== null;
      },
      fix: 'Check teamai.yaml in team repo for syntax errors',
    },
    {
      // A contribution is kept locally when it cannot be published. Without
      // this check a member whose pushes are rejected queues notes forever and
      // is told each time that the next pull will retry.
      name: 'Contributed learnings are published',
      source: 'local',
      // pullForScope warns about the queue on its own, with the push error
      // attached; this check is the standing version of it for `teamai doctor`.
      reportedByPull: 'pending-learnings',
      check: async () => {
        const { listPendingLearnings } = await import('./utils/pending-learnings.js');
        return (await listPendingLearnings(localConfig)).length === 0;
      },
      fix: 'Run `teamai pull` to publish them. If they stay queued, check that you '
        + 'can push to the team repo (run with --verbose to see the push error).',
    },
    ...await buildEnabledToolChecks(ctx),
    ...await buildHookChecks(toolPaths, baseDir, localConfig),
    ...await buildDeliveryChecks(ctx),
    ...await buildDocsCheck(ctx),
    {
      name: 'Env variables injected in shell profile',
      source: 'local',
      check: async () => {
        if (teamConfig?.sharing?.env?.injectShellProfile === false) return true;

        const envYamlPath = path.join(localConfig.repo.localPath, 'env', 'env.yaml');
        if (!await pathExists(envYamlPath)) return true;

        const home = getUserHome();

        // env.sh lives under teamaiHome, which is <projectRoot>/.teamai in
        // project scope and ~/.teamai in user scope — mirror the path that
        // `teamai pull` actually writes to, not a hardcoded user-home path.
        const envShPath = path.join(
          getDataHome(localConfig),
          'env.sh',
        );
        if (!await pathExists(envShPath)) return false;

        const shell = process.env.SHELL ?? '';
        const profilePath = shell.includes('zsh')
          ? path.join(home, '.zshrc')
          : path.join(home, '.bashrc');
        if (!await pathExists(profilePath)) return false;
        const content = await readFileSafe(profilePath);
        return content?.includes(TEAMAI_ENV_START) ?? false;
      },
      fix: 'Run `teamai pull` to inject env variables into shell profile',
    },
  );

  return checks;
}

/**
 * Run every check once, in registry order. `onResult` reports each one as it
 * lands, so the human rendering keeps streaming while a slow check (a provider
 * CLI auth probe) is still running.
 */
export async function runChecks(
  checks: Check[],
  onResult?: (result: CheckResult) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const { name, check, fix } of checks) {
    const ok = await check();
    const result: CheckResult = ok ? { name, ok } : { name, ok, fix };
    results.push(result);
    onResult?.(result);
  }
  return results;
}

/** The only writer of the JSON channel. */
function emitReport(report: DoctorReport): void {
  console.log(JSON.stringify(report, null, 2));
}

/**
 * The human rendering of one finished check, as lines. Exported because `pull`
 * prints the same shape through the logger rather than stdout — one definition
 * of the glyphs and the indent, two sinks.
 */
export function formatCheckResult({ name, ok, fix }: CheckResult): string[] {
  if (ok) return [`  ✔ ${name}`];
  return fix ? [`  ✖ ${name}`, `    → ${fix}`] : [`  ✖ ${name}`];
}

function renderResult(result: CheckResult): void {
  for (const line of formatCheckResult(result)) console.log(line);
}

export async function doctor(options: DoctorOptions): Promise<boolean> {
  const jsonMode = options.json === true;
  // In JSON mode stdout is a data channel: route every log line to stderr so a
  // consumer can parse stdout whole (same trick as hook-dispatch commands).
  if (jsonMode) setStderrOnly(true);

  log.info('Running diagnostics...\n');
  const ctx = await resolveDoctorContext();
  if (!ctx) {
    const notInitialized: CheckResult = {
      name: 'TeamAI is not initialized',
      ok: false,
      fix: 'Run `teamai init <repo-url>` in a project, or add `--scope user` for all projects',
    };
    if (jsonMode) {
      emitReport({ ok: false, scope: null, checks: [notInitialized] });
    } else {
      console.log('  Scope: not initialized\n');
      renderResult(notInitialized);
      console.log('');
    }
    log.warn('Initialization is required before diagnostics can run.');
    return false;
  }

  const { localConfig, toolPaths, baseDir } = ctx;
  const scope = localConfig.scope ?? 'user';
  if (!jsonMode) {
    const scopeLabel = `${scope}${scope === 'project' && localConfig.projectRoot ? ` (${localConfig.projectRoot})` : ''}`;
    console.log(`  Scope: ${scopeLabel}\n`);
  }

  const results = await runChecks(await buildChecks(ctx), jsonMode ? undefined : renderResult);
  let allPassed = results.every((r) => r.ok);

  const { pkgDoctorReport } = await import('./pkg/commands.js');
  const packageReport = await pkgDoctorReport(localConfig, process.cwd());
  if (packageReport && !packageReport.allPassed) allPassed = false;

  // Codex trust-gate reminder: even when hooks are installed, Codex may not run
  // them until the user reviews/trusts them. Note only — teamai never writes
  // [hooks.state] to auto-trust.
  const codexNote = await hasInstalledCodexHooks(toolPaths, baseDir)
    ? codexTrustReminder()
    : null;

  if (jsonMode) {
    emitReport({
      ok: allPassed,
      scope,
      checks: results,
      // pkgDoctorReport renders its own lines; they are human text, not checks.
      ...(packageReport ? { packages: { ok: packageReport.allPassed, lines: packageReport.lines } } : {}),
      ...(codexNote ? { notes: [codexNote] } : {}),
    });
    return allPassed;
  }

  if (packageReport) {
    for (const line of packageReport.lines) console.log(line);
  }

  if (codexNote) {
    console.log('');
    log.info(codexNote);
  }

  console.log('');
  if (allPassed) {
    log.success('All checks passed!');
  } else {
    log.warn('Some checks failed. See suggestions above.');
  }
  return allPassed;
}
