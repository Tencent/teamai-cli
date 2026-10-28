import { createRequire } from 'node:module';
import { Command, Option } from 'commander';
import { setVerbose, setSilent, log } from './utils/logger.js';
import { applyNonInteractiveGitEnv } from './utils/git-env.js';
import { ensureBundledRuntimeOnPath } from './bundled-runtime.js';
import type { GlobalOptions, LocalConfig } from './types.js';
import type { MaintenancePaths } from './maintenance/paths.js';
import type { ScoreOptions } from './score-commands.js';
import { GLOBAL_OPTIONS } from './global-options.js';
import { TEAMAI_HOOK_SUBCOMMANDS } from './hooks.js';
import { dryRunRefusal } from './dry-run-guard.js';
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
export async function reportCommandError(e: unknown): Promise<void> {
  const error = e instanceof Error ? e : undefined;
  log.error(error?.message || error?.name || String(e));
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
    if (TEAMAI_HOOK_SUBCOMMANDS.includes(name as (typeof TEAMAI_HOOK_SUBCOMMANDS)[number])) return;
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
      log.error(`Auto-migration failed: ${(e as Error).message}`);
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
  .argument('[repo]', 'Team repo (owner/repo or full URL). Pass "." for single-repo mode (the current git repo is the team repo).')
  .option('--repo <repo>', 'Team repo (alias of the positional argument)')
  .option('--http <url>', 'Git-free HTTP team repo (read-only consumer; only needs an API key)')
  .option('--provider <name>', 'Git provider for the team repo on this machine: tgit, github, cnb, gitlab, gitcode, or git. Skips auto-detection. `git` uses your existing Git auth and needs no platform token, but opens no PR/MR.')
  .option('--self', 'Single-repo mode: the current git repo is the team repo (equivalent to `teamai init .`). Knowledge lives on main under .teamai/; reports go to the teamai-reports orphan branch.')
  .option('--token <key>', 'API key for HTTP team repo / status reporting (stored 0600, never committed). Also reads TEAMAI_API_TOKEN.')
  .option('--scope <scope>', 'Install scope: workspace (default, <cwd>/.teamai + <cwd>/.claude) or user (~/.teamai + ~/.claude); project is the older name for workspace')
  .option('--inherit-user-scope', 'In workspace scope, also sync safe user-scope resources, load its env variables (not its secrets) in the workspace, and search its knowledge')
  .option('--no-inherit-user-scope', 'Disable user-scope inheritance for this workspace')
  .option('--role <id>', 'Primary role ID (e.g. hai_dev) for non-interactive setup')
  .option('--project <ids>', 'Active logical project(s) from manifest/projects.yaml (comma-separated); scopes which project resources and learnings this directory syncs. Pass "all" to activate every project the manifest declares (a snapshot taken now)')
  // Non-variadic + a collecting coercer: repeatable (`--agent a --agent b`) and
  // comma-separated (`--agent a,b`, split later by normalizeAgentList) both work,
  // WITHOUT the greedy `<name...>` variadic that would swallow the `[repo]`
  // positional (e.g. `init --agent claude .` must keep `.` as the repo arg).
  .option('--agent <name>', 'AI tools to set up (e.g. claude, codex, cursor, codebuddy, workbuddy, dsh). Repeatable or comma-separated. In single-repo mode, selects which tool dirs to create; a custom agent defined only in teamai.yaml\'s toolPaths also gets its root created here (git-backed init only — an HTTP init has no local teamai.yaml to read custom paths from). Omit for an interactive picker. Additive on repeated runs.', (val: string, acc: string[]) => acc.concat(val), [] as string[])
  .option('--force', 'Rewrite the existing config without confirmation, keeping the settings init does not set')
  .action(async (repoArg, cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
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
  .option('--carried <path@blob>', 'Override the stop for a push that would overwrite or delete a placed agent file a teammate changed. '
    + 'Use it only after carrying that change into your root copy, with the value the stop printed; '
    + 'a later team edit stops the push again. Repeatable', (val: string, acc: string[]) => acc.concat(val), [] as string[])
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { push } = await import('./push.js');
    // Only notify when a real push actually happened — not on dry-run, cancel,
    // no-change, or a handled failure (#702 follow-up).
    const outcome = { completed: false };
    await reportNotInitialized(() => push({ ...globalOpts, ...cmdOpts }, outcome));
    if (outcome.completed) await notifyWebhook('push');
  });

program
  .command('pull')
  .description('Pull team resources and inject into local AI tools. Team docs land in sharing.docs.localDir: .teamai/docs/ in a workspace by default, a hidden directory, so search that path directly')
  .option('--silent', 'Silent mode (for hooks)')
  .option('--force', 'Force full sync even if repo is unchanged')
  .option('--team-ref <ref>', 'Pin this workspace to a branch, tag or commit of the team repo; the default branch unpins it')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
    const { status } = await import('./status.js');
    await reportNotInitialized(() => status({ ...globalOpts, ...cmdOpts }));
  });

program
  .command('list [type]')
  .description('List resources (skills|rules|docs|env|agents|hooks|mcp). For skills, --source local/all also scans installed AI agent skill directories.')
  .option('--source <src>', 'Where to look for skills: repo | local | all', 'all')
  .option('--agent <name>', 'Filter local agents by id (only applies to skills)')
  .option('--reveal', 'Show env values in plaintext (default: masked)')
  .action(async (type, cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { list } = await import('./status.js');
    await reportNotInitialized(() => list(type, { ...globalOpts, ...cmdOpts }));
  });

const skillCmd = program
  .command('skill')
  .description('List and inspect skills (default: repo + installed agents, then the CLI-served catalog)')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { skillList } = await import('./skill-cmd.js');
    await skillList(globalOpts);
  });

