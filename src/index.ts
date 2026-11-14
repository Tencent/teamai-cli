import { createRequire } from 'node:module';
import { format } from 'node:util';
import { Command, Option } from 'commander';
import { setVerbose, setSilent, setStderrOnly, log, writeInfoLine } from './utils/logger.js';
import { applyNonInteractiveGitEnv } from './utils/git-env.js';
import { ensureBundledRuntimeOnPath } from './bundled-runtime.js';
import type { GlobalOptions, LocalConfig } from './types.js';
import type { MaintenancePaths } from './maintenance/paths.js';
import type { PromotionCandidate } from './maintenance/promote.js';
import type { ScoreOptions } from './score-commands.js';
import type { EvidenceOptions, LabelOptions, PlanOptions, ReportOptions, StageOptions, SubjectsOptions, WriteOptions } from './score-verbs.js';
import { GLOBAL_OPTIONS } from './global-options.js';
import { ATTEMPT_ENV } from './launch-context.js';
import { useInstallHome } from './utils/home.js';
import { TEAMAI_HOOK_SUBCOMMANDS } from './hooks.js';
import { dryRunRefusal } from './dry-run-guard.js';
import { parseIntOption } from './cli-int.js';
import { registerPackagesCommand } from './pkg/register-command.js';
import { shouldRegisterSessionFlowCommands } from './session-flow/register-gate.js';

// Commands that migrate a legacy `<repo>/.teamai/` into the partition on first
// run (issue #374 P1-3). Only write commands trigger it; read-only commands rely
// on the double-read fallback, and hook-dispatch is excluded outright (see below).
const MIGRATION_TRIGGER_COMMANDS = new Set(['init', 'pull', 'push']);

/**
 * Whether this command queues learnings, which an unmigrated checkout would
 * keep in its own `.teamai/`, deleted with a linked worktree (#808). `import`
 * queues them only with --from-mr; its other modes leave the queue alone, and
 * `--cache-status --json` must print nothing but its JSON. `contribute --scope
 * user` queues in the user install, and `import --from-mr --output` writes
 * drafts only.
 */
function queuesLearnings(command: Command): boolean {
  const name = command.name();
  const opts = command.opts();

  return (
    (name === 'contribute' && opts.scope !== 'user') ||
    (name === 'import' && opts.fromMr !== undefined && opts.output === undefined)
  );
}

/**
 * Whether this command stops while this checkout's queue would stay in its
 * `.teamai/`: one that queues learnings there, and a project `teamai init`
 * (not `roles init`), which would set the project up and leave that queue to
 * be deleted with the worktree (#808).
 */
function needsQueueOutOfCheckout(command: Command): boolean {
  const projectInit = command.name() === 'init' && command.parent?.parent === null && command.opts().scope !== 'user';

  return queuesLearnings(command) || projectInit;
}

/** Whether this command migrates first. */
function triggersMigration(command: Command): boolean {
  return MIGRATION_TRIGGER_COMMANDS.has(command.name()) || queuesLearnings(command);
}

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

/** A command that needs a team says so in one line instead of a stack trace, as `env list` does. */
async function reportNotInitialized(run: () => Promise<void>): Promise<void> {
  const { NotInitializedError } = await import('./config.js');

  try {
    await run();
  } catch (e) {
    if (!(e instanceof NotInitializedError)) throw e;
    log.error(e.message);
    process.exitCode = 1;
  }
}

/**
 * Report an error a command action threw as one line on stderr, and make the
 * process exit 1 (#1270). Without this, a rejection from an async action
 * reaches the user as an unhandled one: Node prints the error with its stack
 * and a `cli.js:NNNN` header, which says nothing a person can act on.
 *
 * A command that wraps itself in `reportNotInitialized` is unchanged; this is
 * the boundary that also covers the commands that never did, such as
 * `session list`.
 *
 * The trace is not lost: `log.debug` always appends it to ~/.teamai/debug.log,
 * and prints it on the console only under `--verbose`.
 */
export async function reportCommandError(cause: unknown): Promise<void> {
  const error = cause instanceof Error ? cause : undefined;
  log.error(error?.message || error?.name || String(cause));

  if (error?.stack) log.debug(error.stack);
  process.exitCode = 1;
}

/**
 * Fire a command-lifecycle webhook (`push` / `pull`) best-effort. These are
 * default subscription events with no other production call site into
 * sendWebhook (#702). Never let a webhook failure affect the command's result.
 */
async function notifyWebhook(event: 'push' | 'pull'): Promise<void> {
  try {
    const { sendWebhook } = await import('./webhook.js');
    await sendWebhook(event, { tool: 'teamai-cli', data: {} });
  } catch {
    // Best-effort notification; never surface to the user.
  }
}

// Without a person at a terminal, no git child may stop to ask for a
// credential: a terminal prompt, an askpass dialog or a credential manager
// window all park the run with no output. A missing credential should fail the
// clone at once instead (issue #711). See utils/git-env.ts for each door, and
// for why ssh's own questions are left to the repository's configuration.
applyNonInteractiveGitEnv();

const program = new Command();

program
  .name('teamai')
  .description('TeamAI — Make Every Team AI Native')
  .version(version);

for (const [flags, description] of GLOBAL_OPTIONS) program.option(flags, description);

program
  .hook('preAction', async (thisCommand, actionCommand) => {
    // A command a step starts in its clone reads and writes under that clone's own install, as the install's pull did,
    // so nothing it writes reaches the member's home. First, so every path resolved below is the install's.
    if (process.env[ATTEMPT_ENV] !== undefined) {
      const { attemptCloneHome } = await import('./workflow/place/place.js');
      const home = await attemptCloneHome(process.cwd(), process.env);

      if (home) useInstallHome(home);
    }

    const opts = thisCommand.opts();

    if (opts.verbose) setVerbose(true);

    // A command with no --dry-run preview refuses the flag rather than run for
    // real (#900). First, so neither migration nor a hook command slips past.
    if (opts.dryRun) {
      const refusal = dryRunRefusal(actionCommand);

      if (refusal) thisCommand.error(refusal, { exitCode: 1 });
    }

    // Auto-migrate a legacy `<repo>/.teamai/` into the partition before the
    // command runs, so the trigger commands (and every path resolver they call)
    // see the migrated layout. Narrowed twice: hook-dispatch is a high-frequency
    // silent path that must never move 12MB, and only write commands trigger a
    // move (read-only commands use the double-read fallback). Dry-run previews.
    const name = actionCommand.name();

    if (TEAMAI_HOOK_SUBCOMMANDS.some((subcommand) => subcommand === name)) return;

    if (!triggersMigration(actionCommand)) return;

    try {
      process.cwd();
    } catch {
      thisCommand.error('Current working directory is unavailable. Change to an existing directory and retry.', { exitCode: 1 });
    }

    const { maybeMigrate, queueKeptInCheckout } = await import('./migrate.js');
    let migration;

    try {
      migration = await maybeMigrate({ dryRun: !!opts.dryRun });
    } catch (e) {
      // A failed migration must not proceed into the command on stale/partial
      // state. Surface a clean message and exit — the copy→verify→rename design
      // leaves the source intact, so a rerun retries safely. (Without this the
      // async-hook rejection would surface as a raw unhandled-rejection stack.)
      log.error(`Auto-migration failed: ${e instanceof Error ? e.message : String(e)}`);
      log.error('Your original .teamai data is unchanged. Re-run the command to retry.');
      process.exit(1);
    }

    // A learning queued in this checkout would go with it when the worktree is
    // removed (#808).
    if (needsQueueOutOfCheckout(actionCommand)) {
      // Not for `init`: it sets the project up itself, and a clone-time
      // self-heal here would enable every tool in HOME before `--agent`
      // could choose them (#993).
      const kept = await queueKeptInCheckout(migration, { dryRun: !!opts.dryRun, selfHeal: name !== 'init' });

      if (kept) {
        log.error(kept);
        process.exit(1);
      }
    }
  });

program
  .command('init')
  .description('Initialize teamai (configure Git provider, clone repo, register member)')
  .argument('[repo]', 'Team repo (owner/repo or full URL). Pass "." for self mode (the current git repo is the team repo).')
  .option('--repo <repo>', 'Team repo (alias of the positional argument)')
  .option('--http <url>', 'Git-free HTTP team repo (read-only consumer; only needs an API key)')
  .option('--provider <name>', 'Git provider for the team repo on this machine: tgit, github, cnb, gitlab, gitcode, or git. Skips auto-detection. `git` uses your existing Git auth and needs no platform token, but opens no PR/MR.')
  .option('--self', 'Self mode: the current git repo is the team repo (equivalent to `teamai init .`). Knowledge lives on main under .teamai/; reports go to the teamai-reports orphan branch.')
  .option('--token <key>', 'API key for HTTP team repo / status reporting (stored 0600, never committed). Also reads TEAMAI_API_TOKEN. With --http and a single --agent, an sk- token is kept for that agent only, next to the other agents\' tokens (--force keeps them too); while that agent\'s current token still works it is kept and the new one is not used unless --replace-token is passed. Without --agent on a machine where one agent already holds a token, that agent takes it, or — keeping its working one — the new token serves the tools without a token of their own.')
  .option('--replace-token', 'With --http and --token, use the supplied token without checking the old one. Only an sk- token changes: a shared key already replaced the old one, so the option has nothing to do for it. Other agents keep their tokens; the backend may invalidate this agent\'s old token.')
  .option('--scope <scope>', 'Install scope: workspace (default, <cwd>/.teamai + <cwd>/.claude) or user (~/.teamai + ~/.claude); project is the older name for workspace')
  .option('--inherit-user-scope', 'In workspace scope, also sync safe user-scope resources, load its env variables (not its secrets) in the workspace, and search its knowledge')
  .option('--no-inherit-user-scope', 'Disable user-scope inheritance for this workspace')
  .option('--role <id>', 'Primary role ID (e.g. hai_dev) for non-interactive setup')
  .option('--project <ids>', 'Active logical project(s) from manifest/projects.yaml (comma-separated); scopes which project resources and learnings this directory syncs. Pass "all" to activate every project the manifest declares (a snapshot taken now)')
  // Non-variadic + a collecting coercer: repeatable (`--agent a --agent b`) and
  // comma-separated (`--agent a,b`, split later by normalizeAgentList) both work,
  // WITHOUT the greedy `<name...>` variadic that would swallow the `[repo]`
  // positional (e.g. `init --agent claude .` must keep `.` as the repo arg).
  .option('--agent <name>', 'AI tools to set up (e.g. claude, codex, cursor, codebuddy, workbuddy, dsh). Repeatable or comma-separated. In self mode, selects which tool dirs to create; a custom agent defined only in teamai.yaml\'s toolPaths also gets its root created here (git-backed init only — an HTTP init has no local teamai.yaml to read custom paths from). Omit for an interactive picker. Additive on repeated runs, which ask before they rewrite the config; --force rewrites it without asking.', (val: string, acc: string[]) => acc.concat(val), [])
  .option('--force', 'Rewrite the existing config without confirmation, keeping the settings init does not set')
  .action(async (repoArg, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { init } = await import('./init.js');
    await init({ ...globalOpts, ...cmdOpts, repoPositional: repoArg });
  });

program
  .command('push')
  .description('Push local resources to team repo')
  .option('--all', 'Push all without confirmation')
  .option('--skill <path>', 'Push a specific skill by path (e.g., ~/.claude/skills/hai/my-skill or skills/hai_dev/my-skill)')
  .option('--role <id>', 'Namespace for every new resource type (skills/<id>/, rules/<id>/, docs/<id>/, env/<id>/, etc.). '
    + 'When the team has manifest/roles.yaml or manifest/projects.yaml, a role or project there must declare it for each type it places. '
    + 'Without --role, --project or --shared, the namespaces of your role and active projects decide')
  .option('--project <id>', "Target a project: each new resource goes to that project's namespace for its own type "
    + '— skills, knowledge for rules, agents, learnings, docs, env, hooks, mcp, models, and more (from manifest/projects.yaml)')
  .option('--shared', 'Place new resources at the shared root for all roles; cannot combine with --role or --project')
  .option('--branch <name>', 'Push to this destination branch instead of a generated teamai/push branch')
  .option('--file <local file>', 'Push exactly this local file, byte for byte, to the team path --path names, as a pull request. '
    + 'No other change in the team clone joins it; requires --path')
  .option('--path <team path>', 'Where --file goes in the team repo, such as benchmarks/frontend/tasks/pod-startup.yaml or scorers/review.md. '
    + 'Placed exactly there, never relocated; cannot combine with --skill, --role, --project, --shared, --all or --carried')
  .option('--carried <path@blob>', 'Override the stop for a push that would overwrite or delete a placed agent file a teammate changed. '
    + 'Use it only after carrying that change into your root copy, with the value the stop printed; '
    + 'a later team edit stops the push again. Repeatable', (val: string, acc: string[]) => acc.concat(val), [])
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    // --file and --path name one file and its destination: no scan, no placement.
    const { isFilePush, pushFile } = await import('./push-file.js');
    const { push } = await import('./push.js');
    // Only notify when a real push actually happened — not on dry-run, cancel,
    // no-change, or a handled failure (#702 follow-up).
    const outcome = { completed: false };
    const options = { ...globalOpts, ...cmdOpts };
    await reportNotInitialized(() => (isFilePush(options) ? pushFile(options, outcome) : push(options, outcome)));

    if (outcome.completed) await notifyWebhook('push');
  });

program
  .command('pull')
  .description('Pull team resources and inject into local AI tools. Team docs land in sharing.docs.localDir: .teamai/docs/ in a workspace by default, a hidden directory, so search that path directly')
  .option('--silent', 'Silent mode (for hooks)')
  .option('--force', 'Force full sync even if repo is unchanged')
  .option('--team-ref <ref>', 'Pin this workspace to a branch, tag or commit of the team repo; the default branch unpins it')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();

    if (cmdOpts.silent) setSilent(true);
    const { pull } = await import('./pull.js');
    // Only notify when a real (non-dry-run) sync completed. The SessionStart hook
    // drives its own `session-start` webhook, so the silent hook pull never fires
    // the `pull` command event (#702 follow-up).
    const outcome = { completed: false };
    await pull({ ...globalOpts, ...cmdOpts, interactive: !cmdOpts.silent }, outcome);

    if (!cmdOpts.silent && outcome.completed) await notifyWebhook('pull');
  });

program
  .command('status')
  .description('Show local vs team repo diff')
  .option('--all', 'List every project data partition under ~/.teamai/projects (flags stale/orphan ones)')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { status } = await import('./status.js');
    await reportNotInitialized(() => status({ ...globalOpts, ...cmdOpts }));
  });

program
  .command('list [type]')
  .description('List resources (skills|rules|docs|env|agents|hooks|mcp|workflows). For skills, --source local/all also scans installed AI agent skill directories. Workflows show their source: team, teamai\'s default, or not runnable. A team folder over a teamai default shows how many of its files are its own and how many it inherits.')
  .option('--source <src>', 'Where to look for skills: repo | local | all', 'all')
  .option('--agent <name>', 'Filter local agents by id (only applies to skills)')
  .option('--reveal', 'Show env values in plaintext (default: masked)')
  .option('--json', 'Print the team repo\'s resources as JSON, env left out. Each file of a team folder over a teamai default has the layer it comes from: team or teamai')
  .action(async (type, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { list } = await import('./status.js');
    await reportNotInitialized(() => list(type, { ...globalOpts, ...cmdOpts }));
  });

const skillCmd = program
  .command('skill')
  .description('List and inspect skills (default: repo + installed agents, then the CLI-served catalog)')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { skillList } = await import('./skill-cmd.js');
    await skillList(globalOpts);
  });

skillCmd
  .command('list')
  .description('List team and installed skills, then the built-in catalog the CLI serves')
  .option('--json', 'Output the CLI-served built-in skill catalog as JSON')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { skillList } = await import('./skill-cmd.js');
    await skillList({ ...globalOpts, ...cmdOpts });
  });

skillCmd
  // Optional so that `--all` needs no name; the action fails when both are missing.
  .command('get [names...]')
  .description('Print built-in skill content served by the installed CLI')
  .option('--full', 'Append the skill\'s references/ and templates/ files')
  .option('--all', 'Print every skill the CLI serves')
  // A hallucinated flag should cost a warning, not a failed command: unknown
  // options fall through to the action, which reports and ignores them.
  .allowUnknownOption()
  .action(async (names: string[] | undefined, cmdOpts) => {
    const { skillGet } = await import('./skill-content.js');
    await skillGet(names ?? [], { full: cmdOpts.full, all: cmdOpts.all });
  });

skillCmd
  .command('path <name>')
  .description('Print the packaged directory of a built-in skill (for scripts and templates)')
  .action(async (name: string) => {
    const { skillPath } = await import('./skill-content.js');
    await skillPath(name);
  });

skillCmd
  .command('show <name>')
  .description('Show skill metadata: source / contributors / installed agents / description')
  .action(async (name: string, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { skillShow } = await import('./skill-cmd.js');
    await skillShow(name, { ...globalOpts, ...cmdOpts });
  });

const excludeCmd = skillCmd
  .command('exclude')
  .description('Manage per-user skill and MCP server exclusion (skip sync without affecting team repo)')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { excludeList } = await import('./exclude.js');
    await excludeList(globalOpts);
  });

excludeCmd
  .command('list')
  .description('List excluded skills and MCP servers')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { excludeList } = await import('./exclude.js');
    await excludeList(globalOpts);
  });

excludeCmd
  .command('add <skills...>')
  .description('Add skill(s) or MCP server(s) to the exclude list')
  .action(async (skills: string[]) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { excludeAdd } = await import('./exclude.js');
    await excludeAdd(skills, globalOpts);
  });

excludeCmd
  .command('remove <skills...>')
  .description('Remove skill(s) or MCP server(s) from the exclude list')
  .action(async (skills: string[]) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { excludeRemove } = await import('./exclude.js');
    await excludeRemove(skills, globalOpts);
  });

const membersCmd = program
  .command('members')
  .description('Manage team members')
  .action(async () => {
    // Default action: list members (backward compatible)
    const globalOpts = program.opts<GlobalOptions>();
    const { listMembers } = await import('./members.js');
    await listMembers(globalOpts);
  });

membersCmd
  .command('list')
  .description('List team members')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { listMembers } = await import('./members.js');
    await listMembers(globalOpts);
  });

program
  .command('remove <type> <names...>')
  .description('Remove resource(s) from team repo and all local AI tools (type: skills|rules|agents|mcp)')
  .option('--force', 'Skip confirmation prompt')
  .option('--role <ns>', 'mcp: remove the server from namespace <ns> (mcp/<ns>/mcp.yaml or the folder mcp/<ns>/<name>/) instead of the root')
  .option('--project <id>', "mcp: remove the server from the project's mcp namespace instead of the root mcp/mcp.yaml")
  .action(async (type, names, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { remove } = await import('./remove.js');
    await remove(type, names, { ...globalOpts, ...cmdOpts });
  });

registerPackagesCommand(program);

