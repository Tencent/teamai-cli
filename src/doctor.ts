import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { detectProjectConfig, loadLocalConfig, loadTeamConfig } from './config.js';
import { pathExists, readFileSafe } from './utils/fs.js';
import { log, setStderrOnly } from './utils/logger.js';
import type { GlobalOptions } from './types.js';
import {
  COPILOT_TOOL_ID,
  RELOCATABLE_TOOLS,
  applyToolRoots,
  detectToolRoot,
  resolveToolRootDir,
  toolRootRejection,
  resolveHookScope,
  legacyManagedHooksPath,
  resolveToolBaseDir,
  isAgentExcluded,
  scopedToolPaths,
  type LocalConfig,
  type TeamaiConfig,
} from './types.js';
import { isToolInstalledForConfig } from './resources/base.js';
import { skillsDirForTool } from './resources/skills.js';
import { isCodexTool } from './utils/tool-names.js';
import { TEAMAI_HOOK_SUBCOMMANDS, isCodexTrustGatedTool, codexTrustReminder, keptTeamHookEntries, readCodexHookTrustForScope } from './hooks.js';
import {
  buildDeliveryChecks,
  buildRulesDeliveryChecks,
  buildAgentsDeliveryChecks,
  buildInstructionDeliveryChecks,
  buildNamespaceNotes,
  buildMcpDeliveryChecks,
  buildMcpReadFileChecks,
  buildLocalAgentMcpLocationChecks,
  buildCodexProjectTrustCheck,
  buildMcpGitExcludeCheck,
  buildEnvDeliveryCheck,
  envLoaderNotes,
  buildEntryResolutionChecks,
  buildSecretValuesCheck,
  buildEntryScopeKeyCheck,
  entryNamespaceNotes,
  buildDocsCheck,
  keptDocNotes,
} from './doctor-delivery.js';
import { agentModelNotes, aliasNamespaceNotes, buildAgentModelChecks } from './doctor-agent-models.js';
import {
  buildDeliveredGitExcludeChecks, buildLocalAgentGitExcludeChecks, deliveredGitExcludeNotes, localAgentGitExcludeNotes,
} from './doctor-git-exclude.js';

/**
 * Where a check gets its answer. `provider` checks shell out to a provider CLI
 * or the network; `local` checks only read this machine. Callers that run the
 * registry outside `teamai doctor` filter on it — see the post-pull pass in
 * `pull()`, which has just used the provider successfully and must not pay for
 * an auth probe on every sync.
 */
export type CheckSource = 'local' | 'provider';
import { hasPiHooks } from './pi-hooks.js';
import { describeEnvAdvisory, envAdvisories } from './env-advisories.js';
import { resolveTeamEnv, type TeamEnv } from './env-resolution.js';

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
  /**
   * True for a check whose failure is a cleanup opportunity, not a sign that
   * anything a user asked for is actually broken. `doctor` still reports it
   * like any other check; `pull`'s post-pull summary excludes it from the
   * "N check(s) failed" count so a healthy delivery is not announced as
   * broken because of unrelated leftover state (#693 review round 6).
   */
  informational?: boolean;
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
  /**
   * The same tool paths resolved at the scope hooks are injected into, which is
   * not the config's scope: a non-self project scope injects into HOME (#264).
   * Hook checks must use these, or a tool whose user-scope prefix differs from
   * its project-scope one is looked for under the wrong prefix and always
   * reported missing.
   */
  hookToolPaths: TeamaiConfig['toolPaths'];
  /** Where hooks are actually injected — see `resolveHookScope` (#264). */
  baseDir: string;
  /** This scope's env, resolved once for every check that reads it (env-resolution.ts); none in HTTP mode. */
  teamEnv?: TeamEnv;
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
  /**
   * Advisories that are not checks: namespace overrides, a team secret with no
   * value (#875), the Codex trust reminder when Codex cannot be asked.
   */
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
      ? async (): Promise<boolean> => await skillsDirForTool(tool, skillsPath, localConfig) !== null
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
 * Check that each relocated tool root is the one teamai writes to.
 *
 * `CLAUDE_CONFIG_DIR` and `CODEX_HOME` move everything their tool reads —
 * settings, hooks, skills, rules, agents — and teamai learns about them only
 * when `init` records them in `toolRoots`. Without the check, a member who sets
 * the variable after initializing (or changes it) keeps getting a green report
 * while every synced resource lands in a directory their tool never opens.
 *
 * Skipped when the variable is unset — then there is nothing to relocate and a
 * member who never used it should not be told about a setting they do not have.
 */
