import YAML from 'yaml';
import path from 'node:path';
import fs from 'node:fs';
import { log } from './utils/logger.js';
import { readFileSafe, listFiles } from './utils/fs.js';
import { parseLearningDoc, titleFromFilename } from './utils/search-index.js';
import { requireInit, detectProjectConfig } from './config.js';
import { calculateTeamHealth } from './skill-health.js';
import { createGit } from './utils/git.js';
import type { GlobalOptions, UserStats, TokenUsage } from './types.js';
import { totalTokens } from './types.js';

interface SkillChange {
  name: string;
  author: string;
  type: 'new' | 'updated';
}

interface LearningInfo {
  title: string;
  date: string;
}

// ─── Weekly Team Digest ────────────────────────────────
//
//  teamai digest
//      │
//      ▼
//  [read team stats from stats/*.yaml]
//      │
//      ▼
//  [read learnings from learnings/*.md]
//      │
//      ▼
//  [read sessions from sessions/*/*.md]
//      │
//      ▼
//  [generate formatted weekly summary]
//

/**
 * Load all team stats from the repo's stats/ directory.
 */
async function loadTeamStats(repoPath: string): Promise<UserStats[]> {
  const statsDir = path.join(repoPath, 'stats');
  const stats: UserStats[] = [];

  try {
    const files = await listFiles(statsDir);
    for (const file of files) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const content = await readFileSafe(path.join(statsDir, file));
      if (!content) continue;
      try {
        const parsed = YAML.parse(content) as UserStats;
        if (parsed?.username && parsed?.skills) {
          stats.push(parsed);
        }
      } catch {
        log.debug(`Skipping invalid stats file: ${file}`);
      }
    }
  } catch {
    // stats/ dir doesn't exist yet
  }

  return stats;
}

/**
 * Parse raw git log output (format: hash|author|message, followed by file paths).
 */
function parseGitLogOutput(output: string): Array<{ author: string; message: string; files: string[] }> {
  const commits: Array<{ author: string; message: string; files: string[] }> = [];
  const lines = output.trim().split('\n');
  let current: { author: string; message: string; files: string[] } | null = null;

  for (const line of lines) {
    if (line.includes('|')) {
      const parts = line.split('|');
      if (parts.length >= 3) {
        if (current) commits.push(current);
        current = { author: parts[1], message: parts.slice(2).join('|'), files: [] };
        continue;
      }
    }
    if (current && line.trim().length > 0) {
      current.files.push(line.trim());
    }
  }
  if (current) commits.push(current);

  return commits;
}

/**
 * Detect new and updated skills in the team repo from the past 7 days
 * by inspecting git log for changes under skills/SKILL.md paths.
 */
async function getRecentSkillChanges(repoPath: string): Promise<SkillChange[]> {
  const seen = new Set<string>();
  const changes: SkillChange[] = [];

  try {
    const git = createGit(repoPath);

    // Get all commits touching skills SKILL.md in the last 7 days (Added or Modified)
    const rawOutput = await git.raw([
      'log', '--since=7 days ago', '--diff-filter=AM',
      '--name-only', '--pretty=format:%H|%an|%s',
      '--', 'skills/*/SKILL.md',
    ]);

    if (!rawOutput.trim()) return changes;

    const commits = parseGitLogOutput(rawOutput);

    for (const commit of commits) {
      for (const file of commit.files) {
        const match = file.match(/^skills\/([^/]+)\/SKILL\.md$/);
        if (!match) continue;
        const skillName = match[1];
        if (seen.has(skillName)) continue;
        seen.add(skillName);

        // Extract author from commit message pattern: "from <username>"
        const authorMatch = commit.message.match(/from (\S+)/);
        const author = authorMatch ? authorMatch[1] : commit.author;

        changes.push({ name: skillName, author, type: 'updated' });
      }
    }

    // Distinguish new vs updated: check if SKILL.md was first Added within the week
    if (changes.length > 0) {
      const addedOutput = await git.raw([
        'log', '--since=7 days ago', '--diff-filter=A',
        '--name-only', '--pretty=format:%H|%an|%s',
        '--', 'skills/*/SKILL.md',
      ]);

      const newSkills = new Set<string>();
      if (addedOutput.trim()) {
        const addedCommits = parseGitLogOutput(addedOutput);
        for (const commit of addedCommits) {
          for (const file of commit.files) {
            const match = file.match(/^skills\/([^/]+)\/SKILL\.md$/);
            if (match) {
              newSkills.add(match[1]);
            }
          }
        }
      }

      for (const change of changes) {
        if (newSkills.has(change.name)) {
          change.type = 'new';
        }
      }
    }
  } catch {
    log.debug('Could not read skill changelog from git log');
  }

  return changes;
}

/**
 * Get session summaries from the past week.
 */
