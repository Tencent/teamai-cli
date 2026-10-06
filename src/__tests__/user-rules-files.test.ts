import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveState: vi.fn(),
  loadStateForScope: vi.fn(async () => ({})),
  saveStateForScope: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  autoDetectInit: vi.fn(),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  createGit: vi.fn(),
}));

// pull() takes a real ~/.teamai/.sync-lock; parallel workers would race on it.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    persist: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

import { RulesHandler, ruleChannelNotes } from '../resources/rules.js';
import { teamRuleToCursorMdc } from '../resources/cursor-mdc.js';
import { teamRuleToJoycodeRule } from '../resources/joycode-rule.js';
import { pull } from '../pull.js';
import { uninstall } from '../uninstall.js';
import { buildChecks, resolveDoctorContext } from '../doctor.js';
import { log } from '../utils/logger.js';
import {
  autoDetectInit, detectProjectConfig, loadLocalConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope,
} from '../config.js';
import { TeamaiConfigSchema } from '../types.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

// What a user-scope pull writes for the two team rules below, markers included (#946).
const BLOCK = '<!-- [teamai:team-rules:start] -->\n'
  + '<!-- DO NOT EDIT: This section is auto-managed by teamai -->\n\n'
  + 'The team codeword is PELICAN-42.\n\n'
  + 'Applies to files matching: src/**\nPrefer named exports.\n\n'
  + '<!-- [teamai:team-rules:end] -->';

const CODEWORD = 'The team codeword is PELICAN-42.\n';
const SCOPED = '---\npaths:\n  - "src/**"\n---\nPrefer named exports.\n';

let tmpDir: string;
let homeDir: string;
let projectRoot: string;
let repoPath: string;

/** Each tool with no rules format, the home dir that says it is installed, and the file only it reads. */
const TOOLS: ReadonlyArray<{ tool: string; root: string; file: string }> = [
  { tool: 'zcode', root: '.zcode', file: '.zcode/AGENTS.md' },
  { tool: 'dsh', root: '.dsh', file: '.dsh/AGENTS.md' },
  { tool: 'openclaw', root: '.openclaw/workspace', file: '.openclaw/workspace/AGENTS.md' },
  { tool: 'pi', root: '.pi/agent', file: '.pi/agent/AGENTS.md' },
  { tool: 'joycode', root: '.joycode', file: '.joycode/rules.txt' },
];

const teamConfig = (): TeamaiConfig => TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' });

function config(scope: 'user' | 'project', enabledAgents: string[]): LocalConfig {
  return {
    repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
    username: 'u',
    updatePolicy: 'auto',
    additionalRoles: [],
    scope,
    ...(scope === 'project' ? { projectRoot } : {}),
    enabledAgents,
  } as LocalConfig;
}

const home = (rel: string) => path.join(homeDir, rel);

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-user-rules-'));
  homeDir = path.join(tmpDir, 'home');
  projectRoot = path.join(tmpDir, 'project');
  repoPath = path.join(tmpDir, 'team-repo');
  await fse.ensureDir(homeDir);
  await fse.ensureDir(projectRoot);
  await fse.ensureDir(path.join(repoPath, 'rules'));
  await fse.writeFile(path.join(repoPath, 'rules', 'codeword.md'), CODEWORD);
  await fse.writeFile(path.join(repoPath, 'rules', 'scoped.md'), SCOPED);
  vi.stubEnv('HOME', homeDir);
  for (const name of ['DSH_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_PROFILE', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_WORKSPACE_DIR']) {
    vi.stubEnv(name, '');
  }
  vi.mocked(log.warn).mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fse.remove(tmpDir);
});

