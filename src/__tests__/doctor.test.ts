import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import path from 'node:path';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
    loadLocalConfig: vi.fn(),
    loadTeamConfig: vi.fn(),
    detectProjectConfig: vi.fn().mockResolvedValue(null),
    // resolveDesiredAgents reads placement records to mirror what pull delivers.
    loadStateForScope: vi.fn().mockResolvedValue({}),
}));

vi.mock('../utils/fs.js', () => ({
    pathExists: vi.fn(),
    readFileSafe: vi.fn(),
    // Manifest loaders read through this one; no manifest exists on this machine.
    readFileIfExists: vi.fn().mockResolvedValue(null),
    // The delivery checks walk the team repo through resolveDesiredSkills,
    // resolveDesiredRules, resolveDesiredAgents and DocsHandler. This machine
    // has none of those; delivery on a real disk is covered by
    // doctor-delivery.test.ts, doctor-rules-delivery.test.ts and
    // doctor-agents-delivery.test.ts.
    listDirs: vi.fn().mockResolvedValue([]),
    listFiles: vi.fn().mockResolvedValue([]),
    listFilesRecursive: vi.fn().mockResolvedValue([]),
    expandHome: vi.fn((p: string) => p),
}));

vi.mock('../utils/logger.js', () => ({
    log: {
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
    setStderrOnly: vi.fn(),
}));

// Mock the tgit provider to avoid side effects
vi.mock('../providers/tgit/index.js', () => ({
    isGfInstalled: vi.fn().mockResolvedValue(true),
    gfIsAuthenticated: vi.fn().mockResolvedValue(true),
}));

// ── Imports (after mocks) ────────────────────────────────

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { pathExists, readFileSafe } from '../utils/fs.js';
import { TEAMAI_HOOK_SUBCOMMANDS } from '../hooks.js';
import { log, setStderrOnly } from '../utils/logger.js';
import { isGfInstalled, gfIsAuthenticated } from '../providers/tgit/index.js';
import { buildChecks, doctor, resolveDoctorContext } from '../doctor.js';
import type { DoctorReport } from '../doctor.js';

const mockedLoadLocalConfig = loadLocalConfig as Mock;
const mockedLoadTeamConfig = loadTeamConfig as Mock;
const mockedPathExists = pathExists as Mock;
const mockedReadFileSafe = readFileSafe as Mock;
const mockedLog = log as unknown as { info: Mock; success: Mock; warn: Mock; error: Mock; debug: Mock };
const mockedIsGfInstalled = isGfInstalled as Mock;
const mockedGfIsAuthenticated = gfIsAuthenticated as Mock;

const mockLocalConfig = {
    repo: { localPath: '/tmp/repo', remote: 'https://git.woa.com/team/repo.git' },
    username: 'testuser',
    updatePolicy: 'auto',
};

const mockTeamConfig = {
    team: 'test-team',
    repo: 'team/repo',
    provider: 'tgit' as const,
    toolPaths: {
        claude: { settings: '.claude/settings.json', skills: '.claude/skills' },
    },
};

// Build a settings content that contains all subcommands
function buildFullHooksContent(): string {
    const lines = TEAMAI_HOOK_SUBCOMMANDS.map(
        (sub) => `"command": "bash -lc \\"teamai ${sub}\\""`,
    );
    return `{ "hooks": { ${lines.join(', ')} } }`;
}

// Build a settings content that is missing some subcommands
function buildPartialHooksContent(exclude: string[]): string {
    const subs = TEAMAI_HOOK_SUBCOMMANDS.filter((s) => !exclude.includes(s));
    const lines = subs.map(
        (sub) => `"command": "bash -lc \\"teamai ${sub}\\""`,
    );
    return `{ "hooks": { ${lines.join(', ')} } }`;
}

// ── Setup ────────────────────────────────────────────────

// Suppress console.log output in tests
const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

// The Claude-root check only appears when CLAUDE_CONFIG_DIR is set, and this
// suite's fixtures record no root — so a developer whose own shell relocates
// Claude Code would otherwise see every doctor test fail. The describe that
// covers the check sets the variable itself.
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CLAUDE_CONFIG_DIR;
    mockedLoadLocalConfig.mockResolvedValue(mockLocalConfig);
    mockedLoadTeamConfig.mockResolvedValue(mockTeamConfig);
    mockedPathExists.mockResolvedValue(true);
    // One blob answers every read, except the role/project manifests the
    // delivery check resolves the desired skill set from: parsing hook JSON as a
    // manifest throws. Absent manifests are the shape this fixture wants anyway.
    mockedReadFileSafe.mockImplementation(async (filePath: string) => (
        filePath.includes(`${path.sep}manifest${path.sep}`) ? null : buildFullHooksContent()
    ));
});

