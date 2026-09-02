import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillsHandler } from '../resources/skills.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-mirror-')); }

function mkTeamConfig(baseDir: string): TeamaiConfig {
  return {
    team: 't', description: '', repo: 'x',
    toolPaths: { claude: { skills: '.claude/skills' } },
  } as unknown as TeamaiConfig;
}

function mkLocalConfig(baseDir: string): LocalConfig {
  return {
    repo: { localPath: path.join(baseDir, 'team-repo'), remote: 'x' },
    username: 'u', scope: 'project', projectRoot: baseDir, additionalRoles: [],
  } as unknown as LocalConfig;
}

describe('SkillsHandler.pullItem mirror semantics', () => {
  it('removes files deleted inside a skill (stale files do not linger)', async () => {
    const baseDir = tmp();
    const src = path.join(baseDir, 'team-repo', 'skills', 'common', 'my-skill');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: my-skill\ndescription: x\n---\n');
    fs.writeFileSync(path.join(src, 'keep.md'), 'keep');
    fs.writeFileSync(path.join(src, 'stale.md'), 'stale');

    // Tool dir pre-exists so isToolInstalled passes.
    const toolSkills = path.join(baseDir, '.claude', 'skills');
    fs.mkdirSync(toolSkills, { recursive: true });

    const handler = new SkillsHandler();
    const item = { name: 'my-skill', type: 'skills' as const, sourcePath: src, relativePath: 'skills/common/my-skill' };
    await handler.pullItem(item, mkTeamConfig(baseDir), mkLocalConfig(baseDir));

    const installed = path.join(toolSkills, 'my-skill');
    expect(fs.existsSync(path.join(installed, 'keep.md'))).toBe(true);
    expect(fs.existsSync(path.join(installed, 'stale.md'))).toBe(true);

    // Simulate an in-skill cleanup commit: stale.md removed from the team repo.
    fs.rmSync(path.join(src, 'stale.md'));
    await handler.pullItem(item, mkTeamConfig(baseDir), mkLocalConfig(baseDir));

    expect(fs.existsSync(path.join(installed, 'keep.md'))).toBe(true);
    expect(fs.existsSync(path.join(installed, 'stale.md'))).toBe(false);
  });
});