describe('a user-scope rules sync puts the team rules in a file only the tool reads (#946)', () => {
  it.each(TOOLS)('writes the team-rules block for $tool to ~/$file, beside the member\'s text', async ({ tool, root, file }) => {
    await fse.ensureDir(home(root));
    await fse.writeFile(home(file), '# My notes\n');

    await new RulesHandler().pullAllRules(teamConfig(), config('user', [tool]));

    expect(await fse.readFile(home(file), 'utf8')).toBe(`# My notes\n\n${BLOCK}\n`);
  });

  it.each(TOOLS)('writes no rules directory for $tool in user scope', async ({ tool, root }) => {
    await fse.ensureDir(home(root));

    await new RulesHandler().pullAllRules(teamConfig(), config('user', [tool]));

    for (const dir of ['.openclaw/rules', '.pi/agent/rules', '.pi/rules', '.joycode/rules']) {
      expect(await fse.pathExists(home(dir))).toBe(false);
    }
  });

  it.each(TOOLS)('a project-scope sync leaves ~/$file unchanged for $tool', async ({ tool, root, file }) => {
    await fse.ensureDir(home(root));
    await fse.writeFile(home(file), '# My notes\n');

    await new RulesHandler().pullAllRules(teamConfig(), config('project', [tool]));

    expect(await fse.readFile(home(file), 'utf8')).toBe('# My notes\n');
  });

  it.each(TOOLS)('creates nothing for $tool when it is not installed', async ({ tool, file }) => {
    await new RulesHandler().pullAllRules(teamConfig(), config('user', [tool]));

    expect(await fse.pathExists(home(file))).toBe(false);
  });

  it.each(TOOLS)('removes the block, and a file that held only it, once $tool is excluded', async ({ tool, root, file }) => {
    await fse.ensureDir(home(root));
    await new RulesHandler().pullAllRules(teamConfig(), config('user', [tool]));
    expect(await fse.readFile(home(file), 'utf8')).toBe(`${BLOCK}\n`);

    await new RulesHandler().pullAllRules(teamConfig(), config('user', ['claude']));

    expect(await fse.pathExists(home(file))).toBe(false);
  });

  it.each(TOOLS)('removes the block once the member disables $tool', async ({ tool, root, file }) => {
    await fse.ensureDir(home(root));
    await new RulesHandler().pullAllRules(teamConfig(), config('user', [tool]));

    await new RulesHandler().pullAllRules(teamConfig(), { ...config('user', [tool]), disabledAgents: [tool] } as LocalConfig);

    expect(await fse.pathExists(home(file))).toBe(false);
  });

  it('writes DeepSeek Harness\'s block to $DSH_HOME/AGENTS.md', async () => {
    const dshHome = path.join(tmpDir, 'dsh-home');
    await fse.ensureDir(dshHome);
    vi.stubEnv('DSH_HOME', dshHome);

    await new RulesHandler().pullAllRules(teamConfig(), config('user', ['dsh']));

    expect(await fse.readFile(path.join(dshHome, 'AGENTS.md'), 'utf8')).toBe(`${BLOCK}\n`);
    expect(await fse.pathExists(home('.dsh/AGENTS.md'))).toBe(false);
  });

  it('writes the other tools\' files when one cannot be written, and names that one', async () => {
    await fse.ensureDir(home('.zcode/AGENTS.md')); // a directory where the file should be
    await fse.ensureDir(home('.pi/agent'));

    await new RulesHandler().pullAllRules(teamConfig(), config('user', ['zcode', 'pi']));

    expect(await fse.readFile(home('.pi/agent/AGENTS.md'), 'utf8')).toBe(`${BLOCK}\n`);
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings.some((m) => m.startsWith(`Could not write the team-rules block to ${home('.zcode/AGENTS.md')}`))).toBe(true);
  });

  it('writes DeepSeek Harness\'s block where only $DSH_HOME exists, as its hooks find it', async () => {
    const dshHome = path.join(tmpDir, 'dsh-home');
    await fse.ensureDir(dshHome);
    vi.stubEnv('DSH_HOME', dshHome);

    await new RulesHandler().pullAllRules(teamConfig(), config('user', ['dsh']));

    expect(await fse.readFile(path.join(dshHome, 'AGENTS.md'), 'utf8')).toBe(`${BLOCK}\n`);
  });

  it('writes nothing for DeepSeek Harness when $DSH_HOME does not exist, even with ~/.dsh', async () => {
    await fse.ensureDir(home('.dsh'));
    vi.stubEnv('DSH_HOME', path.join(tmpDir, 'missing-dsh-home'));

    await new RulesHandler().pullAllRules(teamConfig(), config('user', ['dsh']));

    expect(await fse.pathExists(home('.dsh/AGENTS.md'))).toBe(false);
    expect(await fse.pathExists(path.join(tmpDir, 'missing-dsh-home'))).toBe(false);
  });

  describe('OpenClaw reads the workspace AGENTS.md its hooks resolve', () => {
    it('follows agents.defaults.workspace in openclaw.json ahead of OPENCLAW_WORKSPACE_DIR', async () => {
      const configured = path.join(tmpDir, 'configured-ws');
      const fromEnv = path.join(tmpDir, 'env-ws');
      await fse.ensureDir(configured);
      await fse.ensureDir(fromEnv);
      await fse.outputJson(home('.openclaw/openclaw.json'), { agents: { defaults: { workspace: configured } } });
      vi.stubEnv('OPENCLAW_WORKSPACE_DIR', fromEnv);

      await new RulesHandler().pullAllRules(teamConfig(), config('user', ['openclaw']));

      expect(await fse.readFile(path.join(configured, 'AGENTS.md'), 'utf8')).toBe(`${BLOCK}\n`);
      expect(await fse.pathExists(path.join(fromEnv, 'AGENTS.md'))).toBe(false);
    });

    it('follows OPENCLAW_WORKSPACE_DIR', async () => {
      const fromEnv = path.join(tmpDir, 'env-ws');
      await fse.ensureDir(fromEnv);
      await fse.ensureDir(home('.openclaw/workspace'));
      vi.stubEnv('OPENCLAW_WORKSPACE_DIR', fromEnv);

      await new RulesHandler().pullAllRules(teamConfig(), config('user', ['openclaw']));

      expect(await fse.readFile(path.join(fromEnv, 'AGENTS.md'), 'utf8')).toBe(`${BLOCK}\n`);
      expect(await fse.pathExists(home('.openclaw/workspace/AGENTS.md'))).toBe(false);
    });

    it('follows the profile\'s state dir', async () => {
      vi.stubEnv('OPENCLAW_PROFILE', 'work');
      await fse.ensureDir(home('.openclaw-work/workspace'));
      await fse.ensureDir(home('.openclaw/workspace'));

      await new RulesHandler().pullAllRules(teamConfig(), config('user', ['openclaw']));

      expect(await fse.readFile(home('.openclaw-work/workspace/AGENTS.md'), 'utf8')).toBe(`${BLOCK}\n`);
      expect(await fse.pathExists(home('.openclaw/workspace/AGENTS.md'))).toBe(false);
    });

    it('writes no block, and warns naming openclaw.json, its parse error and the next step, when teamai cannot read that file', async () => {
      // OpenClaw reads JSON5; a workspace set there is invisible to teamai, so
      // the default workspace may not be the one OpenClaw uses.
      await fse.ensureDir(home('.openclaw/workspace'));
      await fse.outputFile(home('.openclaw/openclaw.json'), '{ // JSON5\n  agents: { defaults: { workspace: "~/elsewhere" } },\n}\n');
      vi.mocked(loadLocalConfigForScope).mockImplementation(async (scope) => (scope === 'user' ? config('user', ['openclaw']) : null) as never);
      vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig());

      try {
        await pull({ force: true });
      } finally {
        vi.mocked(loadLocalConfigForScope).mockReset();
      }

      expect(await fse.pathExists(home('.openclaw/workspace/AGENTS.md'))).toBe(false);
      const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
      const warning = warnings.find((message) => message.includes(home('.openclaw/openclaw.json')));
      expect(warning).toBeDefined();
      expect(warning).toMatch(/JSON/);
      expect(warning).toContain('teamai pull');
    });

    it('follows OPENCLAW_STATE_DIR', async () => {
      const stateDir = path.join(tmpDir, 'oc-state');
      await fse.ensureDir(path.join(stateDir, 'workspace'));
      vi.stubEnv('OPENCLAW_STATE_DIR', stateDir);

      await new RulesHandler().pullAllRules(teamConfig(), config('user', ['openclaw']));

      expect(await fse.readFile(path.join(stateDir, 'workspace', 'AGENTS.md'), 'utf8')).toBe(`${BLOCK}\n`);
    });
  });
});

