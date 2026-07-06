import { createRequire } from 'node:module';
import { Command, Option } from 'commander';
import { setVerbose, setSilent, log } from './utils/logger.js';
import type { GlobalOptions } from './types.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
  .name('teamai')
  .description('TeamAI — The team harness for AI agents')
  .version(version)
  .option('--dry-run', 'Preview mode, no changes made')
  .option('-v, --verbose', 'Verbose output')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) setVerbose(true);
  });

program
  .command('init')
  .description('Initialize teamai (configure TGit, clone repo, register member)')
  .option('--repo <repo>', 'Team repo (owner/repo or full URL)')
  .option('--http <url>', 'Git-free HTTP team repo (read-only consumer; only needs an API key)')
  .option('--token <key>', 'API key for HTTP team repo / status reporting (stored 0600, never committed). Also reads TEAMAI_API_TOKEN.')
  .option('--scope <scope>', 'Scope: user (default) or project')
  .option('--role <id>', 'Primary role ID (e.g. hai_dev) for non-interactive setup')
  .option('--agent <name>', 'Only inject hooks into this agent (e.g. claude, codebuddy, workbuddy). Additive on repeated runs.')
  .option('--force', 'Overwrite existing config without confirmation')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { init } = await import('./init.js');
    await init({ ...globalOpts, ...cmdOpts });
  });

program
  .command('push')
  .description('Push local resources to team repo')
  .option('--all', 'Push all without confirmation')
  .option('--skill <path>', 'Push a specific skill by path (e.g., ~/.claude/skills/hai/my-skill or skills/hai_dev/my-skill)')
  .option('--role <id>', 'Target role namespace for pushed project skills')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { push } = await import('./push.js');
    await push({ ...globalOpts, ...cmdOpts });
  });

program
  .command('pull')
  .description('Pull team resources and inject into local AI tools')
  .option('--silent', 'Silent mode (for hooks)')
  .option('--force', 'Force full sync even if repo is unchanged')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    if (cmdOpts.silent) setSilent(true);
    const { pull } = await import('./pull.js');
    await pull({ ...globalOpts, ...cmdOpts });
  });

program
  .command('status')
  .description('Show local vs team repo diff')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { status } = await import('./status.js');
    await status(globalOpts);
  });

program
  .command('list [type]')
  .description('List resources (skills|rules|docs|env). For skills, --source local/all also scans installed AI agent skill directories.')
  .option('--source <src>', 'Where to look for skills: repo | local | all', 'all')
  .option('--agent <name>', 'Filter local agents by id (only applies to skills)')
  .action(async (type, cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { list } = await import('./status.js');
    await list(type, { ...globalOpts, ...cmdOpts });
  });

const skillCmd = program
  .command('skill')
  .description('List and inspect skills (default: list all skills across repo + installed agents)')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { list } = await import('./status.js');
    await list('skills', { ...globalOpts, source: 'all' });
  });

skillCmd
  .command('list')
  .description('List all skills (alias for: teamai list skills --source all)')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { list } = await import('./status.js');
    await list('skills', { ...globalOpts, source: 'all' });
  });

skillCmd
  .command('show <name>')
  .description('Show skill metadata: source / contributors / installed agents / description')
  .action(async (name: string, cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { skillShow } = await import('./skill-cmd.js');
    await skillShow(name, { ...globalOpts, ...cmdOpts });
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
  .description('Remove resource(s) from team repo and all local AI tools (type: skills|rules)')
  .action(async (type, names) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { remove } = await import('./remove.js');
    await remove(type, names, globalOpts);
  });

program
  .command('doctor')
  .description('Diagnose configuration issues')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { doctor } = await import('./doctor.js');
    await doctor(globalOpts);
  });

// ─── Roles subcommand ─────────────────────────────────────

const rolesCmd = program
  .command('roles')
  .description('Manage team roles and resource namespaces')
  .action(async () => {
    // Default action: list roles
    const globalOpts = program.opts() as GlobalOptions;
    const { rolesList } = await import('./roles-cmd.js');
    await rolesList(globalOpts);
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
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { rolesList } = await import('./roles-cmd.js');
    await rolesList(globalOpts);
  });

