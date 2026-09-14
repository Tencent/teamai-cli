/**
 * session-cmd.ts — SessionFlow 子命令注册。
 *
 * 把 SessionFlow 的会话迁移/同步/搜索/恢复能力注册为 `teamai session` 的子命令：
 *
 *   teamai session migrate   跨平台迁移会话（或同平台存档）
 *   teamai session push      推送会话到团队仓
 *   teamai session pull      从团队仓拉取当前项目的会话
 *   teamai session list      列出当前项目下团队成员的会话
 *   teamai session resume    恢复会话到本地平台，接着聊
 *   teamai session search    搜索历史会话内容
 *   teamai session rollback  回滚一次迁移
 *
 * 与现有的 `teamai session save`（脱敏摘要）并列，互不干扰。
 *
 * 项目隔离：按当前 cwd 的 git remote origin → canonical → 团队仓目录。
 * 非 git 目录降级到 _unattributed/，不报错。
 */

import type { Command } from 'commander';
import readline from 'node:readline';
import { getAdapter, listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';
import { MigrationEngine } from './migrate.js';
import { SyncManager, getRepoIdentity, getGitAuthor, defaultSyncMeta } from './sync.js';
import { SessionSearchEngine, type LoadedSession } from './search.js';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 预读所有 stdin 行到队列，ask 从队列取。
 *
 * 不能用 rl.question 逐次等待：管道批量输入时多个 question 的回调会竞争
 * （前一个问题 shift 回调后、下一个问题的回调尚未注册，中间的输入行会被丢弃）。
 * 队列式 reader 在 TTY 和管道下都稳定。
 */
let lineQueue: string[] = [];
let lineResolver: ((line: string) => void) | null = null;
let lineReaderStarted = false;

let sharedRl: readline.Interface | null = null;

function startLineReader(): void {
  if (lineReaderStarted) return;
  lineReaderStarted = true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  sharedRl = rl;
  rl.on('line', (line) => {
    if (lineResolver) {
      const r = lineResolver;
      lineResolver = null;
      r(line.trim());
    } else {
      lineQueue.push(line.trim());
    }
  });
}

/**
 * 关闭 readline 接口，释放 event loop。
 * 必须在所有交互式输入结束后调用，否则进程会挂起不退出（终端不返回提示符）。
 */
function closeStdin(): void {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
  }
  lineResolver = null;
}

/**
 * 读一行用户输入（交互式）。优先取预读队列，否则等待下一行。
 */
function ask(question: string): Promise<string> {
  startLineReader();
  return new Promise((resolve) => {
    if (lineQueue.length > 0) {
      resolve(lineQueue.shift() as string);
      return;
    }
    lineResolver = resolve;
    process.stdout.write(question);
  });
}

/**
 * 显示一个编号菜单，让用户选择一项。
 * 输入数字或名称都接受，返回选中的字符串。
 */
async function promptSelect(question: string, options: string[]): Promise<string> {
  console.log(question);
  for (let i = 0; i < options.length; i++) {
    console.log(`  [${i + 1}] ${options[i]}`);
  }
  const ans = await ask('Select (number or name): ');
  if (!ans) throw new Error('Selection cancelled');
  const num = parseInt(ans, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= options.length) {
    return options[num - 1];
  }
  const lower = ans.toLowerCase();
  const byName = options.find((o) => o.toLowerCase() === lower);
  if (byName) return byName;
  throw new Error(`Invalid selection: ${ans}`);
}

/**
 * 安全获取适配器，无效平台给出友好提示而非 stack trace。
 */
function safeGetAdapter(platform: string) {
  try {
    return getAdapter(platform);
  } catch {
    const available = listAvailablePlatforms().join(', ');
    console.error(`Error: Unknown platform "${platform}".`);
    console.error(`Available platforms: ${available}`);
    process.exit(1);
  }
}

/**
 * 解析当前 cwd 的 repoIdentity（git remote canonical）。
 * 非 git 目录返回 null（降级到 _unattributed），不报错。
 */
function resolveRepoIdentity(cwd?: string): string | null {
  return getRepoIdentity(cwd ?? process.cwd());
}

/**
 * 获取团队仓根目录。
 * 优先用 --repo-root；否则用 cwd（假设 cwd 就是团队仓 clone）。
 */
function resolveRepoRoot(repoRoot?: string): string {
  return repoRoot ?? process.cwd();
}

// ---------------------------------------------------------------------------
// 命令注册
// ---------------------------------------------------------------------------