const LEGACY: ReadonlyArray<{ tool: string; scope: 'user' | 'project'; root: string; dir: string; copy: (raw: string) => string; ext: string }> = [
  { tool: 'openclaw', scope: 'user', root: '.openclaw/workspace', dir: '.openclaw/rules', copy: (raw) => raw, ext: '.md' },
  { tool: 'openclaw', scope: 'project', root: '.openclaw', dir: '.openclaw/rules', copy: (raw) => raw, ext: '.md' },
  { tool: 'pi', scope: 'user', root: '.pi/agent', dir: '.pi/agent/rules', copy: (raw) => raw, ext: '.md' },
  { tool: 'pi', scope: 'project', root: '.pi', dir: '.pi/rules', copy: (raw) => raw, ext: '.md' },
  { tool: 'joycode', scope: 'user', root: '.joycode', dir: '.joycode/rules', copy: teamRuleToCursorMdc, ext: '.mdc' },
  // A release between JoyCode's own render (#946) and this one rewrote user copies in it.
  { tool: 'joycode', scope: 'user', root: '.joycode', dir: '.joycode/rules', copy: teamRuleToJoycodeRule, ext: '.mdc' },
];
const base = (scope: 'user' | 'project') => (scope === 'user' ? homeDir : projectRoot);

describe('pull reclaims the rule copies left where these tools never read them (#946)', () => {
  it.each(LEGACY)('$tool ($scope): removes an unedited copy in $dir and keeps an edited one, named', async ({ tool, scope, root, dir, copy, ext }) => {
    await fse.ensureDir(path.join(base(scope), root));
    const unedited = path.join(base(scope), dir, `scoped${ext}`);
    const edited = path.join(base(scope), dir, `codeword${ext}`);
    await fse.outputFile(unedited, copy(SCOPED));
    await fse.outputFile(edited, 'The team codeword is PELICAN-42. My own addition.\n');

    await new RulesHandler().pullAllRules(teamConfig(), config(scope, [tool]));

    expect(await fse.pathExists(unedited)).toBe(false);
    expect(await fse.readFile(edited, 'utf8')).toBe('The team codeword is PELICAN-42. My own addition.\n');
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings.some((message) => message.includes(edited))).toBe(true);
  });
});