program
  .command('doctor')
  .description('Diagnose configuration issues, and print the run mode (attended or unattended) and what set it: TEAMAI_MODE, CI, or the default')
  .option('--json', 'Output the report as JSON (suitable for CI)')
  .option('--fix', 'Remove lock files left behind by dead processes, delete again the run branches a succeeded workflow run could not delete, remove what runs settled longer ago than workflows.retention left behind (branches but those a pull request uses, worktrees, kept refs, base pins on origin), remove the stored workflow folders no run and no pulled workflow uses, and remove the team hook entries a removed worktree of the repository left in HOME')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { doctor } = await import('./doctor.js');
    const allPassed = await doctor({ ...globalOpts, ...cmdOpts });

    if (!allPassed) process.exitCode = 1;
  });

// ─── Roles subcommand ─────────────────────────────────────

const rolesCmd = program
  .command('roles')
  .description('Manage team roles and resource namespaces')
  .action(async () => {
    // Default action: list roles
    const { rolesList } = await import('./roles-cmd.js');
    await rolesList();
  });

rolesCmd
  .command('init')
  .description('Create a roles manifest for the team repo (admin)')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { rolesInit } = await import('./roles-cmd.js');
    await rolesInit(globalOpts);
  });

rolesCmd
  .command('list')
  .description('List all defined roles and your current role')
  .option('--json', 'Print your effective roles and where they come from (assigned, default, local, none)')
  .action(async (cmdOpts) => {
    const { rolesList } = await import('./roles-cmd.js');
    await rolesList(cmdOpts);
  });

rolesCmd
  .command('set <primary>')
  .description('Set your primary role (updates local config; refused when manifest/members.yaml assigns roles)')
  .option('--add <roles...>', 'Additional roles to include')
  .action(async (primary: string, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { rolesSet } = await import('./roles-cmd.js');
    await rolesSet(primary, { ...globalOpts, ...cmdOpts });
  });

rolesCmd
  .command('add <id>')
  .description('Add a new role to the manifest (admin)')
  .requiredOption('--namespaces <ns>', 'Comma-separated resource namespaces (e.g. common,hai)')
  .option('-d, --description <desc>', 'Description for the role')
  .action(async (id: string, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { rolesAdd } = await import('./roles-cmd.js');
    await rolesAdd(id, { ...globalOpts, ...cmdOpts });
  });

rolesCmd
  .command('remove <id>')
  .description('Remove a role from the manifest (admin)')
  .action(async (id: string) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { rolesRemove } = await import('./roles-cmd.js');
    await rolesRemove(id, globalOpts);
  });

rolesCmd
  .command('update <id>')
  .description('Update a role in the manifest (admin)')
  .option('--add-namespaces <ns>', 'Comma-separated namespaces to add')
  .option('--remove-namespaces <ns>', 'Comma-separated namespaces to remove')
  .option('-d, --description <desc>', 'New description for the role')
  .action(async (id: string, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { rolesUpdate } = await import('./roles-cmd.js');
    await rolesUpdate(id, { ...globalOpts, ...cmdOpts });
  });

// ─── Projects subcommand ──────────────────────────────────

const projectsCmd = program
  .command('projects')
  .description('Manage multi-project resource distribution (orthogonal to roles)')
  .action(async () => {
    // Default action: list projects
    const globalOpts = program.opts<GlobalOptions>();
    const { projectsList } = await import('./projects-cmd.js');
    await projectsList(globalOpts);
  });

projectsCmd
  .command('list')
  .description('List defined projects and the ones active in this directory')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { projectsList } = await import('./projects-cmd.js');
    await projectsList(globalOpts);
  });

projectsCmd
  .command('set [ids...]')
  .description('Set the projects active in this directory (comma-separated or repeated; empty to clear)')
  .action(async (ids: string[] = [], _cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { projectsSet } = await import('./projects-cmd.js');
    await projectsSet(ids, globalOpts);
  });

projectsCmd
  .command('add <id>')
  .description('Add a project to manifest/projects.yaml, creating the file if needed (admin)')
  .requiredOption('--namespaces <ns>', 'Comma-separated namespaces for knowledge, skills, learnings and agents (e.g. common,checkout); env, hooks, mcp, models, docs and wiki are declared by hand')
  .option('--name <name>', 'Display name for the project')
  .option('-d, --description <desc>', 'Description for the project')
  .action(async (id: string, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { projectsAdd } = await import('./projects-cmd.js');
    await projectsAdd(id, { ...globalOpts, ...cmdOpts });
  });

projectsCmd
  .command('update <id>')
  .description('Update a project in manifest/projects.yaml (admin)')
  .option('--add-namespaces <ns>', 'Comma-separated namespaces to add to knowledge, skills, learnings and agents')
  .option('--remove-namespaces <ns>', 'Comma-separated namespaces to remove from knowledge, skills, learnings and agents')
  .option('--name <name>', 'New display name for the project')
  .option('-d, --description <desc>', 'New description for the project')
  .action(async (id: string, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { projectsUpdate } = await import('./projects-cmd.js');
    await projectsUpdate(id, { ...globalOpts, ...cmdOpts });
  });

projectsCmd
  .command('remove <id>')
  .description('Remove a project from manifest/projects.yaml (admin)')
  .action(async (id: string) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { projectsRemove } = await import('./projects-cmd.js');
    await projectsRemove(id, globalOpts);
  });

projectsCmd
  .command('members <id>')
  .description('List members registered for a project')
  .action(async (id: string) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { projectsMembers } = await import('./projects-cmd.js');
    await projectsMembers(id, globalOpts);
  });

// ─── Tags subcommand ──────────────────────────────────────

const tagsCmd = program
  .command('tags')
  .description('Manage tag-based skill/rule filtering')
  .action(async () => {
    // Default action: list tags
    const { tagsList } = await import('./tags.js');
    await tagsList();
  });

tagsCmd
  .command('list')
  .description('List all available tags and subscription status')
  .action(async () => {
    const { tagsList } = await import('./tags.js');
    await tagsList();
  });

tagsCmd
  .command('subscribe <tags...>')
  .description('Subscribe to tags (only matching skills/rules will be synced)')
  .action(async (tags: string[]) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { tagsSubscribe } = await import('./tags.js');
    await tagsSubscribe(tags, globalOpts);
  });

tagsCmd
  .command('unsubscribe <tags...>')
  .description('Unsubscribe from tags')
  .action(async (tags: string[]) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { tagsUnsubscribe } = await import('./tags.js');
    await tagsUnsubscribe(tags, globalOpts);
  });

tagsCmd
  .command('add <type> <name> <tags...>')
  .description(
    'Add tags to a skill or rule in tags.yaml (admin)\n\n' +
      '  <type>  Resource type: "skills" or "rules"\n' +
      '  <name>  Name of the skill or rule (directory name)\n' +
      '  <tags>  One or more tags to add\n\n' +
      '  Examples:\n' +
      '    $ teamai tags add skills hai-deploy hai infra\n' +
      '    $ teamai tags add rules common-coding-style coding best-practices\n',
  )
  .action(async (type: string, name: string, tags: string[]) => {
    const globalOpts = program.opts<GlobalOptions>();

    if (type !== 'skills' && type !== 'rules') {
      console.error('Type must be "skills" or "rules"');
      process.exit(1);
    }

    const { tagsAdd } = await import('./tags.js');
    await tagsAdd(type, name, tags, globalOpts);
  });

tagsCmd
  .command('remove <type> <name> <tags...>')
  .description(
    'Remove tags from a skill or rule in tags.yaml (admin)\n\n' +
      '  <type>  Resource type: "skills" or "rules"\n' +
      '  <name>  Name of the skill or rule (directory name)\n' +
      '  <tags>  One or more tags to remove\n\n' +
      '  Examples:\n' +
      '    $ teamai tags remove skills hai-deploy infra\n' +
      '    $ teamai tags remove rules common-coding-style best-practices\n',
  )
  .action(async (type: string, name: string, tags: string[]) => {
    const globalOpts = program.opts<GlobalOptions>();

    if (type !== 'skills' && type !== 'rules') {
      console.error('Type must be "skills" or "rules"');
      process.exit(1);
    }

    const { tagsRemove } = await import('./tags.js');
    await tagsRemove(type, name, tags, globalOpts);
  });

// ─── Source subcommands (cross-team subscription) ────────

const sourceCmd = program
  .command('source')
  .description('Manage cross-team skill sources')
  .action(async () => {
    const { sourceList } = await import('./source.js');
    await sourceList();
  });

sourceCmd
  .command('add <repo>')
  .description('Add a cross-team source repo')
  .option('--name <name>', 'Alias for this source')
  .action(async (repo: string, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { sourceAdd } = await import('./source.js');
    await sourceAdd(repo, { ...globalOpts, ...cmdOpts });
  });

sourceCmd
  .command('remove <name>')
  .description('Remove a source and clean up its skills')
  .action(async (name: string) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { sourceRemove } = await import('./source.js');
    await sourceRemove(name, globalOpts);
  });

sourceCmd
  .command('add-http <endpoint>')
  .description('Add an HTTP source (report/sync/ack) alongside a git main repo')
  .option('--token <key>', 'API token for the HTTP endpoint (stored 0600, never committed)')
  .option('--replace-token', 'Use --token without checking the old token. Only an sk- token changes: a shared key already replaced the old one. Other agents keep their tokens; the backend may invalidate this agent\'s old token.')
  .option('--agent <name>', 'The AI tool this token is for (e.g. codebuddy, claude); hooks are injected into that tool only. Each agent keeps its own sk- token; a working token is kept unless --replace-token is passed.')
  .option('--force', 'Overwrite an existing HTTP source config')
  .action(async (endpoint: string, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { sourceAddHttp } = await import('./source.js');
    await sourceAddHttp(endpoint, { ...globalOpts, ...cmdOpts });
  });

sourceCmd
  .command('remove-http')
  .description('Remove the HTTP source and clean up its resources')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { sourceRemoveHttp } = await import('./source.js');
    await sourceRemoveHttp(globalOpts);
  });

sourceCmd
  .command('reconcile-plugins', { hidden: true })
  .description('Run plugin reconcile worker (called internally by session_start hook)')
  .action(async () => {
    const { runPluginReconcileWorker } = await import('./local-agent.js');
    await runPluginReconcileWorker();
  });

sourceCmd
  .command('list')
  .description('List all configured sources')
  .action(async () => {
    const { sourceList } = await import('./source.js');
    await sourceList();
  });

sourceCmd
  .command('browse <name>')
  .description('Browse public skills from a source')
  .action(async (name: string) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { sourceBrowse } = await import('./source.js');
    await sourceBrowse(name, globalOpts);
  });

// ─── Other subcommands ────────────────────────────────────

program
  .command('update')
  .description('Check for updates and upgrade teamai CLI')
  .option('--check', 'Only check if an update is available, do not install')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { update } = await import('./update.js');
    await update({ ...globalOpts, ...cmdOpts });
  });

program
  .command('uninstall')
  .description('Remove all teamai-managed resources and hooks from this machine')
  .option('--force', 'Skip confirmation prompt')
  .option('--agent <name>', 'Only uninstall this agent\'s resources in this checkout; shared resources, and the project\'s other checkouts, go only if it is the last tool')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { uninstall } = await import('./uninstall.js');
    await uninstall({ ...globalOpts, ...cmdOpts });
  });

const scriptCmd = program
  .command('script')
  .description('Run a Node script the team declared in teamai.yaml');

scriptCmd
  .command('run <event>')
  .description('Run preInit, postInit, prePull, postPull, or postDeploy for this checkout. preInit and postInit need a terminal. postInit then syncs MCP servers.')
  .action(async (event: string) => {
    const { scriptRun } = await import('./script-commands.js');
    await scriptRun(event);
  });

const envCmd = program
  .command('env')
  .description('Manage team environment variables')
  .option('--reveal', 'Show env variable values in plaintext (default: masked)')
  .action(async (cmdOpts) => {
    // Default action: list env vars (backward compatible)
    const globalOpts = program.opts<GlobalOptions>();
    const { envList } = await import('./env-commands.js');
    await envList({ ...globalOpts, ...cmdOpts });
  });

envCmd
  .command('list')
  .description('List team environment variables')
  .option('--reveal', 'Show env variable values in plaintext (default: masked)')
  .action(async (_cmdOpts, command: Command) => {
    const { envList } = await import('./env-commands.js');
    await envList(command.optsWithGlobals<GlobalOptions & { reveal?: boolean }>());
  });

envCmd
  .command('add <key> [value]')
  .description('Add or update a team environment variable, or declare a secret with --secret')
  .option('-d, --description <desc>', 'Description for the variable or secret')
  .option('--secret', 'Declare a secret in env/secrets.yaml: no value, each member sets their own')
  .option('--url <url>', 'Where a member gets a value for the secret (with --secret)')
  .option('--role <ns>', 'Write to env/<ns>/ instead of env/ (env.yaml, or secrets.yaml with --secret)')
  .option('--project <id>', "Write to the project's env namespace (resources.env in manifest/projects.yaml)")
  .action(async (key, value, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { envAdd } = await import('./env-commands.js');
    await envAdd(key, value, { ...globalOpts, ...cmdOpts });
  });

envCmd
  .command('remove <key>')
  .description('Remove a team environment variable or declared secret')
  .option('--secret', 'Remove the declared secret only (env/secrets.yaml), for a key env.yaml also sets')
  .option('--role <ns>', 'Remove from env/<ns>/ instead of env/')
  .option('--project <id>', "Remove from the project's env namespace (resources.env in manifest/projects.yaml)")
  .action(async (key, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { envRemove } = await import('./env-commands.js');
    await envRemove(key, { ...globalOpts, ...cmdOpts });
  });

envCmd
  .command('set <key>')
  .description("Set your value for a secret the team declares, or an env variable it sets, for this directory's team, on this machine (prompts without echo)")
  .option('--stdin', 'Read the value from piped stdin')
  .option('--from-env <var>', 'Read the value from this environment variable each time it is used; no copy is stored')
  .option('--global', 'Set a secret for every team on this machine; a value set for a team still wins')
  .action(async (key, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { envSet } = await import('./env-commands.js');
    await envSet(key, { ...globalOpts, ...cmdOpts });
  });

envCmd
  .command('unset <key>')
  .description("Remove your value for a secret or env variable, for this directory's team, from this machine")
  .option('--global', 'Remove the value set for every team on this machine instead')
  .action(async (key, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { envUnset } = await import('./env-commands.js');
    await envUnset(key, { ...globalOpts, ...cmdOpts });
  });

envCmd
  .command('exec <command...>')
  .description("Run a command with this directory's team env variables and secrets (put -- before the command)")
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { envExec, exitLike } = await import('./env-exec.js');
    // What was typed after `exec`, `--` included: Commander drops it.
    const argv = process.argv.slice(2);
    exitLike(await envExec(argv.slice(argv.indexOf('exec', argv.indexOf('env')) + 1), globalOpts));
  });

const workflowCmd = program
  .command('workflow')
  .description('Run a validated workflow from workflows/<name>.yaml or the folder workflows/<name>/WORKFLOW.yaml. Writable steps may set deliver: pr to open review requests; TeamAI never merges them.');

workflowCmd
  .command('start <name>')
  .description('Create a run. With --driver skill, the current coding session drives it; with --driver local, this process runs it headless, and in unattended mode (TEAMAI_MODE=unattended or CI) runs teamai score --drain once the run settles, before it exits, unless sessions.publish and session scoring are both off for unattended.')
  .option('--describe', 'Show workflow metadata and required input schemas without creating a run. With --driver skill, also say how to start it: the start command, a question for the person, or the local driver.')
  .option('--driver <kind>', 'Select skill for the current coding session, which then runs the commands each reply prints, or local for headless execution in this process.')
  .option('--parallel <n>', 'With --driver skill: the most steps that run at once, as the describe reply offered')
  .option('--confirmed', 'The person agreed to start this run, as the describe reply asked. From an agent session, an invoke: ask workflow starts only with it, with any driver; teamai takes the agent\'s word for it. In an unattended run (TEAMAI_MODE=unattended or CI) an agent cannot start an invoke: ask workflow, with or without it')
  .option('--hitl <mode>', 'With --driver skill: who answers optional approvals and choices, as the describe reply offered: person (the agent asks the person; refused in an unattended run) or recommend (the agent answers). A required approval always goes to the person')
  .option('--no-judge', 'With --driver skill: leave the scored steps unjudged on this machine, as the describe reply offered')
  .option('--tools <list>', 'Override local prompt tools for this run, as comma-separated name=tool pairs, such as default=claude,review=codex. With --driver local the run remembers them on this install, and resume uses them. With --driver skill: only default=<tool>, the tool this coding session works in, which judges its scored steps and which its steps\' models resolve for when teamai installs agents for it. Pass it when the describe reply says the session names no tool')
  .option('--auto-approve', 'Answer optional approve HITL requests yes and choose requests with their default, for this run: with --driver local the run remembers it on this install, and resume uses it. A required approval still goes to the person')
  .option('--inputs <json>', 'Values for the inputs the workflow declares, as a JSON object, for example {"issue":42}. Every declared input is required, except one the workflow\'s defaults.inputs gives a value.')
  .option('--timeout <duration>', 'The longest the run may take, such as 30m or 2h: its steps stop and it fails with timeout once the shorter of this and the workflow\'s own timeout passes. Its finally steps still run after.')
  .option('--sandbox', 'With --driver local, declare this machine a sandbox for this run: a disposable host such as a CI runner or container, where benchmark trials and steps that need sandbox isolation may run. The run remembers it on this install, and resume uses it; a claim on another machine does not. workflows.sandbox in config declares it for every process.')
  .action(async (name: string, cmdOpts: { driver?: string; tools?: string; inputs?: string; autoApprove?: boolean; describe?: boolean; parallel?: string; confirmed?: boolean; hitl?: string; judge?: boolean; sandbox?: boolean; timeout?: string }) => {
    const { workflowStart } = await import('./workflow-commands.js');
    await workflowStart(name, cmdOpts);
  });

