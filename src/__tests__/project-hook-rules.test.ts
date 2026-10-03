import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
}));

import { buildHandlerRegistry } from '../hook-handlers.js';
import { RulesHandler, ruleChannelNotes } from '../resources/rules.js';
import { buildChecks, resolveDoctorContext } from '../doctor.js';
import { detectProjectConfig } from '../config.js';
import { reconcileHooks } from '../hooks.js';
import { reconcileDshHooks, resolveDshHookConfigPath, resolveDshPatchPath } from '../dsh-hooks.js';
import { injectPiHooks } from '../pi-hooks.js';
import { TeamaiConfigSchema } from '../types.js';
import type { LocalConfig } from '../types.js';

/**
 * #946: in a project, ZCode and DeepSeek Harness get the project's team rules
 * from their session-start hook, and Pi from teamai's extension, which adds
 * what `hook-dispatch instructions` returns to each run's system prompt. In
 * user scope the rules are a block in a file only each reads, so neither
 * channel adds any there.
 */

const PROJECT_RULE = 'The project codeword is PROJ-RULE-7.\n';
const SCOPED = '---\npaths:\n  - "src/**"\n---\nPrefer named exports.\n';
const USER_RULE = 'The personal codeword is USER-RULE-3.\n';

let tmpDir: string;
let homeDir: string;
let repoPath: string;
let userRepo: string;
let projectRoot: string;

function config(scope: 'user' | 'project', enabledAgents?: string[]): LocalConfig {
  return {
    repo: { localPath: scope === 'project' ? repoPath : userRepo, remote: 'https://example.invalid/x/team.git' },
    username: 'u',
    additionalRoles: [],
    scope,
    ...(scope === 'project' ? { projectRoot } : {}),
    ...(enabledAgents ? { enabledAgents } : {}),
  } as unknown as LocalConfig;
}

/** What the handler registered for `event` named `name` adds to the session, or null. */
async function context(event: string, name: string, tool: string, localConfig: LocalConfig, stdin: Record<string, unknown> = {}): Promise<string | null> {
  const registration = buildHandlerRegistry().find((r) => r.event === event && r.handler.name === name);
  if (!registration) throw new Error(`no ${name} handler on ${event}`);
  const output = await registration.handler.execute({ cwd: projectRoot, ...stdin }, tool, localConfig);
  if (output === null) return null;
  const parsed = JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  return parsed.hookSpecificOutput.additionalContext;
}

const sessionStart = (tool: string, localConfig: LocalConfig, source = 'startup') =>
  context('session-start', 'team-rules', tool, localConfig, { hook_event_name: 'SessionStart', source });
const piInstructions = (localConfig: LocalConfig) => context('instructions', 'instructions', 'pi', localConfig);

const count = (text: string | null, needle: string) => (text ?? '').split(needle).length - 1;

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-project-hook-rules-'));
  homeDir = path.join(tmpDir, 'home');
  projectRoot = path.join(tmpDir, 'project');
  repoPath = path.join(tmpDir, 'team-repo');
  userRepo = path.join(tmpDir, 'user-team-repo');
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('DSH_HOME', '');
  await fse.outputFile(path.join(repoPath, 'teamai.yaml'), 'team: test\nrepo: https://example.invalid/x/team.git\n');
  await fse.outputFile(path.join(repoPath, 'rules', 'codeword.md'), PROJECT_RULE);
  await fse.outputFile(path.join(repoPath, 'rules', 'scoped.md'), SCOPED);
  await fse.outputFile(path.join(userRepo, 'teamai.yaml'), 'team: personal\nrepo: https://example.invalid/x/personal.git\n');
  await fse.outputFile(path.join(userRepo, 'rules', 'personal.md'), USER_RULE);
  await fse.ensureDir(projectRoot);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fse.remove(tmpDir);
});