// ── Tests ────────────────────────────────────────────────

describe('doctor — hook checks', () => {
    it('should pass when all subcommands are present in settings', async () => {
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            sharing: { env: { injectShellProfile: false } },
        });
        const allPassed = await doctor({});

        // Should show the hooks check passing (✔)
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('✔'),
        );
        expect(allPassed).toBe(true);
    });

    it('should fail when a subcommand is missing from settings', async () => {
        // Missing 'hook-dispatch' subcommand (the only required one now)
        mockedReadFileSafe.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json')) {
                // Return settings without hook-dispatch
                return '{ "hooks": { "command": "bash -lc \\"teamai pull\\"" } }';
            }
            if (filePath.includes('.zshrc') || filePath.includes('.bashrc')) {
                return '# [teamai:env:start]';
            }
            return null;
        });

        const allPassed = await doctor({});

        // Should show the hooks check failing (✖) with fix suggestion
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('✖'),
        );
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('teamai hooks inject'),
        );
        expect(allPassed).toBe(false);
    });

    it('should fail when settings file does not exist', async () => {
        mockedPathExists.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json')) return false;
            return true;
        });

        await doctor({});

        // Should show at least one failing check
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('✖'),
        );
    });

    it('should check all TEAMAI_HOOK_SUBCOMMANDS', () => {
        // With the merged dispatch format, only hook-dispatch is needed
        expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('hook-dispatch');
        expect(TEAMAI_HOOK_SUBCOMMANDS).toHaveLength(1);
    });

    // Lock the resolveHookScope branch the doctor fix rides on (#264/#370): the
    // hook check must look where hooks are actually injected, not at resolveBaseDir.
    function hookCheckLine(): string | undefined {
        return consoleSpy.mock.calls
            .map((c) => c[0] as string)
            .find((m) => typeof m === 'string' && m.includes('hooks in claude settings'));
    }

    it('non-self project scope resolves the hook check to HOME, not <projectRoot>', async () => {
        const projectRoot = '/tmp/teamai-doctor-proj';
        mockedLoadLocalConfig.mockResolvedValue({ ...mockLocalConfig, scope: 'project', projectRoot });
        // HOME carries the hooks; <projectRoot> is empty. If doctor still used
        // resolveBaseDir (→ projectRoot) this check would report ✖.
        mockedReadFileSafe.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json')) {
                return filePath.includes(projectRoot) ? '{ "hooks": {} }' : buildFullHooksContent();
            }
            return null;
        });

        await doctor({});

        expect(hookCheckLine()).toContain('✔');
    });

    it('self single-repo mode resolves the hook check to <projectRoot>, not HOME', async () => {
        const projectRoot = '/tmp/teamai-doctor-self';
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            scope: 'project',
            projectRoot,
            repo: { ...mockLocalConfig.repo, kind: 'self' },
        });
        // Only <projectRoot> carries the hooks (committed to the business repo).
        mockedReadFileSafe.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json')) {
                return filePath.includes(path.normalize(projectRoot)) ? buildFullHooksContent() : '{ "hooks": {} }';
            }
            return null;
        });

        await doctor({});

        expect(hookCheckLine()).toContain('✔');
    });

    it('checks standalone Copilot hooks under COPILOT_HOME', async () => {
        const copilotHome = '/tmp/teamai-doctor-copilot';
        const originalCopilotHome = process.env.COPILOT_HOME;
        process.env.COPILOT_HOME = copilotHome;
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            scope: 'user',
            enabledAgents: ['copilot'],
        });
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            sharing: { env: { injectShellProfile: false } },
            toolPaths: {
                copilot: {
                    hooks: '.github/hooks/teamai.json',
                    userScope: { hooks: 'hooks/teamai.json' },
                },
            },
        });
        mockedReadFileSafe.mockImplementation(async (filePath: string) => (
            filePath === path.join(copilotHome, 'hooks', 'teamai.json')
                ? buildFullHooksContent()
                : null
        ));

        let copilotLine: string | undefined;
        try {
            await doctor({});
            copilotLine = consoleSpy.mock.calls
                .map((call) => call[0] as string)
                .find((message) => message.includes('hooks in copilot'));
        } finally {
            if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
            else process.env.COPILOT_HOME = originalCopilotHome;
        }

        expect(copilotLine).toContain('✔');
    });

    it('reports missing project hooks for explicitly selected Copilot', async () => {
        const projectRoot = '/tmp/teamai-doctor-copilot-project';
        const hookPath = path.join(projectRoot, '.github', 'hooks', 'teamai.json');
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            scope: 'project',
            projectRoot,
            enabledAgents: ['copilot'],
        });
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            sharing: { env: { injectShellProfile: false } },
            toolPaths: {
                copilot: { hooks: '.github/hooks/teamai.json' },
            },
        });
        mockedPathExists.mockImplementation(async (filePath: string) => (
            filePath !== hookPath && filePath !== path.dirname(hookPath)
        ));

        const allPassed = await doctor({});
        const copilotLine = consoleSpy.mock.calls
            .map((call) => String(call[0]))
            .find((message) => message.includes('hooks in copilot'));

        expect(copilotLine).toContain('✖');
        expect(allPassed).toBe(false);
    });

    // Non-self project scope: `hooks inject` writes copilot at
    // <projectRoot>/.github/hooks/teamai.json (the config's own scope), so doctor
    // must probe that file — not userScope.hooks joined onto projectRoot.
    it('checks project Copilot hooks where inject wrote them when userScope.hooks is set', async () => {
        const projectRoot = '/tmp/teamai-doctor-copilot-project-userscope';
        const hookPath = path.join(projectRoot, '.github', 'hooks', 'teamai.json');
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            scope: 'project',
            projectRoot,
            enabledAgents: ['copilot'],
        });
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            sharing: { env: { injectShellProfile: false } },
            toolPaths: {
                copilot: {
                    hooks: '.github/hooks/teamai.json',
                    userScope: { hooks: 'hooks/teamai.json' },
                },
            },
        });
        mockedPathExists.mockImplementation(async (filePath: string) => (
            filePath === hookPath || filePath === path.dirname(hookPath)
        ));
        mockedReadFileSafe.mockImplementation(async (filePath: string) => (
            filePath === hookPath ? buildFullHooksContent() : null
        ));

        await doctor({});
        const copilotLine = consoleSpy.mock.calls
            .map((call) => String(call[0]))
            .find((message) => message.includes('hooks in copilot'));

        expect(copilotLine).toContain('✔');
    });

    it('does not infer project Copilot installation from .github/hooks alone', async () => {
        const projectRoot = '/tmp/teamai-doctor-unselected-copilot';
        const copilotHome = '/tmp/teamai-doctor-unselected-home';
        const originalCopilotHome = process.env.COPILOT_HOME;
        process.env.COPILOT_HOME = copilotHome;
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            scope: 'project',
            projectRoot,
            enabledAgents: undefined,
        });
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            sharing: { env: { injectShellProfile: false } },
            toolPaths: {
                copilot: { hooks: '.github/hooks/teamai.json' },
            },
        });
        mockedPathExists.mockImplementation(async (filePath: string) => filePath !== copilotHome);

        let allPassed: boolean;
        try {
            allPassed = await doctor({});
        } finally {
            if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
            else process.env.COPILOT_HOME = originalCopilotHome;
        }
        const hasCopilotCheck = consoleSpy.mock.calls
            .map((call) => String(call[0]))
            .some((message) => message.includes('hooks in copilot'));

        expect(hasCopilotCheck).toBe(false);
        expect(allPassed).toBe(true);
    });

    it('skips enabled tools that have no hook configuration', async () => {
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            enabledAgents: ['codex'],
        });
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            sharing: { env: { injectShellProfile: false } },
            toolPaths: {
                codex: { skills: '.codex/skills' },
            },
        });

        const allPassed = await doctor({});

        const allLines = consoleSpy.mock.calls.map((call) => String(call[0]));
        expect(allLines.some((line) => line.includes('hooks in codex'))).toBe(false);
        expect(allPassed).toBe(true);
    });

    it('should pass env check when env/env.yaml does not exist in team repo', async () => {
        mockedPathExists.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith(path.join('env', 'env.yaml'))) return false;
            return true;
        });
        mockedReadFileSafe.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json')) return buildFullHooksContent();
            return null;
        });

        await doctor({});

        const allCalls = consoleSpy.mock.calls.map((c) => c[0]);
        const envLine = allCalls.find((msg: string) => msg.includes('Env variables'));
        expect(envLine).toContain('✔');
    });

    it('should pass env check when injectShellProfile is false', async () => {
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            sharing: { env: { injectShellProfile: false } },
        });
        mockedPathExists.mockImplementation(async (filePath: string) => {
            if (filePath.includes('env.sh')) return false;
            return true;
        });
        mockedReadFileSafe.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json')) return buildFullHooksContent();
            return null;
        });

        await doctor({});

        const allCalls = consoleSpy.mock.calls.map((c) => c[0]);
        const envLine = allCalls.find((msg: string) => msg.includes('Env variables'));
        expect(envLine).toContain('✔');
    });

    it('notes Codex may require trust when Codex hooks are installed', async () => {
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            toolPaths: {
                claude: { settings: '.claude/settings.json', skills: '.claude/skills' },
                codex: { settings: '.codex/hooks.json', skills: '.codex/skills' },
            },
        });
        // Both settings files exist and contain the hook-dispatch command.
        mockedReadFileSafe.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json') || filePath.includes('hooks.json')) {
                return buildFullHooksContent();
            }
            return null;
        });

        await doctor({});

        const infoLines = mockedLog.info.mock.calls.map((c) => String(c[0]));
        const note = infoLines.find((msg) => msg.includes('review/trust'));
        expect(note).toBeDefined();
        expect(note).toContain('Codex');
    });

    it('does not note Codex trust when no Codex hooks are installed', async () => {
        // Default mockTeamConfig has only claude; readFileSafe returns full hooks.
        await doctor({});
        const infoLines = mockedLog.info.mock.calls.map((c) => String(c[0]));
        expect(infoLines.some((msg) => msg.includes('review/trust'))).toBe(false);
    });

    it('should skip tools whose parent directory does not exist', async () => {
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            toolPaths: {
                claude: { settings: '.claude/settings.json', skills: '.claude/skills' },
                'codex-internal': { settings: '.codex-internal/hooks.json', skills: '.codex-internal/skills' },
            },
        });

        mockedPathExists.mockImplementation(async (filePath: string) => {
            // .codex-internal directory does not exist
            if (filePath.includes('.codex-internal')) return false;
            return true;
        });

        await doctor({});

        // Should NOT show codex-internal check at all (skipped)
        const allCalls = consoleSpy.mock.calls.map((c) => c[0]);
        expect(allCalls.some((msg: string) => msg.includes('codex-internal'))).toBe(false);
        // Should still show claude check
        expect(allCalls.some((msg: string) => msg.includes('claude'))).toBe(true);
    });

    it('does not assume a provider before initialization', async () => {
        mockedLoadLocalConfig.mockResolvedValue(null);
        mockedLoadTeamConfig.mockResolvedValue(null);

        const allPassed = await doctor({});

        const allLines = consoleSpy.mock.calls.map((c) => String(c[0]));
        expect(allLines).toContain('  Scope: not initialized\n');
        expect(allLines).toContain('  ✖ TeamAI is not initialized');
        expect(allLines.some((line) => line.includes('gf CLI'))).toBe(false);
        expect(allLines.some((line) => line.includes('hooks in'))).toBe(false);
        expect(mockedIsGfInstalled).not.toHaveBeenCalled();
        expect(mockedGfIsAuthenticated).not.toHaveBeenCalled();
        expect(allPassed).toBe(false);
    });

    it('checks hooks only for enabled agents', async () => {
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            enabledAgents: ['claude'],
        });
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            sharing: { env: { injectShellProfile: false } },
            toolPaths: {
                claude: { settings: '.claude/settings.json', skills: '.claude/skills' },
                codex: { settings: '.codex/hooks.json', skills: '.codex/skills' },
            },
        });

        const allPassed = await doctor({});

        const allLines = consoleSpy.mock.calls.map((c) => String(c[0]));
        expect(allLines.some((line) => line.includes('hooks in claude settings'))).toBe(true);
        expect(allLines.some((line) => line.includes('hooks in codex settings'))).toBe(false);
        expect(allPassed).toBe(true);
    });
});

