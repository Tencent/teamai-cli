/**
 * The namespace-over-root rule for the types that already had namespaces
 * (#707): an item in an active namespace replaces the root item of the same
 * name, whole; deactivating the namespace brings the root item back; two
 * active namespaces with one name stop that type for the run and keep what is
 * installed. Asserted through `pull`, on what lands on disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { execFileSync } from 'node:child_process';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('Already up to date.'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    persist: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

// pull() takes a real ~/.teamai/.sync-lock; parallel workers would race on it.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import crypto from 'node:crypto';
import { checkoutKey, pull } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig, detectProjectConfig, loadStateForScope } from '../config.js';
import { log } from '../utils/logger.js';
import { StateSchema, type TeamaiConfig, type LocalConfig } from '../types.js';

const ROLES_YAML = `
version: 1
roles:
  - id: frontend
    description: Frontend
    resources:
      knowledge: [frontend]
      skills: [frontend]
      agents: [frontend]
  - id: devops
    description: DevOps
    resources:
      knowledge: [devops]
      skills: [devops]
      agents: [devops]
`;

const skillMd = (name: string, body: string): string => `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`;

describe('pull: an active namespace item replaces the root item of the same name', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  function configFor(roles: string[] | null, extra: Partial<LocalConfig> = {}): LocalConfig {
    const [primaryRole, ...additionalRoles] = roles ?? [];
    return {
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      ...(primaryRole ? { primaryRole } : {}),
      additionalRoles,
      resourceProfileVersion: 1,
      scope: 'user',
      ...extra,
    };
  }

  const as = (roles: string[] | null, extra: Partial<LocalConfig> = {}): void => {
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(configFor(roles, extra));
  };
  const read = (rel: string): Promise<string> => fse.readFile(path.join(homeDir, rel), 'utf8');
  const exists = (rel: string): Promise<boolean> => fse.pathExists(path.join(homeDir, rel));
  const team = (rel: string, content: string): Promise<void> => fse.outputFile(path.join(repoPath, rel), content);
  const logged = (level: 'warn' | 'error', pattern: RegExp): boolean => (
    vi.mocked(log[level]).mock.calls.some((args) => pattern.test(args.map(String).join(' ')))
  );

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-ns-override-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await team('manifest/roles.yaml', ROLES_YAML);
    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));

    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HERMES_HOME', path.join(homeDir, '.hermes'));

    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', agents: '.claude/agents', claudemd: '.claude/CLAUDE.md' },
      },
    };

    as(['frontend']);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.error).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  describe('agents', () => {
    it('delivers the namespace agent in place of the root one, and the root one again once it deactivates', async () => {
      await team('agents/reviewer.yaml', 'name: reviewer\ndescription: Shared\ninstructions: Review for everyone.\n');
      await team('agents/frontend/reviewer.yaml', 'name: reviewer\ndescription: Front\ninstructions: Review the front end.\n');

      await pull({});
      expect(await read('.claude/agents/reviewer.md')).toContain('Review the front end.');

      as(['devops']);
      await pull({});
      expect(await read('.claude/agents/reviewer.md')).toContain('Review for everyone.');
    });

    it('stops only agents when two active namespaces define one stem', async () => {
      await team('agents/frontend/reviewer.yaml', 'name: reviewer\ndescription: Front\ninstructions: Review the front end.\n');
      await pull({});
      expect(await read('.claude/agents/reviewer.md')).toContain('Review the front end.');

      await team('agents/devops/reviewer.yaml', 'name: reviewer\ndescription: Ops\ninstructions: Review ops.\n');
      await team('skills/frontend/lint/SKILL.md', skillMd('lint', 'Lint things'));
      as(['frontend', 'devops']);
      await pull({});

      expect(logged('warn', /Duplicate agent "reviewer" found in active namespaces "frontend" and "devops" \(agents\/frontend\/reviewer\.yaml and agents\/devops\/reviewer\.yaml\)/)).toBe(true);
      // The installed agent is kept as it was, and the rest of the pull, which
      // runs after agents, still happens: the search index is rebuilt.
      expect(await read('.claude/agents/reviewer.md')).toContain('Review the front end.');
      const index = await fse.readJson(path.join(homeDir, '.teamai', 'search-index.json')) as { entries: Array<{ filename: string }> };
      expect(index.entries.map((entry) => entry.filename)).toContain('lint.md');
    });

    // A replacement that does not parse delivers nothing, so it must not take
    // the root agent it would replace away with it.
    it('keeps the root agent while the namespace agent replacing it does not parse', async () => {
      await team('agents/reviewer.yaml', 'name: reviewer\ndescription: Shared\ninstructions: Review for everyone.\n');
      as(['devops']);
      await pull({});
      expect(await read('.claude/agents/reviewer.md')).toContain('Review for everyone.');

      await team('agents/devops/reviewer.yaml', 'name: reviewer\ndescription: [\n');
      await pull({ force: true });

      expect(await read('.claude/agents/reviewer.md')).toContain('Review for everyone.');
    });

    it('names the one namespace and both files when an agent is defined twice inside it', async () => {
      await team('agents/frontend/reviewer.yaml', 'name: reviewer\ndescription: Front\ninstructions: Review the front end.\n');
      await team('agents/frontend/reviewer.md', '---\nname: reviewer\ndescription: Legacy\n---\nReview, the old way.\n');

      await pull({});

      expect(logged('warn', /Duplicate agent "reviewer" in namespace "frontend": agents\/frontend\/reviewer\.md and agents\/frontend\/reviewer\.yaml\. Agents were not updated/)).toBe(true);
      expect(logged('warn', /"frontend" and "frontend"/)).toBe(false);
    });
  });

  describe('rules', () => {
    beforeEach(async () => {
      await fse.ensureDir(path.join(homeDir, '.hermes'));
      await team('rules/style.md', '# Shared style\n');
      await team('rules/frontend/style.md', '# Front style\n');
    });

    it('suppresses the root rule, in tool dirs and in the Hermes block, while the namespace is active', async () => {
      await pull({});

      expect(await read('.claude/rules/frontend/style.md')).toBe('# Front style\n');
      expect(await exists('.claude/rules/style.md')).toBe(false);
      const soul = await read('.hermes/SOUL.md');
      expect(soul).toContain('# Front style');
      expect(soul).not.toContain('# Shared style');

      as(['devops']);
      await pull({});

      expect(await read('.claude/rules/style.md')).toBe('# Shared style\n');
      expect(await exists('.claude/rules/frontend/style.md')).toBe(false);
      expect(await read('.hermes/SOUL.md')).toContain('# Shared style');
    });

    it('keeps the root rule when the tag channel withholds the namespace rule that would replace it', async () => {
      await team('tags.yaml', 'rules:\n  frontend/style: [backend]\n');
      as(['frontend'], { subscribedTags: ['ui'] });

      await pull({});

      expect(await read('.claude/rules/style.md')).toBe('# Shared style\n');
      expect(await exists('.claude/rules/frontend/style.md')).toBe(false);
    });

    it('withdraws the replaced root rule from rule dirs shared with the member\'s own rules, unless it was edited', async () => {
      const base = await loadTeamConfig(repoPath);
      if (!base) throw new Error('no team config');
      vi.mocked(loadTeamConfig).mockResolvedValue({
        ...base,
        toolPaths: { ...base.toolPaths, joycode: { skills: '.joycode/skills', rules: '.joycode/rules', agents: '.joycode/agents' } },
      });
      await fse.ensureDir(path.join(homeDir, '.joycode', 'rules'));
      await fse.outputFile(path.join(homeDir, '.joycode/rules/mine.mdc'), 'my own rule\n');
      await team('rules/tone.md', '# Shared tone\n');
      await team('rules/frontend/tone.md', '# Front tone\n');

      as(['devops']);
      await pull({});
      expect(await exists('.joycode/rules/style.mdc')).toBe(true);
      expect(await exists('.joycode/rules/tone.mdc')).toBe(true);
      await fse.appendFile(path.join(homeDir, '.joycode/rules/tone.mdc'), 'my edit\n');

      as(['frontend']);
      await pull({});

      // The unchanged root copy goes, so the two versions are not loaded side by side.
      expect(await exists('.joycode/rules/style.mdc')).toBe(false);
      expect(await exists('.joycode/rules/frontend/style.mdc')).toBe(true);
      // An edited copy, and a rule of the member's own, are left alone.
      expect(await read('.joycode/rules/tone.mdc')).toContain('my edit');
      expect(await read('.joycode/rules/mine.mdc')).toBe('my own rule\n');
    });

    // The admin edits the root rule and adds its namespace override in one push:
    // the member's copy is the version of the last pull, not a member edit.
    // HOME's copy may come from a project pull that inherits the user scope,
    // which records its revision apart from the user scope's own (#823).
    it.each([
      ['the last pull', (rev: string) => ({ lastPullRev: rev })],
      ['an inherited pull', (rev: string) => ({ lastPullRev: null, lastInheritedPullRev: rev })],
    ])('withdraws the replaced root rule\'s copy when the root rule changed in the same push since %s, and names an edited one', async (_case, delivered) => {
      const base = await loadTeamConfig(repoPath);
      if (!base) throw new Error('no team config');
      vi.mocked(loadTeamConfig).mockResolvedValue({
        ...base,
        toolPaths: { ...base.toolPaths, joycode: { skills: '.joycode/skills', rules: '.joycode/rules', agents: '.joycode/agents' } },
      });
      await fse.ensureDir(path.join(homeDir, '.joycode', 'rules'));
      await fse.remove(path.join(repoPath, 'rules/frontend/style.md'));
      await team('rules/tone.md', '# Shared tone\n');
      const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repoPath, encoding: 'utf8' });
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '-m', 'v1');
      const v1 = git('rev-parse', 'HEAD').trim();
      await pull({});
      await fse.appendFile(path.join(homeDir, '.joycode/rules/tone.mdc'), 'my edit\n');

      await team('rules/style.md', '# Shared style v2\n');
      await team('rules/frontend/style.md', '# Front style\n');
      await team('rules/tone.md', '# Shared tone v2\n');
      await team('rules/frontend/tone.md', '# Front tone\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'v2');
      vi.mocked(loadStateForScope).mockResolvedValue({ lastPull: null, ...delivered(v1) } as never);
      try {
        await pull({});
      } finally {
        vi.mocked(loadStateForScope).mockResolvedValue({ lastPull: null } as never);
      }

      expect(await exists('.joycode/rules/style.mdc')).toBe(false);
      expect(await read('.joycode/rules/tone.mdc')).toContain('my edit');
      expect(logged('warn', /Kept .*\.joycode\/rules\/tone\.mdc.*rules\/tone\.md/)).toBe(true);
      expect(logged('warn', /style\.mdc/)).toBe(false);
    });

    it('leaves a root rule alone when only a deeper namespace path shares its file name', async () => {
      await fse.remove(path.join(repoPath, 'rules/frontend/style.md'));
      await team('rules/frontend/web/style.md', '# Web style\n');

      await pull({});

      expect(await read('.claude/rules/style.md')).toBe('# Shared style\n');
      expect(await read('.claude/rules/frontend/web/style.md')).toBe('# Web style\n');
    });

    it('delivers both namespace rules when two active namespaces define one name, and suppresses the root', async () => {
      // Each namespace rule keeps its own path, so the two never compete for
      // one slot: no conflict, only root suppression.
      await team('rules/devops/style.md', '# Ops style\n');
      as(['frontend', 'devops']);

      await pull({});

      expect(await read('.claude/rules/frontend/style.md')).toBe('# Front style\n');
      expect(await read('.claude/rules/devops/style.md')).toBe('# Ops style\n');
      expect(await exists('.claude/rules/style.md')).toBe(false);
      // Hermes keeps both, in the rules scan order it always used.
      const soul = await read('.hermes/SOUL.md');
      expect(soul).toContain('# Front style');
      expect(soul).toContain('# Ops style');
      expect(soul).not.toContain('# Shared style');
    });
  });

  describe('claudemd', () => {
    it('puts the namespace file in the managed block in place of the root file of that name', async () => {
      await team('claudemd/team.md', 'ROOT TEAM NOTES\n');
      await team('claudemd/tools.md', 'SHARED TOOL NOTES\n');
      await team('claudemd/frontend/team.md', 'FRONT TEAM NOTES\n');

      await pull({});
      const front = await read('.claude/CLAUDE.md');
      expect(front).toContain('FRONT TEAM NOTES');
      expect(front).toContain('SHARED TOOL NOTES');
      expect(front).not.toContain('ROOT TEAM NOTES');

      as(['devops']);
      await pull({});
      const ops = await read('.claude/CLAUDE.md');
      expect(ops).toContain('ROOT TEAM NOTES');
      expect(ops).not.toContain('FRONT TEAM NOTES');
    });

    it('keeps both namespace files in the block, in namespace order, when two active namespaces define one name', async () => {
      await team('claudemd/team.md', 'ROOT TEAM NOTES\n');
      await team('claudemd/frontend/team.md', 'FRONT TEAM NOTES\n');
      await team('claudemd/devops/team.md', 'OPS TEAM NOTES\n');
      as(['frontend', 'devops']);

      await pull({});

      const block = await read('.claude/CLAUDE.md');
      expect(block.indexOf('FRONT TEAM NOTES')).toBeGreaterThan(-1);
      expect(block.indexOf('OPS TEAM NOTES')).toBeGreaterThan(block.indexOf('FRONT TEAM NOTES'));
      expect(block).not.toContain('ROOT TEAM NOTES');
    });
  });

  describe('skills', () => {
    beforeEach(async () => {
      await team('tags.yaml', 'skills:\n  review: [ui]\n');
      await team('skills/review/SKILL.md', skillMd('review', 'Shared review'));
      await team('skills/review/checklist.md', 'root-only checklist\n');
      await team('skills/frontend/review/SKILL.md', skillMd('review', 'Front review'));
      await team('skills/frontend/review/front-only.md', 'front-only notes\n');
      await team('skills/lonely/SKILL.md', skillMd('lonely', 'Untagged root skill'));
    });

    it('replaces a root skill received through a tag with the active namespace skill, whole', async () => {
      as(['devops'], { subscribedTags: ['ui'] });
      await pull({});
      expect(await read('.claude/skills/review/SKILL.md')).toContain('Shared review');
      expect(await read('.claude/skills/review/checklist.md')).toBe('root-only checklist\n');

      // A file no team version has is the member's own, not a leftover.
      await fse.outputFile(path.join(homeDir, '.claude/skills/review/my-notes.md'), 'mine\n');

      as(['frontend'], { subscribedTags: ['ui'] });
      await pull({});
      expect(await read('.claude/skills/review/SKILL.md')).toContain('Front review');
      // Nothing of the root version is left behind in the installed directory.
      expect(await exists('.claude/skills/review/checklist.md')).toBe(false);
      expect(await read('.claude/skills/review/my-notes.md')).toBe('mine\n');

      as(['devops'], { subscribedTags: ['ui'] });
      await pull({});
      expect(await read('.claude/skills/review/SKILL.md')).toContain('Shared review');
      expect(await read('.claude/skills/review/checklist.md')).toBe('root-only checklist\n');
      // And nothing of the namespace version, while the member's own file stays.
      expect(await exists('.claude/skills/review/front-only.md')).toBe(false);
      expect(await read('.claude/skills/review/my-notes.md')).toBe('mine\n');
    });

    // A path another team version has is not enough to call a file a leftover:
    // the member may have added a file of that name, in a namespace they never had.
    it('keeps a file the member added at a path another version has, and names it', async () => {
      as(['devops'], { subscribedTags: ['ui'] });
      await pull({});
      await fse.outputFile(path.join(homeDir, '.claude/skills/review/front-only.md'), 'my own notes\n');

      await pull({ force: true });

      expect(await read('.claude/skills/review/front-only.md')).toBe('my own notes\n');
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(
        `Kept ${path.join(homeDir, '.claude/skills/review/front-only.md')}`,
      ));
    });

    describe('with a record of what teamai delivered (#822)', () => {
      const frontOnly = (): string => path.join(homeDir, '.claude/skills/review/front-only.md');
      const recordDelivered = async (delivered: Record<string, string>): Promise<void> => {
        vi.mocked(loadStateForScope).mockResolvedValue(StateSchema.parse({
          lastPullByWorkspace: { [await checkoutKey(homeDir)]: { rev: '', targets: [], delivered } },
        }));
      };
      afterEach(() => {
        vi.mocked(loadStateForScope).mockResolvedValue(StateSchema.parse({ lastPull: null }));
      });

      it('keeps a file the member added at a path another version has without naming it', async () => {
        await recordDelivered({});
        as(['devops'], { subscribedTags: ['ui'] });
        await pull({});
        await fse.outputFile(frontOnly(), 'my own notes\n');

        await pull({ force: true });

        expect(await read('.claude/skills/review/front-only.md')).toBe('my own notes\n');
        expect(logged('warn', /front-only\.md/)).toBe(false);
      });

      it('removes a leftover teamai wrote there at an earlier delivery', async () => {
        await fse.outputFile(frontOnly(), 'older front notes\n');
        await recordDelivered({ [frontOnly()]: crypto.createHash('sha256').update('older front notes\n').digest('hex') });
        as(['devops'], { subscribedTags: ['ui'] });

        await pull({});

        expect(await exists('.claude/skills/review/front-only.md')).toBe(false);
        expect(logged('warn', /front-only\.md/)).toBe(false);
      });
    });

    // A directory without SKILL.md is not a skill: it must neither replace the
    // root skill nor strip the installed one of its SKILL.md.
    it('keeps delivering the root skill while the namespace directory of its name has no SKILL.md', async () => {
      as(['devops'], { subscribedTags: ['ui'] });
      await pull({});
      expect(await read('.claude/skills/review/SKILL.md')).toContain('Shared review');

      await team('skills/devops/review/notes.md', 'draft notes\n');
      await pull({ force: true });

      expect(await read('.claude/skills/review/SKILL.md')).toContain('Shared review');
      expect(await exists('.claude/skills/review/notes.md')).toBe(false);
      expect(logged('warn', /skills\/devops\/review has no SKILL\.md/)).toBe(true);
    });

    it('indexes for recall the skills pull delivers, not every skill in the repo', async () => {
      await team('skills/devops/deploy/SKILL.md', skillMd('deploy', 'Deploy things'));

      await pull({});

      const index = await fse.readJson(path.join(homeDir, '.teamai', 'search-index.json')) as {
        entries: Array<{ type: string; filename: string; path?: string }>;
      };
      const skills = index.entries.filter((entry) => entry.type === 'skills');
      expect(skills.map((entry) => entry.filename)).toEqual(['review.md']);
      expect(skills[0]?.path).toBe(path.join(repoPath, 'skills/frontend/review/SKILL.md'));
    });

    it('stops only skills when two active namespaces define one skill: other types still sync and installed skills stay', async () => {
      await pull({});
      expect(await read('.claude/skills/review/SKILL.md')).toContain('Front review');

      await team('skills/devops/review/SKILL.md', skillMd('review', 'Ops review'));
      await team('agents/helper.yaml', 'name: helper\ndescription: Helps\ninstructions: Help.\n');
      await team('rules/style.md', '# Shared style\n');
      await team('env/env.yaml', 'variables:\n  - key: API_BASE\n    value: https://api.example.com\n');
      as(['frontend', 'devops']);
      await pull({});

      expect(logged('warn', /Duplicate skill "review" found in active namespaces "frontend" and "devops" \(skills\/frontend\/review and skills\/devops\/review\)/)).toBe(true);
      // The installed skill is kept as it was: not replaced, not swept.
      expect(await read('.claude/skills/review/SKILL.md')).toContain('Front review');
      // And recall keeps finding it: the index keeps the skills it held.
      const index = await fse.readJson(path.join(homeDir, '.teamai', 'search-index.json')) as {
        entries: Array<{ type: string; filename: string; path?: string }>;
      };
      const skills = index.entries.filter((entry) => entry.type === 'skills');
      expect(skills.map((entry) => entry.path)).toEqual([path.join(repoPath, 'skills/frontend/review/SKILL.md')]);
      expect(await exists('.claude/agents/helper.md')).toBe(true);
      expect(await read('.claude/rules/style.md')).toBe('# Shared style\n');
      expect(await read('.teamai/env.sh')).toContain('API_BASE');
    });

    it('still does not deliver root skills by default in role mode', async () => {
      await pull({});

      expect(await read('.claude/skills/review/SKILL.md')).toContain('Front review');
      expect(await exists('.claude/skills/lonely')).toBe(false);
    });
  });

  describe('env and hooks', () => {
    beforeEach(async () => {
      const base = await loadTeamConfig(repoPath);
      if (!base) throw new Error('no team config');
      const claude = base.toolPaths.claude;
      vi.mocked(loadTeamConfig).mockResolvedValue({
        ...base,
        toolPaths: { ...base.toolPaths, ...(claude ? { claude: { ...claude, settings: '.claude/settings.json' } } : {}) },
      });
      await team('manifest/roles.yaml', `
version: 1
roles:
  - id: frontend
    resources: { knowledge: [], skills: [], agents: [], env: [frontend], hooks: [frontend] }
  - id: devops
    resources: { knowledge: [], skills: [], agents: [], env: [devops], hooks: [devops] }
`);
    });

    const lintHook = (script: string): string => `hooks:
  - id: lint
    description: lint
    event: Stop
    command: 'bash -lc "~/.teamai/team-scripts/${script}" || true'
`;

    it('keeps env.sh as it is when two active namespaces define one variable, naming both files', async () => {
      await team('env/frontend/env.yaml', 'variables:\n  - key: API_BASE\n    value: https://front.example.com\n');
      await team('env/devops/env.yaml', 'variables:\n  - key: API_BASE\n    value: https://ops.example.com\n');
      await pull({});
      const before = await read('.teamai/env.sh');
      expect(before).toContain('https://front.example.com');

      as(['frontend', 'devops']);
      await pull({ force: true });

      expect(await read('.teamai/env.sh')).toBe(before);
      expect(logged('warn', /variable "API_BASE" is defined in both env\/frontend\/env\.yaml and env\/devops\/env\.yaml/)).toBe(true);
    });

    it('keeps the installed hooks when two active namespaces define one hook, naming both files', async () => {
      await team('hooks/frontend/hooks.yaml', lintHook('front-lint.sh'));
      await team('hooks/devops/hooks.yaml', lintHook('ops-lint.sh'));
      await pull({});
      const before = await read('.claude/settings.json');
      expect(before).toContain('front-lint.sh');

      as(['frontend', 'devops']);
      await pull({ force: true });

      expect(await read('.claude/settings.json')).toBe(before);
      expect(logged('warn', /hook "lint" is defined in both hooks\/frontend\/hooks\.yaml and hooks\/devops\/hooks\.yaml/)).toBe(true);
    });

    it('warns that builtin: in a namespace hooks file is ignored', async () => {
      await team('hooks/frontend/hooks.yaml', `${lintHook('front-lint.sh')}builtin:\n  disable: [todo-reminder]\n`);

      await pull({});

      expect(logged('warn', /hooks\/frontend\/hooks\.yaml: `builtin:` is ignored outside hooks\/hooks\.yaml/)).toBe(true);
      expect(await read('.claude/settings.json')).toContain('front-lint.sh');
    });
  });

  describe('legacy mode (no roles, no projects)', () => {
    it('delivers root and namespace rules and claudemd side by side, as before', async () => {
      await fse.remove(path.join(repoPath, 'manifest'));
      await team('rules/style.md', '# Shared style\n');
      await team('rules/frontend/style.md', '# Front style\n');
      await team('rules/devops/style.md', '# Ops style\n');
      await team('claudemd/team.md', 'ROOT TEAM NOTES\n');
      await team('claudemd/frontend/team.md', 'FRONT TEAM NOTES\n');
      as(null);

      await pull({});

      expect(await read('.claude/rules/style.md')).toBe('# Shared style\n');
      expect(await read('.claude/rules/frontend/style.md')).toBe('# Front style\n');
      expect(await read('.claude/rules/devops/style.md')).toBe('# Ops style\n');
      const block = await read('.claude/CLAUDE.md');
      expect(block).toContain('ROOT TEAM NOTES');
      expect(block).toContain('FRONT TEAM NOTES');
      expect(vi.mocked(log.error)).not.toHaveBeenCalled();
    });
  });
});