describe('a pull at an unchanged team revision after a CLI upgrade (#946)', () => {
  let saved: Record<string, unknown>;

  beforeEach(() => {
    saved = {};
    vi.mocked(saveStateForScope).mockImplementation(async (state) => {
      saved = structuredClone(state) as Record<string, unknown>;
    });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig());
  });

  afterEach(() => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.mocked(loadLocalConfigForScope).mockReset();
  });

  it.each(TOOLS)('writes $tool\'s missing block and reclaims nothing it should keep', async ({ tool, root, file }) => {
    await fse.ensureDir(home(root));
    vi.mocked(loadLocalConfigForScope).mockImplementation(async (scope) => (scope === 'user' ? config('user', [tool]) : null) as never);
    await pull({});
    // What an older CLI left at this revision: no block.
    await fse.writeFile(home(file), 'My own notes.\n');
    vi.mocked(log.success).mockClear();

    await pull({});

    expect(vi.mocked(log.success).mock.calls.some(([message]) => String(message).includes('Already synced at abc1234'))).toBe(true);
    expect(await fse.readFile(home(file), 'utf8')).toBe(`My own notes.\n\n${BLOCK}\n`);
  });

  it.each(LEGACY.filter(({ scope }) => scope === 'user'))('reclaims $tool\'s unedited copy in ~/$dir', async ({ tool, root, dir, copy, ext }) => {
    await fse.ensureDir(home(root));
    vi.mocked(loadLocalConfigForScope).mockImplementation(async (scope) => (scope === 'user' ? config('user', [tool]) : null) as never);
    await pull({});
    // What an older CLI left at this revision.
    const unedited = home(path.join(dir, `scoped${ext}`));
    await fse.outputFile(unedited, copy(SCOPED));
    vi.mocked(log.success).mockClear();

    await pull({});

    expect(vi.mocked(log.success).mock.calls.some(([message]) => String(message).includes('Already synced at abc1234'))).toBe(true);
    expect(await fse.pathExists(unedited)).toBe(false);
  });

  it('reclaims Pi\'s unedited copy in a project\'s .pi/rules', async () => {
    await fse.ensureDir(path.join(projectRoot, '.pi'));
    vi.mocked(detectProjectConfig).mockResolvedValue(config('project', ['pi']));
    try {
      await pull({});
      // What an older CLI left at this revision.
      const unedited = path.join(projectRoot, '.pi', 'rules', 'scoped.md');
      await fse.outputFile(unedited, SCOPED);
      vi.mocked(log.success).mockClear();

      await pull({});

      expect(vi.mocked(log.success).mock.calls.some(([message]) => String(message).includes('Already synced at abc1234'))).toBe(true);
      expect(await fse.pathExists(unedited)).toBe(false);
    } finally {
      vi.mocked(detectProjectConfig).mockResolvedValue(null);
    }
  });
});