describe('doctor — JSON report', () => {
    /**
     * Parses the report and, by insisting on a single console.log, proves that
     * stdout carried nothing but JSON.
     */
    function emittedReport(): DoctorReport {
        expect(consoleSpy.mock.calls).toHaveLength(1);
        return JSON.parse(String(consoleSpy.mock.calls[0][0])) as DoctorReport;
    }

    it('emits a single JSON object carrying every check', async () => {
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            sharing: { env: { injectShellProfile: false } },
        });

        const allPassed = await doctor({ json: true });

        // stdout must stay a pure data channel: one console.log, logs on stderr.
        expect(setStderrOnly).toHaveBeenCalledWith(true);

        const report = emittedReport();
        expect(allPassed).toBe(true);
        expect(report.ok).toBe(true);
        expect(report.scope).toBe('user');
        const names = report.checks.map((c) => c.name);
        expect(names).toContain('Team repo exists locally');
        expect(names).toContain('teamai hooks in claude settings');
        expect(report.checks.every((c) => c.ok)).toBe(true);
    });

    it('carries the fix string of a failing check', async () => {
        mockedReadFileSafe.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json')) {
                return '{ "hooks": { "command": "bash -lc \\"teamai pull\\"" } }';
            }
            if (filePath.includes('.zshrc') || filePath.includes('.bashrc')) {
                return '# [teamai:env:start]';
            }
            return null;
        });

        const allPassed = await doctor({ json: true });

        const report = emittedReport();
        expect(allPassed).toBe(false);
        expect(report.ok).toBe(false);
        const failing = report.checks.find((c) => c.name === 'teamai hooks in claude settings');
        expect(failing?.ok).toBe(false);
        expect(failing?.fix).toContain('teamai hooks inject');
    });

    it('emits the same envelope before initialization', async () => {
        mockedLoadLocalConfig.mockResolvedValue(null);
        mockedLoadTeamConfig.mockResolvedValue(null);

        const allPassed = await doctor({ json: true });

        const report = emittedReport();
        expect(allPassed).toBe(false);
        expect(report.ok).toBe(false);
        expect(report.scope).toBeNull();
        expect(report.checks).toHaveLength(1);
        expect(report.checks[0]).toMatchObject({ name: 'TeamAI is not initialized', ok: false });
        expect(report.checks[0].fix).toContain('teamai init');
    });
});