rolesCmd
  .command('set <primary>')
  .description('Set your primary role (updates local config)')
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

// ─── Tags subcommand ──────────────────────────────────────

const tagsCmd = program
  .command('tags')
  .description('Manage tag-based skill/rule filtering')
  .action(async () => {
    // Default action: list tags
    const globalOpts = program.opts() as GlobalOptions;
    const { tagsList } = await import('./tags.js');
    await tagsList(globalOpts);
  });

tagsCmd
  .command('list')
  .description('List all available tags and subscription status')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { tagsList } = await import('./tags.js');
    await tagsList(globalOpts);
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
    const globalOpts = program.opts() as GlobalOptions;
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
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { uninstall } = await import('./uninstall.js');
    await uninstall({ ...globalOpts, ...cmdOpts });
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
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { envList } = await import('./env-commands.js');
    await envList({ ...globalOpts, ...cmdOpts });
  });

envCmd
  .command('add <key> <value>')
  .description('Add or update a team environment variable')
  .option('-d, --description <desc>', 'Description for the variable')
  .action(async (key, value, cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { envAdd } = await import('./env-commands.js');
    await envAdd(key, value, { ...globalOpts, ...cmdOpts });
  });

envCmd
  .command('remove <key>')
  .description('Remove a team environment variable')
  .action(async (key) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { envRemove } = await import('./env-commands.js');
    await envRemove(key, globalOpts);
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
  .action(async () => {
    const { showStats } = await import('./stats.js');
    await showStats();
  });

program
  .command('digest')
  .description('Generate weekly team activity digest')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { generateDigest } = await import('./digest.js');
    await generateDigest(globalOpts);
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
  .description('Contribute session knowledge to team repo')
  .option('--file <path>', 'Path to the contribution document')
  .option('--title <title>', 'Title for the contribution document')
  .option('--session-id <id>', 'Session ID for dedup tracking')
  .option('--scope <scope>', 'Target scope: user or project')
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
  .action(async (queryParts, cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const query = (queryParts as string[]).join(' ');
    const { recall } = await import('./recall.js');
    await recall(query, { ...globalOpts, depth: cmdOpts.depth });
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
      await todoWriteHint();
    }
  });

program
  .command('import')
  .description('Import knowledge from local directories, remote repos, organizations, MRs, or iWiki')
  .option('--dir <path>', 'Extract code knowledge from a local directory (same as --from-repo but no clone)')
  .addOption(new Option('--from-claude', 'Scan Claude/Cursor rule directories (~/.claude/rules, ~/.cursor/rules)').hideHelp())
  .option('--from-mr <url>', 'Extract learning from merged MR/PR and trigger incremental teamwiki update')
  .option('--from-iwiki <space-id-or-url>', 'Import documents from iWiki Space ID or page URL (requires TAI_PAT_TOKEN)')
  .addOption(new Option('--resume', 'Resume an interrupted import session').hideHelp())
  .option('--all', 'Accept all suggestions without interactive confirmation')
  .addOption(new Option('--output <path>', 'Write drafts to this directory instead of pushing to team repo').hideHelp())
  .option('--from-repo <url>', 'Clone a remote repo and generate per-repo codebase summary')
  .addOption(new Option('--ssh', 'Force SSH clone even if HTTPS token is available').hideHelp())
  .addOption(new Option('--domain <name>', 'Skip AI recommendation and assign repo to this domain explicitly').hideHelp())
  .option('--from-repo-list <path>', 'Batch import repos from a YAML whitelist')
  .addOption(new Option('--concurrency <n>', 'Concurrent repos for --from-repo-list (default 3)').default('3').hideHelp())
  .addOption(new Option('--skip-aggregate', 'Skip domain-*.md / index.md regeneration').hideHelp())
  .option('--incremental', 'Use cached clone with fetch+reset (with --from-repo or --from-repo-list)')
  .option('--skip-enrich', 'Skip AI enrichment (only clone + extract + graph, no LLM calls)')
  .option('--from-org <org>', 'List repos under an org and bootstrap whitelist + domains')
  .addOption(new Option('--bootstrap', 'Run interactive review after --from-org').hideHelp())
  .addOption(new Option('--max-repos <n>', 'Cap on repos pulled from --from-org (default 200)').default('200').hideHelp())
  .addOption(new Option('--exclude-archived', 'Exclude archived repos from --from-org (default true)').hideHelp())
  .addOption(new Option('--include-pattern <re>', 'Regex to include repos by full name (used with --from-org)').hideHelp())
  .addOption(new Option('--exclude-pattern <re>', 'Regex to exclude repos by full name (used with --from-org)').hideHelp())
  .addOption(new Option('--skip-import', 'Only write drafts; skip the actual --from-repo-list run').hideHelp())
  .addOption(new Option('--iwiki-dual', 'Enable dual-output mode for --from-iwiki (write codebase sections in addition to learning)').hideHelp())
  .addOption(new Option('--require-review', 'Defer codebase section writes to .teamai/pending-review.jsonl for human review').hideHelp())
  .option('--cache-status', 'Show import cache status (repos cached, disk usage)')
  .option('--cache-gc', 'Garbage-collect stale import cache entries')
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
      await mrHint();
    }
  });

