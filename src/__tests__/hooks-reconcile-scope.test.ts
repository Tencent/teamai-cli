import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { reconcileTeamHooksForConfig } from '../hooks.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

let project: string;
let repo: string;
let home: string;

const teamConfig = {
  toolPaths: {
    claude: { settings: '.claude/settings.json' },
    cursor: { settings: '.cursor/hooks.json' },
    codex: { settings: '.codex/hooks.json' },
  },
} as unknown as TeamaiConfig;

function localConfig(): LocalConfig {
  return {
    repo: { localPath: repo, remote: 'x' },
    username: 'u',
    scope: 'project',
    projectRoot: project,
    additionalRoles: [],
  } as unknown as LocalConfig;
}

async function writeYaml(content: string): Promise<void> {
  await fse.ensureDir(path.join(repo, 'hooks'));
  await fse.writeFile(path.join(repo, 'hooks', 'hooks.yaml'), content);
}
// Non-self project scope injects into HOME (#264 / the init↔inject unification):
// ~/.claude always exists so the "installed tool" gate passes, and the dispatch
// runtime resolves the active project by cwd — so settings live under HOME, not
// <projectRoot>. These readers therefore all read from `home`.
function claudeSettings(): Promise<{ hooks: Record<string, Array<{ description?: string; hooks: Array<{ command: string }> }>> }> {
  return fse.readJson(path.join(home, '.claude', 'settings.json'));
}
function cursorSettings(): Promise<{ hooks: Record<string, Array<{ command: string }>> }> {
  return fse.readJson(path.join(home, '.cursor', 'hooks.json'));
}
function codexSettings(): Promise<{ hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>> }> {
  return fse.readJson(path.join(home, '.codex', 'hooks.json'));
}
function manifest(): Promise<Record<string, Array<{ id: string }>>> {
  return fse.readJson(path.join(home, '.teamai', 'managed-hooks.json'));
}