describe('buildChecks', () => {
    it('runs outside doctor and yields one hook check per enabled agent', async () => {
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            enabledAgents: ['claude'],
        });
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            toolPaths: {
                claude: { settings: '.claude/settings.json', skills: '.claude/skills' },
                codex: { settings: '.codex/hooks.json', skills: '.codex/skills' },
            },
        });

        const ctx = await resolveDoctorContext();
        if (!ctx) throw new Error('expected a resolved doctor context');

        const checks = await buildChecks(ctx);
        const names = checks.map((c) => c.name);

        expect(names).toContain('teamai hooks in claude settings');
        expect(names).not.toContain('teamai hooks in codex settings');
        // Building the registry renders nothing — that is what makes it reusable.
        expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('returns a null context before initialization', async () => {
        mockedLoadLocalConfig.mockResolvedValue(null);
        mockedLoadTeamConfig.mockResolvedValue(null);

        expect(await resolveDoctorContext()).toBeNull();
    });

    it('reports learnings that are written but not published', async () => {
        mockedLoadLocalConfig.mockResolvedValue(mockLocalConfig);
        mockedLoadTeamConfig.mockResolvedValue(mockTeamConfig);

        const ctx = await resolveDoctorContext();
        if (!ctx) throw new Error('expected a resolved doctor context');

        const check = (await buildChecks(ctx)).find((c) => c.name.includes('learnings'));
        expect(check).toBeDefined();
        expect(check?.fix).toContain('teamai pull');
        // Correct advice here, where doctor is the whole command. The pull's own
        // warning already says it, with the push error, so the post-pull pass
        // skips this one rather than repeat it — see pull-post-checks.test.ts.
        expect(check?.reportedByPull).toBe('pending-learnings');
    });

    it('flags only the queue check as one the pull reports itself', async () => {
        mockedLoadLocalConfig.mockResolvedValue(mockLocalConfig);
        mockedLoadTeamConfig.mockResolvedValue(mockTeamConfig);

        const ctx = await resolveDoctorContext();
        if (!ctx) throw new Error('expected a resolved doctor context');

        const flagged = (await buildChecks(ctx)).filter((c) => c.reportedByPull);
        expect(flagged.map((c) => c.name)).toEqual(['Contributed learnings are published']);
    });
});

