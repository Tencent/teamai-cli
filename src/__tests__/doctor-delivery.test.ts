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

vi.mock('../resources/desired.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resources/desired.js')>();
  return { ...actual, resolveDesiredSkills: vi.fn(actual.resolveDesiredSkills) };
});

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { resolveDesiredSkills } from '../resources/desired.js';
import { log } from '../utils/logger.js';
import { loadStateForScope, saveStateForScope } from '../config.js';
import { buildChecks, doctor, resolveDoctorContext, type Check, type DoctorReport } from '../doctor.js';
import { checkoutKey } from '../pull.js';
import { commitTeamRepo } from './helpers/team-repo-history.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { saveToolHomes, toolHomesPath } from '../tool-home.js';
import { packagedSkillRoots } from '../skill-content.js';

/**
 * The delivery check: what `pull` said it synced, against what an agent can
 * actually read on disk (#598). Everything else in the registry verifies
 * plumbing; this one verifies the payload.
 */
describe('doctor — skills delivered on disk', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  const CLAUDE_SKILLS = ['.claude', 'skills'];

  async function writeTeamSkill(name: string): Promise<void> {
    const dir = path.join(repoPath, 'skills', name);
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  }

  /** A correctly delivered copy, the way pullItem leaves one. */
  async function deliver(segments: string[], name: string): Promise<void> {
    const dir = path.join(homeDir, ...segments, name);
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  }

  async function deliveryCheck(tool = 'claude'): Promise<Check> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    const check = (await buildChecks(ctx)).find((c) => c.name === `Skills delivered to ${tool}`);
    if (!check) throw new Error(`no delivery check for ${tool}`);
    return check;
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-delivery-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);

    await writeTeamSkill('alpha');
    await writeTeamSkill('beta');
    await fse.ensureDir(path.join(homeDir, ...CLAUDE_SKILLS));

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    };
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' },
        env: { injectShellProfile: false },
      },
      toolPaths: { claude: { skills: '.claude/skills' } },
    };

    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('passes when every desired skill is on disk', async () => {
    await deliver(CLAUDE_SKILLS, 'alpha');
    await deliver(CLAUDE_SKILLS, 'beta');

    const check = await deliveryCheck();

    expect(await check.check()).toBe(true);
    expect(check.source).toBe('local');
  });

  it('fails when a file blocks a tool skills directory instead of silently skipping its delivery', async () => {
    teamConfig.toolPaths = { hermes: { skills: '.hermes/skills' } };
    localConfig.enabledAgents = ['hermes'];
    await fse.ensureDir(path.join(homeDir, '.hermes'));
    const blocked = path.join(homeDir, '.hermes', 'skills');
    await fse.writeFile(blocked, 'member file');
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    const checks = await buildChecks(ctx);
    const check = checks.find((c) => c.name === 'hermes skills directory is usable');
    expect(check).toBeDefined();
    expect(await check!.check()).toBe(false);
    expect(check!.fix).toContain(blocked);
    expect(check!.fix).toContain('Move the file aside');
    expect(await fse.readFile(blocked, 'utf8')).toBe('member file');
  });

  it('fails and names the skill the tool never received', async () => {
    await deliver(CLAUDE_SKILLS, 'alpha');

    const check = await deliveryCheck();

    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('beta');
    expect(check.fix).not.toContain('alpha');
    // Not a plain `teamai pull`: this check is printed at the end of one, and a
    // scope whose team repo has not moved is skipped, so it cannot restore this.
    expect(check.fix).toContain('teamai pull --force');
  });

  it('counts the rest rather than printing every name', async () => {
    // A fresh machine is missing everything. The fix is a line a human reads,
    // not the whole desired set pasted into the terminal.
    for (let i = 0; i < 9; i += 1) await writeTeamSkill(`extra-${i}`);

    const check = await deliveryCheck();

    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('and 6 more');
    expect(check.fix).not.toContain('extra-8');
  });

  it('does not warn about a Codex conflict while only reading', async () => {
    // buildDeliveryChecks resolves destinations without a sourcePath. Codex's
    // shared-directory reconciliation needs the team copy to prove two copies
    // are identical, so without one there is nothing to decide: a read-only
    // `doctor` must not report a conflict the write path would have settled.
    teamConfig.toolPaths = { codex: { skills: '.codex/skills' } };
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
    for (const name of ['alpha', 'beta']) {
      await deliver(['.agents', 'skills'], name);
      await deliver(['.codex', 'skills'], name);
    }

    const check = await deliveryCheck('codex');

    expect(await check.check()).toBe(true);
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('Codex skill conflict'));
  });

  it('asks the skills write path whether a tool is installed', async () => {
    // OpenClaw lives at its workspace directory, not at the tool root. A tool
    // root with no workspace passes a generic probe while skill delivery skips
    // the tool entirely, which is "reported success, received nothing" inside
    // the command whose job is to catch it (#598).
    teamConfig.toolPaths = { openclaw: { skills: '.openclaw/skills' } };
    localConfig.enabledAgents = ['openclaw'];
    await fse.ensureDir(path.join(homeDir, '.openclaw'));

    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    const installed = (await buildChecks(ctx)).find((c) => c.name === 'openclaw is installed');

    expect(installed).toBeDefined();
    expect(await installed!.check()).toBe(false);
  });

  it('passes once that tool\'s workspace is there', async () => {
    teamConfig.toolPaths = { openclaw: { skills: '.openclaw/skills' } };
    localConfig.enabledAgents = ['openclaw'];
    await fse.ensureDir(path.join(homeDir, '.openclaw', 'workspace', 'skills'));

    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    const installed = (await buildChecks(ctx)).find((c) => c.name === 'openclaw is installed');

    expect(installed).toBeDefined();
    expect(await installed!.check()).toBe(true);
  });

  describe('OpenClaw hook enabled', () => {
    const NAME = 'OpenClaw hook enabled';
    const stateDir = (): string => path.join(homeDir, '.openclaw');

    async function hookCheck(): Promise<Check | undefined> {
      const ctx = await resolveDoctorContext();
      if (!ctx) throw new Error('expected a resolved doctor context');
      return (await buildChecks(ctx)).find((c) => c.name === NAME);
    }

    beforeEach(async () => {
      for (const v of ['OPENCLAW_STATE_DIR', 'OPENCLAW_PROFILE', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_WORKSPACE_DIR']) vi.stubEnv(v, '');
      teamConfig.toolPaths = { openclaw: { skills: '.openclaw/skills' } };
      // The hook teamai injected, in the default workspace.
      await fse.ensureDir(path.join(stateDir(), 'workspace', 'hooks', 'teamai-status-report'));
    });

    it.each([
      ['the entry is missing', { hooks: { internal: { enabled: true } } }, false],
      ['the entry is disabled', { hooks: { internal: { entries: { 'teamai-status-report': { enabled: false } } } } }, false],
      ['internal hooks are off', { hooks: { internal: { enabled: false, entries: { 'teamai-status-report': { enabled: true } } } } }, false],
      ['the entry is enabled', { hooks: { internal: { enabled: true, entries: { 'teamai-status-report': { enabled: true } } } } }, true],
    ])('reports %s', async (_label, cfg, ok) => {
      await fse.writeJson(path.join(stateDir(), 'openclaw.json'), cfg);

      const check = await hookCheck();

      expect(check).toBeDefined();
      expect(await check!.check()).toBe(ok);
      expect(check!.fix).toContain('openclaw hooks enable teamai-status-report');
    });

    it('is not built when teamai has no hook in the workspace', async () => {
      await fse.remove(path.join(stateDir(), 'workspace', 'hooks'));

      expect(await hookCheck()).toBeUndefined();
    });
  });

  it('reports each installed tool separately', async () => {
    teamConfig.toolPaths = {
      claude: { skills: '.claude/skills' },
      codex: { skills: '.codex/skills' },
    };
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
    await deliver(CLAUDE_SKILLS, 'alpha');
    await deliver(CLAUDE_SKILLS, 'beta');
    await deliver(['.codex', 'skills'], 'alpha');

    expect(await (await deliveryCheck('claude')).check()).toBe(true);
    expect(await (await deliveryCheck('codex')).check()).toBe(false);
  });

  it('counts a codex skill in the shared .agents/skills directory as delivered', async () => {
    teamConfig.toolPaths = { codex: { skills: '.codex/skills' } };
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
    await deliver(['.agents', 'skills'], 'alpha');
    await deliver(['.agents', 'skills'], 'beta');

    expect(await (await deliveryCheck('codex')).check()).toBe(true);
  });

  it('asks nothing of a tool that is not installed', async () => {
    teamConfig.toolPaths = {
      claude: { skills: '.claude/skills' },
      codex: { skills: '.codex/skills' },
    };
    await deliver(CLAUDE_SKILLS, 'alpha');
    await deliver(CLAUDE_SKILLS, 'beta');

    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    const names = (await buildChecks(ctx)).map((c) => c.name);

    expect(names).toContain('Skills delivered to claude');
    expect(names).not.toContain('Skills delivered to codex');
  });

  it('asks nothing of an excluded skill', async () => {
    localConfig.excludedSkills = ['beta'];
    await deliver(CLAUDE_SKILLS, 'alpha');

    expect(await (await deliveryCheck()).check()).toBe(true);
  });

  // The write succeeded, so no write-time gate has anything to report — and the
  // agent still never discovers the skill (#372's class).
  describe('delivered but invisible', () => {
    it('fails when SKILL.md is gone', async () => {
      await deliver(CLAUDE_SKILLS, 'alpha');
      await fse.ensureDir(path.join(homeDir, ...CLAUDE_SKILLS, 'beta'));

      const check = await deliveryCheck();

      expect(await check.check()).toBe(false);
      expect(check.fix).toContain('beta');
      expect(check.fix).toMatch(/unreadable/i);
    });

    it('fails when the frontmatter does not parse', async () => {
      await deliver(CLAUDE_SKILLS, 'alpha');
      const beta = path.join(homeDir, ...CLAUDE_SKILLS, 'beta');
      await fse.ensureDir(beta);
      await fse.writeFile(path.join(beta, 'SKILL.md'), '---\nname: [oops\n---\n# beta\n');

      expect(await (await deliveryCheck()).check()).toBe(false);
    });

    it('fails when the frontmatter name does not match the directory', async () => {
      await deliver(CLAUDE_SKILLS, 'alpha');
      const beta = path.join(homeDir, ...CLAUDE_SKILLS, 'beta');
      await fse.ensureDir(beta);
      await fse.writeFile(path.join(beta, 'SKILL.md'), '---\nname: renamed\ndescription: d\n---\n');

      const check = await deliveryCheck();

      expect(await check.check()).toBe(false);
      expect(check.fix).toContain('beta');
    });

    it('separates what was never delivered from what is unreadable', async () => {
      const beta = path.join(homeDir, ...CLAUDE_SKILLS, 'beta');
      await fse.ensureDir(beta);
      await fse.writeFile(path.join(beta, 'SKILL.md'), '---\nname: renamed\n---\n');

      const check = await deliveryCheck();
      const fix = check.fix ?? '';

      // alpha never arrived; beta arrived broken. Same tool, different cause.
      expect(fix.indexOf('alpha')).toBeGreaterThan(-1);
      expect(fix.indexOf('beta')).toBeGreaterThan(-1);
      expect(fix).toMatch(/not delivered/i);
      expect(fix).toMatch(/unreadable/i);
    });

    it('accepts extra frontmatter fields', async () => {
      await deliver(CLAUDE_SKILLS, 'alpha');
      const beta = path.join(homeDir, ...CLAUDE_SKILLS, 'beta');
      await fse.ensureDir(beta);
      const skillMd = '---\nname: beta\ndescription: d\nallowed-tools: [Read]\nversion: 2\n---\n';
      // As pull delivered it: the team's SKILL.md (a copy that is not one is the member's, #993).
      await fse.writeFile(path.join(repoPath, 'skills', 'beta', 'SKILL.md'), skillMd);
      await fse.writeFile(path.join(beta, 'SKILL.md'), skillMd);

      expect(await (await deliveryCheck()).check()).toBe(true);
    });
  });

  // Docs are the one payload with a single destination instead of one per tool:
  // DocsHandler copies the whole bundle into `sharing.docs.localDir`.
  describe('team docs', () => {
    const CHECK = 'Team docs delivered';

    async function writeTeamDoc(...segments: string[]): Promise<void> {
      const file = path.join(repoPath, 'docs', ...segments);
      await fse.ensureDir(path.dirname(file));
      await fse.writeFile(file, '# doc\n');
    }

    async function docsCheck(): Promise<Check | undefined> {
      const ctx = await resolveDoctorContext();
      if (!ctx) throw new Error('expected a resolved doctor context');
      return (await buildChecks(ctx)).find((c) => c.name === CHECK);
    }

    beforeEach(() => {
      teamConfig.sharing.docs.localDir = '~/team-docs';
    });

    it('passes when the bundle is on disk', async () => {
      await writeTeamDoc('guide.md');
      await writeTeamDoc('api', 'reference.md');
      await fse.ensureDir(path.join(homeDir, 'team-docs', 'api'));
      await fse.writeFile(path.join(homeDir, 'team-docs', 'guide.md'), '# doc\n');
      await fse.writeFile(path.join(homeDir, 'team-docs', 'api', 'reference.md'), '# doc\n');

      const check = await docsCheck();

      expect(check).toBeDefined();
      expect(await check!.check()).toBe(true);
    });

    it('fails and names what is missing from the bundle', async () => {
      await writeTeamDoc('guide.md');
      await writeTeamDoc('api', 'reference.md');
      await fse.ensureDir(path.join(homeDir, 'team-docs'));
      await fse.writeFile(path.join(homeDir, 'team-docs', 'guide.md'), '# doc\n');

      const check = await docsCheck();

      expect(await check!.check()).toBe(false);
      expect(check!.fix).toContain('api/reference.md');
      expect(check!.fix).not.toContain('guide.md');
      expect(check!.fix).toContain('teamai pull --force');
    });

    it('does not accept a directory sitting on a doc\'s name', async () => {
      // pathExists follows symlinks and says yes to a directory, so on its own
      // it cannot tell a delivered document from a name occupied by something
      // else. The bundle is no more readable than if the file were missing.
      await writeTeamDoc('guide.md');
      await fse.ensureDir(path.join(homeDir, 'team-docs', 'guide.md'));

      const check = await docsCheck();

      expect(check).toBeDefined();
      expect(await check!.check()).toBe(false);
      expect(check!.fix).toContain('guide.md');
    });

    it('asks nothing when the team repo ships no docs', async () => {
      expect(await docsCheck()).toBeUndefined();
    });

    // The same filter pull applies (#707): a declared namespace this member
    // does not have active is not owed, and an active one is.
    it('does not expect the docs of a namespace declared elsewhere, and does expect the active one', async () => {
      await fse.outputFile(
        path.join(repoPath, 'manifest', 'projects.yaml'),
        'version: 1\nprojects:\n  - id: alpha\n    resources:\n      docs: [alpha]\n  - id: beta\n    resources:\n      docs: [beta]\n',
      );
      localConfig.projects = ['alpha'];
      await writeTeamDoc('guide.md');
      await writeTeamDoc('alpha', 'gateway.md');
      await writeTeamDoc('beta', 'billing.md');
      await fse.outputFile(path.join(homeDir, 'team-docs', 'guide.md'), '# doc\n');

      const check = await docsCheck();

      expect(await check!.check()).toBe(false);
      expect(check!.fix).toContain('alpha/gateway.md');
      expect(check!.fix).not.toContain('beta');

      await fse.outputFile(path.join(homeDir, 'team-docs', 'alpha', 'gateway.md'), '# doc\n');
      expect(await (await docsCheck())!.check()).toBe(true);
    });

    // Pull keeps an edited copy of an inactive namespace's doc and names it, so
    // doctor does not call it stale; a file the team has nowhere still is.
    it('does not report a kept doc of an inactive namespace as stale, only a file the team lacks', async () => {
      await fse.outputFile(
        path.join(repoPath, 'manifest', 'projects.yaml'),
        'version: 1\nprojects:\n  - id: alpha\n    resources:\n      docs: [alpha]\n  - id: beta\n    resources:\n      docs: [beta]\n',
      );
      localConfig.projects = ['alpha'];
      await writeTeamDoc('beta', 'billing.md');
      await fse.outputFile(path.join(homeDir, 'team-docs', 'beta', 'billing.md'), '# my notes\n');
      // The history proves which local files a pull may prune (#993).
      commitTeamRepo(repoPath);

      // No check at all is as good as a passing one: nothing is reported (#993).
      expect(await (await docsCheck())?.check() ?? true).toBe(true);

      // A copy of a doc the team has since removed is stale; a file of the member's would not be (#993).
      await writeTeamDoc('beta', 'retired.md');
      commitTeamRepo(repoPath, 'retired');
      await fse.remove(path.join(repoPath, 'docs', 'beta', 'retired.md'));
      commitTeamRepo(repoPath, 'remove retired');
      await fse.outputFile(path.join(homeDir, 'team-docs', 'beta', 'retired.md'), '# doc\n');
      const check = await docsCheck();
      expect(await check!.check()).toBe(false);
      expect(check!.fix).toContain('beta/retired.md');
      expect(check!.fix).not.toContain('billing.md');
    });

    it('does not report as stale a directory of the member\'s that pull keeps where the team deleted a doc file (#993)', async () => {
      await writeTeamDoc('guide');
      commitTeamRepo(repoPath, 'add guide');
      await fse.remove(path.join(repoPath, 'docs', 'guide'));
      await writeTeamDoc('other.md');
      commitTeamRepo(repoPath, 'remove guide');
      await fse.outputFile(path.join(homeDir, 'team-docs', 'other.md'), '# doc\n');
      await fse.outputFile(path.join(homeDir, 'team-docs', 'guide', 'personal.md'), 'mine');
      const check = await docsCheck();
      expect(check?.fix ?? '').not.toContain('guide/personal.md');
    });

    it('reports missing and stale docs together without changing local files', async () => {
      // docs/old/retired.md was a team doc, so the local copy is stale once the team removed it (#993).
      await writeTeamDoc('old', 'retired.md');
      commitTeamRepo(repoPath, 'retired');
      await fse.remove(path.join(repoPath, 'docs', 'old'));
      await writeTeamDoc('guide.md');
      commitTeamRepo(repoPath, 'remove retired');
      const stale = path.join(homeDir, 'team-docs', 'old', 'retired.md');
      await fse.outputFile(stale, '# doc\n');
      const check = await docsCheck();
      expect(await check!.check()).toBe(false);
      expect(check!.fix).toContain('Missing from');
      expect(check!.fix).toContain('guide.md');
      expect(check!.fix).toContain('Stale docs');
      expect(check!.fix).toContain('old/retired.md');
      expect(await fse.readFile(stale, 'utf8')).toBe('# doc\n');
    });

    it.each(['missing', 'empty', 'hidden-only'])('detects stale docs when the team bundle is %s', async (state) => {
      // docs/old.md was a team doc, so the local copy is stale once the team removed it (#993).
      await writeTeamDoc('old.md');
      commitTeamRepo(repoPath, 'old');
      await fse.remove(path.join(repoPath, 'docs'));
      if (state === 'empty') await fse.ensureDir(path.join(repoPath, 'docs'));
      if (state === 'hidden-only') await writeTeamDoc('.keep');
      await fse.outputFile(path.join(homeDir, 'team-docs', 'old.md'), '# doc\n');
      commitTeamRepo(repoPath, 'remove old');
      const check = await docsCheck();
      expect(await check!.check()).toBe(false);
      expect(check!.fix).toContain('Stale docs');
      expect(check!.fix).toContain('old.md');
      expect(check!.fix).not.toContain('Missing from');
      expect(check!.fix).toContain('teamai pull --force');
    });

    it.each(['missing', 'empty'])('reports stale empty directories when the team bundle is %s', async (state) => {
      if (state === 'empty') await fse.ensureDir(path.join(repoPath, 'docs'));
      const empty = path.join(homeDir, 'team-docs', 'old', 'nested');
      await fse.ensureDir(empty);
      await fse.outputFile(path.join(homeDir, 'team-docs', 'private', '.keep'), 'hidden');
      const check = await docsCheck();
      expect(await check!.check()).toBe(false);
      expect(check!.fix).toContain('old/nested/');
      expect(check!.fix).not.toContain('private');
      expect(await fse.pathExists(empty)).toBe(true);
    });

    it('accepts an empty directory that still exists in the team bundle', async () => {
      await fse.ensureDir(path.join(repoPath, 'docs', 'empty'));
      await fse.ensureDir(path.join(homeDir, 'team-docs', 'empty'));
      expect(await docsCheck()).toBeUndefined();
    });

    it('ignores hidden local docs and hidden subdirectories', async () => {
      await fse.outputFile(path.join(homeDir, 'team-docs', '.draft.md'), 'hidden');
      await fse.outputFile(path.join(homeDir, 'team-docs', 'old', '.private', 'draft.md'), 'hidden');
      expect(await docsCheck()).toBeUndefined();
    });

    // Changed in #993 from reporting it as stale: pull keeps a member's link at a path the team never had.
    it('does not call a member\'s directory link at a path the team never had stale, nor traverse its target (#993)', async () => {
      const outside = path.join(tempDir, 'outside');
      await fse.outputFile(path.join(outside, 'keep.md'), 'outside');
      await fse.ensureDir(path.join(homeDir, 'team-docs'));
      await fse.symlink(outside, path.join(homeDir, 'team-docs', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      // The history shows the team never had docs/linked (#993).
      commitTeamRepo(repoPath);
      const check = await docsCheck();
      expect(await check?.check() ?? true).toBe(true);
      expect(check?.fix ?? '').not.toContain('linked');
      expect(check?.fix ?? '').not.toContain('keep.md');
      expect(await fse.readFile(path.join(outside, 'keep.md'), 'utf8')).toBe('outside');
    });

    it('reports a destination that cannot be inspected instead of throwing', async () => {
      await fse.outputFile(path.join(homeDir, 'team-docs'), 'not a directory');
      const check = await docsCheck();
      expect(await check!.check()).toBe(false);
      expect(check!.fix).toContain('Could not inspect the docs mirror');
    });
  });

  // The command whose job is reporting bad state must not stack-trace on it.
  it('reports a team repo it cannot resolve a desired set from, instead of throwing', async () => {
    // The same skill in two active role namespaces: scanRoleAwareSkills throws.
    localConfig.primaryRole = 'dev';
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: dev',
      '    resources:',
      '      knowledge: []',
      '      skills: [one, two]',
      '      learnings: []',
      '      agents: []',
      '',
    ].join('\n'));
    for (const ns of ['one', 'two']) {
      const dir = path.join(repoPath, 'skills', ns, 'clash');
      await fse.ensureDir(dir);
      await fse.writeFile(path.join(dir, 'SKILL.md'), '---\nname: clash\n---\n');
    }

    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    const checks = await buildChecks(ctx);

    const resolution = checks.find((c) => c.name === 'Skills to deliver can be resolved');
    expect(resolution).toBeDefined();
    expect(await resolution!.check()).toBe(false);
    expect(resolution!.fix).toContain('clash');
  });

  it('never writes to the tool directory it inspects', async () => {
    await deliver(CLAUDE_SKILLS, 'alpha');

    await (await deliveryCheck()).check();

    expect(await fse.readdir(path.join(homeDir, ...CLAUDE_SKILLS))).toEqual(['alpha']);
  });
});

