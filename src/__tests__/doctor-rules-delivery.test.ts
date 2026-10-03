import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
  // resolveDesiredAgents reads placement records to mirror what pull delivers.
  loadStateForScope: vi.fn().mockResolvedValue({}),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
}));

import crypto from 'node:crypto';
import { loadLocalConfig, loadStateForScope, loadTeamConfig } from '../config.js';
import { buildChecks, doctor, resolveDoctorContext, type Check, type DoctorReport } from '../doctor.js';
import { checkoutKey } from '../pull.js';
import { StateSchema, TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';

/**
 * The rules half of the delivery check (#624). A rule changes both its filename
 * and its bytes per tool, so "it synced" and "the tool can read it" are two
 * different questions — and only the second one is the one that matters.
 */
describe('doctor — rules delivered on disk', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  const CLAUDE_RULES = '.claude/rules';
  const CURSOR_RULES = '.cursor/rules';
  const OPENCODE_RULES = '.config/opencode/rules';
  const OPENCODE_CONFIG = '.config/opencode/opencode.json';

  /** Make OpenCode an installed tool that receives rules in this scope. */
  async function installOpencode(): Promise<void> {
    teamConfig.toolPaths.opencode = {
      rules: '.opencode/rules',
      mcp: OPENCODE_CONFIG,
      mcpProject: 'opencode.json',
      userScope: { rules: OPENCODE_RULES },
    };
    await fse.ensureDir(path.join(homeDir, OPENCODE_RULES));
    for (const name of ['coding-style', 'reviews']) {
      await fse.writeFile(path.join(homeDir, OPENCODE_RULES, `${name}.md`), `Body of ${name}\n`);
    }
  }

  async function writeOpencodeConfig(data: unknown): Promise<void> {
    const file = path.join(homeDir, OPENCODE_CONFIG);
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }

  async function namedCheck(name: string): Promise<Check | undefined> {
    return (await checks()).find((c) => c.name === name);
  }

  async function writeTeamRule(name: string, frontmatter = ''): Promise<void> {
    const file = path.join(repoPath, 'rules', `${name}.md`);
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, `${frontmatter}Body of ${name}\n`);
  }

  /** A correctly delivered copy, the way pullItem leaves one. */
  async function deliverPlain(toolPath: string, name: string): Promise<void> {
    const file = path.join(homeDir, toolPath, `${name}.md`);
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, `Body of ${name}\n`);
  }

  async function deliverMdc(name: string, frontmatter = '---\nalwaysApply: true\n---\n\n'): Promise<void> {
    const file = path.join(homeDir, CURSOR_RULES, `${name}.mdc`);
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, `${frontmatter}Body of ${name}\n`);
  }

  async function checks(): Promise<Check[]> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    return buildChecks(ctx);
  }

  async function rulesCheck(tool: string): Promise<Check> {
    const check = (await checks()).find((c) => c.name === `Rules delivered to ${tool}`);
    if (!check) throw new Error(`no rules delivery check for ${tool}`);
    return check;
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rules-delivery-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);

    await writeTeamRule('coding-style');
    await writeTeamRule('reviews');
    await fse.ensureDir(path.join(homeDir, CLAUDE_RULES));
    await fse.ensureDir(path.join(homeDir, CURSOR_RULES));

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
      toolPaths: {
        claude: { rules: CLAUDE_RULES },
        cursor: { rules: CURSOR_RULES },
      },
    };

    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('passes when every desired rule reached both tools in its own format', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');
    await deliverMdc('coding-style');
    await deliverMdc('reviews');

    expect(await (await rulesCheck('claude')).check()).toBe(true);
    expect(await (await rulesCheck('cursor')).check()).toBe(true);
  });

  it('fails for the tool whose .mdc copy is missing, and names its directory', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');
    await deliverMdc('coding-style');

    const cursor = await rulesCheck('cursor');
    expect(await cursor.check()).toBe(false);
    expect(cursor.fix).toContain('not delivered: reviews');
    expect(cursor.fix).toContain(path.join(homeDir, CURSOR_RULES));

    // Per tool, independently: claude received both.
    expect(await (await rulesCheck('claude')).check()).toBe(true);
  });

  it('reports a .mdc that landed without the frontmatter Cursor reads', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');
    await deliverMdc('coding-style');
    await deliverMdc('reviews', '');

    const cursor = await rulesCheck('cursor');
    expect(await cursor.check()).toBe(false);
    expect(cursor.fix).toContain('delivered from an older copy: reviews');
  });

  it('names --force for an unrecorded older copy, and a plain pull for one on record (#946)', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');
    await deliverMdc('coding-style');
    await deliverMdc('reviews', '');

    const unrecorded = await rulesCheck('cursor');
    expect(await unrecorded.check()).toBe(false);
    expect(unrecorded.fix).toContain('teamai pull --force');

    // What an older CLI wrote and recorded: the "Already synced" pull re-renders it.
    const older = path.join(homeDir, CURSOR_RULES, 'reviews.mdc');
    const delivered = { [older]: crypto.createHash('sha256').update('Body of reviews\n').digest('hex') };
    vi.mocked(loadStateForScope).mockResolvedValue(StateSchema.parse({
      lastPullByWorkspace: { [await checkoutKey(homeDir)]: { rev: 'r1', targets: [], delivered } },
    }));
    try {
      const recorded = await rulesCheck('cursor');
      expect(await recorded.check()).toBe(false);
      expect(recorded.fix).toContain('reviews');
      expect(recorded.fix).toContain('Run `teamai pull`');
      expect(recorded.fix).not.toContain('--force');
    } finally {
      vi.mocked(loadStateForScope).mockResolvedValue(StateSchema.parse({}));
    }
  });

  it('reports a .mdc whose globs no longer match the team rule', async () => {
    // The frontmatter fields are all present and `alwaysApply` is a legal
    // value, so checking that the keys exist calls this delivered. Cursor
    // applies it to `**/*.py` while the team rule says `**/*.ts`.
    await writeTeamRule('reviews', '---\npaths:\n  - "**/*.ts"\n---\n');
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');
    await deliverMdc('coding-style');
    await deliverMdc('reviews', '---\nglobs: "**/*.py"\nalwaysApply: false\n---\n\n');

    const cursor = await rulesCheck('cursor');
    expect(await cursor.check()).toBe(false);
    expect(cursor.fix).toContain('delivered from an older copy: reviews');
  });

  it('reports a .md copy whose body drifted from the team rule', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    const drifted = path.join(homeDir, CLAUDE_RULES, 'reviews.md');
    await fse.ensureDir(path.dirname(drifted));
    await fse.writeFile(drifted, 'Something else entirely\n');
    await deliverMdc('coding-style');
    await deliverMdc('reviews');

    const claude = await rulesCheck('claude');
    expect(await claude.check()).toBe(false);
    expect(claude.fix).toContain('delivered from an older copy: reviews');
  });

  it.each([
    ['kiro', '.kiro/steering', '---\ninclusion: fileMatch\nfileMatchPattern: ["**/*.ts"]\n---\n\n', '`inclusion` or `fileMatchPattern`'],
    ['qoder', '.qoder/rules', '---\ntrigger: glob\nglob: **/*.ts\n---\n\n', '`trigger` or `glob`'],
  ])('checks %s against its own render, and names the fields it scopes by (#946)', async (tool, dir, frontmatter, fields) => {
    await writeTeamRule('reviews', '---\npaths:\n  - "**/*.ts"\n---\n');
    teamConfig.toolPaths = { [tool]: { rules: dir } };
    const always = tool === 'kiro' ? '---\ninclusion: always\n---\n\n' : '---\ntrigger: always_on\n---\n\n';
    await fse.outputFile(path.join(homeDir, dir, 'coding-style.md'), `${always}Body of coding-style\n`);
    const reviews = path.join(homeDir, dir, 'reviews.md');
    await fse.outputFile(reviews, `${frontmatter}Body of reviews\n`);

    expect(await (await rulesCheck(tool)).check()).toBe(true);

    // A hand edit to the glob: well-formed, and wrong.
    await fse.writeFile(reviews, `${frontmatter.replace('**/*.ts', '**/*.py')}Body of reviews\n`);
    const check = await rulesCheck(tool);
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('delivered from an older copy: reviews');
    expect(check.fix).toContain(fields);
    expect(check.fix).not.toContain('.mdc');
  });

  it.each([
    ['omp', '.omp/agent/rules', '---\nalwaysApply: true\n---\n\n'],
    ['kiro', '.kiro/steering', '---\ninclusion: always\n---\n\n'],
  ])('checks the flat file %s reads for a namespaced rule, not the nested path (#946)', async (tool, rulesDir, always) => {
    await writeTeamRule('fe/style');
    teamConfig.toolPaths = { [tool]: { rules: rulesDir } };
    const dir = path.join(homeDir, rulesDir);
    for (const name of ['coding-style', 'reviews']) {
      await fse.outputFile(path.join(dir, `${name}.md`), `${always}Body of ${name}\n`);
    }
    // Where an older teamai left it: the tool does not read below the top level.
    await fse.outputFile(path.join(dir, 'fe', 'style.md'), 'Body of fe/style\n');

    const missing = await rulesCheck(tool);
    expect(await missing.check()).toBe(false);
    expect(missing.fix).toContain('not delivered: fe/style');

    await fse.outputFile(path.join(dir, 'fe.style.md'), `${always}Body of fe/style\n`);
    expect(await (await rulesCheck(tool)).check()).toBe(true);
  });

  it('fails for a namespaced rule OMP gets no file for, as a root rule has its flat name (#946)', async () => {
    await writeTeamRule('fe/style');
    await writeTeamRule('fe.style');
    teamConfig.toolPaths = { omp: { rules: '.omp/agent/rules' } };
    const dir = path.join(homeDir, '.omp/agent/rules');
    for (const name of ['coding-style', 'reviews', 'fe.style']) {
      await fse.outputFile(path.join(dir, `${name}.md`), `---\nalwaysApply: true\n---\n\nBody of ${name}\n`);
    }

    const check = await rulesCheck('omp');
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('not written, as another team rule has its flat name: fe/style');
    expect(check.fix).toContain('rename one of them in the team repo');
  });

  it.each([
    ['omp', '.omp/agent/rules'],
    ['kiro', '.kiro/steering'],
  ])('reports %s collisions when every desired rule has the same flat filename', async (tool, rules) => {
    await fse.remove(path.join(repoPath, 'rules'));
    await writeTeamRule('fe.style/x');
    await writeTeamRule('fe/style.x');
    teamConfig.toolPaths = { [tool]: { rules } };
    await fse.ensureDir(path.join(homeDir, rules));

    const check = await rulesCheck(tool);
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('not written, as another team rule has its flat name');
    expect(check.fix).toContain('fe.style/x');
    expect(check.fix).toContain('fe/style.x');
    expect(check.fix).toContain('rename one of them in the team repo');

    localConfig.disabledAgents = [tool];
    expect((await checks()).some((c) => c.name === `Rules delivered to ${tool}`)).toBe(false);
    localConfig.disabledAgents = [];
    await fse.remove(path.join(homeDir, rules.split('/')[0]));
    expect((await checks()).some((c) => c.name === `Rules delivered to ${tool}`)).toBe(false);
  });

  it('checks a project\'s .joycode/rules against JoyCode\'s render, not Cursor\'s quoted one (#946)', async () => {
    const projectRoot = path.join(tempDir, 'project');
    Object.assign(localConfig, { scope: 'project', projectRoot });
    teamConfig.toolPaths = { joycode: { rules: '.joycode/rules' } };
    await writeTeamRule('reviews', '---\npaths:\n  - "src/**"\n  - "test/**"\n---\n');
    const dir = path.join(projectRoot, '.joycode/rules');
    await fse.outputFile(path.join(dir, 'coding-style.mdc'), '---\nalwaysApply: true\n---\n\nBody of coding-style\n');
    const reviews = path.join(dir, 'reviews.mdc');
    await fse.outputFile(reviews, '---\nglobs: src/**, test/**\nalwaysApply: false\n---\n\nBody of reviews\n');

    expect(await (await rulesCheck('joycode')).check()).toBe(true);

    // What teamai wrote before: JoyCode matches the quotes and never applies it.
    await fse.writeFile(reviews, '---\nglobs: "src/**, test/**"\nalwaysApply: false\n---\n\nBody of reviews\n');
    const check = await rulesCheck('joycode');
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain(dir);
    expect(check.fix).toContain('delivered from an older copy: reviews');
    expect(check.fix).toContain('`globs` or `alwaysApply`');
  });

  describe('CodeBuddy and WorkBuddy (#946)', () => {
    const ALWAYS = '---\nalwaysApply: true\n---\n\n';
    const defaults = TeamaiConfigSchema.parse({ team: 't', repo: 'owner/repo' }).toolPaths;

    async function deliverCodebuddy(dir: string): Promise<void> {
      for (const name of ['coding-style', 'reviews']) await fse.outputFile(path.join(dir, `${name}.md`), `${ALWAYS}Body of ${name}\n`);
    }

    beforeEach(() => {
      teamConfig.toolPaths = { codebuddy: defaults.codebuddy, workbuddy: defaults.workbuddy };
    });

    it('checks the shared project .codebuddy/rules once, naming both tools', async () => {
      const projectRoot = path.join(tempDir, 'project');
      Object.assign(localConfig, { scope: 'project', projectRoot });
      await fse.ensureDir(path.join(projectRoot, '.workbuddy'));
      await deliverCodebuddy(path.join(projectRoot, '.codebuddy/rules'));

      const rules = (await checks()).filter((c) => c.name.startsWith('Rules delivered to'));
      expect(rules.map((c) => c.name)).toEqual(['Rules delivered to codebuddy, workbuddy']);
      expect(await rules[0].check()).toBe(true);

      // A verbatim copy, as teamai wrote it before: CodeBuddy ignores its `paths:` form.
      await fse.writeFile(path.join(projectRoot, '.codebuddy/rules/reviews.md'), 'Body of reviews\n');
      const check = await rulesCheck('codebuddy, workbuddy');
      expect(await check.check()).toBe(false);
      expect(check.fix).toContain(path.join(projectRoot, '.codebuddy/rules'));
      expect(check.fix).toContain('delivered from an older copy: reviews');
      expect(check.fix).toContain('`alwaysApply` or `paths`');
    });

    it('checks WorkBuddy\'s user rules in ~/.workbuddy/rules', async () => {
      await fse.ensureDir(path.join(homeDir, '.codebuddy'));
      await deliverCodebuddy(path.join(homeDir, '.workbuddy/rules'));

      const workbuddy = await rulesCheck('workbuddy');
      expect(await workbuddy.check()).toBe(true);
      const codebuddy = await rulesCheck('codebuddy');
      expect(await codebuddy.check()).toBe(false);
      expect(codebuddy.fix).toContain(path.join(homeDir, '.codebuddy/rules'));
    });
  });

  it('passes a copy the member changed since teamai delivered it, which pull keeps (#822)', async () => {
    const edited = path.join(homeDir, CLAUDE_RULES, 'reviews.md');
    await fse.writeFile(edited, 'My own version\n');
    await deliverMdc('coding-style');
    await deliverMdc('reviews');
    const delivered = { [edited]: crypto.createHash('sha256').update('Body of reviews\n').digest('hex') };
    vi.mocked(loadStateForScope).mockResolvedValue(StateSchema.parse({
      lastPullByWorkspace: { [await checkoutKey(homeDir)]: { rev: 'r1', targets: [], delivered } },
    }));
    try {
      const withMissing = await rulesCheck('claude');
      expect(await withMissing.check()).toBe(false);
      expect(withMissing.fix).toContain('not delivered: coding-style; changed by you (kept by pull): reviews.');
      expect(withMissing.fix).not.toContain('delivered from an older copy: reviews');

      // Only the member's change is left: nothing is wrong with the delivery.
      await deliverPlain(CLAUDE_RULES, 'coding-style');
      expect(await (await rulesCheck('claude')).check()).toBe(true);
    } finally {
      vi.mocked(loadStateForScope).mockResolvedValue(StateSchema.parse({}));
    }
  });

  it('treats a plain .md rule as applicable without frontmatter', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');

    expect(await (await rulesCheck('claude')).check()).toBe(true);
  });

  it('fails when opencode.json does not reference the rules glob', async () => {
    // Every `.md` is delivered byte for byte and OpenCode reads none of them:
    // it does not scan a rules directory, so the files are inert until the
    // glob in `instructions` points at them.
    await installOpencode();
    await writeOpencodeConfig({ instructions: [] });
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');
    await deliverMdc('coding-style');
    await deliverMdc('reviews');

    expect(await (await rulesCheck('opencode')).check()).toBe(true);

    const active = await namedCheck('Team rules are active in opencode');
    expect(active).toBeDefined();
    expect(await active!.check()).toBe(false);
    expect(active!.fix).toContain('rules/*.md');
    expect(active!.fix).toContain('inert');
  });

  it('passes when opencode.json lists the rules glob beside the user\'s own', async () => {
    await installOpencode();
    await writeOpencodeConfig({ instructions: ['CONVENTIONS.md', `${path.join(homeDir, OPENCODE_RULES)}/*.md`] });

    expect(await (await namedCheck('Team rules are active in opencode'))!.check()).toBe(true);
  });

  it('fails on the relative rules/*.md an earlier release wrote, which loads the project\'s rules (#946)', async () => {
    await installOpencode();
    await writeOpencodeConfig({ instructions: ['rules/*.md', `${path.join(homeDir, OPENCODE_RULES)}/*.md`] });

    const active = await namedCheck('Team rules are active in opencode');
    expect(await active!.check()).toBe(false);
    expect(active!.fix).toContain('`rules/*.md`');
    expect(active!.fix).toContain('session');
  });

  it('does not flag a glob the member added for a directory that is no team namespace (#946)', async () => {
    await installOpencode();
    const root = path.join(homeDir, OPENCODE_RULES);
    await writeOpencodeConfig({ instructions: [`${root}/*.md`, `${root}/mine/*.md`] });

    expect(await (await namedCheck('Team rules are active in opencode'))!.check()).toBe(true);
  });

  it('fails until the directory of a namespaced rule has its own glob (#946)', async () => {
    await installOpencode();
    await writeTeamRule('fe/style');
    const root = path.join(homeDir, OPENCODE_RULES);
    await writeOpencodeConfig({ instructions: [`${root}/*.md`] });

    const active = await namedCheck('Team rules are active in opencode');
    expect(await active!.check()).toBe(false);
    expect(active!.fix).toContain(`\`${root}/fe/*.md\``);

    await writeOpencodeConfig({ instructions: [`${root}/*.md`, `${root}/fe/*.md`] });
    expect(await (await namedCheck('Team rules are active in opencode'))!.check()).toBe(true);
  });

  it('fails when opencode.json cannot be parsed, which is when the pull skipped it', async () => {
    await installOpencode();
    await writeOpencodeConfig('{ not json');

    const active = await namedCheck('Team rules are active in opencode');
    expect(await active!.check()).toBe(false);
    expect(active!.fix).toContain('could not be read');
    expect(active!.fix).toContain('Fix the file, then run `teamai pull`.');
  });

  it('checks .opencode/opencode.json in a project, not the root opencode.json (#946)', async () => {
    await installOpencode();
    const projectRoot = path.join(tempDir, 'project');
    await fse.ensureDir(path.join(projectRoot, '.opencode', 'rules'));
    Object.assign(localConfig, { scope: 'project', projectRoot });
    // Only the root file lists a glob, the one earlier releases wrote.
    await fse.writeJson(path.join(projectRoot, 'opencode.json'), { instructions: ['.opencode/rules/*.md'] });

    const active = await namedCheck('Team rules are active in opencode');
    expect(await active!.check()).toBe(false);
    // The file is missing, not broken: a plain pull writes it.
    expect(active!.fix).toContain(`${path.join(projectRoot, '.opencode', 'opencode.json')} does not list \`.opencode/rules/**/*.md\``);
    expect(active!.fix).not.toContain('could not be read');
    expect(active!.fix).toContain('Run `teamai pull`.');

    await fse.writeJson(path.join(projectRoot, '.opencode', 'opencode.json'), { instructions: ['.opencode/rules/**/*.md'] });
    expect(await (await namedCheck('Team rules are active in opencode'))!.check()).toBe(true);
  });

  it.each(['user', 'project'] as const)('reports stale OpenCode activation after the last %s rule is removed', async (scope) => {
    await installOpencode();
    let configFile = path.join(homeDir, OPENCODE_CONFIG);
    let glob = `${path.join(homeDir, OPENCODE_RULES)}/*.md`;
    if (scope === 'project') {
      const projectRoot = path.join(tempDir, 'project');
      Object.assign(localConfig, { scope, projectRoot });
      await fse.ensureDir(path.join(projectRoot, '.opencode', 'rules'));
      configFile = path.join(projectRoot, '.opencode', 'opencode.json');
      glob = '.opencode/rules/**/*.md';
    }
    await fse.remove(path.join(repoPath, 'rules'));
    await fse.writeJson(configFile, { instructions: ['CONVENTIONS.md', glob] });

    const active = await namedCheck('Team rules are active in opencode');
    expect(active).toBeDefined();
    expect(await active!.check()).toBe(false);
    expect(active!.fix).toContain(`\`${glob}\``);
    expect(active!.fix).toContain('Run `teamai pull`.');

    await fse.writeJson(configFile, { instructions: ['CONVENTIONS.md'] });
    expect(await namedCheck('Team rules are active in opencode')).toBeUndefined();
  });

  it('emits no opencode activation check while opencode is not installed here', async () => {
    expect(await namedCheck('Team rules are active in opencode')).toBeUndefined();
  });

  it('fails when the Hermes SOUL.md block is gone', async () => {
    // Hermes has no rules directory: its rules are the contents of a managed
    // block, so a deleted block is a tool reading none of the team's rules.
    const hermesHome = path.join(tempDir, 'hermes');
    await fse.ensureDir(hermesHome);
    vi.stubEnv('HERMES_HOME', hermesHome);
    await fse.writeFile(path.join(hermesHome, 'SOUL.md'), 'My own standing instructions\n');

    const soul = await namedCheck('Team rules are inlined in Hermes SOUL.md');
    expect(soul).toBeDefined();
    expect(await soul!.check()).toBe(false);
    expect(soul!.fix).toContain('carries no teamai rules block');
  });

  it('fails when the Hermes block holds a stale rule set', async () => {
    const hermesHome = path.join(tempDir, 'hermes');
    await fse.ensureDir(hermesHome);
    vi.stubEnv('HERMES_HOME', hermesHome);
    await fse.writeFile(
      path.join(hermesHome, 'SOUL.md'),
      '<!-- [teamai:rules:start] -->\nBody of coding-style\n<!-- [teamai:rules:end] -->\n',
    );

    const soul = await namedCheck('Team rules are inlined in Hermes SOUL.md');
    expect(await soul!.check()).toBe(false);
    expect(soul!.fix).toContain('not what the team rules inline to');
  });

  it('passes when the Hermes block holds every team rule body', async () => {
    const hermesHome = path.join(tempDir, 'hermes');
    await fse.ensureDir(hermesHome);
    vi.stubEnv('HERMES_HOME', hermesHome);
    await fse.writeFile(
      path.join(hermesHome, 'SOUL.md'),
      '<!-- [teamai:rules:start] -->\nBody of coding-style\n\nBody of reviews\n<!-- [teamai:rules:end] -->\n',
    );

    expect(await (await namedCheck('Team rules are inlined in Hermes SOUL.md'))!.check()).toBe(true);
  });

  it('passes when the Hermes block holds a path-scoped rule the way pull inlines it (#938)', async () => {
    await writeTeamRule('reviews', '---\npaths:\n  - "src/**"\n---\n');
    const hermesHome = path.join(tempDir, 'hermes');
    await fse.ensureDir(hermesHome);
    vi.stubEnv('HERMES_HOME', hermesHome);
    await fse.writeFile(
      path.join(hermesHome, 'SOUL.md'),
      '<!-- [teamai:rules:start] -->\nBody of coding-style\n\n'
        + 'Applies to files matching: src/**\nBody of reviews\n<!-- [teamai:rules:end] -->\n',
    );

    expect(await (await namedCheck('Team rules are inlined in Hermes SOUL.md'))!.check()).toBe(true);
  });

  it('emits no Hermes check while Hermes is not installed here', async () => {
    vi.stubEnv('HERMES_HOME', path.join(tempDir, 'no-hermes'));

    expect(await namedCheck('Team rules are inlined in Hermes SOUL.md')).toBeUndefined();
  });

  describe('Hermes in project scope (#946)', () => {
    beforeEach(async () => {
      const hermesHome = path.join(tempDir, 'hermes');
      await fse.ensureDir(hermesHome);
      vi.stubEnv('HERMES_HOME', hermesHome);
      // The block a user-scope pull wrote, which holds the user rules, not this project's.
      await fse.writeFile(path.join(hermesHome, 'SOUL.md'), '<!-- [teamai:rules:start] -->\nUser rule\n<!-- [teamai:rules:end] -->\n');
      Object.assign(localConfig, { scope: 'project', projectRoot: path.join(tempDir, 'project') });
    });

    it('does not compare SOUL.md with the project rules, which only a user-scope pull writes there', async () => {
      expect(await namedCheck('Team rules are inlined in Hermes SOUL.md')).toBeUndefined();
    });

    it('notes that Hermes gets no project rules, and why', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let report: DoctorReport;
      try {
        await doctor({ json: true });
        report = JSON.parse(String(spy.mock.calls.at(-1)?.[0])) as DoctorReport;
      } finally {
        spy.mockRestore();
      }
      const note = (report.notes ?? []).find((line) => line.startsWith('Hermes gets no project rules'));
      expect(note).toBeDefined();
      expect(note).toContain('.hermes.md');
      expect(note).toContain('pre_llm_call');
      expect(note).toContain('4,000');
    });
  });

  describe('Codex AGENTS.md, user scope (#938)', () => {
    const CODEX = 'Team rules are inlined in Codex AGENTS.md';
    // What pull writes for the two team rules, markers included.
    const CURRENT_BLOCK = '<!-- [teamai:team-rules:start] -->\n'
      + '<!-- DO NOT EDIT: This section is auto-managed by teamai -->\n\n'
      + 'Body of coding-style\n\nBody of reviews\n\n'
      + '<!-- [teamai:team-rules:end] -->';
    const CODEX_FAMILY = ['codex', 'codex-internal', 'tcodex'];
    let agentsMd: string;

    /** A Codex-family tool's default-shaped entry, installed in this (user) scope in place of Codex. */
    async function installCodex(tool = 'codex'): Promise<void> {
      delete teamConfig.toolPaths.codex;
      teamConfig.toolPaths[tool] = {
        skills: `.${tool}/skills`,
        settings: `.${tool}/hooks.json`,
        agents: `.${tool}/agents`,
        userScope: { claudemd: `.${tool}/AGENTS.md` },
      };
      await fse.ensureDir(path.join(homeDir, `.${tool}`));
      agentsMd = path.join(homeDir, `.${tool}`, 'AGENTS.md');
    }

    const checkNameFor = (tool: string) => (tool === 'codex' ? CODEX : `${CODEX} (${tool})`);

    beforeEach(() => installCodex());

    it('passes when AGENTS.md holds the block pull writes, beside the member\'s own text', async () => {
      await fse.writeFile(agentsMd, `My own instructions\n\n${CURRENT_BLOCK}\n`);

      const check = await namedCheck(CODEX);
      expect(check).toBeDefined();
      expect(await check!.check()).toBe(true);
    });

    it.each(CODEX_FAMILY)('fails for %s when AGENTS.md carries no block, naming the file and the fix', async (tool) => {
      await installCodex(tool);
      await fse.writeFile(agentsMd, 'My own instructions\n');

      const check = (await namedCheck(checkNameFor(tool)))!;
      expect(await check.check()).toBe(false);
      expect(check.fix).toContain(agentsMd);
      expect(check.fix).toContain('carries no team-rules block');
      // An already-synced pull restores the block too (#938).
      expect(check.fix).toContain('Run `teamai pull` to restore it.');
      expect(check.fix).not.toContain('--force');
    });

    it('passes without a block when every team rule is frontmatter only, since pull writes none', async () => {
      for (const name of ['coding-style', 'reviews']) {
        await fse.writeFile(path.join(repoPath, 'rules', `${name}.md`), '---\npaths:\n  - "src/**"\n---\n');
      }
      await fse.writeFile(agentsMd, 'My own instructions\n');

      const check = (await namedCheck(CODEX))!;
      expect(await check.check()).toBe(true);
    });

    it('fails when the team has no rules left but AGENTS.md still carries a block', async () => {
      await fse.remove(path.join(repoPath, 'rules'));
      await fse.writeFile(agentsMd, `My own instructions\n\n${CURRENT_BLOCK}\n`);

      const check = (await namedCheck(CODEX))!;
      expect(check).toBeDefined();
      expect(await check.check()).toBe(false);
      expect(check.fix).toContain(agentsMd);
    });

    it('adds no Codex check when the team has no rules and AGENTS.md carries no block', async () => {
      await fse.remove(path.join(repoPath, 'rules'));
      await fse.writeFile(agentsMd, 'My own instructions\n');

      expect(await namedCheck(CODEX)).toBeUndefined();
    });

    it.each(CODEX_FAMILY)('fails for %s when the block holds a stale rule set', async (tool) => {
      await installCodex(tool);
      await fse.writeFile(agentsMd, CURRENT_BLOCK.replace('\n\nBody of reviews', '') + '\n');

      const check = (await namedCheck(checkNameFor(tool)))!;
      expect(await check.check()).toBe(false);
      expect(check.fix).toContain(agentsMd);
      expect(check.fix).toContain('not what the team rules inline to');
      expect(check.fix).toContain('Run `teamai pull` to rewrite it.');
      expect(check.fix).not.toContain('--force');
    });

    it.each(CODEX_FAMILY)('fails for %s on a current block when AGENTS.override.md sits beside it, which Codex reads instead', async (tool) => {
      await installCodex(tool);
      await fse.writeFile(agentsMd, `${CURRENT_BLOCK}\n`);
      const override = path.join(homeDir, `.${tool}`, 'AGENTS.override.md');
      await fse.writeFile(override, 'Local override\n');

      const check = (await namedCheck(checkNameFor(tool)))!;
      expect(await check.check()).toBe(false);
      expect(check.fix).toContain(override);
      expect(check.fix).toContain('instead of');
      expect(check.fix).toContain('Move its content into AGENTS.md, or delete it');
    });

    it.each(CODEX_FAMILY)('fails when a team toolPaths entry gives an installed %s no instructions file', async (tool) => {
      await installCodex(tool);
      // A team teamai.yaml written against the 0.22.0 defaults.
      teamConfig.toolPaths[tool] = { skills: `.${tool}/skills`, rules: `.${tool}/rules`, settings: `.${tool}/hooks.json` };

      const check = await namedCheck(checkNameFor(tool));
      expect(check).toBeDefined();
      expect(await check!.check()).toBe(false);
      expect(check!.fix).toContain('has no `claudemd` path');
      // A project-scope `claudemd` would put the blocks back in the shared AGENTS.md (#945).
      expect(check!.fix).not.toContain('`claudemd: AGENTS.md`');
      expect(check!.fix).toContain(`\`userScope.claudemd: .${tool}/AGENTS.md\``);
      // A teamai.yaml edit moves the team repo, so a plain pull syncs it.
      expect(check!.fix).toContain('then run `teamai pull`.');
      expect(check!.fix).not.toContain('--force');
    });

    it('no longer reports rule files delivered to codex', async () => {
      await fse.writeFile(agentsMd, `${CURRENT_BLOCK}\n`);
      await deliverPlain(CLAUDE_RULES, 'coding-style');

      const names = (await checks()).map((c) => c.name);
      expect(names).toContain('Rules delivered to claude');
      expect(names).toContain(CODEX);
      expect(names).not.toContain('Rules delivered to codex');
    });

    it('asks nothing of a Codex that is not installed, and creates nothing', async () => {
      await fse.remove(path.join(homeDir, '.codex'));

      expect(await namedCheck(CODEX)).toBeUndefined();
      expect(await fse.pathExists(path.join(homeDir, '.codex'))).toBe(false);
    });

    it('asks nothing of a Codex the member disabled', async () => {
      localConfig.disabledAgents = ['codex'];

      expect(await namedCheck(CODEX)).toBeUndefined();
    });

    it.each(['codex', 'codex-internal', 'tcodex'])('passes for the default %s entry when its AGENTS.md holds the block', async (tool) => {
      teamConfig.toolPaths = { [tool]: TeamaiConfigSchema.parse({ team: 't', repo: 'owner/repo' }).toolPaths[tool] };
      await fse.ensureDir(path.join(homeDir, `.${tool}`));
      await fse.writeFile(path.join(homeDir, `.${tool}`, 'AGENTS.md'), `${CURRENT_BLOCK}\n`);

      const codex = (await checks()).filter((c) => c.name.startsWith(CODEX));
      expect(codex.map((c) => c.name)).toEqual([tool === 'codex' ? CODEX : `${CODEX} (${tool})`]);
      expect(await codex[0].check()).toBe(true);
    });

    // A team entry replaces the default whole; `{ skills }` leaves its root
    // as the only sign Codex is installed.
    it('asks nothing of a team codex entry with only skills on a machine without .codex/', async () => {
      await fse.remove(path.join(homeDir, '.codex'));
      teamConfig.toolPaths.codex = { skills: '.codex/skills' };

      expect(await namedCheck(CODEX)).toBeUndefined();
      expect(await fse.pathExists(path.join(homeDir, '.codex'))).toBe(false);
    });

    // An entry with neither `rules` nor `claudemd` delivers no rules to Codex
    // on purpose, like any tool without a rules path: nothing to check.
    it.each([
      ['only skills', { skills: '.codex/skills' }],
      ['only agents', { agents: '.codex/agents' }],
    ])('asks nothing of a team codex entry with %s once .codex/ exists, since it delivers no rules to Codex', async (_label, entry) => {
      teamConfig.toolPaths.codex = entry;

      expect(await namedCheck(CODEX)).toBeUndefined();
    });

    it('asks nothing of the project AGENTS.md, since the session-start hook gives Codex the project\'s rules', async () => {
      const projectRoot = path.join(tempDir, 'project');
      await fse.ensureDir(path.join(projectRoot, '.codex'));
      Object.assign(localConfig, { scope: 'project', projectRoot });
      teamConfig.toolPaths = { ...teamConfig.toolPaths, codex: TeamaiConfigSchema.parse({ team: 't', repo: 'owner/repo' }).toolPaths.codex };
      await fse.writeFile(path.join(projectRoot, 'AGENTS.md'), 'My own instructions\n');

      expect((await checks()).filter((c) => c.name.startsWith(CODEX))).toEqual([]);
    });
  });

  it('emits no check for a tool configured without a rules path', async () => {
    teamConfig.toolPaths = { claude: { rules: CLAUDE_RULES }, codex: { skills: '.codex/skills' } };
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');

    const names = (await checks()).map((c) => c.name);
    expect(names).toContain('Rules delivered to claude');
    expect(names).not.toContain('Rules delivered to codex');
  });

  it('emits no check for a tool the member disabled', async () => {
    localConfig.disabledAgents = ['cursor'];
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');

    const names = (await checks()).map((c) => c.name);
    expect(names).not.toContain('Rules delivered to cursor');
  });

  it('emits no check at all when the team repo ships no rules', async () => {
    await fse.remove(path.join(repoPath, 'rules'));

    const names = (await checks()).map((c) => c.name);
    expect(names.filter((n) => n.startsWith('Rules delivered to'))).toEqual([]);
  });

  it('resolves a namespaced rule to its nested destination', async () => {
    await writeTeamRule('frontend/scoped');
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');
    await deliverPlain(CLAUDE_RULES, 'frontend/scoped');
    await deliverMdc('coding-style');
    await deliverMdc('reviews');

    expect(await (await rulesCheck('claude')).check()).toBe(true);

    const cursor = await rulesCheck('cursor');
    expect(await cursor.check()).toBe(false);
    expect(cursor.fix).toContain('not delivered: frontend/scoped');
  });

  it('leaves the rules and agents checks out of the post-pull stage', async () => {
    await fse.ensureDir(path.join(repoPath, 'agents'));
    await fse.writeFile(
      path.join(repoPath, 'agents', 'reviewer.yaml'),
      'name: reviewer\ndescription: reviews\ninstructions: |\n  Review.\n',
    );
    teamConfig.toolPaths.claude = { rules: CLAUDE_RULES, agents: '.claude/agents' };
    await fse.ensureDir(path.join(homeDir, '.claude/agents'));

    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');

    const forDoctor = (await buildChecks(ctx, 'doctor')).map((c) => c.name);
    const forPull = (await buildChecks(ctx, 'pull')).map((c) => c.name);

    expect(forDoctor.filter((n) => !forPull.includes(n)).sort()).toEqual([
      'Agents delivered to claude',
      'No team instruction blocks are left in files no tool loads them from',
      'Rules delivered to claude',
      'Rules delivered to cursor',
      'Team instructions are current for cursor',
    ]);
    // Everything the pull stage keeps is also in the doctor stage.
    expect(forPull.filter((n) => !forDoctor.includes(n))).toEqual([]);
  });

  it('never writes to the tool directory it inspects', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');

    const before = (await fse.readdir(path.join(homeDir, CURSOR_RULES))).sort();
    await (await rulesCheck('cursor')).check();
    const after = (await fse.readdir(path.join(homeDir, CURSOR_RULES))).sort();

    expect(after).toEqual(before);
  });
});