skillCmd
  .command('list')
  .description('List team and installed skills, then the built-in catalog the CLI serves')
  .option('--json', 'Output the CLI-served built-in skill catalog as JSON')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
    const { skillShow } = await import('./skill-cmd.js');
    await skillShow(name, { ...globalOpts, ...cmdOpts });
  });

const excludeCmd = skillCmd
  .command('exclude')
  .description('Manage per-user skill exclusion (skip sync without affecting team repo)')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { excludeList } = await import('./exclude.js');
    await excludeList(globalOpts);
  });

excludeCmd
  .command('list')
  .description('List excluded skills')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { excludeList } = await import('./exclude.js');
    await excludeList(globalOpts);
  });

excludeCmd
  .command('add <skills...>')
  .description('Add skill(s) to the exclude list')
  .action(async (skills: string[]) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { excludeAdd } = await import('./exclude.js');
    await excludeAdd(skills, globalOpts);
  });

excludeCmd
  .command('remove <skills...>')
  .description('Remove skill(s) from the exclude list')
  .action(async (skills: string[]) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { excludeRemove } = await import('./exclude.js');
    await excludeRemove(skills, globalOpts);
  });

const membersCmd = program
  .command('members')
  .description('Manage team members')
  .action(async () => {
    // Default action: list members (backward compatible)
    const globalOpts = program.opts() as GlobalOptions;
    const { listMembers } = await import('./members.js');
    await listMembers(globalOpts);
  });

membersCmd
  .command('list')
  .description('List team members')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { listMembers } = await import('./members.js');
    await listMembers(globalOpts);
  });

program
  .command('remove <type> <names...>')
  .description('Remove resource(s) from team repo and all local AI tools (type: skills|rules|agents|mcp)')
  .option('--force', 'Skip confirmation prompt')
  .option('--role <ns>', 'mcp: remove the server from mcp/<ns>/mcp.yaml instead of the root mcp/mcp.yaml')
  .option('--project <id>', "mcp: remove the server from the project's mcp namespace instead of the root mcp/mcp.yaml")
  .action(async (type, names, cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { remove } = await import('./remove.js');
    await remove(type, names, { ...globalOpts, ...cmdOpts });
  });

registerPackagesCommand(program);

program
  .command('doctor')
  .description('Diagnose configuration issues, and print the run mode (attended or unattended) and what set it: TEAMAI_MODE, CI, or the default')
  .option('--json', 'Output the report as JSON (suitable for CI)')
  .option('--fix', 'Remove lock files left behind by dead processes')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
    const { rolesSet } = await import('./roles-cmd.js');
    await rolesSet(primary, { ...globalOpts, ...cmdOpts });
  });

rolesCmd
  .command('add <id>')
  .description('Add a new role to the manifest (admin)')
  .requiredOption('--namespaces <ns>', 'Comma-separated resource namespaces (e.g. common,hai)')
  .option('-d, --description <desc>', 'Description for the role')
  .action(async (id: string, cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { rolesAdd } = await import('./roles-cmd.js');
    await rolesAdd(id, { ...globalOpts, ...cmdOpts });
  });

rolesCmd
  .command('remove <id>')
  .description('Remove a role from the manifest (admin)')
  .action(async (id: string) => {
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
    const { rolesUpdate } = await import('./roles-cmd.js');
    await rolesUpdate(id, { ...globalOpts, ...cmdOpts });
  });

// ─── Projects subcommand ──────────────────────────────────

const projectsCmd = program
  .command('projects')
  .description('Manage multi-project resource distribution (orthogonal to roles)')
  .action(async () => {
    // Default action: list projects
    const globalOpts = program.opts() as GlobalOptions;
    const { projectsList } = await import('./projects-cmd.js');
    await projectsList(globalOpts);
  });

projectsCmd
  .command('list')
  .description('List defined projects and the ones active in this directory')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { projectsList } = await import('./projects-cmd.js');
    await projectsList(globalOpts);
  });

projectsCmd
  .command('set [ids...]')
  .description('Set the projects active in this directory (comma-separated or repeated; empty to clear)')
  .action(async (ids: string[] = [], _cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
    const { projectsUpdate } = await import('./projects-cmd.js');
    await projectsUpdate(id, { ...globalOpts, ...cmdOpts });
  });

projectsCmd
  .command('remove <id>')
  .description('Remove a project from manifest/projects.yaml (admin)')
  .action(async (id: string) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { projectsRemove } = await import('./projects-cmd.js');
    await projectsRemove(id, globalOpts);
  });

projectsCmd
  .command('members <id>')
  .description('List members registered for a project')
  .action(async (id: string) => {
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
    const { tagsSubscribe } = await import('./tags.js');
    await tagsSubscribe(tags, globalOpts);
  });

tagsCmd
  .command('unsubscribe <tags...>')
  .description('Unsubscribe from tags')
  .action(async (tags: string[]) => {
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
    const { sourceAdd } = await import('./source.js');
    await sourceAdd(repo, { ...globalOpts, ...cmdOpts });
  });

sourceCmd
  .command('remove <name>')
  .description('Remove a source and clean up its skills')
  .action(async (name: string) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { sourceRemove } = await import('./source.js');
    await sourceRemove(name, globalOpts);
  });

sourceCmd
  .command('add-http <endpoint>')
  .description('Add an HTTP source (report/sync/ack) alongside a git main repo')
  .option('--token <key>', 'API token for the HTTP endpoint (stored 0600, never committed)')
  .option('--force', 'Overwrite an existing HTTP source config')
  .action(async (endpoint: string, cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { sourceAddHttp } = await import('./source.js');
    await sourceAddHttp(endpoint, { ...globalOpts, ...cmdOpts });
  });