describe('doctor — where a tool takes skills', () => {
  let tempDir: string;
  let homeDir: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  async function checks(): Promise<Check[]> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    return buildChecks(ctx);
  }

  async function failing(): Promise<Check[]> {
    const out: Check[] = [];
    for (const check of await checks()) if (!await check.check()) out.push(check);
    return out;
  }

  async function report(): Promise<DoctorReport> {
    const printed: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { printed.push(String(line)); });
    try {
      await doctor({ json: true });
    } finally {
      spy.mockRestore();
    }
    const json = printed.find((line) => line.trimStart().startsWith('{'));
    if (json === undefined) throw new Error('doctor printed no JSON');
    return JSON.parse(json) as DoctorReport;
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skill-dirs-doctor-'));
    homeDir = path.join(tempDir, 'home');
    const repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);
    await fse.outputFile(path.join(repoPath, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: d\n---\n');
    localConfig = { repo: { localPath: repoPath, remote: 'owner/repo' }, username: 'tester', scope: 'user', additionalRoles: [] };
    teamConfig = {
      team: 'test', description: '', repo: 'owner/repo', provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: false } },
      toolPaths: { opencode: { skills: '.config/opencode/skills' } },
    };
    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('fails when the last pull wrote a tool\'s skills elsewhere than it takes them now', async () => {
    const xdg = path.join(tempDir, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    const state = await loadStateForScope(localConfig);
    const wrote = path.join(homeDir, '.config', 'opencode', 'skills');
    await saveStateForScope({ ...state, lastPullByWorkspace: { [await checkoutKey(homeDir)]: { rev: 'abc1234', targets: ['opencode'], skillDirs: { opencode: [wrote] } } } }, localConfig);

    const [check, ...rest] = (await failing()).filter((c) => c.name.startsWith('opencode skills'));

    expect(rest).toEqual([]);
    expect(check?.fix).toBe(`opencode takes skills from ${path.join(xdg, 'opencode', 'skills')}, but the last pull wrote them to ${wrote}. Run \`teamai pull\` to sync them there.`);
  });

  it('names the member\'s file that holds a skill back where a tool takes skills now', async () => {
    const xdg = path.join(tempDir, 'xdg');
    const mine = path.join(xdg, 'opencode', 'skills', 'alpha');
    await fse.outputFile(path.join(mine, 'SKILL.md'), '---\nname: alpha\ndescription: mine\n---\nMine.\n');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    const state = await loadStateForScope(localConfig);
    const wrote = path.join(homeDir, '.config', 'opencode', 'skills');
    await saveStateForScope({ ...state, lastPullByWorkspace: { [await checkoutKey(homeDir)]: { rev: 'abc1234', targets: ['opencode'], skillDirs: { opencode: [wrote, path.join(xdg, 'opencode', 'skills')] } } } }, localConfig);

    const check = (await failing()).find((c) => c.name === 'opencode skills are where the last pull wrote them');

    expect(check?.fix).toContain(`Kept ${mine}:`);
    expect(check?.fix).not.toContain('Run `teamai pull` to sync them there.');
  });

  it('tells a Codex member to pull after its home moved, though the shared skills directory is still written', async () => {
    const moved = path.join(homeDir, '.codex-alt');
    await fse.ensureDir(path.join(homeDir, '.codex')); await fse.ensureDir(moved);
    teamConfig.toolPaths = { codex: { skills: '.codex/skills' } };
    localConfig.toolRoots = { codex: moved };
    const wrote = path.join(homeDir, '.codex', 'skills');
    const state = await loadStateForScope(localConfig);
    await saveStateForScope({ ...state, lastPullByWorkspace: { [await checkoutKey(homeDir)]: { rev: 'abc1234', targets: ['codex'], skillDirs: { codex: [wrote, path.join(homeDir, '.agents', 'skills')] } } } }, localConfig);

    const check = (await failing()).find((c) => c.name === 'codex skills are where the last pull wrote them');

    expect(check?.fix).toBe(`codex takes skills from ${path.join(moved, 'skills')}, but the last pull wrote them to ${wrote}. Run \`teamai pull\` to sync them there.`);
  });

  describe('when the last pull kept the old copies of a move it could not finish', () => {
    let xdg: string; let wrote: string; let now: string;
    const moveFix = async (): Promise<string | undefined> => (await failing()).find((c) => c.name === 'opencode skills are where the last pull wrote them')?.fix;
    beforeEach(async () => {
      xdg = path.join(tempDir, 'xdg'); wrote = path.join(homeDir, '.config', 'opencode', 'skills'); now = path.join(xdg, 'opencode', 'skills');
      await fse.outputFile(path.join(now, 'teamai', 'SKILL.md'), await fse.readFile(path.join(packagedSkillRoots().deployRoot, 'teamai', 'SKILL.md')));
      vi.stubEnv('XDG_CONFIG_HOME', xdg);
      const state = await loadStateForScope(localConfig);
      await saveStateForScope({ ...state, lastPullByWorkspace: { [await checkoutKey(homeDir)]: { rev: 'abc1234', targets: ['opencode'], skillDirs: { opencode: [wrote, now] } } } }, localConfig);
    });

    it('names the member\'s built-in skill file that holds the move back', async () => {
      const stub = path.join(now, 'teamai', 'SKILL.md');
      await fse.writeFile(stub, 'Instructions belonging to the member\n');

      const fix = await moveFix();

      expect(fix).toContain(`Kept ${stub}:`);
      expect(fix).not.toContain('Run `teamai pull`');
    });

    it('says a workspace holds a skill back', async () => {
      const { resolveDesiredSkills: actual } = await vi.importActual<typeof import('../resources/desired.js')>('../resources/desired.js');
      vi.mocked(resolveDesiredSkills).mockImplementation(async (...args) => {
        const desired = await actual(...args);
        return desired.kind === 'resolved' ? { ...desired, items: [], held: ['alpha'] } : desired;
      });

      try {
        expect(await moveFix()).toBe(`opencode takes skills from ${now}, but the last pull could not deliver every skill there, so it kept teamai's copies in ${wrote}. `
          + 'This workspace holds back alpha: its members deliver different copies. Make the copies equal in the team repo, or rename one.');
      } finally {
        vi.mocked(resolveDesiredSkills).mockImplementation(actual);
      }
    });

    it('says the built-in skill could not be deployed', async () => {
      await fse.remove(path.join(now, 'teamai'));

      expect(await moveFix()).toBe(`opencode takes skills from ${now}, but the last pull could not deliver every skill there, so it kept teamai's copies in ${wrote}. `
        + 'The built-in teamai skill is not there: `teamai pull` says why it could not deploy it.');
    });
  });

  it('fails when the shell moves a tool\'s home away from the one recorded, and passes when they agree', async () => {
    const recorded = path.join(tempDir, 'recorded', 'opencode');
    await saveToolHomes({ opencode: recorded });
    vi.stubEnv('XDG_CONFIG_HOME', path.join(tempDir, 'other'));

    const mismatch = (await failing()).find((c) => c.name === 'opencode home matches XDG_CONFIG_HOME');

    expect(mismatch?.fix).toBe(`XDG_CONFIG_HOME puts the opencode home at ${path.join(tempDir, 'other', 'opencode')}; this machine syncs opencode to ${recorded}. Re-run \`teamai init\` to record it.`);

    vi.stubEnv('XDG_CONFIG_HOME', path.join(tempDir, 'recorded'));

    expect((await failing()).map((c) => c.name)).not.toContain('opencode home matches XDG_CONFIG_HOME');
  });

  it('leaves a recorded Hermes home alone when only active_profile names another', async () => {
    const recorded = path.join(tempDir, 'recorded', 'hermes');
    await fse.ensureDir(recorded);
    await saveToolHomes({ hermes: recorded });
    await fse.ensureDir(path.join(homeDir, '.hermes', 'profiles', 'work'));
    await fse.writeFile(path.join(homeDir, '.hermes', 'active_profile'), 'work\n');

    expect((await failing()).map((c) => c.name).filter((name) => name.startsWith('hermes home'))).toEqual([]);
  });

  it('fails when the home recorded for a tool is gone, whatever the shell says', async () => {
    const recorded = path.join(tempDir, 'recorded', 'opencode');
    await saveToolHomes({ opencode: recorded });

    const gone = (await failing()).find((c) => c.name === 'opencode home exists');

    expect(gone?.fix).toBe(`The opencode home recorded on this machine, ${recorded}, does not exist, so teamai skips opencode. `
      + `Re-run \`teamai init\` from a shell that sets the home opencode uses, or remove "opencode" from ${toolHomesPath()}.`);

    await fse.ensureDir(recorded);

    expect((await failing()).map((c) => c.name)).not.toContain('opencode home exists');
  });

  it('fails when the tool-homes record is not one, since teamai then ignores it', async () => {
    await fse.outputFile(toolHomesPath(), JSON.stringify({ opencode: 'relative/opencode' }));

    const check = (await failing()).find((c) => c.name === 'tool homes record is readable');

    expect(check?.fix).toBe(`${toolHomesPath()} is not a tool-homes record (opencode: must be an absolute directory): `
      + 'pull syncs nothing until it is, and other commands ignore every home in it. Fix it, or delete it and re-run `teamai init`.');
  });

  it('fails when a tool does not read the directory teamai writes its skills to', async () => {
    teamConfig.toolPaths = { opencode: { skills: '.opencode/skills' } };
    await fse.ensureDir(path.join(homeDir, '.opencode'));

    const check = (await failing()).find((c) => c.name === 'opencode reads the skills teamai writes');

    expect(check?.fix).toContain(`opencode does not read ${path.join(homeDir, '.opencode', 'skills')}`);
  });

  it('notes nothing left in OpenCode\'s default home once its skills follow the moved one (#1221)', async () => {
    const xdg = path.join(tempDir, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);

    const { notes } = await report();

    expect(notes?.some((note) => note.includes('still writes some of its other files'))).toBe(false);
  });

  it('notes nothing left in Pi\'s default home once its skills follow the moved one (#1221)', async () => {
    const pi = path.join(tempDir, 'pi-agent');
    await fse.ensureDir(pi);
    vi.stubEnv('PI_CODING_AGENT_DIR', pi);
    teamConfig.toolPaths = { pi: { skills: '.pi/agent/skills' } };

    const { notes } = await report();

    expect(notes?.filter((note) => note.startsWith('pi '))).toEqual([]);
  });

  /** The report doctor gives when run from each of `dirs`. */
  async function reportsFrom(dirs: readonly string[]): Promise<DoctorReport[]> {
    const cwd = process.cwd();
    const reports: DoctorReport[] = [];
    try {
      for (const dir of dirs) {
        await fse.ensureDir(dir);
        process.chdir(dir);
        reports.push(await report());
      }
    } finally {
      process.chdir(cwd);
    }
    return reports;
  }

  it('notes a project directory a tool reads only from a session started at the project root, and judges its reads from there, whatever directory doctor runs from', async () => {
    const project = path.join(await fse.realpath(tempDir), 'project');
    await fse.ensureDir(path.join(project, '.pi'));
    Object.assign(localConfig, { scope: 'project', projectRoot: project });
    teamConfig.toolPaths = { pi: { skills: '.pi/skills' } };

    const [atRoot, inSubdir, elsewhere] = await reportsFrom([project, path.join(project, 'src'), path.join(tempDir, 'elsewhere')]);

    expect(atRoot.notes).toContain(`pi reads project skills only from a session started in ${project}.`);
    expect([inSubdir.notes, elsewhere.notes]).toEqual([atRoot.notes, atRoot.notes]);
    const readChecks = ({ checks }: DoctorReport) => checks.filter((check) => check.name.includes(' reads the '));
    expect(readChecks(atRoot).map((check) => check.name)).toEqual(['pi reads the skills teamai writes']);
    expect(readChecks(atRoot).map((check) => check.ok)).toEqual([true]);
    expect([readChecks(inSubdir), readChecks(elsewhere)]).toEqual([readChecks(atRoot), readChecks(atRoot)]);
  });

  it('names no project read that every session in the project makes, whatever directory doctor runs from', async () => {
    const project = path.join(await fse.realpath(tempDir), 'project');
    await fse.ensureDir(path.join(project, '.claude'));
    Object.assign(localConfig, { scope: 'project', projectRoot: project });
    teamConfig.toolPaths = { claude: { skills: '.claude/skills', rules: '.claude/rules' } };
    await fse.outputFile(path.join(tempDir, 'team-repo', 'rules', 'style.md'), '# Style\n');

    const [atRoot, inSubdir] = await reportsFrom([project, path.join(project, 'src')]);

    expect(atRoot.notes?.filter((note) => note.startsWith('claude reads '))).toEqual([]);
    expect(inSubdir.notes).toEqual(atRoot.notes);
  });

  it('notes a user read limited to sessions under a directory, whatever directory doctor runs from', async () => {
    teamConfig.toolPaths = { cursor: { rules: '.cursor/rules' } };
    await fse.ensureDir(path.join(homeDir, '.cursor'));
    await fse.outputFile(path.join(tempDir, 'team-repo', 'rules', 'style.md'), '# Style\n');
    // A session directory is real, so the home it is compared with must be too (macOS links /var).
    const home = await fse.realpath(homeDir);
    vi.stubEnv('HOME', home);

    const [underHome, outsideHome] = await reportsFrom([path.join(home, 'work'), path.join(await fse.realpath(tempDir), 'outside')]);

    expect(underHome.notes).toContain(`cursor reads ${path.join(home, '.cursor', 'rules')} only from sessions under ${home}.`);
    expect(outsideHome.notes).toEqual(underHome.notes);
  });
});