function buildToolRootChecks(localConfig: LocalConfig, teamConfig: TeamaiConfig | null): Check[] {
  const checks: Check[] = [];
  for (const [tool, { label, envVar }] of Object.entries(RELOCATABLE_TOOLS)) {
    // Nothing to compare for a config that never writes to this tool.
    const declared = teamConfig?.toolPaths[tool];
    if (!declared || isAgentExcluded(localConfig, tool)) continue;
    const detected = detectToolRoot(tool);
    if (!detected) continue;
    // The effective root, not the recorded string: `~/.claude-work` written by
    // hand is the same directory as the expanded one, while a root the sync
    // refuses (outside HOME, or nested too deep) resolves back to the default —
    // so the check fails exactly when the sync would write somewhere else.
    const recorded = localConfig.toolRoots?.[tool];
    const effective = resolveToolRootDir(tool, RELOCATABLE_TOOLS[tool].defaultRoot, localConfig.toolRoots);
    // A value init refuses cannot be fixed by re-running init: say why instead.
    const rejection = toolRootRejection(detected);
    checks.push({
      name: `${label} root matches ${envVar}`,
      source: 'local',
      // Compared path by path, so a root equal to the default passes only when
      // recording it would change nothing: an unrecorded CLAUDE_CONFIG_DIR=~/.claude
      // leaves the MCP config at ~/.claude.json, while a Claude Code told to use
      // that directory reads .claude.json from inside it.
      check: async () => rejection === null && isDeepStrictEqual(
        applyToolRoots({ [tool]: declared }, { [tool]: detected })[tool],
        applyToolRoots({ [tool]: declared }, localConfig.toolRoots)[tool],
      ),
      fix: rejection
        ? `${envVar} is ${detected}, which teamai cannot sync to (${rejection}); `
          + `this config syncs ${label} to ${effective}. Point ${envVar} at a directory `
          + 'in your home (or ~/.config/<name>) and re-run `teamai init`.'
        : `${envVar} is ${detected}; this config syncs ${label} to ${effective}`
          + `${recorded === undefined ? ' (no root recorded)' : ''}. `
          + 'Re-run `teamai init` to record it.',
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
  hookToolPaths: TeamaiConfig['toolPaths'],
  baseDir: string,
  localConfig: LocalConfig,
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (tool === 'pi') {
      const installed = await isToolInstalledForConfig(tool, paths.skills ?? '.pi/skills', localConfig);
      if (!installed) continue;
      checks.push({
        name: 'teamai hooks in pi extension',
        source: 'local',
        check: async () => hasPiHooks(),
        fix: 'Run `teamai hooks inject` to inject/update hooks',
      });
      continue;
    }
    if (tool === 'openclaw') {
      // OpenClaw has no settings file: its hook is a workspace hook directory,
      // which OpenClaw loads only once openclaw.json enables its entry.
      const { resolveOpenclawWorkspaceDir, isOpenclawHookEnabled, OPENCLAW_HOOK_DIR, OPENCLAW_HOOK_KEY } = await import('./openclaw-hooks.js');
      const workspace = await resolveOpenclawWorkspaceDir();
      if (!workspace || !await pathExists(path.join(workspace, 'hooks', OPENCLAW_HOOK_DIR))) continue;
      checks.push({
        name: 'OpenClaw hook enabled',
        source: 'local',
        check: isOpenclawHookEnabled,
        fix: `OpenClaw loads teamai's hook only when openclaw.json sets hooks.internal.entries.${OPENCLAW_HOOK_KEY}.enabled `
          + `(and internal hooks are not switched off), so OpenClaw sends no status report or sync. `
          + `Run \`openclaw hooks enable ${OPENCLAW_HOOK_KEY}\`. If it is enabled already, openclaw.json is not plain JSON `
          + `(comments, JSON5), which teamai cannot read: \`openclaw hooks info ${OPENCLAW_HOOK_KEY}\` shows what OpenClaw sees.`,
      });
      continue;
    }
    // A standalone hooks file (Copilot) is injected at the config's own scope
    // (`reconcileTeamHooksForConfig` joins resolveToolBaseDir with the
    // config-scoped `hooks`), so it is probed from `toolPaths`. Settings-based
    // hooks follow resolveHookScope and are probed from `hookToolPaths`.
    // Mixing the two — userScope `hooks/teamai.json` under <projectRoot> —
    // reported Copilot missing right after a successful `hooks inject` (#732).
    const settings = hookToolPaths[tool]?.settings;
    const hookPath = paths.hooks
      ? path.join(resolveToolBaseDir(tool, localConfig), paths.hooks)
      : settings
        ? path.join(baseDir, settings)
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
    // ZCode and DeepSeek Harness get the rules from their session-start hook
    // too, checked with the rules (`buildProjectRulesHookChecks`); only Codex
    // has the SubagentStart entry and the context limit this check is about.
    if (isCodexTool(tool)) checks.push(sessionHookRulesCheck(tool, settingsPath));
  }
  return checks;
}

/**
 * In a project the Codex family gets the team rules and instruction blocks
 * from its session hooks (#938, #945): SessionStart, and SubagentStart for a
 * fresh subagent, which fires no SessionStart. Past 2,500 tokens Codex keeps
 * only the start and end of a hook's context unless the entry sets
 * `additionalContextLimit: 0`. Both start entries must be present: the generic
 * hooks check only proves some hook-dispatch command is installed.
 */
function sessionHookRulesCheck(tool: string, settingsPath: string): Check {
  return {
    name: `Project rules and instructions reach ${tool} whole through its session hooks`,
    source: 'local',
    check: async () => {
      const sessionStart = await teamaiHookEntries(settingsPath, 'SessionStart', 'session-start');
      const subagentStart = await teamaiHookEntries(settingsPath, 'SubagentStart', 'subagent-start');
      return [sessionStart, subagentStart].every((entries) => entries.some((entry) => entry.additionalContextLimit === 0));
    },
    fix: `The teamai SessionStart and SubagentStart entries in ${settingsPath} must both exist and set `
      + `\`additionalContextLimit: 0\`. Without them ${tool} keeps only the start and end of a large set of `
      + 'team rules and instructions, and a fresh subagent gets none. Run `teamai pull` to rewrite them'
      + (isCodexTrustGatedTool(tool)
        ? ' (teamai trusts them in Codex; with `codexTrustEnabled: false`, approve them in Codex /hooks).'
        : '.'),
  };
}

/** The teamai handlers for one event in a Codex hooks.json; none when it does not parse. */
async function teamaiHookEntries(
  settingsPath: string,
  event: 'SessionStart' | 'SubagentStart',
  subcommand: string,
): Promise<Array<{ additionalContextLimit?: unknown }>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFileSafe(settingsPath) ?? '');
  } catch {
    return [];
  }
  const groups = (parsed as { hooks?: Record<string, unknown> } | null)?.hooks?.[event];
  if (!Array.isArray(groups)) return [];
  return groups
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .filter((entry): entry is { command: string; additionalContextLimit?: unknown } =>
      typeof entry?.command === 'string' && entry.command.includes(`teamai hook-dispatch ${subcommand}`));
}