sourceCmd
  .command('remove-http')
  .description('Remove the HTTP source and clean up its resources')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
    const { sourceBrowse } = await import('./source.js');
    await sourceBrowse(name, globalOpts);
  });

// ─── Other subcommands ────────────────────────────────────

program
  .command('update')
  .description('Check for updates and upgrade teamai CLI')
  .option('--check', 'Only check if an update is available, do not install')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { update } = await import('./update.js');
    await update({ ...globalOpts, ...cmdOpts });
  });

program
  .command('uninstall')
  .description('Remove all teamai-managed resources and hooks from this machine')
  .option('--force', 'Skip confirmation prompt')
  .option('--agent <name>', 'Only uninstall this agent\'s resources in this checkout; shared resources, and the project\'s other checkouts, go only if it is the last tool')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
    const { envList } = await import('./env-commands.js');
    await envList({ ...globalOpts, ...cmdOpts });
  });

envCmd
  .command('list')
  .description('List team environment variables')
  .option('--reveal', 'Show env variable values in plaintext (default: masked)')
  .action(async (_cmdOpts, command: Command) => {
    const { envList } = await import('./env-commands.js');
    await envList(command.optsWithGlobals() as GlobalOptions & { reveal?: boolean });
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
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
    const { envSet } = await import('./env-commands.js');
    await envSet(key, { ...globalOpts, ...cmdOpts });
  });

envCmd
  .command('unset <key>')
  .description("Remove your value for a secret or env variable, for this directory's team, from this machine")
  .option('--global', 'Remove the value set for every team on this machine instead')
  .action(async (key, cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { envUnset } = await import('./env-commands.js');
    await envUnset(key, { ...globalOpts, ...cmdOpts });
  });

envCmd
  .command('exec <command...>')
  .description("Run a command with this directory's team env variables and secrets (put -- before the command)")
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { envExec, exitLike } = await import('./env-exec.js');
    // What was typed after `exec`, `--` included: Commander drops it.
    const argv = process.argv.slice(2);
    exitLike(await envExec(argv.slice(argv.indexOf('exec', argv.indexOf('env')) + 1), globalOpts));
  });

const workflowCmd = program
  .command('workflow')
  .description('Run a validated workflow from workflows/<name>.yaml. Writable steps may set deliver: pr to open review requests; TeamAI never merges them.');

workflowCmd
  .command('start <name>')
  .description('Create a run. With --driver skill, the current coding session drives it; with --driver local, this process runs it headless, and in unattended mode (TEAMAI_MODE=unattended or CI) runs teamai score --drain once the run settles, before it exits, unless sessions.publish and session scoring are both off for unattended.')
  .option('--describe', 'Show workflow metadata and required input schemas without creating a run. With --driver skill, also say how to start it: the start command, a question for the person, or the local driver.')
  .option('--driver <kind>', 'Select skill for the current coding session, which then runs the commands each reply prints, or local for headless execution in this process.')
  .option('--parallel <n>', 'With --driver skill: the most steps that run at once, as the describe reply offered')
  .option('--confirmed', 'The person agreed to start this run, as the describe reply asked. From an agent session, an invoke: ask workflow starts only with it, with any driver; teamai takes the agent\'s word for it. In an unattended run (TEAMAI_MODE=unattended or CI) an agent cannot start an invoke: ask workflow, with or without it')
  .option('--hitl <mode>', 'With --driver skill: who answers optional approvals and choices, as the describe reply offered: person (the agent asks the person) or recommend (the agent answers). A required approval always goes to the person')
  .option('--no-judge', 'With --driver skill: leave the scored steps unjudged on this machine, as the describe reply offered')
  .option('--tools <list>', 'Override local prompt tools for this run, as comma-separated name=tool pairs. With --driver skill: only default=<tool>, the tool this coding session works in, which judges its scored steps and which its steps\' models resolve for when teamai installs agents for it. Pass it when the describe reply says the session names no tool')
  .option('--auto-approve', 'Answer optional approve HITL requests yes and choose requests with their default: with --driver local in this process, with --driver skill for this run. A required approval still goes to the person')
  .option('--inputs <json>', 'Values for the inputs the workflow declares, as a JSON object, for example {"issue":42}. Every declared input is required.')
  .action(async (name: string, cmdOpts: { driver?: string; tools?: string; inputs?: string; autoApprove?: boolean; describe?: boolean; parallel?: string; confirmed?: boolean; hitl?: string; judge?: boolean }) => {
    const { workflowStart } = await import('./workflow-commands.js');
    await workflowStart(name, cmdOpts);
  });