async function getRecentSessions(repoPath: string): Promise<string[]> {
  const sessionsDir = path.join(repoPath, 'sessions');
  const summaries: string[] = [];

  try {
    const userDirs = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
    for (const userDir of userDirs) {
      if (!userDir.isDirectory()) continue;
      const userSessionsDir = path.join(sessionsDir, userDir.name);
      const files = await listFiles(userSessionsDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const content = await readFileSafe(path.join(userSessionsDir, file));
        if (content) {
          // Extract session entries (simplified: just grab content)
          summaries.push(`[${userDir.name}] ${file}:\n${content.slice(0, 500)}`);
        }
      }
    }
  } catch {
    // sessions/ doesn't exist yet
  }

  return summaries;
}

/**
 * Get recent learnings from the past 7 days.
 *
 * Filters by date embedded in filename (YYYY-MM-DD pattern),
 * then parses frontmatter for title metadata.
 */
async function getRecentLearnings(repoPath: string): Promise<{ recent: LearningInfo[]; total: number }> {
  const learningsDir = path.join(repoPath, 'learnings');
  const recent: LearningInfo[] = [];
  let total = 0;

  try {
    const files = await listFiles(learningsDir);
    const mdFiles = files.filter((f) => f.endsWith('.md'));
    total = mdFiles.length;

    // Calculate 7-day cutoff as YYYY-MM-DD string for comparison
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

    for (const filename of mdFiles) {
      // Extract date from filename pattern: *-YYYY-MM-DD-*.md
      const dateMatch = filename.match(/-(\d{4}-\d{2}-\d{2})-/);
      if (!dateMatch) continue;

      const fileDate = dateMatch[1];
      if (fileDate < cutoff) continue;

      // Parse frontmatter for title
      const content = await readFileSafe(path.join(learningsDir, filename));
      if (!content) continue;

      const parsed = parseLearningDoc(content, filename);
      const title = parsed?.meta.title ?? titleFromFilename(filename);

      recent.push({ title, date: fileDate });
    }

    // Sort by date descending
    recent.sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    // learnings/ doesn't exist yet
  }

  return { recent, total };
}

/** Aggregated team-wide Human Intervention summary (Issue #34). */
export interface InterventionSummary {
  totalSessions: number;
  totalInterventions: number;
  interrupt: number;
  toolReject: number;
  correction: number;
  /** Team-wide mean interventions per session. */
  avgPerSession: number;
  /** Per-user ranking by intervention rate (highest first = least autonomous). */
  ranked: Array<{ username: string; sessions: number; total: number; rate: number }>;
}

/**
 * Summarize the Human Intervention metric across all reported team stats.
 * Returns null when no user has reported any interventions yet.
 */
export function summarizeInterventions(teamStats: UserStats[]): InterventionSummary | null {
  const users = teamStats.filter((u) => u.interventions && u.interventions.sessions > 0);
  if (users.length === 0) return null;

  let totalSessions = 0;
  let interrupt = 0;
  let toolReject = 0;
  let correction = 0;

  const ranked = users.map((u) => {
    const iv = u.interventions!;
    const total = iv.interrupt + iv.toolReject + iv.correction;
    totalSessions += iv.sessions;
    interrupt += iv.interrupt;
    toolReject += iv.toolReject;
    correction += iv.correction;
    return {
      username: u.username,
      sessions: iv.sessions,
      total,
      rate: iv.sessions > 0 ? total / iv.sessions : 0,
    };
  }).sort((a, b) => b.rate - a.rate);

  const totalInterventions = interrupt + toolReject + correction;
  return {
    totalSessions,
    totalInterventions,
    interrupt,
    toolReject,
    correction,
    avgPerSession: totalSessions > 0 ? totalInterventions / totalSessions : 0,
    ranked,
  };
}

/** Aggregated team-wide conversation-turn + token-usage summary (Issue #75). */
export interface ConversationSummary {
  /** Total human conversation turns (UserPromptSubmit) across the team. */
  totalPrompts: number;
  /** Team-wide cumulative token usage. */
  tokens: TokenUsage;
  /** Grand total of all token buckets. */
  totalTokens: number;
  /** Per-user ranking by token usage (highest first). */
  ranked: Array<{ username: string; prompts: number; tokens: number }>;
}

/** Compact a token count into a human-friendly string (e.g. 12.3M, 4.5K). */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Summarize the conversation-turn count and token usage across all reported team
 * stats. Returns null when no user has reported any prompts or tokens yet.
 */
export function summarizeConversation(teamStats: UserStats[]): ConversationSummary | null {
  const users = teamStats.filter(
    (u) => (u.prompts && u.prompts > 0) || (u.tokens && totalTokens(u.tokens) > 0),
  );
  if (users.length === 0) return null;

  let totalPrompts = 0;
  const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  const ranked = users.map((u) => {
    const p = u.prompts ?? 0;
    const t = u.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    totalPrompts += p;
    tokens.input += t.input;
    tokens.output += t.output;
    tokens.cacheRead += t.cacheRead;
    tokens.cacheCreation += t.cacheCreation;
    return { username: u.username, prompts: p, tokens: totalTokens(t) };
  }).sort((a, b) => b.tokens - a.tokens);

  return { totalPrompts, tokens, totalTokens: totalTokens(tokens), ranked };
}

/**
 * Generate and display weekly team digest.
 */