/**
 * Whether the public Codex will run the hooks teamai wrote in this scope (#955),
 * asked read-only through `codex app-server` `hooks/list`. A check when Codex
 * answers; the trust reminder as a note when it cannot (no `codex` on PATH, the
 * app-server failed). Nothing when teamai wrote no Codex hook here.
 */
async function codexHookTrust(ctx: DoctorContext): Promise<{ checks: Check[]; notes: string[] }> {
  const report = ctx.teamConfig ? await readCodexHookTrustForScope(ctx.teamConfig, ctx.localConfig) : null;
  if (!report) return { checks: [], notes: [] };
  if (report.kind !== 'listed') {
    const reason = report.kind === 'failed' ? ` (could not ask Codex: ${report.reason})` : '';
    return { checks: [], notes: [`${codexTrustReminder()}${reason}`] };
  }
  const notLoaded = report.notTrusted.some((h) => h.status === 'not loaded');
  const notTrusted = report.notTrusted.map((h) => `${h.command} in ${h.file} (${h.status})`);
  return {
    checks: [{
      name: 'Codex trusts the teamai hooks',
      source: 'local',
      check: async () => notTrusted.length === 0,
      fix: (notLoaded ? 'For hooks not loaded in a linked worktree, create `.codex/` or start Codex there, then open a new session. ' : '')
        + `Codex will not run: ${notTrusted.join('; ')}. Run \`teamai pull\` to trust them, `
        + 'or trust them in Codex /hooks. If `codexTrustEnabled: false` is set in config.yaml, '
        + 'teamai leaves trusting them to you.',
    }],
    notes: [],
  };
}

/**
 * Resolve the local/team configuration the checks run against. Returns null
 * when TeamAI is not initialized here — the caller decides how to report that.
 */