workflowCmd
  .command('next <run>')
  .description('Get a lease, hitl, wait, or done JSON envelope. Show hitl.message and hitl.respond to a person, who replaces <option> with a choice.')
  .option('--prepare', 'Prepare the leased workspace in its original checkout; report commits and pushes it automatically. A step in a clone workspace, such as a benchmark trial, is leased only with --prepare: teamai makes the clone on this machine, installs its team resources and runs setup, and answers the lease with cwd, where the driver runs the step. So is a step that runs with a team role (role on its lease): teamai delivers the role into its copy. A step that requires strict sandbox isolation goes only to a driver that declares driver.can.isolation sandbox and driver.can.env true.')
  .option('--attempt <attempt>', 'With --prepare: prepare this attempt, which an earlier next leased this driver, instead of taking a new lease. wrong_attempt when the run no longer leases it to the driver. With --driver skill: the attempt of a place action, with --adopt')
  .option('--adopt <dir>', 'With --prepare --attempt: prepare the attempt in <dir>, a place the host made: a clean worktree of this repository on the lease\'s workspace branch, or detached at its start. A place that does not fit answers adopt_mismatch and leaves the attempt leased. TeamAI never removes an adopted place. With --driver skill --attempt: adopt <dir> as the place action of that attempt asked, as its adopt prints it')
  .option('--json <payload>', 'Driver identity, for example {"driver":{"kind":"local","machine":"host","workspace":"/work"}}. Optional: running, the attempt ids of its open leases the driver still runs (an open lease left out is handed back), queued, those of them it has not started, whose own timeout then counts from this call (the answer gives their deadlines in deadlines), canTakeLease, false to poll while a tool runs without taking a new lease, and driver.can, what the driver can do on this request: hitl (a person can answer HITL requests and work interactively), workspace, env (true, or "commands" when the driver scopes team env for command steps and setup only), setup, tokens, max_turns, network, isolation, tools (the tools it launches a prompt step that names its tool on), end_turn (it ends a prompt\'s turn at the lease limits), role (it runs a step whose lease has role, the team role its copy runs with, on what teamai delivered there, with --prepare). An omitted key is not offered, so a step that needs it waits, and wait.held names what it lacks. Send driver.can on every next request, including busy polls. claim, true to take a run another install published from teamai-reports before leasing; a run this install owns stays as it is. Every answer lists in cancelled the running attempts whose tools the driver must stop.')
  .option('--driver <kind>', 'skill: advance a run the current coding session drives, and print its turn: the actions to carry out and the command to run next')
  .option('--wait', 'With --driver skill: wait until the run has something to show, up to 100 s. Run it in the background.')
  .option('--takeover', 'With --driver skill: drive the run from this coding session instead of the one that drives it. Run it only when the person agrees, after an orchestrator_active answer')
  .option('--confirmed', 'With --driver skill --takeover: the person agreed to take this run over, as the confirm_needed answer asked. From an agent session, a run of an invoke: ask workflow is taken over only with it; teamai takes the agent\'s word for it. In an unattended run (TEAMAI_MODE=unattended or CI) an agent cannot take over a run of an invoke: ask workflow, with or without it')
  .option('--choice <id>', 'With --driver skill: answer the host question with the id of one of its options, as its run prints it')
  .option('--ack <offer>', 'With --driver skill: acknowledge that the child of a dispatch started, as its ack prints it, so later turns stop offering it')
  .action(async (run: string, cmdOpts: { json?: string; prepare?: boolean; attempt?: string; adopt?: string; driver?: string; wait?: boolean; takeover?: boolean; confirmed?: boolean; choice?: string; ack?: string }) => {
    const { workflowNext } = await import('./workflow-commands.js');
    await workflowNext(run, cmdOpts);
  });

workflowCmd
  .command('report <run>')
  .description('Report the outcome of a leased step. Prints a JSON envelope.')
  .option('--json <payload>', 'attempt, revision, outcome (success, failed, or released), and driver. A prompt step\'s report also sends tool, the tool the driver launched, and durationMs (milliseconds around the tool launch) and cost ({"amount":0.12,"unit":"USD"}, only as the tool stated it) when known, and limit (timeout, budget or max_turns) when a limit in its lease\'s limits stopped the tool. queued, as on next: the attempts of its other open leases it has not started, whose own timeout then counts from this report.')
  .option('--driver <kind>', 'skill: report an attempt of a run the current coding session drives, as its turn printed the command')
  .option('--attempt <id>', 'With --driver skill: the attempt to report')
  .option('--model-unavailable', 'With --driver skill and --attempt: the host cannot run the model the dispatch names, so the step fails model_unavailable')
  .action(async (run: string, cmdOpts: { json?: string; driver?: string; attempt?: string; modelUnavailable?: boolean }) => {
    const { workflowReport } = await import('./workflow-commands.js');
    await workflowReport(run, cmdOpts);
  });

workflowCmd
  .command('respond <run> <step> <choice>')
  .description('Answer a waiting approve (yes/no) or choose HITL request. A required HITL request accepts only the person\'s answer: from their own terminal, or declared by a driver UI, sent from outside an agent session. Prints one JSON envelope.')
  .option('--json <payload>', 'Driver identity {"driver":{"kind":"ide","machine":"host","workspace":"/work"}} declares an answer a person gave in the driver UI, never one its agent chose. Records channel driver; sent from inside an agent session it records agent true, which a required HITL request refuses. queued, as on next: the attempts of its open leases it has not started, whose own timeout then counts from this answer.')
  .option('--driver <kind>', 'skill: answer an optional gate of a run the current coding session drives, as its choose action prints it, and print the turn. Records the agent\'s answer, which a required HITL request refuses')
  .option('--note <text>', 'Keep a note with the answer, readable as steps.<id>.note')
  .option('--pass <n>', 'Answer only this positive pass number; rejects an answered or replaced HITL request')
  .action(async (run: string, step: string, choice: string, options: { note?: string; pass?: string; json?: string; driver?: string }) => {
    const { workflowRespond } = await import('./workflow-commands.js');
    await workflowRespond(run, step, choice, options);
  });

workflowCmd
  .command('retry <run> <step>')
  .description('Retry a leased or stopped step, or a HITL request to answer it again, with a new pass and revision. A failed pull request delivery is retried in the same pass, without running the step again. Reopen its dependent steps and a settled run; keep earlier passes. After reopening, run resume or let your driver poll next. An isolated run, such as a benchmark run, cannot be retried; start a new one. Prints one JSON envelope.')
  .action(async (run: string, step: string) => {
    const { workflowRetry } = await import('./workflow-commands.js');
    await workflowRetry(run, step);
  });

workflowCmd
  .command('resume [run]')
  .description("Continue a run with the local driver after retry, respond, or a stopped driver (Ctrl-C or closed terminal), with the --tools, --auto-approve and --sandbox this install last drove it with, unless a flag overrides one. Uses this machine's open local lease workspace, then the latest local driver's workspace on this machine, then cwd. Another live local driver returns driver_running. A settled run returns done. A run this machine does not have is taken from teamai-reports, where workflow publish put it; a published run continues only while this install owns it, else not_owner names the owner. With --driver skill, the current coding session continues the run instead, as after a skill start, and the reply is its first turn. In unattended mode, the local driver runs teamai score --drain once the run settles, as start does. Without a run id, fetches teamai-reports as pull does and lists the runs this checkout can resume: the runs teamai-reports offers for its business repository (origin), each with what holds it back, and this machine's running runs, each with the command to resume it.")
  .option('--next', 'Instead of a run id: take the oldest run teamai-reports offers for this checkout\'s business repository (origin) that nothing refuses this caller, claim it, and drive it as resume <run> does; a workflow publish offers a running run until someone claims it. When nobody here would answer (an unattended run, TEAMAI_MODE=unattended or CI, or the local driver with no terminal) it skips a run whose ready steps need a person now: a required approval, an interactive step, or a choice with no default (or any choice, without --auto-approve). A run whose person step is only possible later is taken; when it reaches one, the runner offers it back for a person and exits, and resume lists it as may need a person at <step>. It skips a run whose steps left require env with no value here and, with the local driver, one whose prompt steps left have no tool to run on here: none configured, or not on PATH, or that need a sandbox this machine does not declare (--sandbox or workflows.sandbox); resume without --next lists each as cannot run here, with what gives it, and --next says on stderr why it left each run. With --driver skill it also skips a run that needs the local driver. Prints {"data":{"idle":{"offered":N}}} when it takes none, N being the offered runs it left')
  .option('--driver <kind>', 'local, the default, to drive the run in this process, or skill for the current coding session, which then runs the commands each reply prints. An agent runs it only when the person agrees')
  .option('--parallel <n>', 'With --driver skill: the most steps that run at once; 1 when left out')
  .option('--hitl <mode>', 'With --driver skill: who answers optional approvals and choices: person (the agent asks the person; the default, refused in an unattended run) or recommend (the agent answers). A required approval always goes to the person')
  .option('--no-judge', 'With --driver skill: leave the scored steps unjudged on this machine')
  .option('--tools <list>', 'With --driver local: override, a name at a time, the prompt tools this install last drove the run with, as comma-separated name=tool pairs, such as default=codex. The run remembers the result. With --driver skill: only default=<tool>, the tool this coding session works in, which judges its scored steps and which its steps\' models resolve for when teamai installs agents for it. Pass it when the describe reply says the session names no tool')
  .option('--auto-approve', 'Answer optional approve HITL requests yes and choose requests with their default: with --driver local the run remembers it on this install, with --driver skill for this run. A required approval still goes to the person')
  .option('--no-auto-approve', 'With --driver local: stop answering optional HITL requests by auto-approve, though the run was started or last resumed with --auto-approve. The run remembers it')
  .option('--claim', 'Take the published run over from the install that owns it, replacing this machine\'s copy and releasing its leases')
  .option('--confirmed', 'The person agreed to continue this run, as the confirm_needed answer asked. From an agent session, a run of an invoke: ask workflow continues only with it, with any driver; teamai takes the agent\'s word for it. In an unattended run (TEAMAI_MODE=unattended or CI) an agent cannot continue a run of an invoke: ask workflow, with or without it')
  .option('--sandbox', 'Declare this machine a sandbox for this run: a disposable host such as a CI runner or container, where benchmark trials and steps that need sandbox isolation may run. A run started or resumed with it on this install keeps it; a run claimed from another machine needs it again. workflows.sandbox in config declares it for every process.')
  .action(async (run: string | undefined, options: { driver?: string; parallel?: string; hitl?: string; judge?: boolean; tools?: string; autoApprove?: boolean; claim?: boolean; confirmed?: boolean; next?: boolean; sandbox?: boolean }) => {
    const { workflowResume } = await import('./workflow-commands.js');
    await workflowResume(run, options);
  });

workflowCmd
  .command('publish <run>')
  .description("Publish a run's state to teamai-reports so another member or a runner can continue it with workflow resume. A running run published from a checkout of its business repository (origin) is also offered: the first workflow resume --next in a checkout of that repository claims it, and any claim, or the owner's own workflow resume, takes the offer away, so two runners never take one run. Publish once you stop driving the run. The first publish makes this install the run's owner; publishing an unchanged run writes nothing. Refuses an isolated run, such as a benchmark run, a run of a private workflow, a run with a private step still open (private_open), a run with records not yet on teamai-reports, or one with a value that looks like a secret. Prints one JSON envelope with offered, and listing the leases still in flight.")
  .option('--sessions', "Also put the agent sessions that the run's unsettled steps continue (session: continue or session.from) in the team session archive, scrubbed, so whoever continues the run resumes them; listed in the envelope as sessions. Without it, those steps start new sessions on another machine")
  .action(async (run: string, options: { sessions?: boolean }) => {
    const { workflowPublish } = await import('./workflow-commands.js');
    await workflowPublish(run, options);
  });

workflowCmd
  .command('cancel <run> [step]')
  .description('Cancel a whole run, or a pending, waiting, leased, running, or delivering step and its open descendants. Invalidates leases; drivers stop tools listed in next.cancelled. Prints one JSON envelope.')
  .action(async (run: string, step?: string) => {
    const { workflowCancel } = await import('./workflow-commands.js');
    await workflowCancel(run, step);
  });

const selfImprovementCmd = program
  .command('self-improvement')
  .description('Improve the team\'s harness from a scorer\'s repeated failures: change the resources teamai delivers so that work like the failing one passes, with one regression task per failure, proposed as one pull request on the team repo that the next run updates. run starts the workflow teamai-self-improvement, teamai\'s default or the team\'s file of that name.');

selfImprovementCmd
  .command('run <scorer>')
  .description('Start the workflow teamai-self-improvement with --inputs {"scorer":"<scorer>","suite":"<--suite>"} and drive it. A team\'s workflows/teamai-self-improvement.yaml replaces teamai\'s default, and must take inputs scorer and suite. The default reads digest --json --scorer and improves only when it says ready: two failures or more of the scorer in the last 30 days that a task can start from, or one more for a proposal already on origin. Its prompt step needs a sandbox, and runs in a fresh clone of the team repo on teamai/self-improvement/<scorer>, whose pull request it opens or updates. Prints the run\'s done envelope.')
  .option('--suite <dir>', 'The suite the regression tasks go in, which the team repo\'s default branch must have', 'benchmarks/regressions')
  .option('--driver <kind>', 'The driver that runs it: local, or skill, which only a team workflow with invoke: allow or ask accepts; teamai\'s default denies agents. Without it, workflows.driver decides, else local')
  .option('--tools <list>', 'The tools its prompt steps run on, as workflow start --tools takes them, such as default=claude')
  .option('--sandbox', 'With --driver local, declare this machine a sandbox for this run, where the prompt step, which edits files without asking, may run. The run remembers it on this install, so workflow resume keeps it. workflows.sandbox in config declares it for every process.')
  .action(async (scorer: string, cmdOpts: { suite: string; driver?: string; tools?: string; sandbox?: boolean }) => {
    const { selfImprovementRun } = await import('./workflow-commands.js');
    await selfImprovementRun(scorer, cmdOpts);
  });

const benchmarkCmd = program
  .command('benchmark')
  .description('Run a benchmark suite, and the commands its run\'s steps run. run starts the workflow teamai-benchmark, teamai\'s default or the team\'s file of that name, whose plan, check and report steps run the other commands; try needs no run.');

benchmarkCmd
  .command('run <suite>')
  .description('Plan benchmark suite <suite> without a run first, so a suite that cannot run leaves none, then start the workflow teamai-benchmark with --inputs {"suite":"<suite>","aliases":"team","tasks":[],"arms":[],"fail_on_regression":false} ("member" with --member-aliases; the ids --task and --arm name; true with --fail-on-regression) and the suite\'s timeout as --timeout, and drive it. A team\'s workflows/teamai-benchmark.yaml replaces teamai\'s default, and must take input suite; it gets aliases, tasks, arms and fail_on_regression only when it declares them. Prints the run\'s done envelope and, on stderr, the results. Exits 1 when the run failed or was cancelled, or a finally step, its report or its regression gate, failed or was cancelled; a record still pending publication never changes the exit code.')
  .option('--driver <kind>', 'The driver that runs it: local, or skill. Without it, workflows.driver decides, else local')
  .option('--sandbox', 'With --driver local, declare this machine a sandbox for this run, where the trials, which need strict sandbox isolation, may run. The run remembers it on this install, so workflow resume keeps it. workflows.sandbox in config declares it for every process.')
  .option('--member-aliases', 'Resolve each arm\'s model alias with your own ~/.teamai/models/aliases.yaml over the team\'s models/aliases.yaml, which alone resolves them otherwise: starts the workflow with input aliases member instead of team. The results table and the record show member as the source of a model your file decided.')
  .option('--task <id>', 'Run only this task of the suite: one baseline and its trials. Repeatable. Starts the workflow with input tasks, [] without it; a team file that takes no input tasks is refused.', (value: string, previous: string[]) => previous.concat(value), [])
  .option('--arm <name>', 'Run only this arm of the suite. Repeatable. Starts the workflow with input arms, [] without it; a team file that takes no input arms is refused.', (value: string, previous: string[]) => previous.concat(value), [])
  .option('--fail-on-regression', 'Also exit 1 when an arm\'s pass rate dropped by more than chance against the newest earlier succeeded run of the suite published on teamai-reports with the same arms, trials paired by task and repetition as the dashboard\'s Compare pairs them, a pair left out when its task changed or two different judges decided it: starts the workflow with input fail_on_regression true, false without it, and its regression step fails. With no such run, print a notice and leave the exit code alone. A team file that takes no input fail_on_regression is refused.')
  .action(async (suite: string, cmdOpts: { driver?: string; sandbox?: boolean; memberAliases?: boolean; task: string[]; arm: string[]; failOnRegression?: boolean }) => {
    const { benchmarkRun } = await import('./workflow-commands.js');
    await benchmarkRun(suite, cmdOpts);
  });

benchmarkCmd
  .command('try <task-file>')
  .description('Try one task file before it joins a suite, in a checkout of the suite\'s repo: setup and the check run at startingCommit, where the check must fail, and at solutionCommit, if set, with the protected paths as startingCommit has them, where it must pass. Reads the task file, the SUITE.yaml (or suite.yaml) two directories up from it and the files its check.add entries name in that suite directory, needs no teamai init, and creates no run. Exits non-zero naming the commit and the cause when either goes the wrong way.')
  .action(async (file: string) => {
    const { benchmarkTry } = await import('./workflow-commands.js');
    await benchmarkTry(file);
  });

benchmarkCmd
  .command('plan <suite>')
  .description('The first step of a benchmark run: freeze the team revision this checkout last pulled, fetch every commit a trial reads into the commit cache, and print {"definition":{"definition","workflows"},"plan"}, the workflow the run\'s trials step runs and the plan its check and report steps read, and write the correctness scorers of tasks judged by successCriteria as files of the run, where teamai score plan reads them. Refuses a run with no timeout, or a longer one than the suite\'s: start it with workflow start --timeout.')
  .option('--aliases <whose>', 'Whose aliases resolve the arms\' model aliases: team (default), the team\'s models/aliases.yaml, or member, your ~/.teamai/models/aliases.yaml over the team\'s')
  .option('--tasks <json>', 'The task ids to plan, as a JSON array such as ["fix-login"]; [] or absent plans every task. A name the suite does not have is refused, listing the ones it has.')
  .option('--arms <json>', 'The arm names to plan, as a JSON array such as ["claude"]; [] or absent plans every arm. A name the suite does not have is refused, listing the ones it has.')
  .action(async (suite: string, cmdOpts: { aliases?: string; tasks?: string; arms?: string }) => {
    const { benchmarkPlan } = await import('./workflow-commands.js');
    await benchmarkPlan(suite, cmdOpts);
  });

benchmarkCmd
  .command('report')
  .description('The finally step of a benchmark run: classify the trials of the plan the run measured, write the run\'s benchmark record into its run directory and, when usage reporting allows, publish it to teamai-reports, and print {"text","table","regression"}. The text says record: pending while the record waits for publication. With COMPARE=true in its environment, it compares the record with the newest earlier succeeded one of the suite on teamai-reports with the same arms, adds what it found to the text, each arm\'s compared and excluded pairs first, and sets regression to dropped, held or no_comparable; otherwise regression is off. Refuses a run whose plan this teamai cannot read.')
  .action(async () => {
    const { benchmarkReport } = await import('./workflow-commands.js');
    await benchmarkReport();
  });

benchmarkCmd
  .command('check')
  .description('Run the check of the benchmark step this process runs as, in its clone: the files check.add names, then the task\'s check. A trial\'s check stores the trial\'s correctness label, decided by the check: the highest-scoring label when it passes, the lowest when it fails. On a task with successCriteria too, a passing check stores none, and the judge decides. Prints {"result":"passed"|"failed"|"could_not_run","cause","label"}: cause, when it could not run, is not_found, not_executable, signal, timeout, spawn_failed or prepare_failed (putting back the protected paths or writing check.add failed); label is the version of the label it stored; each is \'\' when it has none. Exits 0 once it decided; exits 1 when it could not check at all. Refuses a run whose plan this teamai cannot read.')
  .option('--baseline', 'The check of a task\'s baseline, on its starting commit')
  .option('--trial', 'The check of a trial, after its prompt, with the protected paths put back as the starting commit has them first')
  .action(async (cmdOpts: { baseline?: boolean; trial?: boolean }) => {
    const { benchmarkCheck } = await import('./workflow-commands.js');
    await benchmarkCheck(cmdOpts);
  });

