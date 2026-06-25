import { createRequire } from 'node:module';
import { Command } from 'commander';
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
  .option('--scope <scope>', 'Scope: user (default) or project')
  .option('--role <id>', 'Primary role ID (e.g. hai_dev) for non-interactive setup')
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
  .description('List resources (skills|rules|docs|env|wiki). For skills, --source local/all also scans installed AI agent skill directories.')
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
  .description('Remove resource(s) from team repo and all local AI tools (type: skills|rules|wiki)')
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
  .command('track [toolName] [toolInput]')
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
  .command('track-slash')
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
  .command('save-session')
  .description('Save current session tool usage summary')
  .option('--summary <text>', 'Session summary text')
  .action(async (cmdOpts) => {
    const { saveSession } = await import('./session-collector.js');
    await saveSession(cmdOpts.summary);
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
  .command('dashboard-report')
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
  .command('contribute-check')
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

program
  .command('recall [query...]')
  .description('Search team learnings knowledge base')
  .action(async (queryParts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const query = (queryParts as string[]).join(' ');
    const { recall } = await import('./recall.js');
    await recall(query, globalOpts);
  });

program
  .command('auto-recall')
  .description('Auto-recall team knowledge on tool errors (called by PostToolUse hook)')
  .option('--stdin', 'Read hook data from STDIN')
  .action(async (cmdOpts) => {
    if (cmdOpts.stdin) {
      const { autoRecall } = await import('./auto-recall.js');
      await autoRecall();
    }
  });

program
  .command('todowrite-hint')
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
  .description('Import knowledge from local files, Claude/Cursor rules, git workspace, MRs, or iWiki')
  .option('--dir <path>', 'Scan local directory for importable Markdown files')
  .option('--from-claude', 'Scan Claude/Cursor rule directories (~/.claude/rules, ~/.cursor/rules)')
  .option('--workspace', 'Generate codebase.md from current git workspace')
  .option('--from-mr <url>', 'Extract learning and codebase suggestions from a merged MR/PR URL')
  .option('--from-iwiki <space-id-or-url>', 'Import documents from iWiki Space ID or page URL (requires TAI_PAT_TOKEN)')
  .option('--resume', 'Resume an interrupted import session')
  .option('--all', 'Accept all suggestions without interactive confirmation')
  .option('--output <path>', 'Write drafts to this directory instead of pushing to team repo')
  .option('--existing-codebase <path>', 'Path to existing codebase.md (used with --from-mr; overrides auto-detection from team repo)')
  .option('--from-repo <url>', 'Clone a remote repo and generate per-repo codebase summary')
  .option('--depth <n>', 'Shallow clone depth for --from-repo (default 1)', '1')
  .option('--ssh', 'Force SSH clone even if HTTPS token is available')
  .option('--domain <name>', 'Skip AI recommendation and assign repo to this domain explicitly')
  .option('--from-repo-list <path>', 'Batch import repos from a YAML whitelist')
  .option('--concurrency <n>', 'Concurrent repos for --from-repo-list (default 3)', '3')
  .option('--skip-aggregate', 'Skip domain-*.md / index.md regeneration')
  .option('--incremental', 'Use cached clone with fetch+reset (with --from-repo or --from-repo-list)')
  .option('--from-org <org>', 'List repos under an org and bootstrap whitelist + domains')
  .option('--bootstrap', 'Run interactive review after --from-org')
  .option('--max-repos <n>', 'Cap on repos pulled from --from-org (default 200)', '200')
  .option('--exclude-archived', 'Exclude archived repos from --from-org (default true)')
  .option('--include-pattern <re>', 'Regex to include repos by full name (used with --from-org)')
  .option('--exclude-pattern <re>', 'Regex to exclude repos by full name (used with --from-org)')
  .option('--skip-import', 'Only write drafts; skip the actual --from-repo-list run')
  .option('--iwiki-dual', 'Enable dual-output mode for --from-iwiki (write codebase sections in addition to learning)')
  .option('--require-review', 'Defer codebase section writes to .teamai/pending-review.jsonl for human review')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { importCmd } = await import('./import.js');
    await importCmd({ ...globalOpts, ...cmdOpts });
  });

program
  .command('mr-hint')
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
  .option('--lint', 'Run global consistency lint over docs/team-codebase')
  .option('--fix', 'Apply low-risk mechanical fixes (only with --lint)')
  .option('--severity <level>', 'Minimum severity to report: high|medium|low|info', 'info')
  .option('--stale-days <n>', 'Threshold for sync-stale check', '60')
  .option('--pending-review-threshold <n>', 'Threshold for pending-review backlog', '10')
  .option('--json', 'Output report as JSON (suitable for CI)')
  .option('--output <path>', 'Custom team-codebase root (mirrors --from-repo)')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { codebaseCmd } = await import('./codebase-cmd.js');
    await codebaseCmd({ ...globalOpts, ...cmdOpts });
  });

program
  .command('cache')
  .description('Inspect and clean ~/.teamai/cache/repos')
  .option('--status', 'Print cache status (default action)')
  .option('--gc', 'Run garbage collection')
  .option('--max-bytes <n>', 'Override capacity cap for --gc')
  .option('--stale-days <n>', 'Threshold for stale-eviction (default 30)', '30')
  .option('--dry-run', 'Report actions without removing files')
  .option('--json', 'Machine-readable output')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { cacheCmd } = await import('./cache-cmd.js');
    await cacheCmd({ ...globalOpts, ...cmdOpts });
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
    .command('domains <subcommand> [repoUrl]')
    .description('Inspect / accept / reject domain-drift signals (subcommand: drift)')
    .option('--apply', 'Apply drift for the given repoUrl')
    .option('--apply-all', 'Apply all drift items above confidence threshold')
    .option('--threshold <n>', 'Confidence threshold for --apply-all (default 0.8)', '0.8')
    .option('--lock', 'Lock the repo against future drift signals')
    .option('--output <path>', 'Custom team-codebase root (mirrors --from-repo)')
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
  .command('hook-dispatch <event>')
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
  .option('--existing-codebase <path>', 'Existing codebase.md for style consistency')
  .option('--comment-marker <marker>', 'HTML comment anchor for idempotent updates', '<!-- teamai:ci-extract -->')
  .option('--write-mode <mode>', 'Write strategy: direct | pending-review', 'direct')
  .option('--output <dir>', 'Write artifacts to directory')
  .option('--individual-comments', 'Post each suggestion as separate comment with reaction/resolve support')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { ciExtractMr } = await import('./ci/extract-mr.js');
    await ciExtractMr({ ...globalOpts, ...cmdOpts });
  });

program.parse();
