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
import * as path from 'node:path';
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
 * 按会话**原生 cwd** 派生归档键（repoIdentity）——Key invariant：
 * 归档键来自会话自身的工作目录，绝不是 CLI 恰好运行所在的目录（设计文档 P3）。
 *
 * 各适配器 readSession 已尽量恢复原生 cwd：
 * - codex / workbuddy：存储自带真实路径
 * - claude-code / codebuddy / cursor：从 JSONL 记录的 cwd 字段恢复
 * - codebuddy-ide：工作区目录是 md5(cwd) 不可逆——恢复不出真实路径时
 *   session.cwd 是 `md5:<hash>` 占位，归 `_unattributed` 并打印英文警告
 */
function deriveArchiveIdentity(session: { cwd: string }, platform: string): string | null {
  const nativeCwd = session.cwd;
  if (nativeCwd && path.isAbsolute(nativeCwd)) {
    return getRepoIdentity(nativeCwd);
  }
  console.warn(
    `  ⚠ native cwd unknowable for ${platform} session, archived under _unattributed`,
  );
  return null;
}

/**
 * 获取团队仓根目录。
 * 优先用 --repo-root；否则用 cwd（假设 cwd 就是团队仓 clone）。
 */
function resolveRepoRoot(repoRoot?: string): string {
  return repoRoot ?? process.cwd();
}

/**
 * 推送团队仓远端；失败时降级为警告而非崩溃。
 *
 * 走到这里时本地 saveSession + gitCommit 已经成功——会话数据没有丢。
 * 远端失败的原因常常与数据无关（无 upstream、只读 HTTP 模式、网络），
 * 用堆栈炸掉会把一次成功的归档伪装成彻底失败，用户再跑一次还会造出重复提交。
 */