const scoreCmd = program
  .command('score')
  .description('Label a workflow pass or a finished agent session with team scorers (scorers/<name>.md or scorers/<name>/SCORER.md). --run <id>, --session <id> or --team-session <name>, with --scorer, starts the default workflow teamai-score for that subject with demand named (no sampling; a failed or expired judgment opens again), on the driver --driver or workflows.driver names, else local, and prints the labels it wrote. A run for a driver this machine does not run waits for it, and the command says how to drive it here. A person starts it from their own terminal: from an agent session the start answers invoke_denied, and an agent judges its session with /teamai-share-session instead. The pass, session, scorers and --label value are checked before any run starts. When only a judge step no tool here can run is left, it exits 1 with judge_pending and the labels already written; a scorer with no label exits 1 with its code. A scorer file (--scorer ./scorers/x.md, or ./scorers/x/SCORER.md for a scorer folder) starts the default workflow teamai-try-scorer instead, which judges the session and its first prompt alone and stores no label; from an agent session it answers invoke_denied, and an agent tries a scorer with /teamai-new-scorer. Prints one JSON envelope; --drain prints lines.')
  .option('--run <id>', 'Label a pass of this run on demand, with --scorer: a scorer a step of the run lists, read at the team revision the run started from. Refused with step_ambiguous, step_not_found or pass_not_found as --step and --pass say, and with evidence_missing, naming each, when a commit or a session the pass recorded is no longer on this machine; no run starts and no label is written.')
  .option('--step <path>', 'With --run: the step path, such as review or check.review; optional when the run lists the scorers on one step only')
  .option('--pass <n>', 'With --run: the pass to judge; default the step\'s latest succeeded pass')
  .option('--session <id>', 'Label this finished session of an agent tool on this machine, with --scorer, whatever sampling, scoring.sessions or an earlier label say; it counts toward daily_limit, which never refuses it. Prints the session\'s first prompt and directory first, then the label; the session and the judge\'s reasoning are never published.')
  .option('--source <platform>', 'With --session: the tool that holds it, as session migrate --source names it (claude-code, codex, opencode, …); needed unless the agent session variable names that session, or the captures its session-start hook wrote here name one platform for it')
  .option('--team-session <name>', 'Judge a session a member pushed with session push instead of one on this machine, by the name session list prints for this directory\'s repository: read from teamai-reports, else from the archive the team kept on its default branch before, and redacted before a judge reads it. Run session pull first for the newest. Its label is about the session where it ran, so it pairs with that session\'s labels from the machine that ran it, and records no agent. Not with --session or --source')
  .option('--author <name>', 'With --team-session: who pushed it, when two members pushed a session with that name')
  .option('--label <value>', 'Label the session by hand with this value of the one --scorer: the teamai-score run skips the stages and the judge, score and passed come from the scorer, and no reasoning is kept. A value the scorer does not list fails before any run starts and lists the ones it does. Honoured only in a run a person started. A hand label and a model label of a session are kept side by side, so rescoring with the model never replaces yours; the dashboard Scorers page shows how often the model judge agrees with hand labels. Not with a scorer file or --batch')
  .option('--scorer <name>', 'With --run: a scorer a step of the run lists, read at the team revision the run started from. With --session or --team-session: a scorer teamai pull cached, or a scorer file to try before pushing it: a path with / or ending in .md, tried by a teamai-try-scorer run. A file\'s label is never stored, so it takes no --push; the output adds the labels stored for its scorer (stored) and its verdict on the session\'s first prompt alone (control). Files and scorer names go in separate commands. Repeatable.', (value: string, previous: string[]) => previous.concat(value), [])
  .option('--driver <driver>', 'With --run, --session or --team-session: the driver of the teamai-score run, or of the teamai-try-scorer run a scorer file starts, local or none, which only starts the run and leaves it to any driver\'s workflow next. Without it, workflows.driver decides, else local')
  .option('--batch', 'With --run or --session: the scorers share one judge launch when they take the same model, stages, and preferred or required tool; a scorer with a check, or a correctness scorer of a benchmark, never does')
  .option('--push', 'Publish every pending label of this machine to scores/<member>/<YYYY-MM>.jsonl on teamai-reports, alone or after the labels of --run or --session. Labels only: never the session, the prompt or the judge\'s reasoning. With usage reporting off, or when the push fails, they stay pending for the next --push. Also pushes what a workflow step with deliver: publish left on this machine while origin could not take it.')
  .option('--drain', 'What every unattended job runs before it ends, alone, in every scope this directory reaches: in unattended mode, finish each session captured unattended here; start the default workflow teamai-finished-sessions on the driver workflows.driver names, else local (a run for a driver this machine does not run waits for it), which archives, scrubbed, and judges the finished sessions as sessions.publish and scoring.sessions say, and starts teamai-score again for each pass and session whose judging lapsed (a failed judgment final and never retried); publish pending labels and workflow run records; where sessions.publish is auto for this run mode, archive the step sessions of its ended runs on teamai-reports; report usage to stats/<member>.yaml. Prints a line per kind of work and what it left for other drivers; exits 1 only when a judgment, a publish or that run failed, and what stayed pending goes on the next --drain.')
  .action(async (cmdOpts: ScoreOptions) => {
    const { scoreCommand } = await import('./score-commands.js');
    await scoreCommand(cmdOpts);
  });

// The verbs a teamai-score run's steps call. `score` has --label, --run and --step too, and takes their values, so a verb
// reads them with optsWithGlobals.
scoreCmd
  .command('plan')
  .description('A step of a teamai-score run: sample each scorer on the subject, group the sampled ones that share a judge launch and take the same stages, and open their marks for the run. A non-empty label input of the teamai-score run is a hand label of its one scorer, honoured only when a person started the root run. Prints {"groups":[{"subject","hand","scorers","model","ci","protected"}]}: empty when nothing is sampled, every scorer is judged or held, or past daily_limit for an auto demand. Refused outside a leased attempt of a teamai-score step.')
  .option('--subject <subject>', 'run:<runId>:<step path>:<pass>, session:<source>:<sessionId> or team-session:<author>:<archive name>')
  .option('--scorers <json>', 'A JSON array of scorer names; [] takes the scorers the pass\'s step lists, or for a session every scorer with sessions: true. On an auto demand, a scorer whose judging of the subject lapsed or waits for CI is taken whatever it samples')
  .option('--batch <bool>', 'true: the scorers share a judge launch where they can; false: as the step, the workflow\'s defaults.scorers.batch and scoring.yaml say')
  .option('--demand <demand>', 'auto: sample, and stop at daily_limit; named: someone asked, so every scorer is taken, a closed mark opens again, and daily_limit counts it but never refuses it', 'auto')
  .action(async (_cmdOpts, command: Command) => {
    const { ScoreVerbs, scoreVerbCommand } = await import('./score-verbs.js');
    await scoreVerbCommand((ctx) => ScoreVerbs.plan(command.optsWithGlobals<PlanOptions>(), ctx));
  });

scoreCmd
  .command('evidence')
  .description('A step of a teamai-score run: write the evidence of one group into $TEAMAI_RUN_DIR/<attempt>/: the redacted transcript and diff, evidence.json, the rubric prompt, the answer schema, and confined.json with the isolation level the team, the scorers and this machine require, and the judge tool a benchmark plan requires, else the tools to prefer. Prints {"dir","rubric","schema","delivers"}. A hand label only resolves the subject. Fails evidence_missing when a commit or session the pass recorded is gone, evidence_empty when nothing of it was kept.')
  .option('--subject <subject>', 'The group\'s subject, as plan printed it')
  .option('--scorers <names>', 'The group\'s scorers, joined by , as plan printed them')
  .action(async (_cmdOpts, command: Command) => {
    const { ScoreVerbs, scoreVerbCommand } = await import('./score-verbs.js');
    await scoreVerbCommand((ctx) => ScoreVerbs.evidence(command.optsWithGlobals<EvidenceOptions>(), ctx));
  });

scoreCmd
  .command('stage')
  .description('A step of a teamai-score run: one stage that may decide a delivered pass before its judge, check (the scorer\'s check on the delivered commit, stopped after 30 minutes), ci (a failed CI of its pull request) or protected (a protected-path refusal). Writes its record in the evidence directory and prints {"decided":true} or {"decided":false}; ci also prints "pending", true while CI has not finished, else false. A stage no scorer of the group takes runs nothing and prints {"decided":false}. A check that cannot run prints {"decided":true}, and label gives check_could_not_run.')
  .argument('<stage>', 'check, ci or protected')
  .option('--evidence <dir>', 'The evidence directory its evidence step printed')
  .option('--wait <duration>', 'With ci: past this long since this machine first saw the CI pending, such as 2h, judge as if the pass had no CI')
  .action(async (stage: string, _cmdOpts, command: Command) => {
    const { ScoreVerbs, scoreVerbCommand } = await import('./score-verbs.js');
    await scoreVerbCommand((ctx) => ScoreVerbs.stage({ ...command.optsWithGlobals<Omit<StageOptions, 'stage'>>(), stage }, ctx));
  });

scoreCmd
  .command('label')
  .description('A step of a teamai-score run: the labels of one group, from the run\'s hand label when a person started the root run, else the first stage that decided it (check, ci, protected), else the judge\'s --answer, each checked against the answer schema and the pinned scorer, with score and passed computed here. Writes them with reasoning to <dir>/labels.json and prints {"labels":[{"scorer","label","code"}]}, one per scorer and no reasoning; code is check_could_not_run, ci_pending, judge_failed or judge_answer_invalid for a scorer with no label. A label a stage decided records judge kind stage. Exits 0 with codes. Refused outside a leased attempt of a teamai-score step.')
  .option('--evidence <dir>', 'The evidence directory its evidence step printed')
  .option('--answer <json>', 'The judge step\'s answer, as its output rendered it; \'\' when it gave none')
  .option('--judge <outcome>', 'The judge step\'s outcome: success, failed, timed_out, cancelled, or \'\' when it was skipped')
  .action(async (_cmdOpts, command: Command) => {
    const { ScoreVerbs, scoreVerbCommand } = await import('./score-verbs.js');
    await scoreVerbCommand((ctx) => ScoreVerbs.label(command.optsWithGlobals<LabelOptions>(), ctx));
  });

scoreCmd
  .command('write')
  .description('A step of a teamai-score run: check the labels label left in <dir>/labels.json again, then write them to scores/labels.jsonl, reasoning/ and the pending outbox, and close each scorer\'s mark: labelled, failed with its code, or waiting for CI. A label of a private or isolated run stays out of the outbox. Writes nothing when a label fails a check. Prints {"written":<n>}. Refused outside a leased attempt of a teamai-score step.')
  .option('--evidence <dir>', 'The evidence directory its evidence step printed')
  .action(async (_cmdOpts, command: Command) => {
    const { ScoreVerbs, scoreVerbCommand } = await import('./score-verbs.js');
    await scoreVerbCommand((ctx) => ScoreVerbs.write(command.optsWithGlobals<WriteOptions>(), ctx));
  });

scoreCmd
  .command('publish')
  .description('A step of a teamai-score run, in the team workspace on teamai-reports with deliver: publish: stage this member\'s pending labels, without reasoning, into scores/<username>/<YYYY-MM>.jsonl of that checkout, merged by key with what origin\'s tip holds; the step publishes what it staged. A pending label origin\'s tip already holds, or holds a newer label of, leaves the outbox. Stages nothing with usage reporting off, for an http team repo, or outside a checkout of teamai-reports. Prints {"staged":<n>}. Refused outside a leased attempt of a teamai-score step.')
  .action(async () => {
    const { ScoreVerbs, scoreVerbCommand } = await import('./score-verbs.js');
    await scoreVerbCommand((ctx) => ScoreVerbs.publish(ctx));
  });

scoreCmd
  .command('settle')
  .description('A step of a teamai-score run, after a verb of a group broke: record a failed attempt of each scorer whose mark the run holds, so automatic judging does not start the subject again. Works when evidence failed. Prints {"settled":<n>}.')
  .option('--subject <subject>', 'The group\'s subject, as plan printed it')
  .option('--scorers <names>', 'The group\'s scorers, joined by , as plan printed them')
  .action(async (_cmdOpts, command: Command) => {
    const { ScoreVerbs, scoreVerbCommand } = await import('./score-verbs.js');
    await scoreVerbCommand((ctx) => ScoreVerbs.settle(command.optsWithGlobals<EvidenceOptions>(), ctx));
  });

scoreCmd
  .command('report')
  .description('A step of a teamai-try-scorer run: the label each scorer file gave the session, read with its reasoning from the labels.json its teamai-score step left, beside the labels this scope keeps of that scorer on the session and the control\'s verdict on the session\'s first prompt alone. Stores nothing. Prints {"answer","text"}: answer is the envelope teamai score --scorer <file> prints, {"data":{"label","stored","control"}} for one file, by scorer for several, or {"error"} when the session got no label; text says it in lines.')
  .option('--labels <json>', 'The labels output of the teamai-score step that judged the session')
  .option('--control <json>', 'The labels output of the teamai-score step that judged its control')
  .action(async (_cmdOpts, command: Command) => {
    const { ScoreVerbs, scoreVerbCommand } = await import('./score-verbs.js');
    await scoreVerbCommand((ctx) => ScoreVerbs.report(command.optsWithGlobals<ReportOptions>(), ctx));
  });

scoreCmd
  .command('subjects')
  .description('List subjects to start teamai-score on. --run <id> [--step <path>]: the judge-work passes of the run, settled on this machine, whose step says scorers.start: workflow, as {"list":["run:<runId>:<step path>:<pass>",…]}; --step is relative to the workflow of the step that runs this, and takes that step and every step inside it. --run <id> --calibration [--step <path>]: the trials of a benchmark run to calibrate its correctness judges on, as {"list":[{"subject":"run:<runId>:<step path>:<pass>","scorer":"teamai:correctness:<task>"},…]}: each trial of a task with a check and success criteria whose check failed, that the suite\'s calibration.rate samples by a hash of the run id and the trial\'s step. --lapsed: what teamai-finished-sessions scores again on this machine, as {"list":[{"subject":"<subject>","scorers":["<name>",…]},…]}: the passes and sessions whose mark lapsed (until the fourth lapse), those that waited for CI that has since finished, each with the scorers of those marks, named ones included, and the passes of a run inside its 14 days that no teamai-score run planned, with the unmarked scorers that sample them: one whose teamai-score run was started and never driven, and, once the run ended, one of a scorers.start: workflow step no step of its workflow scored.')
  .option('--run <id>', 'The run whose passes to list')
  .option('--step <path>', 'With --run: only that step and the steps inside it')
  .option('--calibration', 'With --run: the benchmark trials to calibrate the correctness judges on, each with its scorer')
  .option('--lapsed', 'This machine\'s subjects that automatic judging starts again')
  .action(async (_cmdOpts, command: Command) => {
    const { ScoreVerbs, scoreVerbCommand } = await import('./score-verbs.js');
    await scoreVerbCommand((ctx) => ScoreVerbs.subjects(command.optsWithGlobals<SubjectsOptions>(), ctx));
  });

// ─── Hooks commands ─────────────────────────────────────

const hooksCmd = program
  .command('hooks')
  .description('Manage teamai hooks in AI tool settings');

hooksCmd
  .command('list')
  .description('List hook install status + effective built-in (A) and team (B) hooks')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { hooksList } = await import('./hooks-cmd.js');
    await hooksList(globalOpts);
  });

hooksCmd
  .command('inject')
  .description('Inject teamai hooks into all AI tool settings')
  .option('--silent', 'Silent mode (suppress success message)')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();

    if (cmdOpts.silent) setSilent(true);
    const { hooksInject } = await import('./hooks-cmd.js');
    await hooksInject({ ...globalOpts, ...cmdOpts });
  });

hooksCmd
  .command('remove')
  .description('Remove teamai hooks from all AI tool settings')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { hooksRemove } = await import('./hooks-cmd.js');
    await hooksRemove(globalOpts);
  });

// ─── MCP commands ───────────────────────────────────────

const mcpCmd = program
  .command('mcp')
  .description('Manage team MCP servers across AI tools');

mcpCmd
  .command('list')
  .description('List team MCP servers and their per-tool install status')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { mcpList } = await import('./mcp-cmd.js');
    await mcpList(globalOpts);
  });

mcpCmd
  .command('inject')
  .description('Inject team MCP servers into all AI tool configs')
  .option('--dry-run', 'Show what would change without writing')
  .option('--force', 'Overwrite servers that collide with user-owned entries')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { mcpInject } = await import('./mcp-cmd.js');
    await mcpInject({ ...globalOpts, ...cmdOpts });
  });

mcpCmd
  .command('remove')
  .description('Remove all teamai-managed MCP servers from AI tool configs')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { mcpRemove } = await import('./mcp-cmd.js');
    await mcpRemove(globalOpts);
  });

// ─── Webhook commands ───────────────────────────────────

const webhookCmd = program
  .command('webhook')
  .description('Manage webhook integrations for team notifications');

webhookCmd
  .command('list')
  .description('List configured webhook endpoints')
  .action(async () => {
    const { listWebhooks } = await import('./webhook.js');
    const endpoints = await listWebhooks();

    if (endpoints.length === 0) {
      console.log('No webhook endpoints configured.');

      return;
    }

    console.log('Configured webhook endpoints:\n');

    for (const ep of endpoints) {
      console.log(`  URL: ${ep.url}`);
      console.log(`  Type: ${ep.type}`);
      console.log(`  Events: ${ep.events.join(', ')}`);
      console.log('');
    }
  });

webhookCmd
  .command('test')
  .description('Send test event to webhook endpoints')
  .option('--url <url>', 'Test specific endpoint URL')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { testWebhook } = await import('./webhook.js');
    await testWebhook(cmdOpts.url, { dryRun: globalOpts.dryRun });
  });

// ─── Model profile commands ─────────────────────────────

