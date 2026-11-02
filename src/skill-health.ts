import type { UserStats } from './types.js';

// ─── Health Score ──────────────────────────────────────
//
//  score = usage_score(0-60) + freshness_score(0-40)
//
//  usage_score:    normalized weekly usage count
//  freshness_score: decaying based on days since last use
//
//  Total: 0-100, displayed as ★★★★★ (5 stars)
//

/**
 * Calculate the health score for a single skill.
 *
 * @param totalCount - Total usage count for this skill
 * @param lastUsedDate - When the skill was last used
 * @param maxCount - Maximum usage count across all skills (for normalization)
 * @returns Score from 0 to 100
 */
export function calculateSkillHealth(
  totalCount: number,
  lastUsedDate: Date,
  maxCount: number,
): number {
  if (totalCount === 0 || maxCount === 0) return 0;

  // Usage score: 0-60, linear relative to max usage
  const usageScore = Math.min(60, Math.round((totalCount / maxCount) * 60));

  // Freshness score: 0-40, decays over 30 days
  const daysSinceUse = Math.max(0, (Date.now() - lastUsedDate.getTime()) / 86_400_000);
  const freshnessScore = daysSinceUse >= 30 ? 0 : Math.round(40 * (1 - daysSinceUse / 30));

  return usageScore + freshnessScore;
}

/**
 * Convert a score (0-100) to a star rating string (★★★★★).
 */
export function scoreToStars(score: number): string {
  const filledStars = Math.round((score / 100) * 5);

  return '★'.repeat(filledStars) + '☆'.repeat(5 - filledStars);
}

/**
 * Calculate health scores for all skills from team stats.
 */
export function calculateTeamHealth(
  teamStats: UserStats[],
): Array<{ skill: string; score: number; stars: string; totalCount: number; contributors: number }> {
  // Aggregate across all users
  const skillTotals = new Map<string, { count: number; lastUsed: Date; contributors: Set<string> }>();

  for (const userStats of teamStats) {
    for (const [skillName, data] of Object.entries(userStats.skills)) {
      const existing = skillTotals.get(skillName);
      const lastUsed = new Date(data.lastUsed);

      if (existing) {
        existing.count += data.count;

        if (lastUsed > existing.lastUsed) {
          existing.lastUsed = lastUsed;
        }

        existing.contributors.add(userStats.username);
      } else {
        skillTotals.set(skillName, {
          count: data.count,
          lastUsed,
          contributors: new Set([userStats.username]),
        });
      }
    }
  }

  const maxCount = Math.max(...Array.from(skillTotals.values()).map((s) => s.count), 1);

  const results = Array.from(skillTotals.entries()).map(([skill, data]) => {
    const score = calculateSkillHealth(data.count, data.lastUsed, maxCount);

    return {
      skill,
      score,
      stars: scoreToStars(score),
      totalCount: data.count,
      contributors: data.contributors.size,
    };
  });

  return results.sort((a, b) => b.score - a.score);
}