// A tool listed in enabledAgents is a claim by the user that they use it. Until
// #598 the registry answered that claim with silence: buildHookChecks skipped
// any tool whose settings directory was missing — the same silent skip #574
// reports in pull, reproduced inside doctor.
describe('buildChecks — a tool enabled but not installed', () => {
    const twoToolPaths = {
        claude: { settings: '.claude/settings.json', skills: '.claude/skills' },
        codex: { settings: '.codex/hooks.json', skills: '.codex/skills' },
    };

    /** Everything exists except codex's settings directory. */
    function onlyCodexMissing(): void {
        mockedPathExists.mockImplementation(async (filePath: string) => !filePath.includes('.codex'));
    }

    async function checksFor(localOverrides: Record<string, unknown>) {
        mockedLoadLocalConfig.mockResolvedValue({ ...mockLocalConfig, ...localOverrides });
        mockedLoadTeamConfig.mockResolvedValue({ ...mockTeamConfig, toolPaths: twoToolPaths });
        onlyCodexMissing();
        const ctx = await resolveDoctorContext();
        if (!ctx) throw new Error('expected a resolved doctor context');
        return buildChecks(ctx);
    }

    it('fails for a tool that carries no hook configuration at all', async () => {
        // opencode ships skills and nothing else. Hanging this check off the hook
        // registry made it invisible for exactly the tools most likely to be
        // declared and absent.
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            enabledAgents: ['claude', 'opencode'],
        });
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            toolPaths: {
                claude: { settings: '.claude/settings.json', skills: '.claude/skills' },
                opencode: { skills: '.opencode/skills' },
            },
        });
        mockedPathExists.mockImplementation(async (filePath: string) => !filePath.includes('.opencode'));

        const ctx = await resolveDoctorContext();
        if (!ctx) throw new Error('expected a resolved doctor context');
        const opencode = (await buildChecks(ctx)).find((c) => c.name === 'opencode is installed');

        expect(opencode).toBeDefined();
        expect(await opencode!.check()).toBe(false);
    });

    it('reports an installed tool as passing rather than omitting it', async () => {
        // `doctor --json` is consumed by hooks and CI. A check that only appears
        // when it fails cannot be told apart from one that was never evaluated,
        // and no other check in the registry behaves that way.
        const checks = await checksFor({ enabledAgents: ['claude', 'codex'] });

        const claude = checks.find((c) => c.name === 'claude is installed');
        expect(claude).toBeDefined();
        expect(await claude!.check()).toBe(true);
    });

    it('fails a check naming the tool the user enabled', async () => {
        const checks = await checksFor({ enabledAgents: ['claude', 'codex'] });

        const codex = checks.find((c) => c.name === 'codex is installed');
        expect(codex).toBeDefined();
        expect(await codex!.check()).toBe(false);
        expect(codex!.source).toBe('local');
        expect(codex!.fix).toContain('enabledAgents');
    });

    it('stays silent about an uninstalled tool nobody enabled', async () => {
        const checks = await checksFor({});

        expect(checks.map((c) => c.name)).not.toContain('codex is installed');
        // And no other check stands in for it: an unlisted tool is simply absent.
        expect(checks.map((c) => c.name)).not.toContain('teamai hooks in codex settings');
    });

    it('reaches the JSON report with the shape every check has', async () => {
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            enabledAgents: ['claude', 'codex'],
        });
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            toolPaths: twoToolPaths,
            sharing: { env: { injectShellProfile: false } },
        });
        onlyCodexMissing();

        const allPassed = await doctor({ json: true });

        const report = JSON.parse(String(consoleSpy.mock.calls[0][0])) as DoctorReport;
        const codex = report.checks.find((c) => c.name === 'codex is installed');
        expect(codex).toMatchObject({ name: 'codex is installed', ok: false });
        expect(codex?.fix).toBeTruthy();
        expect(allPassed).toBe(false);
    });
});