/** Model commands fail with one readable line instead of a stack trace. */
async function runModelsCommand(run: (commands: typeof import('./models-cmd.js')) => Promise<void>): Promise<void> {
  try {
    await run(await import('./models-cmd.js'));
  } catch (error) {
    log.error((error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

const collectRepeatable = (val: string, acc: string[]) => acc.concat(val);

const modelsCmd = program
  .command('models')
  .description('Share gateway model profiles and switch agents to them');

modelsCmd
  .command('list [profile]')
  .description('Show team and personal model profiles, or one profile, and the agents using them')
  .action((profile: string | undefined) => runModelsCommand((m) => m.modelsList(profile)));

modelsCmd
  .command('add <id>')
  .description('Add a personal model profile stored only on this machine')
  .option('--name <name>', 'Display name')
  .option('--protocol <protocols>', 'Comma-separated: anthropic, openai-chat-completions, openai-responses, gemini')
  .option('--base-url <url>', 'Gateway root URL (without /v1)')
  .option('--model <ids>', 'Comma-separated model IDs; the first is the default')
  .option('--from-env <name>', 'Read the API key from this environment variable')
  .option('--api-key-stdin', 'Read the API key from stdin without placing it in shell history')
  .action((id: string, cmdOpts) => runModelsCommand((m) => m.modelsAdd(id, cmdOpts)));

modelsCmd
  .command('configure <profile>')
  .description('Set the API key of a profile, or edit a personal profile')
  .option('--from-env <name>', 'Read the API key from this environment variable')
  .option('--api-key-stdin', 'Read the API key from stdin without placing it in shell history')
  .option('--name <name>', 'Personal profiles: new display name')
  .option('--base-url <url>', 'Personal profiles: new gateway root URL')
  .option('--protocol <protocols>', 'Personal profiles: serve models over these protocols too')
  .option('--model <ids>', 'Personal profiles: add model IDs')
  .action((profile: string, cmdOpts) => runModelsCommand((m) => m.modelsConfigure(profile, cmdOpts)));

modelsCmd
  .command('switch [profile]')
  .description('Point agents at a model profile (every compatible agent by default); omit the profile to pick one')
  .option('--agent <name>', 'Only switch this agent. Repeatable or comma-separated.', collectRepeatable, [])
  .option('--model <id>', 'Default model to select (defaults to the first in the profile)')
  .option('--dry-run', 'Show what would change without writing')
  .action((profile: string | undefined, cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();

    return runModelsCommand((m) => m.modelsSwitch(profile, { ...globalOpts, ...cmdOpts }));
  });

modelsCmd
  .command('restore')
  .description('Restore agent model settings captured before the first TeamAI switch')
  .option('--agent <name>', 'Only restore this agent. Repeatable or comma-separated.', collectRepeatable, [])
  .option('--dry-run', 'Show what would change without writing')
  .action((cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();

    return runModelsCommand((m) => m.modelsRestore({ ...globalOpts, ...cmdOpts }));
  });

modelsCmd
  .command('remove <profile>')
  .description('Remove a personal model profile without changing agent settings')
  .action((profile: string) => runModelsCommand((m) => m.modelsRemove(profile)));

// ─── Usage tracking commands ────────────────────────────

program
  .command('track [toolName] [toolInput]', { hidden: true })
  
  .description('Track a tool usage event (called by PostToolUse hook)')
  .option('--stdin', 'Read hook data from STDIN (Claude Code hook format)')
  .option('--tool <name>', 'Tool identifier for usage attribution (e.g. claude, claude-internal)')
  .action(async (toolName, toolInput, cmdOpts) => {
    if (cmdOpts.stdin) {
      const { trackFromStdin } = await import('./usage-tracker.js');
      await trackFromStdin(cmdOpts.tool);
    } else {
      const { track } = await import('./usage-tracker.js');
      await track(toolName ?? '', toolInput ?? '{}', cmdOpts.tool);
    }
  });

program
  .command('track-slash', { hidden: true })
  
  .description('Track a slash command usage (called by UserPromptSubmit hook)')
  .option('--stdin', 'Read hook data from STDIN')
  .option('--tool <name>', 'Tool identifier for usage attribution (e.g. claude, claude-internal)')
  .action(async (cmdOpts) => {
    if (cmdOpts.stdin) {
      const { trackSlashCommand } = await import('./usage-tracker.js');
      await trackSlashCommand(cmdOpts.tool);
    }
  });

program
  .command('stats')
  .description('Show local skill usage statistics')
  .option('--by-repo', 'Break the local event log down per repository')
  .option('--by-time', 'Show local event log activity by hour of day')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { showStats } = await import('./stats.js');
    await showStats({ byRepo: cmdOpts.byRepo, byTime: cmdOpts.byTime, dryRun: globalOpts.dryRun });
  });

// ─── Session subcommands ──────────────────────────────────
const sessionCmd = program
  .command('session')
  .description('Session recording, cross-platform migration, and team sync');

sessionCmd
  .command('save')
  .description('Record a privacy-scrubbed summary of a coding session to a local monthly log')
  .option('--session-id <id>', 'Session to record (default: the agent\'s session, e.g. $CLAUDE_CODE_SESSION_ID, or the most recent)')
  .option('--push', 'Also push the summary to the team repo (feeds `teamai digest`)')
  .option('--force', 'Push even if the session is not flagged as valuable')
  .option('--include-prompt', 'Include the redacted first-prompt line in the pushed summary (default: off)')
  .option('--scope <scope>', 'Config scope for --push: user | workspace (default: auto-detect)')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { saveSession } = await import('./save-session.js');
    await saveSession({ ...globalOpts, ...cmdOpts });
  });