function pushToRemote(syncMgr: SyncManager): void {
  try {
    syncMgr.gitPush();
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.log(`  · Remote push failed (local commit kept): ${reason}`);
  }
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
      // 记录每次成功迁移产出的目标会话 ID + 真实保真度，
      // --push 时精确回读这些 ID（而非"目标平台最近 N 条"，避免推错，见 P4/P7）。
      const migratedTargets: { sessionId: string; fidelityScore: number }[] = [];

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
          console.log(`\n  · --dry-run: preview only, not migrated: ${m.sessionId.slice(0, 8)}...\n`);
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
          if (result.targetSessionId) {
            migratedTargets.push({
              sessionId: result.targetSessionId,
              fidelityScore: result.preview.fidelity.score,
            });
          }
        } else {
          console.error(`\n  ✗ Migration failed: ${result.error}`);
        }
      }

      // --push: 推送到团队仓
      if (opts.push && migrated > 0) {
        const repoRoot = resolveRepoRoot(opts.repoRoot);
        const author = getGitAuthor(workCwd);
        const targetAdapter = safeGetAdapter(target);

        const syncMgr = new SyncManager(repoRoot);
        let saved = 0;
        for (const t of migratedTargets) {
          const session = await targetAdapter.readSession(t.sessionId, opts.targetCwd ?? workCwd);
          // P3：归档键按会话原生 cwd 派生，而非 migrate 运行目录（见 deriveArchiveIdentity）
          const meta = defaultSyncMeta(
            {
              platform: target,
              author,
              cwd: session.cwd || opts.targetCwd || workCwd,
              sessionId: t.sessionId,
              repoIdentity: deriveArchiveIdentity(session, target),
            },
            session.createdAt,
          );
          meta.migration.migratedAt = new Date().toISOString();
          meta.migration.sourcePlatform = source;
          meta.migration.targetPlatform = target;
          meta.migration.fidelityScore = t.fidelityScore;
          syncMgr.saveSession(session, meta);
          saved++;
        }
        const commitHash = syncMgr.gitCommit(`sync: migrate ${saved} session(s) ${source}→${target}`);
        if (commitHash) {
          pushToRemote(syncMgr);
          console.log(`\n  ✓ Pushed ${saved} session(s) to team repo`);
          console.log(`  commit: ${commitHash.slice(0, 8)}`);
        } else {
          console.log(`\n  · No changes to push\n`);
        }
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
    .option('--limit <n>', 'Max sessions to push (default: 5; ignored with --all)', '5')
    .option('--all', 'Push every session of the platform across all workspace directories (ignores --limit)')
    .option('-y, --yes', 'Skip the confirmation prompt for large batches (--all)')
    .action(async (opts) => {
      try {
      const source = opts.source;
      if (!source) {
        console.error('Error: --source <platform> required.');
        console.error('Usage: teamai session push --source <platform> [--repo-root <path>] [--all]');
        process.exit(1);
      }
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = resolveRepoRoot(opts.repoRoot);
      const author = getGitAuthor(workCwd);
      const adapter = safeGetAdapter(source);
      // --all：listConversations() 无参即枚举该平台的全部工作区目录（P5），
      // 影响面收敛在单一平台（与 status --all 一致）；单 cwd 模式保持原行为。
      const metas = opts.all
        ? await adapter.listConversations()
        : await adapter.listConversations(workCwd);
      const limit = parseInt(opts.limit, 10) || 5;
      const sorted = metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const selected = opts.all ? sorted : sorted.slice(0, limit);

      if (selected.length === 0) {
        console.log('No sessions found to push.');
        return;
      }

      // 大批量确认：--all 推送超过 5 条时列清单（id/标题/条数）要求确认，-y 跳过
      if (opts.all && selected.length > 5 && !opts.yes) {
        console.log(`\nAbout to push ${selected.length} session(s) from ${source}:`);
        for (const m of selected) {
          const title = m.title.length > 50 ? m.title.slice(0, 50) + '...' : m.title;
          console.log(`  ${m.sessionId.slice(0, 8)}  ${title}  (${m.messageCount} msgs)`);
        }
        const ans = await ask('\nPush all of the above? (y/N): ');
        if (ans.toLowerCase() !== 'y' && ans.toLowerCase() !== 'yes') {
          console.log('Cancelled.');
          return;
        }
      }

      const syncMgr = new SyncManager(repoRoot);
      let saved = 0;
      for (const m of selected) {
        // --all 时会话可能来自任意工作区，scoped 查找（按 cwd 编码目录）会因
        // 目录名解码有损而 miss——交由适配器全局查找；单 cwd 模式仍传 workCwd。
        const session = await adapter.readSession(m.sessionId, opts.all ? undefined : workCwd);
        if (opts.all) {
          console.log(`  Source: ${session.cwd || 'unknown directory'}`);
        }
        // P3：归档键按会话原生 cwd 派生（见 deriveArchiveIdentity），而非 CLI 运行目录
        const meta = defaultSyncMeta(
          {
            platform: source,
            author,
            cwd: session.cwd || workCwd,
            sessionId: m.sessionId,
            repoIdentity: deriveArchiveIdentity(session, source),
          },
          session.createdAt,
        );
        syncMgr.saveSession(session, meta);
        saved++;
      }
      const commitHash = syncMgr.gitCommit(`sync: push ${saved} session(s) from ${source}${opts.all ? ' (all workspaces)' : ''}`);
      if (commitHash) {
        pushToRemote(syncMgr);
        console.log(`\n  ✓ Pushed ${saved} session(s) from ${source}`);
        console.log(`  commit: ${commitHash.slice(0, 8)}\n`);
      } else {
        console.log(`\n  · No changes to push\n`);
      }
      } finally {
        closeStdin();
      }
    });

  // ── session pull ───────────────────────────────────────────
  sessionCmd
    .command('pull')
    .description('Pull team sessions for the current project')
    .option('--repo-root <path>', 'Team repo root (defaults to cwd)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--all', 'Rebuild indexes for every repo in the team repo (not just the current project)')
    .action(async (opts) => {
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = resolveRepoRoot(opts.repoRoot);

      const syncMgr = new SyncManager(repoRoot);
      syncMgr.gitPull();
      if (opts.all) {
        // P2：对所有 identity（含 _unattributed）逐个幂等重建索引
        const identities = syncMgr.listAllRepoIdentities();
        let total = 0;
        for (const identity of identities) {
          total += syncMgr.rebuildIndex(identity);
        }
        console.log(`\n  ✓ Pulled and indexed ${total} session(s) across ${identities.length} repo(s)\n`);
      } else {
        const repoIdentity = resolveRepoIdentity(workCwd);
        const count = syncMgr.rebuildIndex(repoIdentity);
        console.log(`\n  ✓ Pulled and indexed ${count} session(s)\n`);
      }
    });

  // ── session list ───────────────────────────────────────────
  sessionCmd
    .command('list')
    .description('List team sessions for the current project')
    .option('--repo-root <path>', 'Team repo root (defaults to cwd)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--author <name>', 'Filter by author')
    .option('--all', 'List sessions across all projects in the team repo (not just the current one)')
    .action(async (opts) => {
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = resolveRepoRoot(opts.repoRoot);
      const repoIdentity = resolveRepoIdentity(workCwd);

      const syncMgr = new SyncManager(repoRoot);
      // P2：--all 走跨 repo 视图（含 _unattributed）；条目 repoIdentity 标识来源
      const sessions = opts.all
        ? syncMgr.listSessionsAcrossRepos(opts.author)
        : syncMgr.listSessions(repoIdentity, opts.author);

      if (sessions.length === 0) {
        console.log('No team sessions found.');
        return;
      }

      if (opts.all) {
        console.log(`\nSessions across all projects:\n`);
        console.log(`  SESSION                              AUTHOR       PLATFORM        MSGS  UPDATED    SOURCE`);
        console.log(`  ─────────────────────────────────────────────────────────────────────────────────────`);
        for (const s of sessions) {
          const name = s.sessionName.length > 36 ? s.sessionName.slice(0, 34) + '..' : s.sessionName.padEnd(36);
          const authorCol = s.author.padEnd(12);
          const platCol = s.platform.padEnd(16);
          const msgCol = String(s.messageCount).padStart(4);
          const dateCol = s.updatedAt.slice(0, 10);
          const source = s.repoIdentity ?? '_unattributed';
          console.log(`  ${name}  ${authorCol}${platCol}${msgCol}  ${dateCol}  ${source}`);
        }
      } else {
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
      // resume 无 try/catch 时 loadSession 的错误会以未捕获异常打到终端。
      // 常见根因是会话归档在其他项目名下（repoIdentity 不匹配）——
      // 给出可操作的指引而不是裸 stack trace（见设计文档 P9）。
      let session;
      try {
        ({ session } = syncMgr.loadSession(repoIdentity, sessionName, opts.author));
      } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        console.error('The session may be archived under another project identity.');
        console.error('Try `teamai session search --all <keyword>` to find it,');
        console.error('or rerun with `--cwd <project path>` of the project it belongs to.');
        process.exit(1);
      }

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

      // P1：--all 遍历所有 repo（含 _unattributed）加载会话；
      // 非 --all 只加载当前 repo。原实现的循环体是死代码——listRepos()
      // 返回编码后的目录名且无解码器，canonical identity 只能从各 repo 的
      // _index.json 反查（见 SyncManager.listAllRepoIdentities）。
      const identitiesToSearch: Array<string | null> = opts.all
        ? syncMgr.listAllRepoIdentities()
        : [repoIdentity];
      for (const identity of identitiesToSearch) {
        for (const entry of syncMgr.listSessions(identity)) {
          try {
            const { session } = syncMgr.loadSession(identity, entry.sessionName, entry.author);
            loadedSessions.push({ sessionName: entry.sessionName, author: entry.author, session });
          } catch {
            // skip corrupted
          }
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
          `\n  · --dry-run: would delete ${opts.platform}/${sessionId}` +
            `${opts.cwd ? ` (only ${opts.cwd})` : ' (all workspaces)'}\n`,
        );
        return;
      }

      const adapter = safeGetAdapter(opts.platform);
      const deleted = await adapter.deleteSession(sessionId, opts.cwd);
      // 适配器返回 false 表示确认没删到任何东西（会话不存在）。
      // 之前无论是否存在都打印 ✓，静默 no-op 却报成功，脚本无法判断是否生效。
      if (deleted === false) {
        console.log(`\n  · Session not found: ${opts.platform}/${sessionId}, no changes (may have already been deleted)\n`);
        return;
      }
      console.log(`\n  ✓ Rolled back: ${opts.platform}/${sessionId}\n`);
    });
}