export async function resolveDoctorContext(): Promise<DoctorContext | null> {
  // Read-only: the load never persists a migration (#893).
  const projectConfig = await detectProjectConfig(undefined, undefined, { dryRun: true });
  const localConfig = projectConfig ?? (await loadLocalConfig({ dryRun: true }));
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
  // hooks live in ~/.claude and always reports them missing. The paths have to
  // follow the same scope, or a tool whose user-scope prefix differs from its
  // project-scope one (`qoder-cn`, OpenCode) is probed under the wrong prefix.
  const hookScope = resolveHookScope(localConfig);
  const hookToolPaths: TeamaiConfig['toolPaths'] = teamConfig
    ? Object.fromEntries(
      Object.entries(scopedToolPaths(teamConfig, { ...localConfig, scope: hookScope.scope }))
        .filter(([tool]) => !isAgentExcluded(localConfig, tool)),
    )
    : {};
  const baseDir = hookScope.baseDir;
  const teamEnv = localConfig.repo.kind === 'http' ? undefined : await resolveTeamEnv(localConfig);

  return { localConfig, teamConfig, toolPaths, hookToolPaths, baseDir, teamEnv };
}

/**
 * Which caller the registry is being built for.
 *
 * `pull` runs the registry again at the end of an interactive sync, under a
 * budget that covers building it as well as running it. Skills and docs cost a
 * stat per item; rules cost a read per rule per tool and agents parse every
 * spec. Spending the budget on those loses the cheap checks that catch the bug
 * this whole line of work exists for, so they are `doctor`-only.
 *
 * The stage is a property of the caller, not of a check, which is why it is an
 * argument here rather than a third optional flag on `Check` beside `source`
 * and `reportedByPull`.
 */
export type CheckStage = 'pull' | 'doctor';

/**
 * The check registry. Exported so callers other than `teamai doctor` can run
 * the same diagnostics and act on the result.
 */
export async function buildChecks(ctx: DoctorContext, stage: CheckStage = 'doctor'): Promise<Check[]> {
  const { localConfig, teamConfig, toolPaths, hookToolPaths, baseDir } = ctx;
  // A member's `init --provider` choice outranks the team's provider (#789).
  const providerName = localConfig.provider ?? teamConfig?.provider;
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
    ...await buildGitHookChecks(localConfig, stage),
    ...await buildTrackedHookIndexCheck(localConfig),
    ...buildToolRootChecks(localConfig, teamConfig),
    ...await buildEnabledToolChecks(ctx),
    ...await buildHookChecks(toolPaths, hookToolPaths, baseDir, localConfig),
    ...await buildDeliveryChecks(ctx),
    // Built only for `doctor`: the work is in building these, not in running
    // them, so skipping them post-pull is what keeps the budget for the rest.
    ...(stage === 'doctor' ? await buildRulesDeliveryChecks(ctx) : []),
    ...(stage === 'doctor' ? await buildAgentsDeliveryChecks(ctx) : []),
    ...(stage === 'doctor' ? await buildInstructionDeliveryChecks(ctx) : []),
    ...await buildAgentModelChecks(ctx, stage),
    ...await buildMcpDeliveryChecks(ctx),
    ...await buildMcpReadFileChecks(ctx),
    ...await buildLocalAgentMcpLocationChecks(ctx),
    ...await buildCodexProjectTrustCheck(ctx),
    ...await buildMcpGitExcludeCheck(ctx),
    ...await buildDeliveredGitExcludeChecks(ctx),
    ...await buildLocalAgentGitExcludeChecks(),
    ...await buildDocsCheck(ctx),
    ...await buildEnvDeliveryCheck(ctx),
    ...await buildEntryResolutionChecks(ctx),
    ...buildSecretValuesCheck(ctx),
    ...await buildEntryScopeKeyCheck(ctx),
  );

  return checks;
}

/**
 * Project scope: whether teamai's git hook is installed (`doctor` only: pull
 * installs it, and a member on an old git would hear it after every pull), and
 * the failure its last silent run recorded (git-hook.ts), which `pull`
 * mentions itself. A project root outside git has no hook to report.
 */
async function buildGitHookChecks(localConfig: LocalConfig, stage: CheckStage): Promise<Check[]> {
  if (localConfig.scope !== 'project' || !localConfig.projectRoot) return [];
  const { gitHookStatus, describeMissingGitHook, readGitHookFailure, describeGitHookFailure } = await import('./git-hook.js');
  // A project root that no longer exists cannot be asked (git refuses the cwd).
  const status = stage === 'doctor' ? await gitHookStatus(localConfig.projectRoot).catch(() => null) : null;
  const failure = await readGitHookFailure(localConfig);
  const report = failure ? describeGitHookFailure(failure) : null;
  const installed: Check[] = !status || (!status.installed && status.reason === 'not-a-repository') ? [] : [{
    name: 'Git hook syncs new worktrees and git pull',
    source: 'local',
    check: async () => status.installed,
    ...(status.installed ? {} : { fix: describeMissingGitHook(status) }),
  }];
  return [
    ...installed,
    report
      ? {
        name: `Last git hook run failed: ${report.message}`,
        source: 'local',
        reportedByPull: 'git-hook-failure',
        check: async () => false,
        fix: report.fix,
      }
      : { name: 'No git hook failure recorded', source: 'local', check: async () => true },
  ];
}