// Load session migration commands when this process is actually about session,
// or when another tool is only reading the command table.
// `argv[2] === 'session'` misses `teamai --dry-run session …`, `teamai -v session …`,
// and `teamai help session`. Digest, recall, push, and pull still skip this import.
if (shouldRegisterSessionFlowCommands()) {
  try {
    const { registerSessionFlowCommands } = await import('./session-flow/session-cmd.js');
    registerSessionFlowCommands(sessionCmd);
  } catch (e) {
    log.warn(`Session commands unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

program
  .command('digest')
  .description('Generate weekly team activity digest')
  .option('--json', 'Print what an improvement starts from instead, as one JSON envelope: the failing score labels of the last 30 days, each with its subject and the commit its work started at, and each scorer\'s cohorts with the agreement of its model judge with hand labels. Never a judge\'s reasoning; a benchmark\'s labels are left out')
  .option('--scorer <name>', 'With --json, also print data.improvement for this scorer: failures, its failures a regression task can start from (a recorded start commit this checkout has, and no task of --suite on the team repo\'s default branch or on an open --proposal names its subject), each subject once, newest first; covered, the tasks that name its other failures; refused, each failure no task can start from, with why: tracked_changes, not_recorded or not_in_checkout; and hasProposal, whether --proposal is open: origin has it, and its default branch neither merged it nor has each regression task it adds. The workflow\'s if decides from these whether it runs')
  .option('--suite <dir>', 'With --scorer, the suite whose tasks cover a failure', 'benchmarks/regressions')
  .option('--proposal <branch>', 'With --scorer, the team repo branch an open proposal is on, whose tasks cover failures too')
  .action(async (cmdOpts: { json?: boolean; scorer?: string; suite: string; proposal?: string }) => {
    if (cmdOpts.json) {
      const { DigestFailures } = await import('./digest-failures.js');
      await DigestFailures.print(cmdOpts.scorer === undefined ? {} : { improvement: { scorer: cmdOpts.scorer, suite: cmdOpts.suite, proposal: cmdOpts.proposal } });

      return;
    }

    if (cmdOpts.scorer !== undefined || cmdOpts.proposal !== undefined) {
      log.error('invalid_arguments: --scorer and --proposal print with --json. Add --json.');
      process.exitCode = 1;

      return;
    }

    const { generateDigest } = await import('./digest.js');
    await generateDigest();
  });

// ─── Dashboard commands ─────────────────────────────────

program
  .command('dashboard')
  .description('Start the AI coding session dashboard (Web UI)')
  .option('-p, --port <port>', 'Port number', String(3721))
  .action(async (cmdOpts) => {
    const { startDashboard } = await import('./dashboard.js');
    await startDashboard(parseIntOption('--port', String(cmdOpts.port), 0, 65535));
  });

program
  .command('dashboard-report', { hidden: true })
  
  .description('Report session state to dashboard (called by hooks)')
  .option('--stdin', 'Read hook data from STDIN')
  .option('--tool <name>', 'Tool identifier (e.g. claude, claude-internal)')
  .action(async (cmdOpts) => {
    if (cmdOpts.stdin) {
      const { dashboardReport } = await import('./dashboard-collector.js');
      await dashboardReport(cmdOpts.tool);
    }
  });

program
  .command('hook-dispatch <event> [hookArgs...]', { hidden: true })
  .description('Unified hook dispatcher — handles all teamai hooks for a given event in one process')
  .option('--stdin', 'Read hook data from STDIN (accepted for forward compat, always reads STDIN)')
  .option('--tool <name>', 'Tool identifier (e.g. codebuddy, workbuddy, claude)')
  .option('--matcher <matcher>', 'Hook matcher for PostToolUse (e.g. Skill, Bash)')
  .option('--copilot-global <source>', 'Internal: identify a Copilot user built-in to prevent duplicate project execution')
  .option('--bg-only', 'Internal: run only fire-and-forget background handlers (used by the detached child)')
  .option('--stdin-file <path>', 'Internal: read the hook payload from this file instead of STDIN')
  .option('--team-hooks', 'Run the team hooks of the project the hook\'s cwd belongs to (Codex when the project\'s .codex/hooks.json is not teamai\'s alone; CodeBuddy project gates; OpenCode, OMP, Pi, Kiro, Hermes and OpenClaw from their bridge)')
  .option('--team-hook-id <id>', 'Internal: CodeBuddy team hook id')
  .option('--team-hook-gate <encoded>', 'Internal: CodeBuddy project gate')
  .option('--team-hook-command <encoded>', 'Internal: CodeBuddy team hook command')
  .option('--team-hook-timeout <seconds>', 'Internal: CodeBuddy team hook timeout')
  .action(async (event: string, hookArgs: string[], cmdOpts: { stdin?: boolean; tool?: string; matcher?: string; bgOnly?: boolean; copilotGlobal?: string; stdinFile?: string; teamHooks?: boolean; teamHookId?: string; teamHookGate?: string; teamHookCommand?: string; teamHookTimeout?: string }) => {
    const bgOnly = cmdOpts.bgOnly ?? false;
    const tool = cmdOpts.tool ?? 'claude';

    // Team hooks keep their own timeouts and exit status: Codex bounds the
    // entry by the largest of them, and exit 2 is a hook's blocking decision.
    if (cmdOpts.teamHooks) {
      let code = 0;

      try {
        const bridged = await import('./bridged-team-hooks.js');

        if (tool === 'codex') {
          const { runCodexDispatcher } = await import('./codex-team-hooks.js');
          code = await runCodexDispatcher(event);
        } else if (bridged.isBridgedTeamHookTool(tool)) {
          const { runBridgedTeamHooks } = bridged;
          const { readStdin } = await import('./utils/hook-stdin.js');
          const reply = await runBridgedTeamHooks(tool, event, await readStdin());

          if (reply.stderr) process.stderr.write(reply.stderr);

          if (reply.stdout) await new Promise<void>((resolve) => process.stdout.write(reply.stdout, () => resolve()));
          code = reply.code;
        } else if (tool === 'codebuddy' && cmdOpts.teamHookGate && cmdOpts.teamHookCommand) {
          const parsedTimeout = cmdOpts.teamHookTimeout === undefined ? undefined : Number(cmdOpts.teamHookTimeout);

          if (parsedTimeout !== undefined && (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0)) {
            throw new Error(`invalid CodeBuddy team hook timeout ${JSON.stringify(cmdOpts.teamHookTimeout)}`);
          }

          const { runCodebuddyTeamHook } = await import('./codebuddy-team-hooks.js');
          code = await runCodebuddyTeamHook(cmdOpts.teamHookGate, cmdOpts.teamHookCommand, parsedTimeout);
        }
      } catch (e) {
        process.stderr.write(`teamai: team hooks did not run: ${e instanceof Error ? e.message : String(e)}\n`);

        // CodeBuddy must report dispatcher failures to its host. Codex keeps
        // its historical fail-open wrapper: its hook runner reports the
        // diagnostic but the shared `--team-hooks` command remains successful.
        if (tool === 'codebuddy') code = 1;
      }

      process.exit(code);
    }

    // Hard wall-clock safety net for the FOREGROUND (parent) hook process, which
    // blocks the host IDE's hook. The host aborts a hook at ~10s regardless of
    // any larger declared timeout, reporting "Hook timed out after 10000ms"
    // (error 3003) and breaking the IDE. Guarantee we exit well before that no
    // matter which stage stalls — a STDIN read that never sees EOF, a wedged
    // handler, or a pending socket from an aborted fetch keeping the event loop
    // alive. 7s leaves margin below the 10s cap while sitting comfortably above
    // the 4.5s foreground handler budget, so it never truncates legitimate work.
    // The detached `--bg-only` child is unref'd and not awaited by the host, so
    // it is exempt and keeps its full budget to finish real syncs/downloads.
    // A hook the fast path fell through from read its STDIN before this timer
    // started, bounded by the same 1s EOF deadline (utils/hook-stdin.ts).
    const HOOK_HARD_EXIT_MS = 7_000;
    // Git (`--tool git`) has no hook timeout to stay under, and a cut here
    // would stop the inline delivery mid-write; its handler bounds itself.
    let hardExit: NodeJS.Timeout | undefined;

    if (!bgOnly && tool !== 'git') {
      hardExit = setTimeout(() => process.exit(0), HOOK_HARD_EXIT_MS);
      hardExit.unref();
    }

    const { hookDispatchCli } = await import('./hook-dispatch-cli.js');

    try {
      await hookDispatchCli(event, tool, cmdOpts.matcher ?? '*', { ...cmdOpts, hookArgs });
    } finally {
      if (hardExit) clearTimeout(hardExit);
      // Hook subprocesses must exit promptly: a hung/unreachable backend fetch can
      // leave a socket pending on the event loop, blocking natural exit and tripping
      // the host IDE's default hook timeout. Force exit once dispatch has settled.
      // Tradeoff: this also terminates best-effort fire-and-forget background work
      // (e.g. event compaction) for all tools, which is acceptable because such work
      // is idempotent/best-effort and safe to drop.
      process.exit(0);
    }
  });

program
  .command('bind-project')
  .description('Enroll the current workspace in HTTP local-agent sync and bind it to a ClawPro project. A workspace where this never ran is left alone')
  .option('--project-id <id>', 'Project ID from /projects/mine')
  .option('--skip', 'Enroll the current workspace without a project (never prompt again)')
  .action(async (cmdOpts) => {
    const { bindCurrentProject } = await import('./local-agent.js');
    await bindCurrentProject({
      projectId: cmdOpts.projectId !== undefined ? parseIntOption('--project-id', String(cmdOpts.projectId), 1) : undefined,
      skip: !!cmdOpts.skip,
    });
  });

// ─── Contribute commands ──────────────────────────────────

program
  .command('contribute-check', { hidden: true })
  
  .description('Check if session qualifies for contribution (called by PostToolUse hook)')
  .option('--stdin', 'Read hook data from STDIN')
  .option('--tool <name>', 'Tool identifier (e.g. claude, claude-internal)')
  .action(async (cmdOpts) => {
    if (cmdOpts.stdin) {
      const { contributeCheck } = await import('./contribute-check.js');
      await contributeCheck(cmdOpts.tool);
    }
  });

program
  .command('contribute')
  .description('Contribute session knowledge to team repo; projects list shows the default destination and allowed namespaces')
  .option('--file <path>', 'Path to the contribution document')
  .option('--title <title>', 'Title for the contribution document')
  .option('--namespace <ns>', 'Write to an active learnings namespace, or to the shared root with "" (default: the only active namespace, or the shared root when none or several are active)')
  .option('--session-id <id>', 'Session the learning came from (default: the agent\'s session, e.g. $CLAUDE_CODE_SESSION_ID). Recorded as `session` in the learning and counted as that session\'s outcome. Inside a workflow attempt, the learning is also recorded on the step')
  .option('--scope <scope>', 'Target scope: user or workspace')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { contribute } = await import('./contribute.js');
    await contribute({ ...globalOpts, ...cmdOpts });
  });

// ─── Recall commands ─────────────────────────────────────

const recallCmd = program
  .command('recall [query...]')
  .description('Search team learnings knowledge base')
  .option('--depth <level>', 'Recall depth: route (entry-points only) | context (module-level, default) | lookup (full graph traversal)', 'context')
  .option('--check', 'Relevance precheck only: print RELEVANT/NOT_RELEVANT + top score; no file reads, no upvote')
  .addOption(new Option('--caller <name>', 'Internal, set by the teamai-recall subagent to mark its own runs; do not pass it yourself').hideHelp())
  .action(async (queryParts: string[], cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const query = queryParts.join(' ');
    const { recall } = await import('./recall.js');
    await recall(query, { ...globalOpts, depth: cmdOpts.depth, check: cmdOpts.check, caller: cmdOpts.caller });
  });

recallCmd
  .command('disable')
  .description('Disable automatic knowledge-base recall')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { recallDisable } = await import('./recall-toggle.js');
    await recallDisable(globalOpts);
  });

recallCmd
  .command('enable')
  .description('Enable automatic knowledge-base recall')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { recallEnable } = await import('./recall-toggle.js');
    await recallEnable(globalOpts);
  });

recallCmd
  .command('status')
  .description('Show recall feature status')
  .action(async () => {
    const globalOpts = program.opts<GlobalOptions>();
    const { recallStatus } = await import('./recall-toggle.js');
    await recallStatus(globalOpts);
  });

program
  .command('todowrite-hint', { hidden: true })
  
  .description('Remind the agent to invoke teamai-recall when TodoWrite is used (PostToolUse hook)')
  .option('--stdin', 'Read hook data from STDIN')
  .option('--tool <name>', 'Source AI tool (claude / codebuddy / cursor)')
  .action(async (cmdOpts) => {
    if (cmdOpts.stdin) {
      const { todoWriteHint } = await import('./todowrite-hint.js');
      await todoWriteHint(cmdOpts.tool);
    }
  });

const importCommand = program
  .command('import')
  .description('Import knowledge from local directories, remote repos, organizations, MRs, AI tools\' rules, or iWiki. --dir, --from-repo, --from-repo-list and --from-org start the default workflow teamai-import-from-repo; --from-tools starts teamai-import-rules and --from-iwiki teamai-import-from-iwiki, which ask you to accept, edit or skip each item unless --all is given')
  .option('--dir <path>', 'Extract code knowledge from a local directory (same as --from-repo but no clone)')
  .option('--from-tools', 'Import the rule files in the rules directory of every AI coding tool on this machine (~/.claude/rules, ~/.cursor/rules, ~/.codebuddy/rules, ...): the AI classifies each as a rule, doc or learning, and the accepted ones are pushed to the team repo\'s rules/, docs/ or learnings/')
  .addOption(new Option('--from-claude', 'Alias of --from-tools').hideHelp())
  .option('--from-mr <url...>', 'Extract learning from one or more merged MRs/PRs and trigger incremental teamwiki update')
  .option('--no-discussions', 'Leave the MR\'s review threads out of the extraction (with --from-mr)')
  .option('--from-iwiki <space-id-or-url>', 'Import documents from iWiki Space ID or page URL (requires TAI_PAT_TOKEN): the AI classifies each as a rule, doc or learning, and the accepted ones are pushed to the team repo\'s rules/, docs/ or learnings/')
  .addOption(new Option('--resume', 'Replaced by teamai workflow resume <run>, which the import prints when it starts').hideHelp())
  .option('--all', 'Accept all suggestions without interactive confirmation; needed where no person answers, such as inside a workflow step')
  .addOption(new Option('--output <path>', 'Write drafts to this directory instead of pushing to team repo; code knowledge goes to <path>/teamwiki').hideHelp())
  .option('--from-repo <url>', 'Clone a remote repo and generate per-repo codebase summary')
  .addOption(new Option('--ssh', 'Force SSH clone even if HTTPS token is available').hideHelp())
  .addOption(new Option('--domain <name>', 'Skip AI recommendation and assign repo to this domain explicitly').hideHelp())
  .option('--from-repo-list <path>', 'Batch import repos from a YAML whitelist')
  .addOption(new Option('--concurrency <n>', 'Concurrent repos for --from-repo-list (positive safe integer, default 3)').default('3').hideHelp())
  .option('--incremental', 'Re-extract only files changed since the last import (with --dir, --from-repo or --from-repo-list; remote repos also reuse the cached clone)')
  .option('--skip-enrich', 'Skip AI enrichment (only clone + extract + graph, no LLM calls)')
  .option('--max-files <n>', 'Max source files collected per repository (default 200)')
  .option('--from-org <org>', 'List repos under an org and generate a repo whitelist')
  .addOption(new Option('--max-repos <n>', 'Cap on repos pulled from --from-org (default 200)').default('200').hideHelp())
  .addOption(new Option('--exclude-archived', 'Exclude archived repos from --from-org (default true)').hideHelp())
  .addOption(new Option('--include-pattern <re>', 'Regex to include repos by full name (used with --from-org)').hideHelp())
  .addOption(new Option('--exclude-pattern <re>', 'Regex to exclude repos by full name (used with --from-org)').hideHelp())
  .addOption(new Option('--skip-import', 'Only write drafts; skip the actual --from-repo-list run').hideHelp())
  .addOption(new Option('--iwiki-dual', 'Enable dual-output mode for --from-iwiki (write codebase sections in addition to learning)').hideHelp())
  .addOption(new Option('--require-review', 'Defer codebase section writes to .teamai/pending-review.jsonl for human review').hideHelp())
  .option('--cache-status', 'Show import cache status (repos cached, disk usage)')
  .option('--cache-gc', 'Garbage-collect stale import cache entries')
  .option('--json', 'Output cache status or GC result as JSON')
  .addOption(new Option('--max-bytes <n>', 'Override capacity cap for --cache-gc').hideHelp())
  .addOption(new Option('--stale-days <n>', 'Threshold for stale-eviction in days (default 30)').default('30').hideHelp())
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();

    if (cmdOpts.cacheStatus || cmdOpts.cacheGc) {
      const { cacheCmd } = await import('./cache-cmd.js');
      await cacheCmd({
        ...globalOpts,
        status: cmdOpts.cacheStatus,
        gc: cmdOpts.cacheGc,
        maxBytes: cmdOpts.maxBytes,
        staleDays: cmdOpts.staleDays,
        json: cmdOpts.json,
      });

      return;
    }

    const { importCmd } = await import('./import.js');
    await importCmd({ ...globalOpts, ...cmdOpts });
  });

/** Runs a verb of a workflow step: prints what it answers as JSON, or says why it failed and exits 1, 65 when its flags are not what the step passes. */
async function importVerb<TAnswer>(run: () => Promise<TAnswer>): Promise<void> {
  setStderrOnly(true);
  const { ImportInputError } = await import('./import-from-repo.js');
  // Only JSON goes to stdout: the lines the extractor prints are the step's progress, kept on the stream they were for.
  const { log: stdoutLog } = console;
  console.log = (...args: unknown[]) => writeInfoLine(format(...args));

  try {
    const answer = await run();
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));

    if (error instanceof ImportInputError) await rejectVerbInput();
    else process.exitCode = 1;
  } finally {
    console.log = stdoutLog;
  }
}

// The verbs teamai-import-rules and teamai-import-learnings runs' steps call.
importCommand
  .command('scan-rules')
  .description('A step of a teamai-import-rules run: list the rule files in the user rules directory of every AI coding tool teamai supports. Prints {"candidates":[{"path","file"}]}.')
  .action(async () => {
    const { ImportLearnings } = await import('./import-local.js');
    await importVerb(() => ImportLearnings.scanRules());
  });

importCommand
  .command('read-candidate')
  .description('A step of a teamai-import-learnings run: read the start of a file to classify, as much as the AI tool is shown. Prints {"content"}.')
  .requiredOption('--file <path>', 'The file that holds the item\'s text')
  .action(async (cmdOpts: { file: string }) => {
    const { ImportLearnings } = await import('./import-local.js');
    await importVerb(() => ImportLearnings.readCandidate(cmdOpts));
  });

importCommand
  .command('classify-reply')
  .description('A step of a teamai-import-learnings run: read what the AI tool said a file is. A reply that is not the JSON asked for reads as personal, so the file is left out. Prints {"type","title","summary","tags","personal"}.')
  .requiredOption('--path <path>', 'The path the file is shown as')
  .requiredOption('--reply <text>', 'What the AI tool answered')
  .action(async (cmdOpts: { path: string; reply: string }) => {
    const { ImportLearnings } = await import('./import-local.js');
    await importVerb(async () => ImportLearnings.classifyReply(cmdOpts));
  });

importCommand
  .command('write-learnings')
  .description('A step of a teamai-import-learnings run: write each item that is not personal and was accepted, or edited with the note as its title, with its type in the frontmatter, into rules/, docs/ or learnings/ of the team repo by that type, or all into one directory. Prints {"kept","written"}.')
  .requiredOption('--classified <json>', 'The results of the classify step')
  .option('--reviewed <json>', 'The results of the review step; empty accepts every item', '')
  .requiredOption('--target <dir>', 'The team repo, or the directory every item is written into')
  .requiredOption('--by-type <bool>', 'true writes by type into rules/, docs/ and learnings/ of --target')
  .action(async (cmdOpts: { classified: string; reviewed: string; target: string; byType: string }) => {
    const { ImportLearnings } = await import('./import-local.js');
    await importVerb(() => ImportLearnings.writeLearnings(cmdOpts));
  });

importCommand
  .command('publish-rules')
  .description('A step of a teamai-import-rules run: commit and push what the import wrote into the team repo, then say the import is complete. Prints {}.')
  .requiredOption('--kept <n>', 'How many items were not personal')
  .requiredOption('--written <json>', 'The files the import wrote')
  .requiredOption('--target <dir>', 'The team repo, or the directory every item was written into')
  .requiredOption('--by-type <bool>', 'true when --target is the team repo, which is pushed')
  .action(async (cmdOpts: { kept: string; written: string; target: string; byType: string }) => {
    const { ImportLearnings } = await import('./import-local.js');
    await importVerb(() => ImportLearnings.publishRules(cmdOpts));
  });

// The verbs a teamai-import-from-mr run's steps call.
importCommand
  .command('fetch-mr')
  .description('A step of a teamai-import-from-mr run: read a merged MR or PR, with its review threads, as the extraction prompt shows it. Prints {"url","title","description","commits","diff","threads","thread_count","author","date"}.')
  .requiredOption('--url <url>', 'The MR or PR URL: GitHub, TGit or GitLab')
  .requiredOption('--mrs <json>', 'Every MR URL of the run, to say which of them this is')
  .option('--threads <bool>', 'false leaves the review threads out', 'true')
  .action(async (cmdOpts: { url: string; mrs: string; threads: string }) => {
    const { ImportFromMr } = await import('./import-from-mr.js');
    await importVerb(() => ImportFromMr.fetch(cmdOpts));
  });

importCommand
  .command('draft-mr')
  .description('A step of a teamai-import-from-mr run: keep the learning the AI tool wrote for an MR in $TEAMAI_RUN_DIR, and say its title, its tags and the existing learnings it overlaps. Prints {"title","file","tags","overlaps","repo_url"}.')
  .requiredOption('--url <url>', 'The MR or PR URL')
  .requiredOption('--title <title>', 'The MR\'s title, the learning\'s title when its frontmatter has none')
  .requiredOption('--reply <markdown>', 'What the AI tool answered')
  .action(async (cmdOpts: { url: string; title: string; reply: string }) => {
    const { ImportFromMr } = await import('./import-from-mr.js');
    await importVerb(() => ImportFromMr.draft(cmdOpts));
  });

importCommand
  .command('publish-mr')
  .description('A step of a teamai-import-from-mr run: publish each accepted learning, or the edited one under the note as its title, as teamai contribute does, then update and push the teamwiki of each repository whose evidence the team repo holds; or write each into one directory. Prints {"published"}.')
  .requiredOption('--extracted <json>', 'The results of the extract step')
  .option('--reviewed <json>', 'The results of the review step; empty accepts every draft', '')
  .requiredOption('--target <dir>', 'The team repo, or the directory every draft is written into')
  .requiredOption('--drafts <bool>', 'true writes each draft into --target as learning.md and publishes nothing')
  .action(async (cmdOpts: { extracted: string; reviewed: string; target: string; drafts: string }) => {
    const { ImportFromMr } = await import('./import-from-mr.js');
    await importVerb(() => ImportFromMr.publish(cmdOpts));
  });

importCommand
  .command('finish-mr')
  .description('A step of a teamai-import-from-mr run: sum up a run of several MRs and name each that failed. Prints {"text","exit_code","learnings"}: exit_code 1 when an MR failed.')
  .requiredOption('--extracted <json>', 'The results of the extract step')
  .action(async (cmdOpts: { extracted: string }) => {
    const { ImportFromMr } = await import('./import-from-mr.js');
    await importVerb(async () => ImportFromMr.finish(cmdOpts));
  });

// The verbs a teamai-import-from-iwiki run's steps call.
importCommand
  .command('fetch-iwiki')
  .description('A step of a teamai-import-from-iwiki run: download the pages of an iWiki space, or one page, into $TEAMAI_RUN_DIR/iwiki/, with TAI_PAT_TOKEN. Prints {"source","documents","candidates":[{"path","file"}],"dual_context"}.')
  .requiredOption('--source <space-id-or-url>', 'A numeric space id, or a page URL holding /p/<id>')
  .option('--dual <bool>', 'true also prints the pages as the dual sections are asked about', 'false')
  .action(async (cmdOpts: { source: string; dual: string }) => {
    const { ImportFromIwiki } = await import('./import-iwiki.js');
    await importVerb(() => ImportFromIwiki.fetch(cmdOpts));
  });

importCommand
  .command('publish-iwiki')
  .description('A step of a teamai-import-from-iwiki run: link the imported pages to the teamwiki\'s code knowledge, then commit and push what the import wrote into the team repo. Prints {}.')
  .requiredOption('--kept <n>', 'How many items were not personal')
  .requiredOption('--written <json>', 'The files the import wrote')
  .requiredOption('--target <dir>', 'The team repo, or the directory every item was written into')
  .requiredOption('--by-type <bool>', 'true when --target is the team repo, which is pushed')
  .requiredOption('--documents <file>', 'The JSON file of the documents the fetch-iwiki step printed')
  .action(async (cmdOpts: { kept: string; written: string; target: string; byType: string; documents: string }) => {
    const { ImportFromIwiki } = await import('./import-iwiki.js');
    await importVerb(() => ImportFromIwiki.publish(cmdOpts));
  });

importCommand
  .command('write-sections')
  .description('A step of a teamai-import-from-iwiki run: write the business API, external knowledge and glossary sections the AI tool found into external-knowledge.md, or queue them in .teamai/pending-review.jsonl. Prints {}.')
  .requiredOption('--source <iwiki-url>', 'iwiki://<id>, recorded in each section')
  .option('--reply <text>', 'What the AI tool answered', '')
  .option('--failure <message>', 'Why the AI tool did not answer, when it did not', '')
  .requiredOption('--sections-dir <dir>', 'The directory that holds external-knowledge.md')
  .requiredOption('--review-dir <dir>', 'The directory whose .teamai/pending-review.jsonl takes the sections with --review')
  .option('--review <bool>', 'true queues the sections for teamai review instead of writing them', 'false')
  .action(async (cmdOpts: { source: string; reply: string; failure: string; sectionsDir: string; reviewDir: string; review: string }) => {
    const { writeSections } = await import('./iwiki-dual.js');
    await importVerb(() => writeSections(cmdOpts));
  });

// The verbs a teamai-import-from-repo run's steps call.
importCommand
  .command('stage')
  .description('A step of a teamai-import-from-repo run: fetch a repository into its clone cache, or read a local checkout, and extract it into a staging teamwiki under $TEAMAI_RUN_DIR, with no AI call. Prints {"slug","stage","updated","enrich","narrate","context","head","finished"}.')
  .requiredOption('--item <json>', 'The item: {"kind":"repo"|"dir","source","domain","auth","slug","repo_url","mr_urls"}')
  .requiredOption('--settings <json>', 'The run\'s settings: {"depth","ssh","incremental","skip_enrich","max_files","team_repo"}')
  .requiredOption('--wiki-root <dir>', 'The teamwiki the item is imported into')
  .action(async (cmdOpts: { item: string; settings: string; wikiRoot: string }) => {
    const { ImportFromRepo } = await import('./import-from-repo.js');
    await importVerb(() => ImportFromRepo.stage(cmdOpts));
  });

importCommand
  .command('publish')
  .description('A step of a teamai-import-from-repo run: publish an item\'s staged evidence into the teamwiki, with the narrative the AI tool wrote for a repository and the domain its list entry names, then reconcile the teamwiki. Prints {"deep"}: whether deep enrich follows.')
  .requiredOption('--item <json>', 'The item, as the stage step got it')
  .requiredOption('--settings <json>', 'The run\'s settings, as the stage step got them')
  .requiredOption('--wiki-root <dir>', 'The teamwiki the item is imported into')
  .requiredOption('--stage <dir>', 'The staging directory the stage step printed')
  .requiredOption('--slug <slug>', 'The codebase, its directory under evidence/code/')
  .option('--narrative <markdown>', 'What the tool answered for a repository\'s narrative', '')
  .option('--narrative-failure <message>', 'Why the tool could not answer for the narrative, when it could not', '')
  .action(async (cmdOpts: { item: string; settings: string; wikiRoot: string; stage: string; slug: string; narrative: string; narrativeFailure: string }) => {
    const { ImportFromRepo } = await import('./import-from-repo.js');
    const { whileTeamwikiLocked } = await import('./utils/teamwiki-root.js');
    await importVerb(() => whileTeamwikiLocked(cmdOpts.wikiRoot, () => ImportFromRepo.publish(cmdOpts)));
  });

importCommand
  .command('finish-item')
  .description('A step of a teamai-import-from-repo run: say how an item\'s deep enrich ended and record the commit a repository was imported at. Prints {"deep_complete"}.')
  .requiredOption('--item <json>', 'The item, as the stage step got it')
  .requiredOption('--settings <json>', 'The run\'s settings, as the stage step got them')
  .requiredOption('--wiki-root <dir>', 'The teamwiki the item is imported into')
  .requiredOption('--mode <mode>', 'The command that started the run: dir, repo, list, org, update or ci')
  .requiredOption('--slug <slug>', 'The codebase, its directory under evidence/code/')
  .option('--head <sha>', 'The commit a repository was fetched at', '')
  .option('--deep <complete>', 'What the deep-enrich run said: true, false, or empty when none ran', '')
  .option('--deep-failure <message>', 'Why the deep-enrich run failed, when it did: the deep enrich did not finish', '')
  .action(async (cmdOpts: { item: string; settings: string; wikiRoot: string; mode: string; slug: string; head: string; deep: string; deepFailure: string }) => {
    const { ImportFromRepo } = await import('./import-from-repo.js');
    await importVerb(() => ImportFromRepo.finishItem(cmdOpts));
  });

importCommand
  .command('finish')
  .description('A step of a teamai-import-from-repo run: once every item settled, rebuild the teamwiki indexes, publish the batch to the team repo, and sum it up. Prints {"text","exit_code","imported"}; exit_code is 1 when an item failed or its deep enrich did not finish.')
  .requiredOption('--mode <mode>', 'The command that started the run: dir, repo, list, org, update or ci')
  .requiredOption('--wiki-root <dir>', 'The teamwiki the items were imported into')
  .requiredOption('--settings <json>', 'The run\'s settings')
  .requiredOption('--results <json>', 'The results of the imports step')
  .option('--skipped <n>', 'How many entries of the list were skipped before the run', '0')
  .action(async (cmdOpts: { mode: string; wikiRoot: string; settings: string; skipped: string; results: string }) => {
    const { ImportFromRepo } = await import('./import-from-repo.js');
    const { whileTeamwikiLocked } = await import('./utils/teamwiki-root.js');
    await importVerb(() => whileTeamwikiLocked(cmdOpts.wikiRoot, () => ImportFromRepo.finish(cmdOpts)));
  });

program
  .command('mr-hint', { hidden: true })
  
  .description('Hint AI about recently merged but un-imported MRs (SessionStart hook)')
  .option('--stdin', 'Read hook data from STDIN')
  .option('--tool <name>', 'Source AI tool (claude / codebuddy / cursor)')
  .action(async (cmdOpts) => {
    if (cmdOpts.stdin) {
      const { mrHint } = await import('./mr-hint.js');
      await mrHint(cmdOpts.tool);
    }
  });

const codebaseCommand = program
  .command('codebase')
  .description('Inspect and maintain the teamwiki that `teamai import` writes')
  .addOption(new Option('--project <name>', 'Codebase slug under teamwiki/evidence/code/, required for --deep-enrich').hideHelp())
  .addOption(new Option('--upgrade-wiki', 'Migrate docs/team-codebase/ to teamwiki/ graph format').hideHelp())
  .option('--lint', 'Run global consistency lint over the teamwiki knowledge graph, and count the member\'s resource relations (resources, relations, without a relation, unresolved)')
  .option('--reconcile', 'Reconcile product and code knowledge in teamwiki')
  .option('--deep-enrich', 'Generate deep knowledge docs from extracted evidence. In the team repo it starts the default workflow teamai-codebase-deep-enrich on the driver workflows.driver names, else local, which publishes the docs; an --output teamwiki is written by this process')
  .addOption(new Option('--fix', 'Deprecated: teamwiki lint has no autofix; runs lint in report-only mode').hideHelp())
  .option('--status', 'Show knowledge-base git baseline (headSha / repoUrl / branch)')
  .addOption(new Option('--severity <level>', 'Minimum severity to report: high|medium|low|info').default('info').hideHelp())
  .option('--json', 'Output report as JSON (suitable for CI)')
  .addOption(new Option('--output <path>', 'Use <path>/teamwiki, as written by `teamai import --output <path>`, instead of the team repo\'s').hideHelp())
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { codebaseCmd } = await import('./codebase-cmd.js');
    await codebaseCmd({ ...globalOpts, ...cmdOpts });
  });

/** The target a `codebase deep-enrich-*` verb's flags name; undefined, said and exited 65, when they name none. */
async function deepEnrichVerbTarget(flags: { wikiRoot: string; codebase: string; maxModules: string }): Promise<import('./deep-enrich.js').DeepEnrichTarget | undefined> {
  const { DeepEnrich } = await import('./deep-enrich.js');
  const parsed = DeepEnrich.targetOf(flags);

  if (parsed.ok) return parsed.target;
  log.error(parsed.message);
  await rejectVerbInput();

  return undefined;
}

/** Exits a verb 65, so its step fails input_rejected and no retry is offered. */
async function rejectVerbInput(): Promise<void> {
  const { INPUT_REJECTED_EXIT } = await import('./workflow/protocol.js');
  process.exitCode = INPUT_REJECTED_EXIT;
}

// The verbs a teamai-codebase-deep-enrich run's steps call.
codebaseCommand
  .command('deep-enrich-plan')
  .description('A step of a teamai-codebase-deep-enrich run: refuse a symbolic link on the way to the docs, drop the AI docs a newer extract made stale, and list what is still missing. Prints {"components":[{"slug","responsibilities","facts","call_chains","deps"}],"architecture":{"needed","modules","edges","interfaces"}}. Exits 65 when _manifest.json has no component.')
  .requiredOption('--wiki-root <dir>', 'The teamwiki directory')
  .requiredOption('--codebase <slug>', 'The codebase, its directory under evidence/code/')
  .option('--max-modules <n>', 'Only the first n components of the manifest; 0 takes every one', '0')
  .action(async (cmdOpts: { wikiRoot: string; codebase: string; maxModules: string }) => {
    setStderrOnly(true);
    const target = await deepEnrichVerbTarget(cmdOpts);

    if (!target) return;
    const { DeepEnrich } = await import('./deep-enrich.js');
    const { whileTeamwikiLocked } = await import('./utils/teamwiki-root.js');
    const planned = await whileTeamwikiLocked(target.wikiRoot, () => DeepEnrich.plan(target));

    if (planned) {
      process.stdout.write(`${JSON.stringify(planned)}\n`);

      return;
    }

    await rejectVerbInput();
  });

codebaseCommand
  .command('deep-enrich-write')
  .description('A step of a teamai-codebase-deep-enrich run: write one component\'s design doc, or the architecture overview, from what the AI tool answered, or say why it has none. Prints {"written"}.')
  .requiredOption('--wiki-root <dir>', 'The teamwiki directory')
  .requiredOption('--codebase <slug>', 'The codebase, its directory under evidence/code/')
  .option('--component <slug>', 'The component whose doc this is')
  .option('--architecture', 'The doc is the architecture overview')
  .option('--text <markdown>', 'What the tool answered', '')
  .option('--failure <message>', 'Why the tool could not answer, when it could not', '')
  .action(async (cmdOpts: { wikiRoot: string; codebase: string; component?: string; architecture?: boolean; text: string; failure: string }) => {
    setStderrOnly(true);
    const target = await deepEnrichVerbTarget({ ...cmdOpts, maxModules: '0' });

    if (!target) return;

    if ((cmdOpts.component === undefined) === (cmdOpts.architecture !== true)) {
      log.error('Pass either --component <slug> or --architecture.');
      await rejectVerbInput();

      return;
    }

    const { DeepEnrich } = await import('./deep-enrich.js');
    const doc = cmdOpts.component === undefined ? { kind: 'architecture' as const } : { kind: 'component' as const, slug: cmdOpts.component };
    const { whileTeamwikiLocked } = await import('./utils/teamwiki-root.js');
    const written = await whileTeamwikiLocked(target.wikiRoot, () => DeepEnrich.write(target, doc, { text: cmdOpts.text, failure: cmdOpts.failure }));
    process.stdout.write(`${JSON.stringify(written)}\n`);
  });

codebaseCommand
  .command('deep-enrich-graph')
  .description('A step of a teamai-codebase-deep-enrich run: write the deterministic graph docs and the G6 triples, and say whether the G5 scenarios are still to be asked for. Prints {"scenarios":{"needed","architecture","call_chains","modules"}}.')
  .requiredOption('--wiki-root <dir>', 'The teamwiki directory')
  .requiredOption('--codebase <slug>', 'The codebase, its directory under evidence/code/')
  .option('--max-modules <n>', 'Only the first n components of the manifest; 0 takes every one', '0')
  .action(async (cmdOpts: { wikiRoot: string; codebase: string; maxModules: string }) => {
    setStderrOnly(true);
    const target = await deepEnrichVerbTarget(cmdOpts);

    if (!target) return;
    const { DeepEnrich } = await import('./deep-enrich.js');
    const { whileTeamwikiLocked } = await import('./utils/teamwiki-root.js');
    process.stdout.write(`${JSON.stringify(await whileTeamwikiLocked(target.wikiRoot, () => DeepEnrich.graph(target)))}\n`);
  });

codebaseCommand
  .command('deep-enrich-finish')
  .description('A step of a teamai-codebase-deep-enrich run: write the G5 scenarios from what the AI tool answered, the graph router, the teamwiki indexes and the quality reports, and say which AI docs are still missing. Prints {"text","exit_code","complete","missing_components","missing_architecture"}; exit_code is 1 when a doc is missing.')
  .requiredOption('--wiki-root <dir>', 'The teamwiki directory')
  .requiredOption('--codebase <slug>', 'The codebase, its directory under evidence/code/')
  .option('--max-modules <n>', 'Only the first n components of the manifest; 0 takes every one', '0')
  .option('--scenarios <markdown>', 'What the tool answered for the scenarios', '')
  .option('--scenarios-failure <message>', 'Why the tool could not answer for the scenarios, when it could not', '')
  .action(async (cmdOpts: { wikiRoot: string; codebase: string; maxModules: string; scenarios: string; scenariosFailure: string }) => {
    setStderrOnly(true);
    const target = await deepEnrichVerbTarget(cmdOpts);

    if (!target) return;
    const { DeepEnrich } = await import('./deep-enrich.js');
    const { whileTeamwikiLocked } = await import('./utils/teamwiki-root.js');
    const finished = await whileTeamwikiLocked(target.wikiRoot, () => DeepEnrich.finish(target, { text: cmdOpts.scenarios, failure: cmdOpts.scenariosFailure }));
    process.stdout.write(`${JSON.stringify(finished)}\n`);
  });

codebaseCommand
  .command('deep-enrich-publish')
  .description('A step of a teamai-codebase-deep-enrich run: commit and push the codebase\'s evidence and docs, with the teamwiki\'s router.md and index.md, to the team repo that holds the teamwiki. Prints {"pushed"}.')
  .requiredOption('--wiki-root <dir>', 'The teamwiki directory')
  .requiredOption('--codebase <slug>', 'The codebase, its directory under evidence/code/')
  .action(async (cmdOpts: { wikiRoot: string; codebase: string }) => {
    setStderrOnly(true);
    const target = await deepEnrichVerbTarget({ ...cmdOpts, maxModules: '0' });

    if (!target) return;
    const { DeepEnrich } = await import('./deep-enrich.js');
    const { whileTeamwikiLocked } = await import('./utils/teamwiki-root.js');
    process.stdout.write(`${JSON.stringify(await whileTeamwikiLocked(target.wikiRoot, () => DeepEnrich.publish(target)))}\n`);
  });

async function codebaseEnrichVerbTarget(flags: { wikiRoot: string; codebase: string }): Promise<import('./enrich-with-ai.js').CodebaseEnrichTarget | undefined> {
  const { CodebaseEnrich } = await import('./enrich-with-ai.js');
  const parsed = CodebaseEnrich.targetOf(flags);

  if (parsed.ok) return parsed.target;
  log.error(parsed.message);
  await rejectVerbInput();

  return undefined;
}

async function moduleRepliesOf(results: string): Promise<import('./enrich-with-ai.js').ModuleReply[] | undefined> {
  const { CodebaseEnrich } = await import('./enrich-with-ai.js');
  const parsed = CodebaseEnrich.repliesOf(results);

  if (parsed.ok) return parsed.replies;
  log.error(parsed.message);
  await rejectVerbInput();

  return undefined;
}

// The verbs a teamai-codebase-enrich run's steps call.
codebaseCommand
  .command('enrich-plan')
  .description('A step of a teamai-codebase-enrich run: list the modules of a codebase with at least five facts in the teamwiki\'s facts cache, which the last extract wrote. Prints {"modules":[{"name","files","components","interfaces"}],"interfaces"}.')
  .requiredOption('--wiki-root <dir>', 'The teamwiki directory the codebase was extracted into')
  .requiredOption('--codebase <slug>', 'The codebase, its directory under evidence/code/')
  .action(async (cmdOpts: { wikiRoot: string; codebase: string }) => {
    setStderrOnly(true);
    const target = await codebaseEnrichVerbTarget(cmdOpts);

    if (!target) return;
    const { CodebaseEnrich } = await import('./enrich-with-ai.js');
    process.stdout.write(`${JSON.stringify(await CodebaseEnrich.plan(target))}\n`);
  });

codebaseCommand
  .command('enrich-summary')
  .description('A step of a teamai-codebase-enrich run: read what the AI tool answered about each module, for the domain prompt. Prints {"count","project","modules"}; count is 0 when a module could not be asked or no answer parsed, and nothing is to be written.')
  .requiredOption('--codebase <slug>', 'The codebase, its directory under evidence/code/')
  .requiredOption('--results <json>', 'The results of the modules step')
  .action(async (cmdOpts: { codebase: string; results: string }) => {
    setStderrOnly(true);
    const replies = await moduleRepliesOf(cmdOpts.results);

    if (!replies) return;
    const { CodebaseEnrich } = await import('./enrich-with-ai.js');
    process.stdout.write(`${JSON.stringify(CodebaseEnrich.summary(cmdOpts.codebase, replies))}\n`);
  });

codebaseCommand
  .command('enrich-write')
  .description('A step of a teamai-codebase-enrich run: write _manifest.json and _domains.json beside the codebase\'s evidence from what the AI tool answered. Prints {"modules","domain"}; modules is 0 when nothing was written.')
  .requiredOption('--wiki-root <dir>', 'The teamwiki directory the codebase was extracted into')
  .requiredOption('--codebase <slug>', 'The codebase, its directory under evidence/code/')
  .requiredOption('--results <json>', 'The results of the modules step')
  .option('--domain <json>', 'What the tool answered for the domain', '')
  .option('--domain-failure <message>', 'Why the tool could not answer for the domain, when it could not', '')
  .action(async (cmdOpts: { wikiRoot: string; codebase: string; results: string; domain: string; domainFailure: string }) => {
    setStderrOnly(true);
    const target = await codebaseEnrichVerbTarget(cmdOpts);
    const replies = target && await moduleRepliesOf(cmdOpts.results);

    if (!target || !replies) return;
    const { CodebaseEnrich } = await import('./enrich-with-ai.js');
    process.stdout.write(`${JSON.stringify(await CodebaseEnrich.write(target, replies, { text: cmdOpts.domain, failure: cmdOpts.domainFailure }))}\n`);
  });


program
    .command('review [id]')
    .description('Inspect and process .teamai/pending-review.jsonl items; --dry-run validates apply decisions and previews rejections without writing documents or removing pending items. With --branch <name>, run read-only health checks on a team repo branch instead')
    .option('--apply', 'Apply the change for the given id (only for codebase-section)')
    .option('--reject', 'Reject the given id without applying')
    .option('--reason <msg>', 'Reason for reject')
    .option('--all-apply', 'Apply all items at or below --max-risk')
    .option('--max-risk <level>', 'Risk ceiling for --all-apply: high|medium|low (default medium)', 'medium')
    .option('--branch <name>', 'Run read-only health checks on this team repo branch (e.g. teamai/push/<user>/<timestamp>) and report fail/warn/info findings')
    .option('--json', 'Machine-readable output (dry-run decisions include dryRun: true; ok reports validation only; --branch prints the findings object)')
    .action(async (idArg, cmdOpts) => {
        const globalOpts = program.opts<GlobalOptions>();

        if (cmdOpts.branch) {
            const { reviewBranchCmd } = await import('./review-branch.js');
            await reviewBranchCmd({ ...globalOpts, ...cmdOpts, branch: cmdOpts.branch });

            return;
        }

        const { reviewCmd } = await import('./review-cmd.js');
        await reviewCmd({ ...globalOpts, ...cmdOpts, idArg });
    });

// ─── Unified hook dispatch (replaces individual hook subcommands) ────

// ─── CI 命令组 ──────────────────────────────────────────

const ciCmd = program
  .command('ci')
  .description('CI pipeline integration commands');

ciCmd
  .command('extract-mr')
  .description('Extract knowledge from MR/PR and post as comment or write to team repo: starts the default workflow teamai-ci-extract-mr on the local driver, with no teamai init needed; a run with none takes --team-repo\'s teamai.yaml and workflows')
  .requiredOption('--url <url>', 'MR/PR web URL')
  .option('--mode <mode>', 'Operation mode: comment | write | both', 'comment')
  .option('--team-repo <path>', 'Team knowledge repo path (required for write mode)')
  .option('--comment-marker <marker>', 'HTML comment anchor for idempotent updates', '<!-- teamai:ci-extract -->')
  .option('--write-mode <mode>', 'Write strategy: direct; pending-review has no effect and writes as direct does', 'direct')
  .option('--output <dir>', 'Write artifacts to directory')
  .option('--individual-comments', 'Post each suggestion as separate comment with reaction/resolve support')
  .option('--no-discussions', 'Leave the MR\'s review threads out of the extraction')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts<GlobalOptions>();
    const { CiExtractMr } = await import('./ci/extract-mr.js');
    await CiExtractMr.start({ ...globalOpts, ...cmdOpts });
  });

// The verbs a teamai-ci-extract-mr run's steps call.
ciCmd
  .command('comment')
  .description('A step of a teamai-ci-extract-mr run: post the drafted learning on the MR, as the comment --marker finds and updates or as its own comment, then the knowledge graph nodes of the source files the merge changed. Prints {}.')
  .requiredOption('--url <url>', 'The MR or PR URL')
  .requiredOption('--learnings <json>', 'The learnings output of the extract step')
  .requiredOption('--marker <marker>', 'The HTML comment the MR comment is found and updated by')
  .requiredOption('--individual <bool>', 'true posts the learning as its own comment, with reaction support')
  .requiredOption('--preview <bool>', 'true says each comment instead of posting it')
  .action(async (cmdOpts: { url: string; learnings: string; marker: string; individual: string; preview: string }) => {
    const { CiExtractMr } = await import('./ci/extract-mr.js');
    await importVerb(() => CiExtractMr.comment(cmdOpts));
  });

ciCmd
  .command('write')
  .description('A step of a teamai-ci-extract-mr run: update the team repo\'s teamwiki from the merged checkout when a source file changed, write the drafted learning into its learnings/, and commit and push both, leaving out what a reviewer rejected on an individual comment. Prints {}.')
  .requiredOption('--url <url>', 'The MR or PR URL')
  .requiredOption('--learnings <json>', 'The learnings output of the extract step')
  .requiredOption('--team-repo <path>', 'The team repo\'s checkout')
  .requiredOption('--individual <bool>', 'true reads the reactions on the individual comments')
  .requiredOption('--preview <bool>', 'true says the learning\'s file and writes and pushes nothing')
  .action(async (cmdOpts: { url: string; learnings: string; teamRepo: string; individual: string; preview: string }) => {
    const { CiExtractMr } = await import('./ci/extract-mr.js');
    await importVerb(() => CiExtractMr.write(cmdOpts));
  });

ciCmd
  .command('artifacts')
  .description('A step of a teamai-ci-extract-mr run: write the drafted learning into a directory as learning.md. Prints {}.')
  .requiredOption('--learnings <json>', 'The learnings output of the extract step')
  .requiredOption('--dir <path>', 'The directory')
  .action(async (cmdOpts: { learnings: string; dir: string }) => {
    const { CiExtractMr } = await import('./ci/extract-mr.js');
    await importVerb(() => CiExtractMr.artifacts(cmdOpts));
  });

program
  .command('deep-enrich', { hidden: true })
  .description('Run deep AI knowledge generation for an imported repo, as codebase --deep-enrich does, without publishing: the default workflow teamai-codebase-deep-enrich, on the team repo\'s teamwiki or another --wiki-root, which needs no teamai init')
  .requiredOption('--project <slug>', 'Project slug (directory name in evidence/code/)')
  .option('--wiki-root <path>', 'Teamwiki root path')
  .option('--max-modules <n>', 'Max modules to process (cost control)', parseInt)
  .action(async (cmdOpts: { project: string; wikiRoot?: string; maxModules?: number }) => {
    const { hiddenDeepEnrichTarget, startDeepEnrich } = await import('./codebase-cmd.js');
    const { DetachedTeamRepoError } = await import('./utils/git.js');

    try {
      await startDeepEnrich({
        target: await hiddenDeepEnrichTarget(cmdOpts.wikiRoot),
        project: cmdOpts.project,
        maxModules: cmdOpts.maxModules,
        json: false,
        command: `teamai deep-enrich --project ${cmdOpts.project}`,
      });
    } catch (error) {
      if (!(error instanceof DetachedTeamRepoError)) throw error;
      log.error(error.message);
      process.exitCode = 1;
    }
  });

recallCmd
  .command('feedback')
  .description('Record manual feedback for a recalled document')
  .option('--positive <docId>', 'Upvote a document (marks as actually useful)')
  .option('--negative <docId>', 'Record negative signal for a document')
  .action(async (cmdOpts) => {
    const { recallFeedback } = await import('./votes.js');
    const globalOpts = program.opts<GlobalOptions>();
    await recallFeedback({ positive: cmdOpts.positive, negative: cmdOpts.negative, dryRun: globalOpts.dryRun });
  });

const maintenanceCmd = recallCmd
  .command('maintenance')
  .description('Automatic maintenance of team knowledge base')
  .option('--prune', 'Remove low-confidence learnings')
  .option('--threshold <n>', 'Confidence threshold for pruning (default 0.15)', (value) => {
    const threshold = value.trim() === '' ? NaN : Number(value);

    if (!Number.isFinite(threshold)) throw new Error('--threshold must be a finite number');

    return threshold;
  })
  .option('--archive', 'Move to archive/ instead of deleting')
  .option('--confidence-writeback', 'Update frontmatter confidence scores')
  .option('--update-quality', 'Find stale docs/rules/skills and write a .draft.md update beside each: starts the default workflow teamai-draft-learning-updates on the driver workflows.driver names, else local, prints what it drafted, and exits 1 when an entry could not be drafted. --dry-run only lists the entries')
  .option('--json', 'With --update-quality: print the run\'s JSON envelope instead of its text')
  .option('--dry-run', 'Show what would be done without making changes')
  .action(async (localOpts) => {
    // The root program takes `--dry-run` wherever it is written, so this
    // command's own declaration never sets it: read it merged, as the other
    // actions do (#900).
    const cmdOpts = { ...program.opts<GlobalOptions>(), ...localOpts };

    if (!cmdOpts.confidenceWriteback && !cmdOpts.prune && !cmdOpts.updateQuality) {
      log.info('Usage: teamai recall maintenance --prune | --confidence-writeback | --update-quality');

      return;
    }

    // The other modes come first, as below. Its steps resolve the checkouts they read themselves; the run is told where the drafts land.
    if (cmdOpts.updateQuality && !cmdOpts.confidenceWriteback && !cmdOpts.prune && !cmdOpts.dryRun) {
      const paths = await maintenanceVerbPaths({ dryRun: false });

      if (!paths) return;
      const { runShortcut } = await import('./workflow-commands.js');
      await runShortcut({ workflow: 'teamai-draft-learning-updates', inputs: { knowledge_root: paths.repoPath }, command: 'teamai recall maintenance --update-quality', json: cmdOpts.json === true });

      return;
    }

    const { autoDetectInit } = await import('./config.js');
    const { localConfig } = await autoDetectInit(undefined, { dryRun: cmdOpts.dryRun });
    const paths = await maintenancePathsOrExit(localConfig, { dryRun: cmdOpts.dryRun });

    if (!paths) return;

    const {
      repoPath, votesDir, learningsReadDirs, learningsWriteDir,
    } = paths;

    const { safeDeliveredLearningsNamespaces } = await import('./workspace-children.js');
    const learningsNamespaces = await safeDeliveredLearningsNamespaces(localConfig, 'recall maintenance');

    if (cmdOpts.confidenceWriteback) {
      const { computeAllConfidence, writeBackConfidence } = await import('./maintenance/index.js');
      const map = await computeAllConfidence(votesDir);

      const written = await writeBackConfidence(learningsReadDirs, map, learningsWriteDir, {
        dryRun: cmdOpts.dryRun,
        namespaces: learningsNamespaces,
      });

      if (written.length > 0 && !cmdOpts.dryRun) {
        await publishMaintenance(localConfig, `[teamai] Update confidence for ${written.length} learning(s)`, written);
      }

      return;
    }

    if (cmdOpts.prune) {
      const { findPruneCandidates, executePrune } = await import('./maintenance/index.js');

      const candidates = await findPruneCandidates(learningsReadDirs, votesDir, {
        threshold: cmdOpts.threshold,
        namespaces: learningsNamespaces,
      });

      if (candidates.length === 0) {
        log.info('No learnings below threshold. Knowledge base is healthy.');

        return;
      }

      log.info(`Found ${candidates.length} candidate(s) for pruning:`);

      for (const c of candidates) {
        log.info(`  - ${c.filename} (confidence: ${c.confidence.toFixed(2)}, reason: ${c.reason})`);
      }

      const pruned = await executePrune(learningsWriteDir, candidates, {
        dryRun: cmdOpts.dryRun,
        archive: cmdOpts.archive,
      });

      if (pruned.archived + pruned.removed > 0) {
        await publishMaintenance(
          localConfig,
          `[teamai] Prune ${pruned.archived + pruned.removed} learning(s)`,
          pruned.changed,
        );
      }

      return;
    }

    if (cmdOpts.updateQuality) {
      // Listing makes no AI call, so a dry run lists here and starts no run.
      const { findStaleEntries, reportStaleEntries } = await import('./maintenance/index.js');
      const { DefaultFolders } = await import('./default-folders.js');
      const { params: gates } = await DefaultFolders.load({ kind: 'workflows', name: 'teamai-draft-learning-updates' }, localConfig);
      reportStaleEntries(await findStaleEntries(votesDir, { docs: `${repoPath}/docs`, rules: `${repoPath}/rules`, skills: `${repoPath}/skills` }, gates));

      return;
    }
  });

// The verbs a teamai-draft-learning-updates run's steps call.
maintenanceCmd
  .command('stale')
  .description('A step of a teamai-draft-learning-updates run: list the docs, rules and skills recalled often but rarely adopted, as --update-quality --dry-run does, on stderr. Prints {"entries":[{"doc_id","path","type","recalled_count","upvoted_count","user_count"}]}.')
  .action(async () => {
    setStderrOnly(true);
    const paths = await maintenanceVerbPaths({ dryRun: false });

    if (!paths) return;
    const { DraftLearningUpdates } = await import('./maintenance/index.js');
    const { DefaultFolders } = await import('./default-folders.js');
    const { params: gates } = await DefaultFolders.load({ kind: 'workflows', name: 'teamai-draft-learning-updates' }, paths.config);
    process.stdout.write(`${JSON.stringify(await DraftLearningUpdates.stale(paths.votesDir, paths.repoPath, gates))}\n`);
  });

maintenanceCmd
  .command('draft-context')
  .description('A step of a teamai-draft-learning-updates run: the content of one stale entry, and the learnings members adopted instead, as the prompt shows them. Prints {"content","related"}; related is empty when no learning was adopted. Fails when the entry cannot be read.')
  .requiredOption('--path <file>', 'The entry, as stale printed its path')
  .requiredOption('--doc-id <id>', 'The entry\'s doc_id, as stale printed it')
  .action(async (cmdOpts: { path: string; docId: string }) => {
    setStderrOnly(true);
    // The stale step refreshed the checkouts this run reads.
    const paths = await maintenanceVerbPaths({ dryRun: true });

    if (!paths) return;
    const { DraftLearningUpdates } = await import('./maintenance/index.js');
    const { safeDeliveredLearningsNamespaces } = await import('./workspace-children.js');
    const namespaces = await safeDeliveredLearningsNamespaces(paths.config, 'recall maintenance');
    const { DefaultFolders } = await import('./default-folders.js');
    const { params } = await DefaultFolders.load({ kind: 'workflows', name: 'teamai-draft-learning-updates' }, paths.config);
    process.stdout.write(`${JSON.stringify(await DraftLearningUpdates.context({ path: cmdOpts.path, docId: cmdOpts.docId }, paths.votesDir, paths.learningsReadDirs, { limit: params.max_related, namespaces }))}\n`);
  });

maintenanceCmd
  .command('write-draft')
  .description('A step of a teamai-draft-learning-updates run: write a draft update of one stale entry beside it, as <entry>.draft.md. Prints {"draft"}, its path.')
  .requiredOption('--path <file>', 'The entry, as stale printed its path')
  .requiredOption('--draft <text>', 'The draft\'s content')
  .action(async (cmdOpts: { path: string; draft: string }) => {
    setStderrOnly(true);
    const { DraftLearningUpdates } = await import('./maintenance/index.js');
    process.stdout.write(`${JSON.stringify(await DraftLearningUpdates.writeDraft(cmdOpts.path, cmdOpts.draft))}\n`);
  });

maintenanceCmd
  .command('draft-report')
  .description('A step of a teamai-draft-learning-updates run: from the results of its draft step, what --update-quality prints: each entry it could not draft, and how to apply the drafts. Prints {"text","exit_code"}; exit_code is 1 when an entry could not be drafted.')
  .requiredOption('--results <json>', 'The draft step\'s results, as a JSON array')
  .action(async (cmdOpts: { results: string }) => {
    setStderrOnly(true);
    const { DraftLearningUpdates } = await import('./maintenance/index.js');
    process.stdout.write(`${JSON.stringify(DraftLearningUpdates.report(DraftLearningUpdates.parseResults(cmdOpts.results)))}\n`);
  });

recallCmd
  .command('promote [learningId]')
  .description('List the learnings ready to promote, high-confidence and adopted by several members, each with the category its keywords suggest; listing makes no AI call. With a learning id: starts the default workflow teamai-promote-learning on the driver workflows.driver names, else local. The AI picks the category, unless --category gives it, and rewrites the learning for it; the result is pushed on a review branch with a pull request that says the category and why, then the learning is marked promoted. Exits 1 when the learning is not a candidate. --dry-run only says where it would go')
  .addOption(new Option('--category <cat>', 'Target category: skills | rules | docs; skills use <learningId>/SKILL.md. Without it, the AI picks one').choices(['skills', 'rules', 'docs']))
  .option('--dry-run', 'Show what would be done without making changes')
  .action(async (learningId: string | undefined, localOpts) => {
    // As in `recall maintenance`: `--dry-run` reaches the root's options only (#900).
    const cmdOpts = { ...program.opts<GlobalOptions>(), ...localOpts };

    if (learningId && !cmdOpts.dryRun) {
      const { runShortcut } = await import('./workflow-commands.js');
      await runShortcut({ workflow: 'teamai-promote-learning', inputs: { learning: learningId, category: cmdOpts.category ?? '' }, command: `teamai recall promote ${learningId}`, json: false });

      return;
    }

    const { autoDetectInit } = await import('./config.js');
    const { localConfig } = await autoDetectInit(undefined, { dryRun: cmdOpts.dryRun });
    const listed = await promotionListing(localConfig, { dryRun: cmdOpts.dryRun === true });

    if (!listed) return;
    const { paths, candidates } = listed;

    if (learningId) {
      const { PromotionCategorySchema, writePromotion } = await import('./maintenance/index.js');
      const candidate = candidates.find((c) => c.docId === learningId);

      if (!candidate) {
        log.error(`Learning "${learningId}" not found or not eligible for promotion.`);
        process.exitCode = 1;

        return;
      }

      const category = PromotionCategorySchema.optional().parse(cmdOpts.category) ?? candidate.suggestedCategory;
      await writePromotion(candidate, paths.repoPath, { category, dryRun: true });

      return;
    }

    if (candidates.length === 0) {
      log.info('No learnings eligible for promotion yet.');

      return;
    }

    log.info(`${candidates.length} learning(s) eligible for promotion:`);

    for (const c of candidates) {
      log.info(`  - ${c.docId} (confidence: ${c.confidence.toFixed(2)}, suggested: ${c.suggestedCategory})`);
    }

    log.info('\nRun: teamai recall promote <learning-id> [--category <cat>]');
  });

// The verbs a teamai-promote-learning run's steps call. They sit here rather than under `recall promote`, whose
// learning id would otherwise be taken for a verb of the same name.
maintenanceCmd
  .command('promote-candidate')
  .description('A step of a teamai-promote-learning run: the learning to promote, as recall promote lists it, with its title, its content and the category its keywords suggest. Prints {"title","content","suggested"}. Exits 65, which fails its step as input_rejected, when it is not a candidate; fails when this workspace cannot publish one.')
  .requiredOption('--learning <id>', 'The learning id, as recall promote lists it')
  .action(async (cmdOpts: { learning: string }) => {
    setStderrOnly(true);
    const { autoDetectInit } = await import('./config.js');
    const { localConfig } = await autoDetectInit(undefined, { dryRun: false });
    const { assertCanPromote } = await import('./maintenance/promotion-publish.js');
    assertCanPromote(localConfig);
    const listed = await promotionListing(localConfig, { dryRun: false });

    if (!listed) return;
    const candidate = listed.candidates.find((entry) => entry.docId === cmdOpts.learning);

    // The learning id is the run's input, so the run fails as one whose input was rejected, which no retry changes.
    if (!candidate) {
      const { INPUT_REJECTED_EXIT } = await import('./workflow/protocol.js');
      log.error(`Learning "${cmdOpts.learning}" not found or not eligible for promotion.`);
      process.exitCode = INPUT_REJECTED_EXIT;

      return;
    }

    const { readFileSafe } = await import('./utils/fs.js');
    process.stdout.write(`${JSON.stringify({ title: candidate.title, content: await readFileSafe(candidate.path) ?? '', suggested: candidate.suggestedCategory })}\n`);
  });

maintenanceCmd
  .command('promote-category')
  .description('A step of a teamai-promote-learning run: the category to promote to, and why: --given, else --chosen, else, when the AI could not choose, --suggested. Prints {"category","reason"}.')
  .requiredOption('--given <cat>', 'The category recall promote --category gave, or \'\'')
  .requiredOption('--chosen <cat>', 'The category the AI chose, or \'\' when it did not run or could not choose')
  .requiredOption('--reason <text>', 'Why the AI chose it, or \'\'')
  .addOption(new Option('--suggested <cat>', 'The category the learning\'s keywords suggest').choices(['skills', 'rules', 'docs']).makeOptionMandatory())
  .action(async (cmdOpts: { given: string; chosen: string; reason: string; suggested: string }) => {
    setStderrOnly(true);
    const { chooseCategory, PromotionCategorySchema } = await import('./maintenance/index.js');
    process.stdout.write(`${JSON.stringify(chooseCategory({ ...cmdOpts, suggested: PromotionCategorySchema.parse(cmdOpts.suggested) }))}\n`);
  });

maintenanceCmd
  .command('promote-publish')
  .description('A step of a teamai-promote-learning run: write the promoted entry, push it on a teamai/push/ review branch, and open a pull request whose body says the category and why. With an empty --content the learning is published as written. Prints {"target","exit_code"}; exit_code is 1 when no pull request could be opened.')
  .requiredOption('--learning <id>', 'The learning id, as recall promote lists it')
  .addOption(new Option('--category <cat>', 'The category to promote to, as the category step chose it').choices(['skills', 'rules', 'docs']).makeOptionMandatory())
  .requiredOption('--reason <text>', 'Why it is promoted to that category, as the pull request says it')
  .requiredOption('--content <text>', 'The learning rewritten for its category, or \'\' to publish it as written')
  .option('--content-failure <message>', 'Why the AI could not rewrite it, said when --content is empty', '')
  .action(async (cmdOpts: { learning: string; category: string; reason: string; content: string; contentFailure: string }) => {
    setStderrOnly(true);
    const { autoDetectInit } = await import('./config.js');
    const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: false });
    const { PromotionCategorySchema } = await import('./maintenance/index.js');
    const { PromoteLearning } = await import('./maintenance/promotion-publish.js');
    const { safeDeliveredLearningsNamespaces } = await import('./workspace-children.js');

    const published = await PromoteLearning.publish(cmdOpts.learning, localConfig, teamConfig, {
      category: PromotionCategorySchema.parse(cmdOpts.category),
      reason: cmdOpts.reason,
      content: cmdOpts.content === '' ? { kind: 'as-written', why: cmdOpts.contentFailure } : { kind: 'rewritten', text: cmdOpts.content },
      namespaces: await safeDeliveredLearningsNamespaces(localConfig, 'recall promote'),
    });

    process.stdout.write(`${JSON.stringify(published)}\n`);
  });

maintenanceCmd
  .command('promote-mark')
  .description('A step of a teamai-promote-learning run: mark the learning as promoted to the entry publish pushed, and publish the mark to the learnings branch. Prints {"exit_code"}; it is 1 when the pull request or the mark could not be published.')
  .requiredOption('--learning <id>', 'The learning id, as recall promote lists it')
  .requiredOption('--published <json>', 'What the publish step printed: {"target","exit_code"}')
  .action(async (cmdOpts: { learning: string; published: string }) => {
    setStderrOnly(true);
    const { autoDetectInit } = await import('./config.js');
    const { localConfig } = await autoDetectInit(undefined, { dryRun: false });
    const { PromoteLearning } = await import('./maintenance/promotion-publish.js');
    const { safeDeliveredLearningsNamespaces } = await import('./workspace-children.js');
    const namespaces = await safeDeliveredLearningsNamespaces(localConfig, 'recall promote');
    process.stdout.write(`${JSON.stringify(await PromoteLearning.mark(cmdOpts.learning, PromoteLearning.parsePublished(cmdOpts.published), localConfig, { namespaces }))}\n`);
  });

/**
 * The learnings ready to promote, as `recall promote` lists them, with the paths it read them from. Outside a dry run
 * the checkouts and the review branches are refreshed first, under one hold of the sync lock; while another sync holds
 * it, they are listed as last fetched. Undefined once the failure is said.
 */
async function promotionListing(localConfig: LocalConfig, options: { dryRun: boolean }): Promise<{ paths: MaintenancePaths; candidates: PromotionCandidate[] } | undefined> {
  const { findPromotionCandidates, fetchPromotionRefs } = await import('./maintenance/index.js');
  const { safeDeliveredLearningsNamespaces } = await import('./workspace-children.js');
  const namespaces = await safeDeliveredLearningsNamespaces(localConfig, 'recall promote');
  // An HTTP team repo has no git checkout: its directory may sit in the business repo.
  const { usesBranchWorktree, getKnowledgeDir } = await import('./types.js');
  const knowledgeCheckout = usesBranchWorktree(localConfig) ? getKnowledgeDir(localConfig) : undefined;
  let paths: MaintenancePaths | undefined;

  if (knowledgeCheckout && !options.dryRun) {
    // A fetch beside a pull in the same clone pushes the pull into its reset
    // fallback, so the checkouts and the review branches share one hold of the sync lock.
    const refreshForListing = async () => {
      const refreshed = await maintenancePathsOrExit(localConfig, { holdsSyncLock: true });

      if (refreshed) {
        await fetchPromotionRefs(knowledgeCheckout).catch((cause: unknown) => {
          log.warn(`Could not fetch the review branches, so candidates follow the last fetch: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
      }

      return refreshed;
    };

    const { syncLockPath } = await import('./utils/learnings-publish.js');
    const { withFileLock } = await import('./update.js');
    const lock = syncLockPath(localConfig);

    const listed = lock === null
      ? { held: true as const, value: await refreshForListing() }
      : await withFileLock(lock, { attempts: 1, delayMs: 0 }, refreshForListing);

    if (listed.held) {
      paths = listed.value;
    } else {
      log.warn('Another teamai pull/push is in progress, so candidates follow the last fetch.');
      // As a dry run does: both checkouts as they are, neither refreshed nor created.
      paths = await maintenancePathsOrExit(localConfig, { dryRun: true });
    }
  } else {
    paths = await maintenancePathsOrExit(localConfig, { dryRun: options.dryRun });
  }

  if (!paths) return undefined;

  const { DefaultFolders } = await import('./default-folders.js');
  const { params: thresholds } = await DefaultFolders.load({ kind: 'workflows', name: 'teamai-promote-learning' }, localConfig);

  return { paths, candidates: await findPromotionCandidates({ learningsDirs: paths.learningsReadDirs, votesDir: paths.votesDir, knowledgeCheckout, namespaces, thresholds }) };
}

