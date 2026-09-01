import path from 'node:path';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../config.js', () => ({
    autoDetectInit: vi.fn(),
}));

vi.mock('../hooks.js', async () => {
    const actual = await vi.importActual<typeof import('../hooks.js')>('../hooks.js');
    return {
        getHookStatus: vi.fn(),
        reconcileHooksToAllTools: vi.fn(),
        hasInstalledCodexTrustGatedTool: vi.fn(),
        // Keep the real reminder text so assertions verify the actual wording.
        codexTrustReminder: actual.codexTrustReminder,
    };
});

vi.mock('../resources/hooks.js', () => ({
    parseTeamHooks: vi.fn(),
    resolveTeamHooks: vi.fn(),
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

// ── Imports (after mocks) ────────────────────────────────

import { autoDetectInit } from '../config.js';
import { getHookStatus, reconcileHooksToAllTools, hasInstalledCodexTrustGatedTool } from '../hooks.js';
import { parseTeamHooks, resolveTeamHooks } from '../resources/hooks.js';
import { log } from '../utils/logger.js';
import { hooksInject, hooksRemove, hooksList } from '../hooks-cmd.js';

const mockedAutoDetectInit = autoDetectInit as Mock;
const mockedGetHookStatus = getHookStatus as Mock;
const mockedReconcile = reconcileHooksToAllTools as Mock;
const mockedHasCodexTrustGated = hasInstalledCodexTrustGatedTool as Mock;
const mockedParseTeamHooks = parseTeamHooks as Mock;
const mockedResolveTeamHooks = resolveTeamHooks as Mock;
const mockedLog = log as unknown as { info: Mock; success: Mock; warn: Mock; error: Mock; debug: Mock };

const mockLocalConfig = {
    repo: { localPath: '/tmp/repo', remote: 'https://git.woa.com/team/repo.git' },
    username: 'testuser',
    updatePolicy: 'auto',
    scope: 'user',
};

const mockTeamConfig = {
    toolPaths: {
        claude: { settings: '.claude/settings.json', skills: '.claude/skills' },
        'claude-internal': { settings: '.claude-internal/settings.json', skills: '.claude-internal/skills' },
        cursor: { settings: '.cursor/hooks.json', skills: '.cursor/skills' },
        codex: { skills: '.codex/skills' },
    },
};

const TEAM_DEFS = [{ source: 'team', key: 'x', event: 'Stop', command: 'echo x', description: '[teamai:hook:x] x' }];

function mockHome(home: string): () => void {
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    return () => {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedAutoDetectInit.mockResolvedValue({ localConfig: mockLocalConfig, teamConfig: mockTeamConfig });
    mockedGetHookStatus.mockResolvedValue('missing');
    mockedReconcile.mockResolvedValue(undefined);
    mockedHasCodexTrustGated.mockResolvedValue(false);
    mockedParseTeamHooks.mockResolvedValue(TEAM_DEFS);
    mockedResolveTeamHooks.mockResolvedValue({ defs: TEAM_DEFS, builtin: undefined });
});

describe('hooksInject', () => {
    it('reconciles built-in + team hooks across all tools (user scope)', async () => {
        await hooksInject({});

        expect(mockedAutoDetectInit).toHaveBeenCalled();
        expect(mockedResolveTeamHooks).toHaveBeenCalledWith(mockTeamConfig, '/tmp/repo', expect.objectContaining({ auto: false }));
        expect(mockedReconcile).toHaveBeenCalledTimes(1);
        expect(mockedReconcile).toHaveBeenCalledWith(
            mockTeamConfig.toolPaths,
            expect.any(String),
            TEAM_DEFS,
            expect.stringContaining('managed-hooks.json'),
            { builtinOverride: undefined },
        );
        expect(mockedLog.success).toHaveBeenCalledWith(expect.stringContaining('Hooks injected'));
    });

    it('suppresses success message with --silent', async () => {
        await hooksInject({ silent: true });
        expect(mockedReconcile).toHaveBeenCalled();
        expect(mockedLog.success).not.toHaveBeenCalled();
    });

    it('warns to trust Codex hooks when the public Codex is installed', async () => {
        mockedHasCodexTrustGated.mockResolvedValue(true);
        await hooksInject({});
        expect(mockedLog.success).toHaveBeenCalledWith(expect.stringContaining('Hooks injected'));
        const warned = mockedLog.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('Codex');
        expect(warned).toMatch(/review\/trust|trust them/i);
        expect(warned).toContain('/hooks');
    });

    it('does not warn about Codex trust when no trust-gated Codex is installed', async () => {
        mockedHasCodexTrustGated.mockResolvedValue(false);
        await hooksInject({});
        expect(mockedLog.warn).not.toHaveBeenCalled();
    });

    it('suppresses the Codex trust reminder with --silent', async () => {
        mockedHasCodexTrustGated.mockResolvedValue(true);
        await hooksInject({ silent: true });
        expect(mockedLog.success).not.toHaveBeenCalled();
        expect(mockedLog.warn).not.toHaveBeenCalled();
    });

    it('propagates error when not initialized', async () => {
        mockedAutoDetectInit.mockRejectedValue(new Error('teamai is not initialized'));
        await expect(hooksInject({})).rejects.toThrow('not initialized');
    });

    it('injects into HOME and sweeps the legacy <projectRoot> copy (#264/#370)', async () => {
        const restoreHome = mockHome('/home/testuser');
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: { ...mockLocalConfig, scope: 'project', projectRoot: '/path/to/project' },
            teamConfig: mockTeamConfig,
        });
        try {
            await hooksInject({});
        } finally {
            restoreHome();
        }

        // #264: project scope injects the single copy into HOME (covers all cwds;
        // dispatch identifies the project via stdin.cwd). #370: it also sweeps any
        // legacy <projectRoot> copy an older CLI wrote, so only HOME's copy fires.
        expect(mockedReconcile).toHaveBeenCalledTimes(2);
        // Call 1 — inject team defs into HOME with the user manifest.
        expect(mockedReconcile).toHaveBeenNthCalledWith(
            1, mockTeamConfig.toolPaths, '/home/testuser', TEAM_DEFS, expect.any(String), { builtinOverride: undefined },
        );
        const injectManifest = mockedReconcile.mock.calls[0][3] as string;
        expect(injectManifest).toContain('/home/testuser');
        expect(injectManifest).not.toContain('/path/to/project');
        // Call 2 — removeAll sweep of the legacy <projectRoot> copy + its manifest.
        expect(mockedReconcile).toHaveBeenNthCalledWith(
            2, mockTeamConfig.toolPaths, '/path/to/project', [], expect.stringContaining('/path/to/project'), { removeAll: true },
        );
    });
});

describe('hooksList', () => {
    it('prints built-in hooks and team hooks from hooks.yaml', async () => {
        mockedParseTeamHooks.mockResolvedValue([
            { source: 'team', key: 'lint', event: 'Stop', command: 'npm run lint', description: '[teamai:hook:lint] lint', tools: ['claude'] },
        ]);
        const out: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
        try {
            await hooksList({});
        } finally {
            spy.mockRestore();
        }
        const text = out.join('\n');
        expect(text).toContain('Built-in hooks (A)');
        expect(text).toContain('hook-dispatch');
        expect(text).toContain('Team hooks (B)');
        expect(text).toContain('[lint] Stop');
        expect(text).toContain('npm run lint');
        expect(text).toContain('(tools: claude)');
    });
});

describe('hooksList', () => {
    it('should list hook status for configured tools', async () => {
        const restoreHome = mockHome('/home/testuser');
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mockedGetHookStatus
            .mockResolvedValueOnce('installed')
            .mockResolvedValueOnce('missing')
            .mockResolvedValueOnce('installed');

        try {
            await hooksList({});

            expect(mockedGetHookStatus).toHaveBeenCalledTimes(3);
            expect(mockedGetHookStatus).toHaveBeenCalledWith(
                path.join('/home/testuser', '.claude/settings.json'),
                'claude',
            );
            expect(mockedGetHookStatus).toHaveBeenCalledWith(
                path.join('/home/testuser', '.claude-internal/settings.json'),
                'claude-internal',
            );
            expect(mockedGetHookStatus).toHaveBeenCalledWith(
                path.join('/home/testuser', '.cursor/hooks.json'),
                'cursor',
            );

            const output = consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
            expect(output).toContain('claude');
            expect(output).toContain('installed');
            expect(output).toContain('claude-internal');
            expect(output).toContain('missing');
            expect(output).toContain('codex');
            expect(output).toContain('not configured');
            expect(output).toContain('no settings configured');
        } finally {
            restoreHome();
            consoleLog.mockRestore();
        }
    });

    it('should list only HOME base dir when project config detected (#264)', async () => {
        const restoreHome = mockHome('/home/testuser');
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const projectConfig = {
            ...mockLocalConfig,
            scope: 'project',
            projectRoot: '/path/to/project',
        };
        mockedAutoDetectInit.mockResolvedValue({ localConfig: projectConfig, teamConfig: mockTeamConfig });
        mockedGetHookStatus
            .mockResolvedValueOnce('installed')
            .mockResolvedValueOnce('missing')
            .mockResolvedValueOnce('installed');

        try {
            await hooksList({});

            // #264: project scope only checks HOME, not projectRoot.
            expect(mockedGetHookStatus).toHaveBeenCalledTimes(3);
            expect(mockedGetHookStatus).toHaveBeenCalledWith(
                path.join('/home/testuser', '.claude/settings.json'),
                'claude',
            );
            expect(mockedGetHookStatus).not.toHaveBeenCalledWith(
                path.join('/path/to/project', '.claude/settings.json'),
                'claude',
            );
        } finally {
            restoreHome();
            consoleLog.mockRestore();
        }
    });

    it('should propagate error when not initialized', async () => {
        mockedAutoDetectInit.mockRejectedValue(new Error('teamai is not initialized'));

        await expect(hooksList({})).rejects.toThrow('not initialized');
    });
});

describe('hooksRemove', () => {
    it('removes all teamai hooks (built-in + team) across tools', async () => {
        await hooksRemove({});

        expect(mockedReconcile).toHaveBeenCalledTimes(1);
        expect(mockedReconcile).toHaveBeenCalledWith(
            mockTeamConfig.toolPaths,
            expect.any(String),
            [],
            expect.stringContaining('managed-hooks.json'),
            { removeAll: true },
        );
        expect(mockedLog.success).toHaveBeenCalledWith(expect.stringContaining('Hooks removed'));
    });

    it('removes from HOME and cleans up legacy projectRoot entries (#264)', async () => {
        const restoreHome = mockHome('/home/testuser');
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: { ...mockLocalConfig, scope: 'project', projectRoot: '/path/to/project' },
            teamConfig: mockTeamConfig,
        });
        try {
            await hooksRemove({});
        } finally {
            restoreHome();
        }
        // 1 main (HOME) + 1 legacy cleanup (projectRoot)
        expect(mockedReconcile).toHaveBeenCalledTimes(2);

        // Main removal targets HOME with user manifest.
        expect(mockedReconcile).toHaveBeenNthCalledWith(1,
            mockTeamConfig.toolPaths, '/home/testuser', [], expect.any(String), { removeAll: true },
        );
        const userManifest = mockedReconcile.mock.calls[0][3] as string;
        expect(userManifest).toContain('/home/testuser');

        // Legacy cleanup targets projectRoot with project manifest.
        expect(mockedReconcile).toHaveBeenNthCalledWith(2,
            mockTeamConfig.toolPaths, '/path/to/project', [], expect.any(String), { removeAll: true },
        );
        const legacyManifest = mockedReconcile.mock.calls[1][3] as string;
        expect(legacyManifest).toContain('/path/to/project');
    });

    it('self single-repo mode removes once, without a redundant legacy sweep (#370)', async () => {
        const restoreHome = mockHome('/home/testuser');
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: {
                ...mockLocalConfig,
                scope: 'project',
                projectRoot: '/path/to/project',
                repo: { ...mockLocalConfig.repo, kind: 'self' },
            },
            teamConfig: mockTeamConfig,
        });
        try {
            await hooksRemove({});
        } finally {
            restoreHome();
        }
        // Self mode's primary target is <projectRoot>; the legacy sweep would be
        // the same location (double work) or HOME (would clobber user scope), so
        // it must not fire — exactly one removal against <projectRoot>.
        expect(mockedReconcile).toHaveBeenCalledTimes(1);
        expect(mockedReconcile).toHaveBeenCalledWith(
            mockTeamConfig.toolPaths, '/path/to/project', [], expect.any(String), { removeAll: true },
        );
    });

    it('propagates error when not initialized', async () => {
        mockedAutoDetectInit.mockRejectedValue(new Error('teamai is not initialized'));
        await expect(hooksRemove({})).rejects.toThrow('not initialized');
    });
});