program
  .command('codebase')
  .description('Inspect and maintain team-codebase outputs')
  .addOption(new Option('--extract [path]', 'Extract code knowledge and build graph from source').hideHelp())
  .addOption(new Option('--incremental', 'Only re-extract changed files (requires prior manifest)').hideHelp())
  .addOption(new Option('--project <name>', 'Project slug for extract output (default: directory name)').hideHelp())
  .addOption(new Option('--max-files <n>', 'Max source files to scan (default: 200)').hideHelp())
  .addOption(new Option('--upgrade-wiki', 'Migrate docs/team-codebase/ to teamwiki/ graph format').hideHelp())
  .option('--lint', 'Run global consistency lint over docs/team-codebase')
  .option('--fix', 'Apply low-risk mechanical fixes (only with --lint)')
  .addOption(new Option('--severity <level>', 'Minimum severity to report: high|medium|low|info').default('info').hideHelp())
  .addOption(new Option('--stale-days <n>', 'Threshold for sync-stale check').default('60').hideHelp())
  .addOption(new Option('--pending-review-threshold <n>', 'Threshold for pending-review backlog').default('10').hideHelp())
  .option('--json', 'Output report as JSON (suitable for CI)')
  .addOption(new Option('--output <path>', 'Custom teamwiki output root directory').hideHelp())
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { codebaseCmd } = await import('./codebase-cmd.js');
    await codebaseCmd({ ...globalOpts, ...cmdOpts });
  });


program
    .command('review [id]')
    .description('Inspect and process .teamai/pending-review.jsonl items')
    .option('--apply', 'Apply the change for the given id (only for codebase-section)')
    .option('--reject', 'Reject the given id without applying')
    .option('--reason <msg>', 'Reason for reject')
    .option('--all-apply', 'Apply all items at or below --max-risk')
    .option('--max-risk <level>', 'Risk ceiling for --all-apply: high|medium|low (default medium)', 'medium')
    .option('--json', 'Machine-readable output')
    .action(async (idArg, cmdOpts) => {
        const globalOpts = program.opts() as GlobalOptions;
        const { reviewCmd } = await import('./review-cmd.js');
        await reviewCmd({ ...globalOpts, ...cmdOpts, idArg });
    });

program
    .command('domains <subcommand> [repoUrl]', { hidden: true })
    
    .description('Inspect / accept / reject domain-drift signals (subcommand: drift)')
    .option('--apply', 'Apply drift for the given repoUrl')
    .option('--apply-all', 'Apply all drift items above confidence threshold')
    .option('--threshold <n>', 'Confidence threshold for --apply-all (default 0.8)', '0.8')
    .option('--lock', 'Lock the repo against future drift signals')
    .option('--output <path>', 'Custom teamwiki output root directory')
    .option('--skip-aggregate', 'Skip regenerateAggregate after apply')
    .option('--json', 'Machine-readable output')
    .action(async (subcommand, repoUrlArg, cmdOpts) => {
        if (subcommand !== 'drift') {
            log.error(`Unknown subcommand: ${subcommand}（仅支持 drift）`);
            process.exitCode = 2;
            return;
        }
        const globalOpts = program.opts() as GlobalOptions;
        const { driftCmd } = await import('./drift-cmd.js');
        await driftCmd({ ...globalOpts, ...cmdOpts, repoUrlArg });
    });