workflowCmd
  .command('next <run>')
  .description('Get a lease, hitl, wait, or done JSON envelope. Show hitl.message and hitl.respond to a person, who replaces <option> with a choice.')
  .option('--prepare', 'Prepare the leased workspace in its original checkout; report commits and pushes it automatically')
  .option('--attempt <attempt>', 'With --prepare: prepare this attempt, which an earlier next leased this driver, instead of taking a new lease. wrong_attempt when the run no longer leases it to the driver. With --driver skill: the attempt of a place action, with --adopt')
  .option('--adopt <dir>', 'With --prepare --attempt: prepare the attempt in <dir>, a place the host made: a clean worktree of this repository on the lease\'s workspace branch, or detached at its start. A place that does not fit answers adopt_mismatch and leaves the attempt leased. TeamAI never removes an adopted place. With --driver skill --attempt: adopt <dir> as the place action of that attempt asked, as its adopt prints it')
  .option('--json <payload>', 'Driver identity, for example {"driver":{"kind":"local","machine":"host","workspace":"/work"}}. Optional: running, the attempt ids of its open leases the driver still runs (an open lease left out is handed back), canTakeLease, false to poll while a tool runs without taking a new lease, and driver.can, what the driver can do on this request: hitl (a person can answer HITL requests and work interactively), workspace, env (true, or "commands" when the driver scopes team env for command steps and setup only), setup, tokens, max_turns, network, isolation. An omitted key is not offered, so a step that needs it waits, and wait.held names what it lacks. Send driver.can on every next request, including busy polls. claim, true to take a run another install published from teamai-reports before leasing; a run this install owns stays as it is. Every answer lists in cancelled the running attempts whose tools the driver must stop.')
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
  .option('--json <payload>', 'attempt, revision, outcome (success, failed, or released), and driver')
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
  .option('--json <payload>', 'Driver identity {"driver":{"kind":"ide","machine":"host","workspace":"/work"}} declares an answer a person gave in the driver UI, never one its agent chose. Records channel driver; sent from inside an agent session it records agent true, which a required HITL request refuses.')
  .option('--driver <kind>', 'skill: answer an optional gate of a run the current coding session drives, as its choose action prints it, and print the turn. Records the agent\'s answer, which a required HITL request refuses')
  .option('--note <text>', 'Keep a note with the answer, readable as steps.<id>.note')
  .option('--pass <n>', 'Answer only this positive pass number; rejects an answered or replaced HITL request')
  .action(async (run: string, step: string, choice: string, options: { note?: string; pass?: string; json?: string; driver?: string }) => {
    const { workflowRespond } = await import('./workflow-commands.js');
    await workflowRespond(run, step, choice, options);
  });

workflowCmd
  .command('retry <run> <step>')
  .description('Retry a leased or stopped step, or a HITL request to answer it again, with a new pass and revision. A failed pull request delivery is retried in the same pass, without running the step again. Reopen its dependent steps and a settled run; keep earlier passes. After reopening, run resume or let your driver poll next. Prints one JSON envelope.')
  .action(async (run: string, step: string) => {
    const { workflowRetry } = await import('./workflow-commands.js');
    await workflowRetry(run, step);
  });

workflowCmd
  .command('resume <run>')
  .description("Continue a run with the local driver after retry, respond, or a stopped driver (Ctrl-C or closed terminal). Uses this machine's open local lease workspace, then the latest local driver's workspace on this machine, then cwd. Another live local driver returns driver_running. A settled run returns done. A run this machine does not have is taken from teamai-reports, where workflow publish put it; a published run continues only while this install owns it, else not_owner names the owner. With --driver skill, the current coding session continues the run instead, as after a skill start, and the reply is its first turn. In unattended mode, the local driver runs teamai score --drain once the run settles, as start does.")
  .option('--driver <kind>', 'local, the default, to drive the run in this process, or skill for the current coding session, which then runs the commands each reply prints. An agent runs it only when the person agrees')
  .option('--parallel <n>', 'With --driver skill: the most steps that run at once; 1 when left out')
  .option('--hitl <mode>', 'With --driver skill: who answers optional approvals and choices: person (the agent asks the person; the default) or recommend (the agent answers). A required approval always goes to the person')
  .option('--no-judge', 'With --driver skill: leave the scored steps unjudged on this machine')
  .option('--tools <list>', 'Override local prompt tools for this run, as comma-separated name=tool pairs. With --driver skill: only default=<tool>, the tool this coding session works in, which judges its scored steps and which its steps\' models resolve for when teamai installs agents for it. Pass it when the describe reply says the session names no tool')
  .option('--auto-approve', 'Answer optional approve HITL requests yes and choose requests with their default: with --driver local in this process, with --driver skill for this run. A required approval still goes to the person')
  .option('--claim', 'Take the published run over from the install that owns it, replacing this machine\'s copy and releasing its leases')
  .option('--confirmed', 'The person agreed to continue this run, as the confirm_needed answer asked. From an agent session, a run of an invoke: ask workflow continues only with it, with any driver; teamai takes the agent\'s word for it. In an unattended run (TEAMAI_MODE=unattended or CI) an agent cannot continue a run of an invoke: ask workflow, with or without it')
  .action(async (run: string, options: { driver?: string; parallel?: string; hitl?: string; judge?: boolean; tools?: string; autoApprove?: boolean; claim?: boolean; confirmed?: boolean }) => {
    const { workflowResume } = await import('./workflow-commands.js');
    await workflowResume(run, options);
  });

workflowCmd
  .command('publish <run>')
  .description("Publish a run's state to teamai-reports so another member or a runner can continue it with workflow resume. The first publish makes this install the run's owner; publishing an unchanged run writes nothing. Refuses a run with records not yet on teamai-reports, or with a value that looks like a secret. Prints one JSON envelope listing the leases still in flight.")
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