describe('ZCode and DeepSeek Harness get the project\'s rules from their session-start hook (#946)', () => {
  it.each(['zcode', 'dsh'])('%s: adds the project rules once at session start, a path-scoped rule after its globs', async (tool) => {
    const text = await sessionStart(tool, config('project'));

    expect(count(text, 'PROJ-RULE-7')).toBe(1);
    expect(text).toContain('Applies to files matching: src/**\nPrefer named exports.');
    expect(text).not.toContain('paths:');
  });

  it.each(['zcode', 'dsh'])('%s: adds nothing in a session outside a project, whose rules are in its own AGENTS.md', async (tool) => {
    expect(await sessionStart(tool, config('user'))).toBeNull();
  });

  it.each(['zcode', 'dsh'])('%s: adds nothing on resume, whose history already holds them', async (tool) => {
    expect(await sessionStart(tool, config('project'), 'resume')).toBeNull();
  });

  it.each(['zcode', 'dsh'])('%s: adds nothing once the project excludes it', async (tool) => {
    expect(await sessionStart(tool, config('project', ['claude']))).toBeNull();
  });

  it.each(['zcode', 'dsh'])('%s: adds the rules only, not the instruction blocks, which #945 gives it no channel for', async (tool) => {
    await fse.outputFile(path.join(repoPath, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n');

    const text = await sessionStart(tool, config('project'));

    expect(text).toContain('PROJ-RULE-7');
    expect(text).not.toContain('Be kind to teammates.');
  });
});

describe('Pi gets the project\'s rules from teamai\'s extension, beside the instruction blocks (#946)', () => {
  it('adds the project rules once, a path-scoped rule after its globs, after the instruction blocks', async () => {
    await fse.outputFile(path.join(repoPath, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n');

    const text = (await piInstructions(config('project')))!;

    expect(count(text, 'PROJ-RULE-7')).toBe(1);
    expect(text).toContain('Applies to files matching: src/**\nPrefer named exports.');
    expect(text.indexOf('Be kind to teammates.')).toBeLessThan(text.indexOf('PROJ-RULE-7'));
  });

  it('adds the project rules when the project has no instruction blocks', async () => {
    expect(count(await piInstructions(config('project')), 'PROJ-RULE-7')).toBe(1);
  });

  it('adds nothing in a session outside a project, whose rules are in ~/.pi/agent/AGENTS.md', async () => {
    expect(await piInstructions(config('user'))).toBeNull();
  });

  it('adds nothing once the project excludes Pi', async () => {
    expect(await piInstructions(config('project', ['claude']))).toBeNull();
  });

  it('adds no rules at session start, whose output Pi\'s extension does not read', async () => {
    expect(await sessionStart('pi', config('project'))).toBeNull();
  });
});

describe('OMP and Hermes get no rules through their extension or plugin (#946)', () => {
  it.each(['omp', 'hermes'])('%s: the instructions text carries no team rules', async (tool) => {
    await fse.outputFile(path.join(repoPath, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n');

    const text = await context('instructions', 'instructions', tool, config('project'));

    expect(text).toContain('Be kind to teammates.');
    expect(text).not.toContain('PROJ-RULE-7');
  });
});

describe('with teamai in both scopes, each rule reaches the tool once (#946)', () => {
  /** The file each tool reads its user rules from, and the home dir that says it is installed. */
  const TOOLS = [
    { tool: 'zcode', root: '.zcode', file: '.zcode/AGENTS.md', project: (cfg: LocalConfig) => sessionStart('zcode', cfg) },
    { tool: 'dsh', root: '.dsh', file: '.dsh/AGENTS.md', project: (cfg: LocalConfig) => sessionStart('dsh', cfg) },
    { tool: 'pi', root: '.pi/agent', file: '.pi/agent/AGENTS.md', project: piInstructions },
  ];
  const teamConfig = () => TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' });

  it.each(TOOLS)('$tool: the user rules from ~/$file only, the project rules from its project channel only', async ({ tool, root, file, project }) => {
    await fse.ensureDir(path.join(homeDir, root));
    await fse.ensureDir(path.join(projectRoot, root.split('/')[0]));
    await new RulesHandler().pullAllRules(teamConfig(), config('user', [tool]));
    await new RulesHandler().pullAllRules(teamConfig(), config('project', [tool]));

    const userFile = await fse.readFile(path.join(homeDir, file), 'utf8');
    const hook = await project(config('project', [tool]));
    // Pi rebuilds its prompt every run and fetches this text once per session,
    // so a second run gets the same text again, not a second copy.
    const secondRun = await project(config('project', [tool]));

    expect(count(userFile, 'USER-RULE-3')).toBe(1);
    expect(count(hook, 'USER-RULE-3')).toBe(0);
    expect(count(hook, 'PROJ-RULE-7')).toBe(1);
    expect(count(userFile, 'PROJ-RULE-7')).toBe(0);
    expect(secondRun).toBe(hook);
  });

  it('a project pull writes Pi no rule copies, which it would never read', async () => {
    await fse.ensureDir(path.join(projectRoot, '.pi'));

    await new RulesHandler().pullAllRules(teamConfig(), config('project', ['pi']));

    expect(await fse.pathExists(path.join(projectRoot, '.pi', 'rules'))).toBe(false);
  });
});

describe('doctor checks the hook or extension that adds the project rules (#946)', () => {
  const zcodeConfig = () => path.join(homeDir, '.zcode', 'cli', 'config.json');

  async function checks(enabled: string[]) {
    vi.mocked(detectProjectConfig).mockResolvedValue(config('project', enabled));
    try {
      const ctx = await resolveDoctorContext();
      if (!ctx) throw new Error('expected a resolved doctor context');
      return await buildChecks(ctx);
    } finally {
      vi.mocked(detectProjectConfig).mockResolvedValue(null);
    }
  }
  const find = async (enabled: string[], name: string) => (await checks(enabled)).find((c) => c.name === name);

  const ZCODE = 'Project rules reach zcode through its SessionStart hook';
  const DSH = 'Project rules reach dsh through its session-start hook';
  const PI = 'pi adds the team instructions and rules to its prompt';

  it('zcode: passes once teamai\'s SessionStart hook is in ~/.zcode/cli/config.json and hooks are on', async () => {
    await reconcileHooks(zcodeConfig(), 'zcode');

    expect(await (await find(['zcode'], ZCODE))!.check()).toBe(true);
  });

  it('zcode: is not held to the Codex hook limit, which ZCode has no field for', async () => {
    await reconcileHooks(zcodeConfig(), 'zcode');

    const names = (await checks(['zcode'])).map((c) => c.name);
    expect(names).toContain(ZCODE);
    expect(names.filter((name) => name.includes('whole through its session hooks'))).toEqual([]);
  });

  it('zcode: fails while ZCode\'s config-file hooks are off, naming the file and the switch', async () => {
    await reconcileHooks(zcodeConfig(), 'zcode');
    const cfg = await fse.readJson(zcodeConfig());
    await fse.writeJson(zcodeConfig(), { ...cfg, hooks: { ...cfg.hooks, enabled: false } });

    const failing = (await find(['zcode'], ZCODE))!;
    expect(await failing.check()).toBe(false);
    expect(failing.fix).toContain(zcodeConfig());
    expect(failing.fix).toContain('hooks.enabled');
    expect(failing.fix).toContain('teamai hooks inject');
    expect(failing.fix).not.toContain('--force');
  });

  it('zcode: fails naming the parse error when ~/.zcode/cli/config.json is not JSON, not as a missing hook', async () => {
    await fse.outputFile(zcodeConfig(), '{ "hooks": { "enabled": true, ');

    const failing = (await find(['zcode'], ZCODE))!;
    expect(await failing.check()).toBe(false);
    expect(failing.fix).toContain(`${zcodeConfig()} is not valid JSON (`);
    expect(failing.fix).not.toContain('has no teamai SessionStart hook');
  });

  it('zcode: fails when the SessionStart hook is missing', async () => {
    await fse.outputJson(zcodeConfig(), { hooks: { enabled: true, events: {} } });

    expect(await (await find(['zcode'], ZCODE))!.check()).toBe(false);
  });

  it('dsh: passes once the hook config and the patch are written', async () => {
    await fse.ensureDir(path.join(homeDir, '.dsh'));
    await reconcileDshHooks([], {});

    const passing = (await find(['dsh'], DSH))!;
    expect(await passing.check()).toBe(true);
  });

  it('dsh: is checked where $DSH_HOME says dsh lives, as pull finds it', async () => {
    const dshHome = path.join(tmpDir, 'dsh-home');
    await fse.ensureDir(dshHome);
    vi.stubEnv('DSH_HOME', dshHome);

    const failing = (await find(['dsh'], DSH))!;
    expect(await failing.check()).toBe(false);
    expect(failing.fix).toContain(resolveDshPatchPath());
  });

  it('dsh: names both files when both are missing', async () => {
    await fse.ensureDir(path.join(homeDir, '.dsh'));

    const failing = (await find(['dsh'], DSH))!;
    expect(failing.fix).toContain(resolveDshPatchPath());
    expect(failing.fix).toContain(resolveDshHookConfigPath());
  });

  it('dsh: fails when the patch is gone, naming it and the --patch flag', async () => {
    await fse.ensureDir(path.join(homeDir, '.dsh'));
    await reconcileDshHooks([], {});
    await fse.remove(resolveDshPatchPath());

    const failing = (await find(['dsh'], DSH))!;
    expect(await failing.check()).toBe(false);
    expect(failing.fix).toContain(resolveDshPatchPath());
    expect(failing.fix).toContain('--patch');
    expect(failing.fix).toContain('teamai hooks inject');
  });

  it('pi: fails while teamai\'s extension is missing, naming the rules, and passes once it is installed', async () => {
    await fse.ensureDir(path.join(homeDir, '.pi', 'agent'));
    await fse.ensureDir(path.join(projectRoot, '.pi'));

    const failing = (await find(['pi'], PI))!;
    expect(await failing.check()).toBe(false);
    expect(failing.fix).toContain('get no team instructions or rules');

    await injectPiHooks();
    expect(await (await find(['pi'], PI))!.check()).toBe(true);
  });

  it('asks nothing of a tool that is not installed, or that the project excludes', async () => {
    const names = (await checks(['claude'])).map((c) => c.name);
    expect(names).not.toContain(ZCODE);
    expect(names).not.toContain(DSH);

    const uninstalled = (await checks(['zcode', 'dsh'])).map((c) => c.name);
    expect(uninstalled).not.toContain(ZCODE);
    expect(uninstalled).not.toContain(DSH);
  });

  it('asks nothing of these hooks in user scope, where the rules are in a file', async () => {
    await reconcileHooks(zcodeConfig(), 'zcode');
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    await fse.outputFile(
      path.join(homeDir, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${userRepo}\n  remote: https://example.invalid/x/personal.git\nusername: u\nenabledAgents: [zcode]\n`,
    );
    const ctx = (await resolveDoctorContext())!;

    expect((await buildChecks(ctx)).map((c) => c.name)).not.toContain(ZCODE);
  });
});

describe('init and doctor name the limits of the project hooks (#946)', () => {
  it('notes that ZCode drops the hook text at compaction', async () => {
    await fse.ensureDir(path.join(homeDir, '.zcode'));

    const notes = await ruleChannelNotes(config('project', ['zcode']));

    expect(notes.some((note) => note.startsWith('ZCode') && note.includes('compact'))).toBe(true);
  });

  it('notes that DeepSeek Harness needs the patch, can miss the first request, and drops the text at compaction', async () => {
    await fse.ensureDir(path.join(homeDir, '.dsh'));

    const note = (await ruleChannelNotes(config('project', ['dsh']))).find((n) => n.startsWith('DeepSeek Harness'));

    expect(note).toContain(`--patch "${resolveDshPatchPath()}"`);
    expect(note).toContain('first request');
    expect(note).toContain('compact');
  });

  it('notes DeepSeek Harness where $DSH_HOME says it lives', async () => {
    const dshHome = path.join(tmpDir, 'dsh-home');
    await fse.ensureDir(dshHome);
    vi.stubEnv('DSH_HOME', dshHome);

    expect((await ruleChannelNotes(config('project', ['dsh']))).some((n) => n.startsWith('DeepSeek Harness'))).toBe(true);
  });

  it.each([
    ['in user scope', 'user' as const, ['zcode', 'dsh'], true],
    ['when they are excluded', 'project' as const, ['claude'], true],
    ['when they are not installed', 'project' as const, ['zcode', 'dsh'], false],
  ])('says nothing %s', async (_label, scope, enabled, installed) => {
    if (installed) {
      await fse.ensureDir(path.join(homeDir, '.zcode'));
      await fse.ensureDir(path.join(homeDir, '.dsh'));
    }

    const notes = await ruleChannelNotes(config(scope, enabled));

    expect(notes.some((note) => note.startsWith('ZCode') || note.startsWith('DeepSeek Harness'))).toBe(false);
  });
});