// ─── Unified hook dispatch (replaces individual hook subcommands) ────

program
  .command('hook-dispatch <event>', { hidden: true })
  
  .description('Unified hook dispatcher — handles all teamai hooks for a given event in one process')
  .option('--tool <name>', 'Tool identifier (e.g. claude, claude-internal, cursor)')
  .option('--matcher <matcher>', 'Hook matcher for PostToolUse (e.g. Skill, Bash)')
  .action(async (event: string, cmdOpts: { tool?: string; matcher?: string }) => {
    const { hookDispatchCli } = await import('./hook-dispatch-cli.js');
    await hookDispatchCli(event, cmdOpts.tool ?? 'claude', cmdOpts.matcher ?? '*');
  });

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
    const p = await import('node:path');
    const wikiRoot = cmdOpts.wikiRoot ?? p.join(process.cwd(), '.teamai', 'team-repo', 'teamwiki');
    const evidenceDir = p.join(wikiRoot, 'evidence', 'code', cmdOpts.project);
    const { deepEnrich } = await import('./deep-enrich.js');
    await deepEnrich({ project: cmdOpts.project, evidenceDir, wikiRoot, maxModules: cmdOpts.maxModules });
  });

recallCmd
  .command('feedback')
  .description('Record manual feedback for a recalled document')
  .option('--positive <docId>', 'Upvote a document (marks as actually useful)')
  .option('--negative <docId>', 'Record negative signal for a document')
  .action(async (cmdOpts) => {
    const { recallFeedback } = await import('./votes.js');
    await recallFeedback({ positive: cmdOpts.positive, negative: cmdOpts.negative });
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
  .action(async (cmdOpts) => {
    const { requireInit } = await import('./config.js');
    const { localConfig } = await requireInit();
    const repoPath = localConfig.repo.localPath;
    const votesDir = `${repoPath}/votes`;
    const learningsDir = `${repoPath}/learnings`;

    if (cmdOpts.confidenceWriteback) {
      const { computeAllConfidence, writeBackConfidence } = await import('./maintenance/index.js');
      const map = await computeAllConfidence(votesDir);
      await writeBackConfidence(learningsDir, map);
      return;
    }

    if (cmdOpts.prune) {
      const { findPruneCandidates, executePrune } = await import('./maintenance/index.js');
      const candidates = await findPruneCandidates(learningsDir, votesDir, {
        threshold: cmdOpts.threshold,
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
      await executePrune(repoPath, candidates, {
        dryRun: cmdOpts.dryRun,
        archive: cmdOpts.archive,
      });
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
        const related = await findRelatedAdoptedLearnings(entry, votesDir, learningsDir);
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

    const { log } = await import('./utils/logger.js');
    log.info('Usage: teamai recall maintenance --prune | --confidence-writeback | --update-quality');
  });

recallCmd
  .command('promote [learningId]')
  .description('Promote a high-confidence learning to formal knowledge (docs/skills/rules)')
  .option('--category <cat>', 'Target category: skills | rules | docs')
  .option('--dry-run', 'Show what would be done without making changes')
  .action(async (learningId, cmdOpts) => {
    const { requireInit } = await import('./config.js');
    const { localConfig } = await requireInit();
    const repoPath = localConfig.repo.localPath;
    const votesDir = `${repoPath}/votes`;
    const learningsDir = `${repoPath}/learnings`;
    const { findPromotionCandidates, executePromotion } = await import('./maintenance/index.js');
    const { log } = await import('./utils/logger.js');

    const candidates = await findPromotionCandidates(learningsDir, votesDir);

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
    });
  });

program.parse();