/**
 * The maintenance paths, or undefined with exit code 1 when teamai refuses a
 * side-branch checkout (#808): another repository's, whose learnings
 * maintenance would rewrite, or an old one in the way of the shared checkout it
 * would write into, which the next publish would then delete. The refusal names
 * the checkout and the way out, and has already been printed. Also when the
 * reports or learnings lock cannot be taken, so the checkout cannot be checked,
 * and while a pull/push holds the sync lock, so neither is refreshed.
 */
/** The maintenance paths of the scope a verb runs in, with its config, or undefined once the failure is said. */
async function maintenanceVerbPaths(options: { dryRun: boolean }): Promise<(MaintenancePaths & { config: LocalConfig }) | undefined> {
  const { autoDetectInit } = await import('./config.js');
  const { localConfig } = await autoDetectInit(undefined, { dryRun: options.dryRun });
  const paths = await maintenancePathsOrExit(localConfig, options);

  return paths && { ...paths, config: localConfig };
}

async function maintenancePathsOrExit(
  localConfig: LocalConfig,
  options: { dryRun?: boolean; holdsSyncLock?: boolean },
): Promise<MaintenancePaths | undefined> {
  const { CheckoutLockedError, CheckoutUnavailableError, SyncLockedError, resolveMaintenancePaths } = await import('./maintenance/index.js');
  const { CheckoutRefusedError } = await import('./utils/branch-worktree.js');

  try {
    return await resolveMaintenancePaths(localConfig, options);
  } catch (e) {
    if (e instanceof CheckoutLockedError || e instanceof CheckoutUnavailableError || e instanceof SyncLockedError) {
      log.error(e.message);
    } else if (!(e instanceof CheckoutRefusedError)) {
      throw e;
    }

    process.exitCode = 1;

    return undefined;
  }
}

