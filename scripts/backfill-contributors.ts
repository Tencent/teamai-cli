#!/usr/bin/env npx tsx
/**
 * One-time script to backfill CONTRIBUTORS files for existing skills
 * in the team repo using git log to find who originally committed each skill.
 *
 * Usage:
 *   npx tsx scripts/backfill-contributors.ts <team-repo-path>
 *
 * Example:
 *   npx tsx scripts/backfill-contributors.ts ~/.teamai/repo
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoPath = process.argv[2];
if (!repoPath) {
  console.error('Usage: npx tsx scripts/backfill-contributors.ts <team-repo-path>');
  process.exit(1);
}

const skillsDir = path.join(repoPath, 'skills');
if (!fs.existsSync(skillsDir)) {
  console.error(`Skills directory not found: ${skillsDir}`);
  process.exit(1);
}

const CONTRIBUTORS_FILE = 'CONTRIBUTORS';

const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
let updated = 0;
let skipped = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) continue;

  const skillName = entry.name;
  const contribPath = path.join(skillsDir, skillName, CONTRIBUTORS_FILE);

  // Skip if CONTRIBUTORS already exists
  if (fs.existsSync(contribPath)) {
    console.log(`  skip  ${skillName} (CONTRIBUTORS exists)`);
    skipped++;
    continue;
  }

  // Use git log to find authors who committed files under this skill directory.
  // %an = author name. We look at the initial add (--diff-filter=A) and all modifications.
  try {
    const raw = execSync(
      `git log --format='%an' -- 'skills/${skillName}/'`,
      { cwd: repoPath, encoding: 'utf-8' },
    ).trim();

    if (!raw) {
      console.log(`  skip  ${skillName} (no git history)`);
      skipped++;
      continue;
    }

    // Deduplicate while preserving order (earliest committer first via reverse)
    const allAuthors = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const seen = new Set<string>();
    const contributors: string[] = [];
    // git log outputs newest-first; reverse to get chronological order
    for (const author of allAuthors.toReversed()) {
      if (!seen.has(author)) {
        seen.add(author);
        contributors.push(author);
      }
    }

    fs.writeFileSync(contribPath, contributors.join('\n') + '\n', 'utf-8');
    console.log(`  wrote ${skillName} → ${contributors.join(', ')}`);
    updated++;
  } catch (e) {
    console.error(`  error ${skillName}: ${(e as Error).message}`);
  }
}

console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}`);