program
  .command('score')
  .description('Judge workflow passes with team scorers (scorers/<name>.md). Any driver takes judge work with --next, runs its own judge on the lease prompt with the lease evidence directory as its only readable root and settles it with --lease <ref> --submit, or judges it here with --lease <ref>. --run <id> --step <path> --scorer <name> judges a pass on demand. --scorer <name> [--session <id>] judges a finished agent session here: the one --session names, or, inside a session, the one its agent session variable names; it never guesses. --team-session <name> judges a session a member pushed instead. --label <value> labels the session by hand instead of judging it. With --json, it leases that session to the driver\'s own judge instead. workflow next never hands out judge work, and a driver never lists a judge ref in workflow next running. Prints one JSON envelope; --drain prints lines.')
  .option('--next', 'Take judge work: workflow passes first, then finished sessions of each run mode whose scoring.sessions policy is auto (config.yaml, else scorers/scoring.yaml; by default off attended, auto unattended). An attended session is finished 6 hours after its last activity, an unattended one once a score --drain reached it. A lease has ref, source (workflow or session), scorer, subject, evidence, prompt, answer.schema, expiresAt, the cwd to submit from and a submit command line; else idle with counts. A batch lease, for scorers of one pass that share a judge call, has scorers and batched: true instead of scorer. --json {"driver":{"kind":"t3","machine":"host","workspace":"/work","can":{"judge":{"isolation":"verified","access":"read","tools":["claude"]}}},"running":["<ref>"]}. isolation is verified or best-effort; access is what your judge can do, answer (no tools), read (reads the evidence) or full (any tool), default full, and its labels record it; tools in your order of preference. running lists the judge refs you still run, which renews them; a live workflow lease of yours left out is handed back, and a session lease left out lapses: a session is judged once. A lease lapses 30 minutes after it was taken or renewed. Optional: run, a run id, to take only that run\'s workflow passes and never a session, from any directory, since the run\'s scope is found by its id; canTakeLease, false to renew running and take nothing, not even a lease handed back.')
  .option('--lease <ref>', 'The judge lease, as --next printed it (s<13 hex>/a<8 hex>). Without --submit, judge it here with the tool the lease names, in a confined profile, and settle it through the submit path: --json {"driver":{…same as --next…}}.')
  .option('--submit', 'Settle --lease <ref> with the payload {"driver":{…same as --next…},"outcome":"success","answer":{"label":"<one of answer.schema>","reasoning":"…"},"judge":{"tool":"claude","model":"…","usage":{"inputTokens":0,"outputTokens":0}}}. For a batch lease, answer is {"<scorer>":{"label":"…","reasoning":"…"},…} with one entry per scorer. outcome is success, failed, or released. A label a scorer does not list is refused, the whole answer with it, and the lease stays open; teamai computes score and passed.')
  .option('--json <payload>', 'The payload as a JSON string')
  .option('--stdin', 'Read the payload from stdin')
  .option('--run <id>', 'Judge a pass of this run on demand, whatever sampling says, with --step and --scorer; this also reopens judge work that failed or expired. Without --queue, judges it here with the local judge and prints the label.')
  .option('--step <path>', 'With --run: the step path, such as review or check.review')
  .option('--pass <n>', 'With --run: the pass to judge; default the step\'s latest succeeded pass')
  .option('--session <id>', 'Judge this finished session of an agent tool on this machine, whatever sampling says, with --scorer. Prints the session\'s first prompt and directory first, then the label; the session and the judge\'s reasoning are never published. With --json {"driver":{…same as --next…}}, prints a lease for your own judge, as --next does, instead of judging here; several --scorer need --batch. The lease is taken whatever sampling, the six idle hours, scoring.sessions, the scorer\'s sessions, an earlier label or daily_limit say, and counts toward the day\'s daily_limit. Nothing is taken when a scorer asks for more isolation than can.judge offers (isolation_unmet), when none of its tools runs a scorer\'s model (judge_model_unavailable), or while a live lease holds the work (busy).')
  .option('--source <platform>', 'With --session: the tool that holds it, as session migrate --source names it (claude-code, codex, opencode, …); needed unless the agent session variable names that session, or the captures its session-start hook wrote here name one platform for it')
  .option('--team-session <name>', 'Judge a session a member pushed with session push instead of one on this machine, by the name session list prints for this directory\'s repository: read from teamai-reports, else from the archive the team kept on its default branch before, and redacted before a judge reads it. Run session pull first for the newest. Its label is about the session where it ran, so it pairs with that session\'s labels from the machine that ran it, and records no agent. Not with --session, --source or --json')
  .option('--author <name>', 'With --team-session: who pushed it, when two members pushed a session with that name')
  .option('--label <value>', 'Label the session by hand with this value of the one --scorer: no judge runs, score and passed come from the scorer, and no reasoning is kept. A value the scorer does not list fails and lists the ones it does. A hand label and a model label of a session are kept side by side, so rescoring with the model never replaces yours; the dashboard Scorers page shows how often the model judge agrees with hand labels. Not with a scorer file, --batch or --json')
  .option('--scorer <name>', 'With --run: a scorer the run pinned or one teamai pull cached. With --session, or alone inside a session: a scorer teamai pull cached, or a scorer file to try before pushing it: a path with / or ending in .md. A file\'s label is never stored, so it takes no --push; the output adds the labels stored for its scorer (stored) and its verdict on the session\'s first prompt alone (control). Repeatable.', (value: string, previous: string[]) => previous.concat(value), [] as string[])
  .option('--queue', 'With --run: leave the work to any driver\'s score --next instead of judging it here')
  .option('--batch', 'With --run or --session: the scorers share one judge call when they resolve to the same tool and model')
  .option('--push', 'Publish every pending label of this machine to scores/<member>/<YYYY-MM>.jsonl on teamai-reports, alone or after --session. Labels only: never the session, the prompt or the judge\'s reasoning. With usage reporting off, or when the push fails, they stay pending for the next --push.')
  .option('--drain', 'What every unattended job runs before it ends, alone, in every scope this directory reaches: in unattended mode, finish each session captured unattended here; judge each pass and session a judge tool here can take, a failed judgment final and never retried; publish pending labels; where sessions.publish is auto for this run mode, archive, scrubbed, its finished sessions and the step sessions of its ended runs on teamai-reports; report usage to stats/<member>.yaml. Prints a line per kind of work and what it left for other drivers; exits 1 only when a judgment or a publish failed, and what stayed pending goes on the next --drain.')
  .action(async (cmdOpts: ScoreOptions) => {
    const { scoreCommand } = await import('./score-commands.js');
    await scoreCommand(cmdOpts);
  });

