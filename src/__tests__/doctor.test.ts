import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import path from 'node:path';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../config.js', () => ({
    loadLocalConfig: vi.fn(),
    loadTeamConfig: vi.fn(),
    detectProjectConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/fs.js', () => ({
    pathExists: vi.fn(),
    readFileSafe: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
    log: {
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
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
import { log } from '../utils/logger.js';
import { isGfInstalled, gfIsAuthenticated } from '../providers/tgit/index.js';
import { doctor } from '../doctor.js';

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

beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadLocalConfig.mockResolvedValue(mockLocalConfig);
    mockedLoadTeamConfig.mockResolvedValue(mockTeamConfig);
    mockedPathExists.mockResolvedValue(true);
    mockedReadFileSafe.mockResolvedValue(buildFullHooksContent());
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