describe('uninstall removes the team-rules block (#946)', () => {
  afterEach(() => {
    vi.mocked(autoDetectInit).mockReset();
  });

  it.each(TOOLS)('uninstall --agent $tool removes the block, and the file teamai created for it alone', async ({ tool, root, file }) => {
    await fse.ensureDir(home(root));
    const localConfig = config('user', [tool, 'claude']);
    await new RulesHandler().pullAllRules(teamConfig(), localConfig);
    expect(await fse.pathExists(home(file))).toBe(true);
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig, teamConfig: teamConfig() } as never);

    await uninstall({ force: true, agent: tool });

    expect(await fse.pathExists(home(file))).toBe(false);
  });

  it.each(TOOLS)('uninstall --agent $tool keeps the member\'s text in ~/$file', async ({ tool, root, file }) => {
    await fse.ensureDir(home(root));
    await fse.writeFile(home(file), '# My notes\n');
    const localConfig = config('user', [tool, 'claude']);
    await new RulesHandler().pullAllRules(teamConfig(), localConfig);
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig, teamConfig: teamConfig() } as never);

    await uninstall({ force: true, agent: tool });

    expect(await fse.readFile(home(file), 'utf8')).toBe('# My notes\n');
  });
});

describe('uninstall reclaims the same legacy copies (#946)', () => {
  afterEach(() => {
    vi.mocked(autoDetectInit).mockReset();
  });

  it.each(LEGACY)('$tool ($scope): uninstall --agent removes an unedited copy in $dir and keeps an edited one, named', async ({ tool, scope, root, dir, copy, ext }) => {
    await fse.ensureDir(path.join(base(scope), root));
    const unedited = path.join(base(scope), dir, `scoped${ext}`);
    const edited = path.join(base(scope), dir, `codeword${ext}`);
    await fse.outputFile(unedited, copy(SCOPED));
    await fse.outputFile(edited, 'The team codeword is PELICAN-42. My own addition.\n');
    const localConfig = config(scope, [tool, 'claude']);
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig, teamConfig: teamConfig() } as never);

    await uninstall({ force: true, agent: tool });

    expect(await fse.pathExists(unedited)).toBe(false);
    expect(await fse.pathExists(edited)).toBe(true);
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings.some((message) => message.includes(edited))).toBe(true);
  });
});