// ─── Hooks commands ─────────────────────────────────────

const hooksCmd = program
  .command('hooks')
  .description('Manage teamai hooks in AI tool settings');

hooksCmd
  .command('list')
  .description('List hook install status + effective built-in (A) and team (B) hooks')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { hooksList } = await import('./hooks-cmd.js');
    await hooksList(globalOpts);
  });

hooksCmd
  .command('inject')
  .description('Inject teamai hooks into all AI tool settings')
  .option('--silent', 'Silent mode (suppress success message)')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    if (cmdOpts.silent) setSilent(true);
    const { hooksInject } = await import('./hooks-cmd.js');
    await hooksInject({ ...globalOpts, ...cmdOpts });
  });

hooksCmd
  .command('remove')
  .description('Remove teamai hooks from all AI tool settings')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
    const { mcpList } = await import('./mcp-cmd.js');
    await mcpList(globalOpts);
  });

mcpCmd
  .command('inject')
  .description('Inject team MCP servers into all AI tool configs')
  .option('--dry-run', 'Show what would change without writing')
  .option('--force', 'Overwrite servers that collide with user-owned entries')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { mcpInject } = await import('./mcp-cmd.js');
    await mcpInject({ ...globalOpts, ...cmdOpts });
  });

mcpCmd
  .command('remove')
  .description('Remove all teamai-managed MCP servers from AI tool configs')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
    const { testWebhook } = await import('./webhook.js');
    await testWebhook(cmdOpts.url, { dryRun: globalOpts.dryRun });
  });

// ─── Model profile commands ─────────────────────────────