/**
 * Publish the files a maintenance command just changed in the learnings
 * worktree, and nothing else there. Best-effort: the change is already on disk, so a failure to publish is worth
 * reporting but never worth failing the command over.
 */
async function publishMaintenance(localConfig: LocalConfig, message: string, changed: readonly string[]): Promise<void> {
  const { publishLearningsMaintenance } = await import('./utils/learnings-publish.js');
  const result = await publishLearningsMaintenance(localConfig, message, changed);

  if (result.status === 'published') {
    log.success('Published maintenance changes to the learnings branch');
  } else if (result.status === 'failed') {
    log.warn(`Maintenance changes stay local for now: ${result.reason}`);
  } else if (result.status === 'busy') {
    log.warn('Maintenance changes stay local for now: another teamai write is in progress');
  }
}

/**
 * The command table doubles as the source of truth for the generated skill
 * command reference (skill-data/core/references/commands.md). Importing this
 * module with TEAMAI_COMMAND_TABLE_ONLY set yields `program` without running
 * the CLI. Documentation checks and tests load the table through scripts/command-table.ts.
 */
export { program };

if (!process.env.TEAMAI_COMMAND_TABLE_ONLY) {
  // Bundled runtimes first: a hook-spawned command may not inherit our PATH
  // (see bundled-runtime.ts) and pull shells out to git.
  ensureBundledRuntimeOnPath();

  const args = process.argv.slice(2);

  // A workflow step or another child inherits this, so a preview stays a
  // preview there too (#1753 review).
  if (args.includes('--dry-run')) process.env.TEAMAI_DRY_RUN = '1';

  const { registerRunningInstallation, registersRunningInstallation } = await import('./installations.js');

  if (registersRunningInstallation(args)) registerRunningInstallation();

  // Every error a command action throws leaves as one line on stderr with exit
  // 1, never as an unhandled rejection with a Node stack trace (#1270).
  await program.parseAsync().catch(reportCommandError);
}