describe('doctor checks the block in the file each tool reads (#946)', () => {
  const NAMES: Record<string, string> = {
    zcode: 'Team rules are inlined in ZCode AGENTS.md',
    dsh: 'Team rules are inlined in DeepSeek Harness AGENTS.md',
    openclaw: 'Team rules are inlined in OpenClaw workspace AGENTS.md',
    pi: 'Team rules are inlined in Pi AGENTS.md',
    joycode: 'Team rules are inlined in JoyCode rules.txt',
  };

  async function check(tool: string) {
    vi.mocked(loadLocalConfig).mockResolvedValue(config('user', [tool]));
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig());
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    return (await buildChecks(ctx)).find((c) => c.name === NAMES[tool]);
  }

  it.each(TOOLS)('passes for $tool after a pull, and fails naming ~/$file after a hand edit', async ({ tool, root, file }) => {
    await fse.ensureDir(home(root));
    await new RulesHandler().pullAllRules(teamConfig(), config('user', [tool]));

    const passing = await check(tool);
    expect(passing).toBeDefined();
    expect(await passing!.check()).toBe(true);

    await fse.writeFile(home(file), (await fse.readFile(home(file), 'utf8')).replace('PELICAN-42', 'PELICAN-43'));
    const failing = (await check(tool))!;
    expect(await failing.check()).toBe(false);
    expect(failing.fix).toContain(home(file));
    expect(failing.fix).toContain('Run `teamai pull` to rewrite it.');
    expect(failing.fix).not.toContain('--force');
  });

  it.each(TOOLS)('fails for $tool when ~/$file carries no block', async ({ tool, root, file }) => {
    await fse.ensureDir(home(root));
    await fse.writeFile(home(file), '# My notes\n');

    const failing = (await check(tool))!;
    expect(await failing.check()).toBe(false);
    expect(failing.fix).toContain(home(file));
    expect(failing.fix).toContain('Run `teamai pull` to restore it.');
  });

  it('fails for OpenClaw with the parse error when teamai cannot read openclaw.json', async () => {
    await fse.ensureDir(home('.openclaw/workspace'));
    await fse.outputFile(home('.openclaw/workspace/AGENTS.md'), `${BLOCK}\n`);
    await fse.outputFile(home('.openclaw/openclaw.json'), '{ // JSON5\n  agents: {},\n}\n');

    const failing = (await check('openclaw'))!;
    expect(failing).toBeDefined();
    expect(await failing.check()).toBe(false);
    expect(failing.fix).toContain(home('.openclaw/openclaw.json'));
    expect(failing.fix).toMatch(/JSON/);
  });

  it.each(TOOLS)('asks nothing of $tool when it is not installed', async ({ tool }) => {
    expect(await check(tool)).toBeUndefined();
  });

  it('asks nothing of these tools in project scope', async () => {
    for (const { root } of TOOLS) await fse.ensureDir(home(root));
    vi.mocked(loadLocalConfig).mockResolvedValue(config('project', TOOLS.map(({ tool }) => tool)));
    vi.mocked(detectProjectConfig).mockResolvedValue(config('project', TOOLS.map(({ tool }) => tool)));
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig());
    try {
      const ctx = await resolveDoctorContext();
      const names = (await buildChecks(ctx!)).map((c) => c.name);
      for (const name of Object.values(NAMES)) expect(names).not.toContain(name);
    } finally {
      vi.mocked(detectProjectConfig).mockResolvedValue(null);
    }
  });
});