export async function generateDigest(options: GlobalOptions): Promise<void> {
  try {
    const projectConfig = await detectProjectConfig();
    const localConfig = projectConfig ?? (await requireInit()).localConfig;
    const repoPath = localConfig.repo.localPath;

    const teamStats = await loadTeamStats(repoPath);

    if (teamStats.length === 0) {
      console.log('No team usage data available yet.');
      console.log('Usage data is collected automatically and reported during `teamai pull`.');
      return;
    }

    const health = calculateTeamHealth(teamStats);
    const sessions = await getRecentSessions(repoPath);

    // Header
    const now = new Date();
    const weekStart = new Date(now.getTime() - 7 * 86_400_000);
    console.log('');
    console.log('╔════════════════════════════════════════════════════╗');
    console.log('║           📊 Team AI Weekly Digest                ║');
    console.log(`║  ${weekStart.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}                        ║`);
    console.log('╚════════════════════════════════════════════════════╝');
    console.log('');

    // Team members active
    console.log(`👥 Active members: ${teamStats.length}`);
    console.log('');

    // Most used skills
    console.log('🏆 Most Used Skills:');
    for (const item of health.slice(0, 10)) {
      console.log(`  ${item.stars}  ${item.skill} (${item.totalCount} uses)`);
    }
    console.log('');

    // Total events
    const totalEvents = teamStats.reduce(
      (sum, u) => sum + Object.values(u.skills).reduce((s, sk) => s + sk.count, 0),
      0,
    );
    console.log(`📈 Total skill invocations: ${totalEvents}`);
    console.log(`🔧 Unique skills used: ${health.length}`);
    console.log('');

    // Session highlights
    if (sessions.length > 0) {
      console.log('📝 Session Highlights:');
      for (const session of sessions.slice(0, 5)) {
        console.log(`  ${session.slice(0, 120)}...`);
      }
      console.log('');
    }

    // Learnings
    const { recent: recentLearnings, total: totalLearnings } = await getRecentLearnings(repoPath);
    if (recentLearnings.length > 0) {
      console.log(`📚 本周新增 Learnings: ${recentLearnings.length} 篇`);
      for (const learning of recentLearnings) {
        console.log(`  • ${learning.title}`);
      }
      console.log('');
    }
    if (totalLearnings > 0) {
      console.log(`📊 知识库总量: ${totalLearnings} 篇 learnings`);
      console.log('');
    }

    // Skill changelog
    const skillChanges = await getRecentSkillChanges(repoPath);
    const newSkills = skillChanges.filter((c) => c.type === 'new');
    const updatedSkills = skillChanges.filter((c) => c.type === 'updated');

    if (newSkills.length > 0) {
      console.log('🆕 New Skills This Week:');
      for (const skill of newSkills) {
        console.log(`  • ${skill.name} (by ${skill.author})`);
      }
      console.log('');
    }

    if (updatedSkills.length > 0) {
      console.log('🔄 Recently Updated Skills:');
      for (const skill of updatedSkills) {
        console.log(`  • ${skill.name}`);
      }
      console.log('');
    }

    // Session autonomy — Human Intervention metric (Issue #34)
    const interventions = summarizeInterventions(teamStats);
    if (interventions) {
      console.log('🤖 会话自主性 (Human Intervention):');
      console.log(
        `  团队均值: ${interventions.avgPerSession.toFixed(2)} 次干预/会话 ` +
        `(${interventions.totalSessions} 会话, ${interventions.totalInterventions} 次干预)`,
      );
      console.log(
        `  分解: 中断 ${interventions.interrupt} · 拒绝 ${interventions.toolReject} · 纠偏 ${interventions.correction}`,
      );
      console.log('  干预率排行 (高 → 低, 越低自主性越强):');
      for (const r of interventions.ranked.slice(0, 10)) {
        console.log(`    • ${r.username}: ${r.rate.toFixed(2)}/会话 (${r.total} 次 / ${r.sessions} 会话)`);
      }
      console.log('');
    }

    // Conversation turns + token usage (Issue #75)
    const conversation = summarizeConversation(teamStats);
    if (conversation) {
      const t = conversation.tokens;
      console.log('💬 对话量与 Token 用量:');
      console.log(`  人工对话总轮数: ${conversation.totalPrompts} 次`);
      console.log(
        `  Token 总量: ${formatTokenCount(conversation.totalTokens)} ` +
        `(输入 ${formatTokenCount(t.input)} · 输出 ${formatTokenCount(t.output)} · ` +
        `缓存读 ${formatTokenCount(t.cacheRead)} · 缓存写 ${formatTokenCount(t.cacheCreation)})`,
      );
      console.log('  Token 用量排行 (高 → 低):');
      for (const r of conversation.ranked.slice(0, 10)) {
        console.log(`    • ${r.username}: ${formatTokenCount(r.tokens)} tokens (${r.prompts} 轮对话)`);
      }
      console.log('');
    }

    console.log('─'.repeat(52));
    console.log('Generated by teamai digest');
  } catch (e) {
    log.error(`Failed to generate digest: ${(e as Error).message}`);
  }
}
