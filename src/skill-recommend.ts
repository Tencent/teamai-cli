import { readKnownSkills } from './usage-tracker.js';
import type { UserStats } from './types.js';

// ─── Skill Recommendations ─────────────────────────────
//
//  After teamai pull, suggest skills that:
//  1. Are popular with the team (used by many members)
//  2. The current user hasn't tried yet
//
//  User's skill history is read from two sources:
//  - usage.jsonl (unreported events since last truncation)
//  - known-skills.json (persisted history that survives truncation)
//

/**
 * Calculate skill popularity from team stats.
 */
function getTeamSkillPopularity(
  teamStats: UserStats[],
): Array<{ skill: string; userCount: number; percentage: number }> {
  const totalUsers = teamStats.length;
  if (totalUsers === 0) return [];

  const skillUsers = new Map<string, Set<string>>();

  for (const userStats of teamStats) {
    for (const skillName of Object.keys(userStats.skills)) {
      const users = skillUsers.get(skillName) ?? new Set();
      users.add(userStats.username);
      skillUsers.set(skillName, users);
    }
  }

  return Array.from(skillUsers.entries())
    .map(([skill, users]) => ({
      skill,
      userCount: users.size,
      percentage: Math.round((users.size / totalUsers) * 100),
    }))
    .sort((a, b) => b.userCount - a.userCount);
}

/**
 * Generate skill recommendations for the current user.
 */
export async function getRecommendations(
  teamStats: UserStats[],
): Promise<Array<{ skill: string; percentage: number; reason: string }>> {
  if (teamStats.length === 0) return [];

  const userSkills = await readKnownSkills();
  const popularity = getTeamSkillPopularity(teamStats);

  const recommendations: Array<{ skill: string; percentage: number; reason: string }> = [];

  for (const item of popularity) {
    // Only recommend skills the user hasn't tried
    if (userSkills.has(item.skill)) continue;

    // Only recommend skills used by at least 30% of the team
    if (item.percentage < 30) continue;

    recommendations.push({
      skill: item.skill,
      percentage: item.percentage,
      reason: 'popular with your team (you haven\'t tried it)',
    });
  }

  return recommendations.slice(0, 5); // Top 5
}

/**
 * Display recommendations to the user.
 */
export function displayRecommendations(
  recommendations: Array<{ skill: string; percentage: number; reason: string }>,
): void {
  if (recommendations.length === 0) return;

  console.log('');
  console.log('💡 Recommended skills (popular with your team):');
  for (const rec of recommendations) {
    console.log(`  • ${rec.skill} — ${rec.reason}`);
  }
}