beforeEach(async () => {
  project = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-proj-'));
  repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-repo-'));
  home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-home-'));
  // Point HOME at the sandbox so the non-self project scope resolves its hook
  // base dir to this dir rather than the developer's real home.
  vi.stubEnv('HOME', home);
  // Pre-create the tool root dirs under HOME so they are detected as installed.
  await fse.ensureDir(path.join(home, '.claude'));
  await fse.ensureDir(path.join(home, '.cursor'));
  await fse.ensureDir(path.join(home, '.codex'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fse.remove(project);
  await fse.remove(repo);
  await fse.remove(home);
});

describe('reconcileTeamHooksForConfig — pull/init core path', () => {
  it('injects built-in + team hooks into each tool, records the manifest', async () => {
    await writeYaml(`
hooks:
  - id: lint
    description: run lint at stop
    event: Stop
    command: npm run lint
    timeout: 20
`);
    const defs = await reconcileTeamHooksForConfig(teamConfig, localConfig());
    expect(defs).toHaveLength(1);

    const claude = await claudeSettings();
    expect(claude.hooks.Stop).toHaveLength(2); // built-in + team
    expect(claude.hooks.Stop[1].description).toBe('[teamai:hook:lint] run lint at stop');

    const cursor = await cursorSettings();
    expect(cursor.hooks.stop).toHaveLength(2);
    expect(cursor.hooks.stop.some((h) => h.command.includes('npm run lint'))).toBe(true);

    const codex = await codexSettings();
    expect(codex.hooks.Stop).toHaveLength(2);
    expect(codex.hooks.Stop.some((h) => h.hooks[0].command.includes('npm run lint'))).toBe(true);

    const m = await manifest();
    expect(m.claude.map((r) => r.id)).toEqual(['lint']);
    expect(m.cursor.map((r) => r.id)).toEqual(['lint']);
    expect(m.codex.map((r) => r.id)).toEqual(['lint']);
  });

  it('keeps project team hooks isolated when projects share HOME', async () => {
    await writeYaml(`
hooks:
  - id: project-a
    description: project a
    event: Stop
    command: echo project-a
`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    const projectB = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-proj-b-'));
    const repoB = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-repo-b-'));
    try {
      await fse.ensureDir(path.join(repoB, 'hooks'));
      await fse.writeFile(path.join(repoB, 'hooks', 'hooks.yaml'), `
hooks:
  - id: project-b
    description: project b
    event: Stop
    command: echo project-b
`);
      const configB = {
        repo: { localPath: repoB, remote: 'x' }, username: 'b', scope: 'project',
        projectRoot: projectB, additionalRoles: [],
      } as unknown as LocalConfig;
      await fse.ensureDir(path.join(projectB, '.claude'));
      await reconcileTeamHooksForConfig(teamConfig, configB);

      const claude = await claudeSettings();
      const teamCommands = claude.hooks.Stop
        .filter((entry) => entry.description?.startsWith('[teamai:hook:'))
        .map((entry) => entry.hooks[0].command);
      expect(teamCommands).toHaveLength(2);
      expect(teamCommands.some((command) => command.includes("echo project-a") && command.includes(project))).toBe(true);
      expect(teamCommands.some((command) => command.includes("echo project-b") && command.includes(projectB))).toBe(true);

      const m = await manifest();
      expect(m.claude).toHaveLength(2);
    } finally {
      await fse.remove(projectB);
      await fse.remove(repoB);
    }
  });

  it('applies hooks.yaml edits on the next reconcile (add/remove), built-in untouched', async () => {
    await writeYaml(`
hooks:
  - id: lint
    description: lint
    event: Stop
    command: npm run lint
`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    // Remove the team hook from the yaml and reconcile again.
    await writeYaml('hooks: []');
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    const claude = await claudeSettings();
    expect(claude.hooks.Stop).toHaveLength(1); // built-in only
    expect(claude.hooks.Stop[0].description?.startsWith('[teamai] ')).toBe(true);

    const cursor = await cursorSettings();
    expect(cursor.hooks.stop.some((h) => h.command === 'npm run lint')).toBe(false);
    expect(cursor.hooks.stop).toHaveLength(1);

    const codex = await codexSettings();
    expect(codex.hooks.Stop.some((h) => h.hooks[0].command === 'npm run lint')).toBe(false);
    expect(codex.hooks.Stop).toHaveLength(1);

    const m = await manifest();
    expect(m.claude).toBeUndefined();
    expect(m.cursor).toBeUndefined();
    expect(m.codex).toBeUndefined();
  });

  it('a role switch removes the previous role\'s hooks and adds the new role\'s, built-in untouched', async () => {
    await fse.ensureDir(path.join(repo, 'manifest'));
    await fse.writeFile(path.join(repo, 'manifest', 'roles.yaml'), `
version: 1
roles:
  - id: frontend
    description: Frontend
    resources: { knowledge: [common], skills: [common] }
  - id: devops
    description: DevOps
    resources: { knowledge: [common], skills: [common] }
`);
    await writeYaml(`
hooks:
  - id: stylelint
    description: frontend only
    event: Stop
    command: npm run lint:css
    roles: [frontend]
  - id: guard-tf
    description: devops only
    event: Stop
    command: guard-tf.sh
    roles: [devops]
`);
    const asRole = (role: string): LocalConfig => ({ ...localConfig(), primaryRole: role, additionalRoles: [] });

    // Project scope wraps team commands in a $PWD guard, so match by inclusion.
    const stopCommands = async (): Promise<string[]> => (await claudeSettings()).hooks.Stop.map((h) => h.hooks[0].command);

    await reconcileTeamHooksForConfig(teamConfig, asRole('frontend'));
    expect((await stopCommands()).some((c) => c.includes('npm run lint:css'))).toBe(true);
    expect((await stopCommands()).some((c) => c.includes('guard-tf.sh'))).toBe(false);
    expect((await manifest()).claude.map((r) => r.id)).toEqual(['stylelint']);

    await reconcileTeamHooksForConfig(teamConfig, asRole('devops'));
    expect((await stopCommands()).some((c) => c.includes('guard-tf.sh'))).toBe(true);
    expect((await stopCommands()).some((c) => c.includes('npm run lint:css'))).toBe(false);
    const claude = await claudeSettings();
    expect(claude.hooks.Stop.filter((h) => h.description?.startsWith('[teamai] '))).toHaveLength(1);
    expect((await manifest()).claude.map((r) => r.id)).toEqual(['guard-tf']);

    const cursor = await cursorSettings();
    expect(cursor.hooks.stop.some((h) => h.command.includes('npm run lint:css'))).toBe(false);
    expect(cursor.hooks.stop.some((h) => h.command.includes('guard-tf.sh'))).toBe(true);
  });

  it('removeAll clears built-in + team hooks', async () => {
    await writeYaml(`
hooks:
  - id: lint
    description: lint
    event: Stop
    command: npm run lint
`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());
    await reconcileTeamHooksForConfig(teamConfig, localConfig(), { removeAll: true });

    const claude = await claudeSettings();
    for (const entries of Object.values(claude.hooks)) {
      expect(entries).toHaveLength(0);
    }
    const codex = await codexSettings();
    for (const entries of Object.values(codex.hooks)) {
      expect(entries).toHaveLength(0);
    }
  });

  it('applies §4.8 builtin disabled + timeout overrides from hooks.yaml', async () => {
    await writeYaml(`
hooks: []
builtin:
  disabled: [Hook dispatch post-tool-use TodoWrite]
  overrides:
    Hook dispatch stop: { timeout: 99 }
`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    const cursor = await cursorSettings();
    // TodoWrite dropped → 2 built-in postToolUse entries instead of 3.
    expect(cursor.hooks.postToolUse).toHaveLength(2);
    expect(cursor.hooks.postToolUse.some((h) => h.command.includes('TodoWrite'))).toBe(false);
    // Stop timeout overridden.
    expect((cursor.hooks.stop[0] as { timeout?: number }).timeout).toBe(99);
  });

  it('works with no hooks.yaml (built-in self-heal only)', async () => {
    const defs = await reconcileTeamHooksForConfig(teamConfig, localConfig());
    expect(defs).toEqual([]);
    const claude = await claudeSettings();
    expect(claude.hooks.SessionStart).toHaveLength(1);
    // No manifest written when there are no team hooks.
    expect(await fse.pathExists(path.join(home, '.teamai', 'managed-hooks.json'))).toBe(false);
  });

  it('self single-repo mode injects into projectRoot, not HOME (committed to main, travels on clone)', async () => {
    // Pre-create the tool root under projectRoot so it counts as installed there.
    await fse.ensureDir(path.join(project, '.claude'));
    const selfConfig = {
      repo: { localPath: repo, remote: 'x', kind: 'self', businessRepoRoot: project },
      username: 'u',
      scope: 'project',
      projectRoot: project,
      additionalRoles: [],
    } as unknown as LocalConfig;

    await reconcileTeamHooksForConfig(teamConfig, selfConfig);

    // Self mode writes to the business repo tree (projectRoot), never HOME.
    const projectClaude = await fse.readJson(path.join(project, '.claude', 'settings.json'));
    expect(projectClaude.hooks.SessionStart).toHaveLength(1);
    expect(await fse.pathExists(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });
});

// ── Legacy <projectRoot> sweep (#370 follow-up) ──────────────
//
// The sweep that clears the pre-#370 <projectRoot> copy must not damage the
// HOME copy the primary pass just wrote. Two ways it did:
//  1. Hermes/OpenCode reconcile through global adapters that ignore baseDir, so
//     a removeAll sweep against <projectRoot> deleted their HOME hooks.
//  2. When projectRoot IS the home dir, "legacy" and "live" are the same file.
describe('reconcileTeamHooksForConfig — legacy projectRoot sweep', () => {
  const withOpencodeAndHermes = {
    toolPaths: {
      claude: { settings: '.claude/settings.json' },
      opencode: { skills: '.opencode/skills' },
      hermes: {},
    },
  } as unknown as TeamaiConfig;

  const opencodePlugin = () =>
    path.join(home, '.config', 'opencode', 'plugin', 'teamai-hooks.ts');
  const hermesScript = () => path.join(home, '.hermes', 'hooks', 'teamai-status-report.sh');

  it('keeps the HOME OpenCode plugin and Hermes hook it just installed', async () => {
    vi.stubEnv('HERMES_HOME', path.join(home, '.hermes'));
    await fse.ensureDir(path.join(home, '.config', 'opencode'));
    await fse.ensureDir(path.join(home, '.hermes'));

    await reconcileTeamHooksForConfig(withOpencodeAndHermes, localConfig());

    expect(await fse.pathExists(opencodePlugin())).toBe(true);
    expect(await fse.pathExists(hermesScript())).toBe(true);
  });

  it('still deletes the legacy <projectRoot> OpenCode plugin', async () => {
    await fse.ensureDir(path.join(home, '.config', 'opencode'));
    const legacyPlugin = path.join(project, '.opencode', 'plugin', 'teamai-hooks.ts');
    await fse.ensureDir(path.dirname(legacyPlugin));
    await fse.writeFile(legacyPlugin, '// stale project copy');

    await reconcileTeamHooksForConfig(withOpencodeAndHermes, localConfig());

    expect(await fse.pathExists(legacyPlugin)).toBe(false);
    expect(await fse.pathExists(opencodePlugin())).toBe(true);
  });

  it('sweeps the legacy copy of a tool excluded by filterAgents', async () => {
    // cursor wrote <projectRoot>/.cursor/hooks.json back when it was enabled;
    // disabling it today must not strand that copy.
    await fse.ensureDir(path.join(project, '.cursor'));
    await fse.writeJson(path.join(project, '.cursor', 'hooks.json'), {
      version: 1,
      hooks: { stop: [{ command: 'teamai hook-dispatch stop --tool cursor' }] },
    });

    await reconcileTeamHooksForConfig(teamConfig, localConfig(), { filterAgents: ['claude'] });

    const stale = await fse.readJson(path.join(project, '.cursor', 'hooks.json'));
    expect(stale.hooks.stop ?? []).toHaveLength(0);
  });

  it('does not wipe the live hooks when projectRoot IS the home dir', async () => {
    // `teamai init .` run in ~ (dotfiles-style repo): the legacy location and
    // the live HOME target are the same file, so there is nothing to sweep.
    const cfg = {
      repo: { localPath: repo, remote: 'x' },
      username: 'u',
      scope: 'project',
      projectRoot: home,
      additionalRoles: [],
    } as unknown as LocalConfig;

    await reconcileTeamHooksForConfig(teamConfig, cfg);

    const claude = await claudeSettings();
    expect(claude.hooks.SessionStart).toHaveLength(1);
  });
});

// ── Project gate rendering per host shell ────────────────────
//
// A tool whose Windows hook runner is cmd.exe cannot execute a POSIX
// `if [ "$PWD" ... ]` gate: cmd aborts on that syntax, so the whole team hook —
// gate and payload alike — never runs. Pin the cmd rendering for those tools and
// the POSIX rendering for everything else.
describe('project gate rendering per host shell', () => {
  const codebuddyOnly = {
    toolPaths: { codebuddy: { settings: '.codebuddy/settings.json' } },
  } as unknown as TeamaiConfig;

  async function teamStopCommands(file: string): Promise<string[]> {
    const settings = await fse.readJson(path.join(home, file));
    return (settings.hooks.Stop ?? [])
      .filter((e: { description?: string }) => e.description?.startsWith('[teamai:hook:'))
      .map((e: { hooks: Array<{ command: string }> }) => e.hooks[0].command);
  }

  const telemetryYaml = (tool: string): string => `
hooks:
  - id: telemetry
    description: inject telemetry
    event: Stop
    matcher: "*"
    command: python3 .docs/script/inject-telemetry.py
    tools: [${tool}]
`;

  it('renders a cmd.exe gate for a tool whose Windows hook runner is cmd.exe', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      await writeYaml(telemetryYaml('codebuddy'));
      await fse.ensureDir(path.join(home, '.codebuddy'));
      await reconcileTeamHooksForConfig(codebuddyOnly, localConfig());

      const [command] = await teamStopCommands('.codebuddy/settings.json');
      // `cd` prints the cwd into the pipe — never `%CD%` interpolated into a
      // parsed command — and the root is caret-escaped inside `^"…^"` quotes.
      expect(command.startsWith('cd| findstr /i /b /l /c:^"')).toBe(true);
      expect(command).toContain(' >nul || cd| findstr /i /e /l /c:^"');
      // Outside the project the gate must exit 0 (a non-zero status would make
      // CodeBuddy treat UserPromptSubmit as allowed:false and block the prompt),
      // while the payload's own status is passed through inside it.
      expect(command.endsWith('^" >nul & if not errorlevel 1 (python3 .docs/script/inject-telemetry.py) else exit /b 0')).toBe(true);
      expect(command).not.toContain('echo %CD%');
      expect(command).not.toContain('&& (python3');
      expect(command).not.toContain('$PWD');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('keeps the POSIX gate for a tool whose runner is not cmd.exe', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      await writeYaml(telemetryYaml('claude'));
      await reconcileTeamHooksForConfig(teamConfig, localConfig());

      const [command] = await teamStopCommands('.claude/settings.json');
      expect(command.startsWith('if [ "$PWD" = ')).toBe(true);
      expect(command.endsWith('); fi')).toBe(true);
    } finally {
      platformSpy.mockRestore();
    }
  });
});

// ── The rendered cmd gate, executed by a real cmd.exe ────────
//
// The assertions above pin only the shape of the gate. These run it in real
// directories whose names carry the characters cmd.exe re-parses — `&`, which
// otherwise executes the rest of the directory name, plus `^`, `%` and a space
// — because a gate that merely looks right can still run part of a path as a
// command or silently stop matching. Windows-only: cmd.exe is the point.
describe('project gate — real cmd.exe execution (win32)', () => {
  const codebuddyOnly = {
    toolPaths: { codebuddy: { settings: '.codebuddy/settings.json' } },
  } as unknown as TeamaiConfig;

  /** Render the gate for `root`, then run it from `cwd` through cmd.exe. */
  async function renderGate(root: string, sandboxHome: string): Promise<string> {
    await writeYaml(`
hooks:
  - id: gate
    description: gate probe
    event: Stop
    command: echo TEAMAI_GATE_PAYLOAD
    tools: [codebuddy]
`);
    await fse.ensureDir(path.join(sandboxHome, '.codebuddy'));
    await reconcileTeamHooksForConfig(codebuddyOnly, { ...localConfig(), projectRoot: root } as LocalConfig);
    const settings = await fse.readJson(path.join(sandboxHome, '.codebuddy', 'settings.json'));
    const commands = (settings.hooks.Stop ?? [])
      .filter((e: { description?: string }) => e.description?.startsWith('[teamai:hook:'))
      .map((e: { hooks: Array<{ command: string }> }) => e.hooks[0].command);
    expect(commands).toHaveLength(1);
    return commands[0];
  }

  /** Run a rendered hook command the way CodeBuddy's hook runner does. */
  function runCommand(command: string, cwd: string): { status: number | null; stdout: string } {
    const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '' };
  }

  it.skipIf(process.platform !== 'win32')(
    'fires only inside the project and never executes part of the path',
    async () => {
      for (const name of ['plain', 'sp&x', 'a^b', 'a%b', 'a%TEMP%b', 'sp ace', 'x&echo CANARY&y']) {
        const root = path.join(project, name);
        const sub = path.join(root, 'sub');
        const sibling = path.join(project, `${name}-sibling`);
        await fse.ensureDir(sub);
        await fse.ensureDir(sibling);
        // A fresh HOME per project keeps the shared settings file free of the
        // previous iteration's project-scoped entries.
        const sandboxHome = path.join(project, 'home', name);
        vi.stubEnv('HOME', sandboxHome);
        const command = await renderGate(root, sandboxHome);

        for (const cwd of [root, sub]) {
          const { status, stdout } = runCommand(command, cwd);
          expect(stdout, `${name} inside ${cwd}`).toContain('TEAMAI_GATE_PAYLOAD');
          expect(status, `${name} inside ${cwd}`).toBe(0);
        }
        for (const cwd of [project, sibling]) {
          const { status, stdout } = runCommand(command, cwd);
          expect(stdout, `${name} outside ${cwd}`).not.toContain('TEAMAI_GATE_PAYLOAD');
          // A mismatch must stay an exit-0 no-op: CodeBuddy reads a non-zero
          // hook status as allowed:false and would block every prompt typed
          // outside the project.
          expect(status, `${name} outside ${cwd}`).toBe(0);
        }
        // `&` in the directory name must never split the gate into commands.
        expect(runCommand(command, root).stdout, `${name} injection canary`).not.toMatch(/^\s*CANARY\s*$/m);
      }
    },
  );
});