describe('doctor — the recorded Claude Code root', () => {
    const CHECK_NAME = 'Claude Code root matches CLAUDE_CONFIG_DIR';
    const home = process.env.HOME ?? '';
    const relocated = path.join(home, '.claude-work');

    afterEach(() => {
        if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    });

    async function checkFor(toolRoots?: Record<string, string>) {
        mockedLoadLocalConfig.mockResolvedValue({ ...mockLocalConfig, ...(toolRoots ? { toolRoots } : {}) });
        const ctx = await resolveDoctorContext();
        if (!ctx) throw new Error('expected a resolved doctor context');
        return (await buildChecks(ctx)).find((c) => c.name === CHECK_NAME);
    }

    it('is not built when the config does not sync Claude Code at all', async () => {
        process.env.CLAUDE_CONFIG_DIR = relocated;
        mockedLoadLocalConfig.mockResolvedValue({ ...mockLocalConfig, disabledAgents: ['claude'] });
        const ctx = await resolveDoctorContext();
        expect((await buildChecks(ctx!)).find((c) => c.name === CHECK_NAME)).toBeUndefined();
    });

    it('passes when the recorded root is the one Claude Code is told to use', async () => {
        process.env.CLAUDE_CONFIG_DIR = relocated;
        const check = await checkFor({ claude: relocated });
        expect(check).toBeDefined();
        expect(await check!.check()).toBe(true);
    });

    it('fails when nothing was recorded, and says how to record it', async () => {
        process.env.CLAUDE_CONFIG_DIR = relocated;
        const check = await checkFor();
        expect(await check!.check()).toBe(false);
        expect(check!.fix).toContain(relocated);
        expect(check!.fix).toContain('Re-run `teamai init`');
    });

    it('fails when the recorded root is a different directory', async () => {
        process.env.CLAUDE_CONFIG_DIR = relocated;
        const check = await checkFor({ claude: path.join(home, '.claude-other') });
        expect(await check!.check()).toBe(false);
        expect(check!.fix).toContain(path.join(home, '.claude-other'));
    });

    it('stays out of the report when the variable is unset', async () => {
        delete process.env.CLAUDE_CONFIG_DIR;
        expect(await checkFor()).toBeUndefined();
    });

    it('runs for an explicit default root, which is not the same as no variable', async () => {
        process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
        const unrecorded = await checkFor();
        expect(await unrecorded!.check()).toBe(false);
        expect(await (await checkFor({ claude: path.join(home, '.claude') }))!.check()).toBe(true);
    });

    it('reads a root written with ~/ as the directory it expands to', async () => {
        process.env.CLAUDE_CONFIG_DIR = relocated;
        const check = await checkFor({ claude: '~/.claude-work' });
        expect(await check!.check()).toBe(true);
    });

    it('fails for a recorded root the sync refuses, naming where it actually writes', async () => {
        // Outside HOME: applyToolRoots drops it, so the sync keeps using
        // ~/.claude and the check must not call that a match.
        process.env.CLAUDE_CONFIG_DIR = '/opt/claude-config';
        const check = await checkFor({ claude: '/opt/claude-config' });
        expect(await check!.check()).toBe(false);
        expect(check!.fix).toContain(path.join(home, '.claude'));
        // Re-running init cannot record this value, so the fix says why instead.
        expect(check!.fix).toContain('outside the home directory');
        expect(check!.fix).not.toContain('to record it');
    });
});