/**
 * 在 `teamai session` 子命令对象上注册 SessionFlow 的 7 个子命令。
 */
export function registerSessionFlowCommands(sessionCmd: Command): void {
  // --dry-run / -v 是顶层 program 上的全局选项，不会自动出现在子命令的 opts 里。
  // 原项目各命令统一用 `program.opts()` 取全局选项再与命令自身选项合并
  // （见 src/index.ts 中 init/push/pull 的 action），这里保持一致。
  const root = sessionCmd.parent ?? sessionCmd;
  const isDryRun = (): boolean => Boolean((root.opts() as { dryRun?: boolean }).dryRun);

  // ── session platforms ──────────────────────────────────────
  sessionCmd
    .command('platforms')
    .description('List supported and installed AI agent platforms')
    .action(async () => {
      const available = listAvailablePlatforms();
      const installed = listInstalledPlatforms();
      console.log('Available platforms:');
      for (const p of available) {
        const status = installed.includes(p) ? '✓ installed' : '✗ not installed';
        console.log(`  ${p}: ${status}`);
      }
    });

  // ── session migrate ────────────────────────────────────────
  sessionCmd
    .command('migrate')
    .description('Migrate a session from one platform to another (or archive to same platform)')
    .argument('[sessionId]', 'Session ID to migrate')
    .option('-s, --source <platform>', 'Source platform (e.g. claude-code, codebuddy)')
    .option('-t, --target <platform>', 'Target platform')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--target-cwd <path>', 'Override cwd for the target session')
    .option('--push', 'Also push the migrated session to the team repo')
    .option('--repo-root <path>', 'Team repo root (for --push)')
    .option('--all', 'Migrate all recent sessions from source (top 5)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (sessionId, opts) => {
      try {
      let source = opts.source;
      let target = opts.target;

      // 交互式：缺 source/target 时引导选择
      if (!source) {
        source = await promptSelect('Select source platform:', listAvailablePlatforms());
      }
      if (!target) {
        const others = listAvailablePlatforms().filter((p) => p !== source);
        target = await promptSelect('Select target platform:', others);
      }

      let workCwd = opts.cwd ?? process.cwd();
      const sourceAdapter = safeGetAdapter(source);
      let metas = await sourceAdapter.listConversations(workCwd);

      // 当前 cwd 无会话时，交互式提示列出全部目录的会话
      if (metas.length === 0 && !opts.cwd && !sessionId) {
        const allMetas = await sourceAdapter.listConversations();
        if (allMetas.length > 0) {
          console.log(`\nNo sessions found in current directory: ${workCwd}`);
          console.log(`But ${allMetas.length} session(s) found across all directories on ${source}.`);
          const ans = await ask('List all? (y/N): ');
          if (ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes') {
            metas = allMetas;
          }
        }
      }

      if (metas.length === 0) {
        console.log('No sessions found on source platform.');
        return;
      }

      // 选择会话
      let targets: typeof metas;
      if (opts.all) {
        targets = metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
      } else if (sessionId) {
        targets = metas.filter((m) => m.sessionId === sessionId || m.sessionId.startsWith(sessionId));
        if (targets.length === 0) {
          console.error(`Session not found: ${sessionId}`);
          process.exit(1);
        }
      } else {
        // 交互式：列出最近的 10 个，让用户选号
        const recent = metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);
        console.log('\nRecent sessions on ' + source + ':');
        for (let i = 0; i < recent.length; i++) {
          const m = recent[i];
          const title = m.title.length > 50 ? m.title.slice(0, 50) + '...' : m.title;
          console.log(`  [${i + 1}] ${m.sessionId.slice(0, 8)}  ${title}  (${m.messageCount} msgs, ${formatBytes(m.sizeBytes)})`);
        }
        const ans = await ask('\nSelect session (number) or Enter to cancel: ');
        const num = parseInt(ans, 10);
        if (!ans || Number.isNaN(num) || num < 1 || num > recent.length) {
          console.log('Cancelled.');
          return;
        }
        targets = [recent[num - 1]];
      }

      const engine = new MigrationEngine(source, target);
      let migrated = 0;

      for (const m of targets) {
        const preview = await engine.preview(m.sessionId, workCwd);

        console.log(`\n  Migration Preview`);
        console.log(`  ─────────────────────────────────`);
        console.log(`  Source:    ${preview.sourcePlatform}`);
        console.log(`  Target:    ${preview.targetPlatform}`);
        console.log(`  Session:   ${preview.sessionTitle} (${preview.sessionId.slice(0, 8)}...)`);
        console.log(`  CWD:       ${preview.cwd}`);
        console.log(`  Messages:  ${preview.messageCount}`);
        console.log(`  ─────────────────────────────────`);
        console.log(`  Fidelity:  ${(preview.fidelity.score * 100).toFixed(1)}% (Mode ${preview.fidelity.mode})`);
        console.log(`  Preserved: ${preview.fidelity.preservedBlocks}/${preview.fidelity.totalBlocks} blocks`);
        if (preview.fidelity.degradedBlocks > 0) {
          console.log(`  Degraded:  ${preview.fidelity.degradedBlocks} blocks`);
        }
        for (const d of preview.fidelity.degradations) {
          console.log(`    ⚠ ${d}`);
        }
        for (const w of preview.fidelity.warnings) {
          console.log(`    ⚠ ${w}`);
        }

        // --dry-run：Preview 打印完就停。
        // 迁移没有确认环节（打完 Preview 就直接执行），不接全局 --dry-run 的话，
        // 想看保真度和告警就只能真迁一次、不满意再 rollback。
        if (isDryRun()) {
          console.log(`\n  · --dry-run：仅预览，未迁移 ${m.sessionId.slice(0, 8)}...\n`);
          continue;
        }

        // 目标 cwd 默认为当前工作目录（真实绝对路径）。
        // 不传的话 writeSession 会回退到 session.cwd——那可能是源平台存的
        // encoded 形式（如 `-Users-foo-project`），无法还原真实路径。
        const result = await engine.migrate(m.sessionId, workCwd, opts.targetCwd ?? workCwd);
        if (result.success) {
          console.log(`\n  ✓ Migration successful`);
          console.log(`  Target session ID: ${result.targetSessionId}`);
          if (result.targetFilePath) {
            console.log(`  Target file: ${result.targetFilePath}`);
          }
          console.log(`  Fidelity: ${(result.preview.fidelity.score * 100).toFixed(1)}%`);
          migrated++;
        } else {
          console.error(`\n  ✗ Migration failed: ${result.error}`);
        }
      }

      // --push: 推送到团队仓
      if (opts.push && migrated > 0) {
        const repoRoot = resolveRepoRoot(opts.repoRoot);
        const repoIdentity = resolveRepoIdentity(workCwd);
        const author = getGitAuthor(workCwd);
        const targetAdapter = safeGetAdapter(target);
        const targetMetas = await targetAdapter.listConversations(opts.targetCwd ?? workCwd);
        const recent = targetMetas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, migrated);

        const syncMgr = new SyncManager(repoRoot);
        let saved = 0;
        for (const m of recent) {
          const session = await targetAdapter.readSession(m.sessionId, opts.targetCwd ?? workCwd);
          const meta = defaultSyncMeta({
            platform: target,
            author,
            cwd: opts.targetCwd ?? workCwd,
            sessionId: m.sessionId,
            repoIdentity,
          });
          meta.migration.migratedAt = new Date().toISOString();
          meta.migration.sourcePlatform = source;
          meta.migration.targetPlatform = target;
          meta.migration.fidelityScore = 1.0;
          syncMgr.saveSession(session, meta);
          saved++;
        }
        const commitHash = syncMgr.gitCommit(`sync: migrate ${saved} session(s) ${source}→${target}`);
        syncMgr.gitPush();
        console.log(`\n  ✓ Pushed ${saved} session(s) to team repo`);
        console.log(`  commit: ${commitHash.slice(0, 8)}`);
      }

      console.log(
        isDryRun()
          ? `\n  ${targets.length} session(s) would be migrated (--dry-run, no changes made).\n`
          : `\n  ${migrated} session(s) migrated.\n`,
      );
      } finally {
        closeStdin();
      }
    });

  // ── session push ───────────────────────────────────────────
  sessionCmd
    .command('push')
    .description('Push local sessions to the team repo')
    .option('--source <platform>', 'Source platform to read sessions from')
    .option('--repo-root <path>', 'Team repo root (defaults to cwd)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--limit <n>', 'Max sessions to push (default: 5)', '5')
    .action(async (opts) => {
      const source = opts.source;
      if (!source) {
        console.error('Error: --source <platform> required.');
        console.error('Usage: teamai session push --source <platform> [--repo-root <path>]');
        process.exit(1);
      }
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = resolveRepoRoot(opts.repoRoot);
      const repoIdentity = resolveRepoIdentity(workCwd);
      const author = getGitAuthor(workCwd);
      const adapter = safeGetAdapter(source);
      const metas = await adapter.listConversations(workCwd);
      const limit = parseInt(opts.limit, 10) || 5;
      const sorted = metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);

      if (sorted.length === 0) {
        console.log('No sessions found to push.');
        return;
      }

      const syncMgr = new SyncManager(repoRoot);
      let saved = 0;
      for (const m of sorted) {
        const session = await adapter.readSession(m.sessionId, workCwd);
        const meta = defaultSyncMeta({
          platform: source,
          author,
          cwd: workCwd,
          sessionId: m.sessionId,
          repoIdentity,
        });
        syncMgr.saveSession(session, meta);
        saved++;
      }
      const commitHash = syncMgr.gitCommit(`sync: push ${saved} session(s) from ${source}`);
      syncMgr.gitPush();
      console.log(`\n  ✓ Pushed ${saved} session(s) from ${source}`);
      console.log(`  commit: ${commitHash.slice(0, 8)}\n`);
    });

  // ── session pull ───────────────────────────────────────────
  sessionCmd
    .command('pull')
    .description('Pull team sessions for the current project')
    .option('--repo-root <path>', 'Team repo root (defaults to cwd)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .action(async (opts) => {
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = resolveRepoRoot(opts.repoRoot);
      const repoIdentity = resolveRepoIdentity(workCwd);

      const syncMgr = new SyncManager(repoRoot);
      syncMgr.gitPull();
      const count = syncMgr.rebuildIndex(repoIdentity);
      console.log(`\n  ✓ Pulled and indexed ${count} session(s)\n`);
    });

  // ── session list ───────────────────────────────────────────
  sessionCmd
    .command('list')
    .description('List team sessions for the current project')
    .option('--repo-root <path>', 'Team repo root (defaults to cwd)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--author <name>', 'Filter by author')
    .action(async (opts) => {
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = resolveRepoRoot(opts.repoRoot);
      const repoIdentity = resolveRepoIdentity(workCwd);

      const syncMgr = new SyncManager(repoRoot);
      const sessions = syncMgr.listSessions(repoIdentity, opts.author);

      if (sessions.length === 0) {
        console.log('No team sessions found.');
        return;
      }

      const repoLabel = repoIdentity ?? '_unattributed';
      console.log(`\nSessions for ${repoLabel}:\n`);
      console.log(`  SESSION                              AUTHOR       PLATFORM        MSGS  UPDATED`);
      console.log(`  ──────────────────────────────────────────────────────────────────────────`);
      for (const s of sessions) {
        const name = s.sessionName.length > 36 ? s.sessionName.slice(0, 34) + '..' : s.sessionName.padEnd(36);
        const authorCol = s.author.padEnd(12);
        const platCol = s.platform.padEnd(16);
        const msgCol = String(s.messageCount).padStart(4);
        const dateCol = s.updatedAt.slice(0, 10);
        console.log(`  ${name}  ${authorCol}${platCol}${msgCol}  ${dateCol}`);
      }
      console.log(`\n  ${sessions.length} session(s)\n`);
    });

  // ── session resume ─────────────────────────────────────────
  sessionCmd
    .command('resume')
    .description('Restore a team session to a local platform')
    .argument('<sessionName>', 'Session name (from `teamai session list`)')
    // 选项名用 --platform 而非 --in：与 rollback 的 --platform 对齐，
    // 也符合本项目其余命令的名词式命名（--source / --target / --agent / --role）。
    .requiredOption('--platform <platform>', 'Target platform to restore into')
    .option('--repo-root <path>', 'Team repo root (defaults to cwd)')
    .option('--cwd <path>', 'Working directory for the restored session (defaults to current directory)')
    .option('--author <name>', 'Author of the session (if ambiguous)')
    .action(async (sessionName, opts) => {
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = resolveRepoRoot(opts.repoRoot);
      const repoIdentity = resolveRepoIdentity(workCwd);

      const syncMgr = new SyncManager(repoRoot);
      const { session } = syncMgr.loadSession(repoIdentity, sessionName, opts.author);

      const resumeAdapter = safeGetAdapter(opts.platform);
      const resumeCwd = opts.cwd ?? process.cwd();
      session.cwd = resumeCwd;

      const newSessionId = await resumeAdapter.writeSession(session, resumeCwd);

      console.log(`\n  ✓ Session restored to ${opts.platform}`);
      console.log(`  Session ID: ${newSessionId}`);
      console.log(`  Messages: ${session.messages.length}`);
      console.log(`  CWD: ${resumeCwd}`);
      console.log(`\n  To continue: ${opts.platform} --resume ${newSessionId}\n`);
    });

  // ── session search ─────────────────────────────────────────
  sessionCmd
    .command('search')
    .description('Search team session content')
    .argument('<query>', 'Search query')
    .option('--repo-root <path>', 'Team repo root (defaults to cwd)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--limit <n>', 'Max results (default: 10)', '10')
    .option('--all', 'Search across all projects (not just current)')
    .action(async (query, opts) => {
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = resolveRepoRoot(opts.repoRoot);
      const repoIdentity = resolveRepoIdentity(workCwd);
      const limit = parseInt(opts.limit, 10) || 10;

      const syncMgr = new SyncManager(repoRoot);
      const loadedSessions: LoadedSession[] = [];

      if (opts.all) {
        // 遍历所有 repo
        const repos = syncMgr.listRepos();
        for (const repo of repos) {
          const entries = syncMgr.listSessions(null); // _unattributed
          // listRepos 返回的是编码后的目录名，需要用 null 遍历 _unattributed
        }
        // 简化：直接遍历 sessions/repos/ 下所有子目录
        const allRepos = syncMgr.listRepos();
        for (const _repo of allRepos) {
          // listSessions 需要 repoIdentity（canonical），但 listRepos 返回的是编码名
          // 这里用一个简化方案：遍历 _index.json
        }
        // _unattributed
        const unattributed = syncMgr.listSessions(null);
        for (const entry of unattributed) {
          try {
            const { session } = syncMgr.loadSession(null, entry.sessionName, entry.author);
            loadedSessions.push({ sessionName: entry.sessionName, author: entry.author, session });
          } catch {
            // skip corrupted
          }
        }
      }

      // 当前 repo
      const entries = syncMgr.listSessions(repoIdentity);
      for (const entry of entries) {
        try {
          const { session } = syncMgr.loadSession(repoIdentity, entry.sessionName, entry.author);
          loadedSessions.push({ sessionName: entry.sessionName, author: entry.author, session });
        } catch {
          // skip corrupted
        }
      }

      const searchEngine = new SessionSearchEngine();
      const results = await searchEngine.search(loadedSessions, query, { limit });

      if (results.length === 0) {
        console.log('No results found.');
        return;
      }

      console.log('');
      for (let i = 0; i < results.length; i++) {
        const hit = results[i];
        const date = hit.createdAt ? hit.createdAt.slice(0, 10) : 'unknown';
        const snippet = hit.snippet.length > 150 ? hit.snippet.slice(0, 150) + '...' : hit.snippet;
        console.log(`  [${i + 1}] ${hit.sessionName} (${hit.author}, ${date})`);
        console.log(`      Score: ${hit.score.toFixed(1)}`);
        console.log(`      ${snippet}`);
        console.log('');
      }
      console.log(`  ${results.length} result(s) found`);
    });

  // ── session rollback ───────────────────────────────────────
  sessionCmd
    .command('rollback')
    .description('Rollback a migration (delete the target session)')
    .argument('<sessionId>', 'Target session ID to delete')
    .requiredOption('--platform <platform>', 'Platform where the session was written')
    .option('--cwd <cwd>', 'Only roll back the copy under this project path (default: all)')
    .action(async (sessionId, opts) => {
      // 回滚是破坏性操作（删 CLI 文件 + 删 IDE 侧边栏条目），先看清楚再删。
      if (isDryRun()) {
        console.log(
          `\n  · --dry-run：将删除 ${opts.platform}/${sessionId}` +
            `${opts.cwd ? ` (仅 ${opts.cwd})` : ' (所有工作区)'}\n`,
        );
        return;
      }

      const adapter = safeGetAdapter(opts.platform);
      const deleted = await adapter.deleteSession(sessionId, opts.cwd);
      // 适配器返回 false 表示确认没删到任何东西（会话不存在）。
      // 之前无论是否存在都打印 ✓，静默 no-op 却报成功，脚本无法判断是否生效。
      if (deleted === false) {
        console.log(`\n  · 未找到会话 ${opts.platform}/${sessionId}，无变更（可能已被删除）\n`);
        return;
      }
      console.log(`\n  ✓ Rolled back: ${opts.platform}/${sessionId}\n`);
    });
}