describe('OpenClaw\'s instruction blocks follow the same workspace, in user scope only (#946)', () => {
  beforeEach(async () => {
    await fse.writeFile(path.join(repoPath, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n');
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig());
  });

  afterEach(() => {
    vi.mocked(loadLocalConfigForScope).mockReset();
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
  });

  it('a user-scope pull writes culture and the team rules to the profile\'s workspace AGENTS.md, and leaves the default one, which the default profile reads', async () => {
    vi.stubEnv('OPENCLAW_PROFILE', 'work');
    await fse.ensureDir(home('.openclaw-work/workspace'));
    await fse.outputFile(home('.openclaw/workspace/AGENTS.md'), '# Default workspace\n\n<!-- [teamai:culture:start] -->\nold\n<!-- [teamai:culture:end] -->\n');
    vi.mocked(loadLocalConfigForScope).mockImplementation(async (scope) => (scope === 'user' ? config('user', ['openclaw']) : null) as never);

    await pull({});

    const content = await fse.readFile(home('.openclaw-work/workspace/AGENTS.md'), 'utf8');
    expect(content).toContain('Be kind to teammates.');
    expect(content).toContain(BLOCK);
    expect(await fse.readFile(home('.openclaw/workspace/AGENTS.md'), 'utf8'))
      .toBe('# Default workspace\n\n<!-- [teamai:culture:start] -->\nold\n<!-- [teamai:culture:end] -->\n');
  });

  it('a user-scope pull keeps Pi\'s team-rules block beside the instruction blocks, each once, over two pulls', async () => {
    await fse.ensureDir(home('.pi/agent'));
    vi.mocked(loadLocalConfigForScope).mockImplementation(async (scope) => (scope === 'user' ? config('user', ['pi']) : null) as never);

    await pull({ force: true });
    await pull({ force: true });

    const content = await fse.readFile(home('.pi/agent/AGENTS.md'), 'utf8');
    expect(content.split('<!-- [teamai:culture:start] -->').length - 1).toBe(1);
    expect(content.split('<!-- [teamai:team-rules:start] -->').length - 1).toBe(1);
    expect(content).toContain('Be kind to teammates.');
    expect(content).toContain(BLOCK);
  });

  it('a project-scope pull writes no blocks into the project for OpenClaw, and strips an older release\'s', async () => {
    await fse.ensureDir(home('.openclaw/workspace'));
    const projectFile = path.join(projectRoot, '.openclaw', 'workspace', 'AGENTS.md');
    await fse.outputFile(projectFile, '# Project notes\n\n<!-- [teamai:culture:start] -->\nold\n<!-- [teamai:culture:end] -->\n');
    vi.mocked(detectProjectConfig).mockResolvedValue(config('project', ['openclaw']));

    await pull({});

    expect(await fse.readFile(projectFile, 'utf8')).toBe('# Project notes\n');
    expect(await fse.pathExists(path.join(projectRoot, 'AGENTS.md'))).toBe(false);
    expect(await fse.pathExists(home('.openclaw/workspace/AGENTS.md'))).toBe(false);
  });
});

describe('init and doctor say why OpenClaw gets no project rules (#946)', () => {
  it('notes it in project scope while OpenClaw is installed', async () => {
    await fse.ensureDir(home('.openclaw/workspace'));

    const notes = await ruleChannelNotes(config('project', ['openclaw']));

    expect(notes.some((note) => note.startsWith('OpenClaw gets no project rules') && note.includes('workspace AGENTS.md'))).toBe(true);
  });

  it.each([
    ['in user scope', 'user' as const, ['openclaw'], true],
    ['when OpenClaw is excluded', 'project' as const, ['claude'], true],
    ['when OpenClaw is not installed', 'project' as const, ['openclaw'], false],
  ])('says nothing %s', async (_label, scope, enabled, installed) => {
    if (installed) await fse.ensureDir(home('.openclaw/workspace'));

    const notes = await ruleChannelNotes(config(scope, enabled));

    expect(notes.some((note) => note.startsWith('OpenClaw'))).toBe(false);
  });
});

/**
 * A team `toolPaths` entry replaces the default one whole, so one written
 * before #946 still sends rules to a directory the tool never reads; doctor
 * must not pass that delivery (#946).
 */
describe('doctor fails a delivery to a rules directory the tool does not read (#946)', () => {
  const OLD_ENTRIES: ReadonlyArray<{
    tool: string; scope: 'user' | 'project'; root: string; dir: string; name: string; entry: Record<string, unknown>; change: string;
  }> = [
    {
      tool: 'pi', scope: 'user', root: '.pi/agent', dir: '.pi/agent/rules', name: 'Rules delivered to pi',
      entry: { skills: '.pi/skills', rules: '.pi/rules', claudemd: 'AGENTS.md', userScope: { skills: '.pi/agent/skills', rules: '.pi/agent/rules', claudemd: '.pi/agent/AGENTS.md' } },
      change: '`userScope.rules`',
    },
    {
      tool: 'pi', scope: 'project', root: '.pi', dir: '.pi/rules', name: 'Rules delivered to pi',
      entry: { skills: '.pi/skills', rules: '.pi/rules', claudemd: 'AGENTS.md', userScope: { skills: '.pi/agent/skills', rules: '.pi/agent/rules', claudemd: '.pi/agent/AGENTS.md' } },
      change: '`rules`',
    },
    {
      tool: 'workbuddy', scope: 'project', root: '.workbuddy', dir: '.workbuddy/rules', name: 'Rules delivered to workbuddy',
      entry: { skills: '.workbuddy/skills', rules: '.workbuddy/rules', settings: '.workbuddy/settings.json' },
      change: '`rules: .codebuddy/rules`',
    },
    {
      tool: 'joycode', scope: 'user', root: '.joycode', dir: '.joycode/rules', name: 'Rules delivered to joycode',
      entry: { skills: '.joycode/skills', rules: '.joycode/rules' },
      change: '`userScope.rules: null`',
    },
  ];

  afterEach(() => {
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
  });

  it.each(OLD_ENTRIES)('$tool ($scope): fails for $dir, naming the directory, why and the toolPaths change', async ({ tool, scope, root, dir, name, entry, change }) => {
    await fse.ensureDir(path.join(base(scope), root));
    const team = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git', toolPaths: { [tool]: entry } });
    const localConfig = config(scope, [tool]);
    await new RulesHandler().pullAllRules(team, localConfig);
    // The old entry still delivers there; this is the case doctor must catch.
    expect(await fse.pathExists(path.join(base(scope), dir, `codeword${tool === 'joycode' ? '.mdc' : '.md'}`))).toBe(true);

    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    if (scope === 'project') vi.mocked(detectProjectConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(team);
    const ctx = await resolveDoctorContext();
    const failing = (await buildChecks(ctx!)).find((c) => c.name === name);

    expect(failing).toBeDefined();
    expect(await failing!.check()).toBe(false);
    expect(failing!.fix).toContain(`toolPaths.${tool} entry still sends the rules to ${path.join(base(scope), dir)}`);
    expect(failing!.fix).toContain(`toolPaths.${tool}`);
    expect(failing!.fix).toContain(change);
    // A copy there is inert, so restoring it is no fix.
    expect(failing!.fix).not.toContain('--force');
  });

  it('still passes the default WorkBuddy delivery to .codebuddy/rules in a project', async () => {
    await fse.ensureDir(path.join(projectRoot, '.workbuddy'));
    const localConfig = config('project', ['workbuddy']);
    await new RulesHandler().pullAllRules(teamConfig(), localConfig);

    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig());
    const ctx = await resolveDoctorContext();
    const check = (await buildChecks(ctx!)).find((c) => c.name.startsWith('Rules delivered to') && c.name.includes('workbuddy'));

    expect(check).toBeDefined();
    expect(await check!.check()).toBe(true);
  });
});
