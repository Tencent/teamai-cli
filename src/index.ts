import { createRequire } from 'node:module';
import { Command } from 'commander';
import { setVerbose, setSilent } from './utils/logger.js';
import type { GlobalOptions } from './types.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
  .name('teamai')
  .description('TeamAI — 团队 AI 经验共享框架')
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
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { init } = await import('./init.js');
    await init({ ...globalOpts, ...cmdOpts });
  });

program
  .command('push')
  .description('Push local resources to team repo')
  .option('--all', 'Push all without confirmation')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { push } = await import('./push.js');
    await push({ ...globalOpts, ...cmdOpts });
  });

program
  .command('pull')
  .description('Pull team resources and inject into local AI tools')
  .option('--silent', 'Silent mode (for hooks)')
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
  .description('List resources (skills|rules|docs|env)')
  .action(async (type) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { list } = await import('./status.js');
    await list(type, globalOpts);
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
  .command('remove <type> <name>')
  .description('Remove a resource from team repo and all local AI tools (type: skills|rules)')
  .action(async (type, name) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { remove } = await import('./remove.js');
    await remove(type, name, globalOpts);
  });

program
  .command('doctor')
  .description('Diagnose configuration issues')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { doctor } = await import('./doctor.js');
    await doctor(globalOpts);
  });

program
  .command('update')
  .description('Check for updates and upgrade teamai CLI')
  .option('--check', 'Only check if an update is available, do not install')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { update } = await import('./update.js');
    await update({ ...globalOpts, ...cmdOpts });
  });

const envCmd = program
  .command('env')
  .description('Manage team environment variables')
  .action(async () => {
    // Default action: list env vars (backward compatible)
    const globalOpts = program.opts() as GlobalOptions;
    const { envList } = await import('./env-commands.js');
    await envList(globalOpts);
  });

envCmd
  .command('list')
  .description('List team environment variables')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const { envList } = await import('./env-commands.js');
    await envList(globalOpts);
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
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const { contribute } = await import('./contribute.js');
    await contribute({ ...globalOpts, ...cmdOpts });
  });

program.parse();