/** Model commands fail with one readable line instead of a stack trace. */
async function runModelsCommand(run: (commands: typeof import('./models-cmd.js')) => Promise<void>): Promise<void> {
  try {
    await run(await import('./models-cmd.js'));
  } catch (error) {
    log.error((error as Error).message);
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
  .option('--protocol <protocols>', 'Comma-separated: anthropic, openai-chat-completions, openai-responses')
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
  .option('--agent <name>', 'Only switch this agent. Repeatable or comma-separated.', collectRepeatable, [] as string[])
  .option('--model <id>', 'Default model to select (defaults to the first in the profile)')
  .option('--dry-run', 'Show what would change without writing')
  .action((profile: string | undefined, cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    return runModelsCommand((m) => m.modelsSwitch(profile, { ...globalOpts, ...cmdOpts }));
  });

modelsCmd
  .command('restore')
  .description('Restore agent model settings captured before the first TeamAI switch')
  .option('--agent <name>', 'Only restore this agent. Repeatable or comma-separated.', collectRepeatable, [] as string[])
  .option('--dry-run', 'Show what would change without writing')
  .action((cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
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
    const globalOpts = program.opts() as GlobalOptions;
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
    log.warn(`Session commands unavailable: ${(e as Error).message}`);
  }
}

program
  .command('digest')
  .description('Generate weekly team activity digest')
  .action(async () => {
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
    await startDashboard(Number(cmdOpts.port));
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
  .command('score-sessions', { hidden: true })
  .description('Judge this machine\'s finished sessions with the local judge (started by the session-start hook)')
  .action(async () => {
    const { scoreSessionsCommand } = await import('./score-sessions.js');
    await scoreSessionsCommand();
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
  .option('--team-hooks', 'Run the team hooks of the project the hook\'s cwd belongs to (Codex, when the project\'s .codex/hooks.json is not teamai\'s alone)')
  .action(async (event: string, hookArgs: string[], cmdOpts: { stdin?: boolean; tool?: string; matcher?: string; bgOnly?: boolean; copilotGlobal?: string; stdinFile?: string; teamHooks?: boolean }) => {
    const bgOnly = cmdOpts.bgOnly ?? false;
    const tool = cmdOpts.tool ?? 'claude';

    // Team hooks keep their own timeouts and exit status: Codex bounds the
    // entry by the largest of them, and exit 2 is a hook's blocking decision.
    if (cmdOpts.teamHooks) {
      let code = 0;
      try {
        if (tool === 'codex') {
          const { runCodexDispatcher } = await import('./codex-team-hooks.js');
          code = await runCodexDispatcher(event);
        }
      } catch (e) {
        process.stderr.write(`teamai: team hooks did not run: ${(e as Error).message}\n`);
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
  .description('Bind the current workspace to a ClawPro project for HTTP local-agent sync')
  .option('--project-id <id>', 'Project ID from /projects/mine')
  .option('--skip', 'Mark current workspace as skipped (never prompt again)')
  .action(async (cmdOpts) => {
    const { bindCurrentProject } = await import('./local-agent.js');
    await bindCurrentProject({
      projectId: cmdOpts.projectId ? Number.parseInt(cmdOpts.projectId, 10) : undefined,
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
    const globalOpts = program.opts() as GlobalOptions;
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
  .action(async (queryParts, cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const query = (queryParts as string[]).join(' ');
    const { recall } = await import('./recall.js');
    await recall(query, { ...globalOpts, depth: cmdOpts.depth, check: cmdOpts.check, caller: cmdOpts.caller });
  });

recallCmd
  .command('disable')
  .description('Disable automatic knowledge-base recall')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { recallDisable } = await import('./recall-toggle.js');
    await recallDisable(globalOpts);
  });

recallCmd
  .command('enable')
  .description('Enable automatic knowledge-base recall')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { recallEnable } = await import('./recall-toggle.js');
    await recallEnable(globalOpts);
  });

recallCmd
  .command('status')
  .description('Show recall feature status')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
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

program
  .command('import')
  .description('Import knowledge from local directories, remote repos, organizations, MRs, or iWiki')
  .option('--dir <path>', 'Extract code knowledge from a local directory (same as --from-repo but no clone)')
  .addOption(new Option('--from-claude', 'Scan Claude/Cursor rule directories (the Claude root\'s rules/ — ~/.claude or the recorded toolRoots.claude — and ~/.cursor/rules)').hideHelp())
  .option('--from-mr <url...>', 'Extract learning from one or more merged MRs/PRs and trigger incremental teamwiki update')
  .option('--no-discussions', 'Leave the MR\'s review threads out of the extraction (with --from-mr)')
  .option('--from-iwiki <space-id-or-url>', 'Import documents from iWiki Space ID or page URL (requires TAI_PAT_TOKEN)')
  .addOption(new Option('--resume', 'Resume an interrupted import session').hideHelp())
  .option('--all', 'Accept all suggestions without interactive confirmation')
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
    const globalOpts = program.opts() as GlobalOptions;
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

program
  .command('codebase')
  .description('Inspect and maintain the teamwiki that `teamai import` writes')
  .addOption(new Option('--project <name>', 'Codebase slug under teamwiki/evidence/code/, required for --deep-enrich').hideHelp())
  .addOption(new Option('--upgrade-wiki', 'Migrate docs/team-codebase/ to teamwiki/ graph format').hideHelp())
  .option('--lint', 'Run global consistency lint over the teamwiki knowledge graph')
  .option('--reconcile', 'Reconcile product and code knowledge in teamwiki')
  .option('--deep-enrich', 'Generate deep knowledge docs from extracted evidence')
  .addOption(new Option('--fix', 'Deprecated: teamwiki lint has no autofix; runs lint in report-only mode').hideHelp())
  .option('--status', 'Show knowledge-base git baseline (headSha / repoUrl / branch)')
  .addOption(new Option('--severity <level>', 'Minimum severity to report: high|medium|low|info').default('info').hideHelp())
  .option('--json', 'Output report as JSON (suitable for CI)')
  .addOption(new Option('--output <path>', 'Use <path>/teamwiki, as written by `teamai import --output <path>`, instead of the team repo\'s').hideHelp())
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { codebaseCmd } = await import('./codebase-cmd.js');
    await codebaseCmd({ ...globalOpts, ...cmdOpts });
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
        const globalOpts = program.opts() as GlobalOptions;
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
  .description('Extract knowledge from MR/PR and post as comment or write to team repo')
  .requiredOption('--url <url>', 'MR/PR web URL')
  .option('--mode <mode>', 'Operation mode: comment | write | both', 'comment')
  .option('--team-repo <path>', 'Team knowledge repo path (required for write mode)')
  .option('--comment-marker <marker>', 'HTML comment anchor for idempotent updates', '<!-- teamai:ci-extract -->')
  .option('--write-mode <mode>', 'Write strategy: direct | pending-review', 'direct')
  .option('--output <dir>', 'Write artifacts to directory')
  .option('--individual-comments', 'Post each suggestion as separate comment with reaction/resolve support')
  .option('--no-discussions', 'Leave the MR\'s review threads out of the extraction')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { ciExtractMr } = await import('./ci/extract-mr.js');
    await ciExtractMr({ ...globalOpts, ...cmdOpts });
  });

program
  .command('deep-enrich', { hidden: true })
  .description('Run deep AI knowledge generation for an imported repo')
  .requiredOption('--project <slug>', 'Project slug (directory name in evidence/code/)')
  .option('--wiki-root <path>', 'Teamwiki root path')
  .option('--max-modules <n>', 'Max modules to process (cost control)', parseInt)
  .action(async (cmdOpts: { project: string; wikiRoot?: string; maxModules?: number }) => {
    const { runHiddenDeepEnrich } = await import('./deep-enrich.js');
    const { DetachedTeamRepoError } = await import('./utils/git.js');
    try {
      await runHiddenDeepEnrich({
        project: cmdOpts.project,
        wikiRoot: cmdOpts.wikiRoot,
        maxModules: cmdOpts.maxModules,
      });
    } catch (error) {
      if (!(error instanceof DetachedTeamRepoError)) throw error;
      const { log } = await import('./utils/logger.js');
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
    const globalOpts = program.opts() as GlobalOptions;
    await recallFeedback({ positive: cmdOpts.positive, negative: cmdOpts.negative, dryRun: globalOpts.dryRun });
  });

recallCmd
  .command('maintenance')
  .description('Automatic maintenance of team knowledge base')
  .option('--prune', 'Remove low-confidence learnings')
  .option('--threshold <n>', 'Confidence threshold for pruning (default 0.15)', parseFloat)
  .option('--archive', 'Move to archive/ instead of deleting')
  .option('--confidence-writeback', 'Update frontmatter confidence scores')
  .option('--update-quality', 'Find stale docs/rules/skills and suggest updates')
  .option('--dry-run', 'Show what would be done without making changes')
  .action(async (localOpts) => {
    // The root program takes `--dry-run` wherever it is written, so this
    // command's own declaration never sets it: read it merged, as the other
    // actions do (#900).
    const cmdOpts = { ...(program.opts() as GlobalOptions), ...localOpts };
    if (!cmdOpts.confidenceWriteback && !cmdOpts.prune && !cmdOpts.updateQuality) {
      const { log } = await import('./utils/logger.js');
      log.info('Usage: teamai recall maintenance --prune | --confidence-writeback | --update-quality');
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
        const { log } = await import('./utils/logger.js');
        log.info('No learnings below threshold. Knowledge base is healthy.');
        return;
      }
      const { log } = await import('./utils/logger.js');
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
      const { findStaleEntries, reportStaleEntries, findRelatedAdoptedLearnings, generateUpdateDraft } = await import('./maintenance/index.js');
      const { writeFile } = await import('./utils/fs.js');
      const { log } = await import('./utils/logger.js');
      const entries = await findStaleEntries(votesDir, {
        docs: `${repoPath}/docs`,
        rules: `${repoPath}/rules`,
        skills: `${repoPath}/skills`,
      });
      reportStaleEntries(entries);

      if (entries.length === 0 || cmdOpts.dryRun) return;

      log.info('\nGenerating AI-powered update drafts...');
      for (const entry of entries) {
        const related = await findRelatedAdoptedLearnings(entry, votesDir, learningsReadDirs, {
          namespaces: learningsNamespaces,
        });
        const draft = await generateUpdateDraft(entry, related);
        if (draft) {
          const draftPath = `${entry.path}.draft.md`;
          await writeFile(draftPath, draft);
          log.success(`  Draft written: ${draftPath}`);
        }
      }
      log.info('\nReview drafts, then rename .draft.md -> .md to apply updates.');
      return;
    }
  });

recallCmd
  .command('promote [learningId]')
  .description('Publish a high-confidence learning as new knowledge on a review branch, then mark it promoted')
  .addOption(new Option('--category <cat>', 'Target category: skills | rules | docs; skills use <learningId>/SKILL.md').choices(['skills', 'rules', 'docs']))
  .option('--dry-run', 'Show what would be done without making changes')
  .action(async (learningId, localOpts) => {
    // As in `recall maintenance`: `--dry-run` reaches the root's options only (#900).
    const cmdOpts = { ...(program.opts() as GlobalOptions), ...localOpts };
    const { autoDetectInit } = await import('./config.js');
    const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: cmdOpts.dryRun });
    const { safeDeliveredLearningsNamespaces } = await import('./workspace-children.js');
    const learningsNamespaces = await safeDeliveredLearningsNamespaces(localConfig, 'recall promote');
    if (learningId && !cmdOpts.dryRun) {
      const { promoteAndPublish } = await import('./maintenance/promotion-publish.js');
      await promoteAndPublish(learningId, localConfig, teamConfig, {
        category: cmdOpts.category,
        namespaces: learningsNamespaces,
      });
      return;
    }
    const {
      findPromotionCandidates,
      executePromotion,
      fetchPromotionRefs,
    } = await import('./maintenance/index.js');
    const { log } = await import('./utils/logger.js');

    // An HTTP team repo has no git checkout: its directory may sit in the business repo.
    const { usesBranchWorktree, getKnowledgeDir } = await import('./types.js');
    const knowledgeCheckout = usesBranchWorktree(localConfig) ? getKnowledgeDir(localConfig) : undefined;
    let paths: MaintenancePaths | undefined;
    if (knowledgeCheckout && !cmdOpts.dryRun) {
      // A fetch beside a pull in the same clone pushes the pull into its reset
      // fallback, so the checkouts and the review branches share one hold of the sync lock.
      const refreshForListing = async () => {
        const refreshed = await maintenancePathsOrExit(localConfig, { holdsSyncLock: true });
        if (refreshed) {
          await fetchPromotionRefs(knowledgeCheckout).catch((e: unknown) => {
            log.warn(`Could not fetch the review branches, so candidates follow the last fetch: ${e instanceof Error ? e.message : String(e)}`);
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
      paths = await maintenancePathsOrExit(localConfig, { dryRun: cmdOpts.dryRun });
    }
    if (!paths) return;
    const {
      repoPath, votesDir, learningsReadDirs, learningsWriteDir,
    } = paths;
    const candidates = await findPromotionCandidates(learningsReadDirs, votesDir, knowledgeCheckout, {
      namespaces: learningsNamespaces,
    });

    if (candidates.length === 0) {
      log.info('No learnings eligible for promotion yet.');
      return;
    }

    if (!learningId) {
      log.info(`${candidates.length} learning(s) eligible for promotion:`);
      for (const c of candidates) {
        log.info(`  - ${c.docId} (confidence: ${c.confidence.toFixed(2)}, suggested: ${c.suggestedCategory})`);
      }
      log.info('\nRun: teamai recall promote <learning-id> [--category <cat>]');
      return;
    }

    const candidate = candidates.find((c) => c.docId === learningId);
    if (!candidate) {
      log.error(`Learning "${learningId}" not found or not eligible for promotion.`);
      return;
    }

    await executePromotion(candidate, repoPath, {
      category: cmdOpts.category as 'skills' | 'rules' | 'docs' | undefined,
      dryRun: cmdOpts.dryRun,
      learningsWriteDir,
    });
  });


/**
 * The maintenance paths, or undefined with exit code 1 when teamai refuses a
 * side-branch checkout (#808): another repository's, whose learnings
 * maintenance would rewrite, or an old one in the way of the shared checkout it
 * would write into, which the next publish would then delete. The refusal names
 * the checkout and the way out, and has already been printed. Also when the
 * reports or learnings lock cannot be taken, so the checkout cannot be checked,
 * and while a pull/push holds the sync lock, so neither is refreshed.
 */
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
      const { log } = await import('./utils/logger.js');
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
  const { log } = await import('./utils/logger.js');
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
 * the CLI. Test-only: tests load the table through helpers/command-table.ts.
 */
export { program };

if (!process.env.TEAMAI_COMMAND_TABLE_ONLY) {
  // Bundled runtimes first: a hook-spawned command may not inherit our PATH
  // (see bundled-runtime.ts) and pull shells out to git.
  ensureBundledRuntimeOnPath();

  // Every error a command action throws leaves as one line on stderr with exit
  // 1, never as an unhandled rejection with a Node stack trace (#1270).
  await program.parseAsync().catch(reportCommandError);
}