/**
 * Project scope: the hook index and the package lock a release before #993
 * kept in the working tree, when git tracks them. Pull moves the index's
 * records to the data home, and the lock is copied there, but a tracked file
 * is left for the member to untrack (`migrateLegacyManagedHooks`,
 * `packageLockDir`).
 */
async function buildTrackedHookIndexCheck(localConfig: LocalConfig): Promise<Check[]> {
  if (localConfig.scope !== 'project' || !localConfig.projectRoot) return [];
  const root = localConfig.projectRoot;
  const { gitTracks } = await import('./git-exclude.js');
  const legacyFiles = [
    { file: legacyManagedHooksPath(root), what: 'hook index', after: 'teamai pull deletes it once nothing in it is needed' },
    { file: path.join(root, '.teamai', 'teamai.lock'), what: 'package lock', after: 'the next `teamai packages install` or session start deletes it' },
  ];
  const checks: Check[] = [];
  for (const { file, what, after } of legacyFiles) {
    if (!await pathExists(file) || (await gitTracks(file)).kind !== 'tracked') continue;
    const rel = path.relative(root, file).split(path.sep).join('/');
    checks.push({
      name: `${file} is tracked by git`,
      source: 'local',
      informational: true,
      check: async () => false,
      fix: `teamai keeps its ${what} in its data home now; this copy is left over from an older release. `
        + `Run \`git rm --cached ${rel}\` in ${root} and commit, so it leaves the repository; ${after}.`,
    });
  }
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

  const { localConfig } = ctx;
  const scope = localConfig.scope ?? 'user';
  if (!jsonMode) {
    const scopeLabel = `${scope}${scope === 'project' && localConfig.projectRoot ? ` (${localConfig.projectRoot})` : ''}`;
    console.log(`  Scope: ${scopeLabel}\n`);
  }

  // Doctor only: it spawns `codex app-server`, which the post-pull pass skips.
  const codexTrust = await codexHookTrust(ctx);
  const results = await runChecks([...await buildChecks(ctx), ...codexTrust.checks], jsonMode ? undefined : renderResult);
  let allPassed = results.every((r) => r.ok);

  const { pkgDoctorReport } = await import('./pkg/commands.js');
  const packageReport = await pkgDoctorReport(localConfig, process.cwd());
  if (packageReport && !packageReport.allPassed) allPassed = false;

  // Info, not checks: which namespace item or entry replaces which root one
  // (#707), a model alias an agent uses from a namespace not active here, and
  // how each alias agent's model resolved in each tool (#830).
  const { ruleChannelNotes } = await import('./resources/rules.js');
  const notes = [
    ...await buildNamespaceNotes(ctx),
    ...await entryNamespaceNotes(ctx),
    // Hook entries a pull keeps as the member's (#993): the team's own entries are written beside them.
    ...ctx.teamConfig ? await keptTeamHookEntries(ctx.teamConfig, localConfig) : [],
    ...await aliasNamespaceNotes(ctx),
    ...await agentModelNotes(ctx),
    ...(await envAdvisories(localConfig, ctx.teamConfig, ctx.teamEnv)).map(describeEnvAdvisory),
    ...await envLoaderNotes(ctx),
    ...await ruleChannelNotes(localConfig),
    ...codexTrust.notes,
    // What git sees of the delivered team resources, and what no pull changes (#915).
    ...await deliveredGitExcludeNotes(ctx),
    ...await localAgentGitExcludeNotes(),
    ...await keptDocNotes(ctx),
  ];

  if (jsonMode) {
    emitReport({
      ok: allPassed,
      scope,
      checks: results,
      // pkgDoctorReport renders its own lines; they are human text, not checks.
      ...(packageReport ? { packages: { ok: packageReport.allPassed, lines: packageReport.lines } } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    });
    return allPassed;
  }

  if (packageReport) {
    for (const line of packageReport.lines) console.log(line);
  }

  if (notes.length > 0) {
    console.log('');
    for (const note of notes) log.info(note);
  }

  console.log('');
  if (allPassed) {
    log.success('All checks passed!');
  } else {
    log.warn('Some checks failed. See suggestions above.');
  }
  return allPassed;
}
