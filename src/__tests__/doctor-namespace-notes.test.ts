/**
 * `doctor` answers "why do I have this version?" (#707): each namespace item
 * that replaces a root item, and in legacy mode each name the team repo
 * defines twice, is listed as a note — information, never a failed check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
  isSilent: () => false,
  setSilent: vi.fn(),
}));

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { doctor, type DoctorReport } from '../doctor.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

const ROLES_YAML = [
  'version: 1',
  'roles:',
  '  - id: frontend',
  '    resources:',
  '      knowledge: [frontend]',
  '      skills: [frontend]',
  '      agents: [frontend]',
  '',
].join('\n');

describe('doctor — namespace overrides and repeated names', () => {
  let tempDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;

  const team = (rel: string, content: string): Promise<void> => fse.outputFile(path.join(repoPath, rel), content);

  async function report(): Promise<DoctorReport> {
    const printed: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { printed.push(String(line)); });
    try {
      await doctor({ json: true });
    } finally {
      spy.mockRestore();
    }
    const json = printed.find((line) => line.trimStart().startsWith('{'));
    if (!json) throw new Error('doctor printed no JSON report');
    return JSON.parse(json) as DoctorReport;
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-doctor-notes-'));
    const homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);
    await fse.ensureDir(path.join(homeDir, '.claude'));
    await team('teamai.yaml', 'team: test\n');

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    };
    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' },
        env: { injectShellProfile: false },
      },
      toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules', agents: '.claude/agents' } },
    };
    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);

    await team('skills/review/SKILL.md', '---\nname: review\ndescription: shared\n---\n');
    await team('skills/frontend/review/SKILL.md', '---\nname: review\ndescription: front\n---\n');
    await team('rules/style.md', '# Shared\n');
    await team('rules/frontend/style.md', '# Front\n');
    await team('claudemd/team.md', 'ROOT\n');
    await team('claudemd/frontend/team.md', 'FRONT\n');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('lists each override by file, as a note rather than a check', async () => {
    localConfig.primaryRole = 'frontend';
    await team('manifest/roles.yaml', ROLES_YAML);
    await team('agents/reviewer.yaml', 'name: reviewer\ndescription: Shared\ninstructions: x\n');
    await team('agents/frontend/reviewer.yaml', 'name: reviewer\ndescription: Front\ninstructions: y\n');

    const { notes, checks } = await report();

    expect(notes).toEqual(expect.arrayContaining([
      'skills: "review" from skills/frontend/review replaces skills/review',
      'agents: "reviewer" from agents/frontend/reviewer.yaml replaces agents/reviewer.yaml',
      'rules: "style" from rules/frontend/style.md replaces rules/style.md',
      'claudemd: "team.md" from claudemd/frontend/team.md replaces claudemd/team.md',
    ]));
    expect(checks.map((check) => check.name).join('\n')).not.toMatch(/replace/i);
  });

  it('notes a model alias an agent uses from a namespace that resources.models does not activate', async () => {
    localConfig.primaryRole = 'frontend';
    await team('manifest/roles.yaml', `${ROLES_YAML}      models: [frontend]\n  - id: backend\n    resources:\n`
      + '      knowledge: []\n      skills: []\n      models: [backend]\n');
    await team('models/aliases.yaml', 'aliases:\n  strong:\n    claude: opus\n');
    await team('models/frontend/aliases.yaml', 'aliases:\n  fast:\n    claude: haiku\n');
    await team('models/backend/aliases.yaml', 'aliases:\n  strong:\n    claude: fable\n  auditor:\n    claude: fable\n  unused:\n    claude: fable\n');
    await team('agents/implementer.yaml', 'name: implementer\ndescription: x\ninstructions: x\nmodel: strong\n');
    await team('agents/checker.yaml', 'name: checker\ndescription: x\ninstructions: x\nmodel: auditor\n');
    await team('agents/quick.yaml', 'name: quick\ndescription: x\ninstructions: x\nmodel: fast\n');

    const { notes } = await report();
    const aliasNotes = (notes ?? []).filter((note) => note.startsWith('models: alias'));

    // In agent scan order; the aliases no received agent uses, or only active files define, get no note.
    expect(aliasNotes).toEqual([
      'models: alias "auditor" in models/backend/aliases.yaml, used by agent checker, does not apply here, as your roles and '
        + 'projects do not list "backend" in resources.models: no active team file maps "auditor", so each tool uses its default '
        + 'model unless your local aliases file maps it. If it should apply, add `models: [backend]` to the resources of your role '
        + 'in manifest/roles.yaml or of your project in manifest/projects.yaml.',
      'models: alias "strong" in models/backend/aliases.yaml, used by agent implementer, does not apply here, as your roles and '
        + 'projects do not list "backend" in resources.models: "strong" comes from models/aliases.yaml instead. If it should '
        + 'apply, add `models: [backend]` to the resources of your role in manifest/roles.yaml or of your project in manifest/projects.yaml.',
    ]);
  });

  it('lists names the team repo defines twice in legacy mode', async () => {
    const { notes } = await report();

    expect(notes).toEqual(expect.arrayContaining([
      'skills: "review" is defined in skills/frontend/review and skills/review (legacy mode: only one of them is installed)',
      'rules: "style" is defined in rules/frontend/style.md and rules/style.md (legacy mode: each is delivered at its own path)',
      'claudemd: "team.md" is defined in claudemd/frontend/team.md and claudemd/team.md (legacy mode: all of them are in the managed block)',
    ]));
  });
});
