import path from 'node:path';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../config.js', () => ({
    autoDetectInit: vi.fn(),
}));

vi.mock('../hooks.js', () => ({
    getHookStatus: vi.fn(),
    reconcileHooksToAllTools: vi.fn(),
}));

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
import { getHookStatus, reconcileHooksToAllTools } from '../hooks.js';
import { parseTeamHooks, resolveTeamHooks } from '../resources/hooks.js';
import { log } from '../utils/logger.js';
import { hooksInject, hooksRemove, hooksList } from '../hooks-cmd.js';

const mockedAutoDetectInit = autoDetectInit as Mock;
const mockedGetHookStatus = getHookStatus as Mock;
const mockedReconcile = reconcileHooksToAllTools as Mock;
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

    it('propagates error when not initialized', async () => {
        mockedAutoDetectInit.mockRejectedValue(new Error('teamai is not initialized'));
        await expect(hooksInject({})).rejects.toThrow('not initialized');
    });

    it('reconciles into project and user base dirs when project config detected', async () => {
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

        expect(mockedReconcile).toHaveBeenCalledTimes(2);
        expect(mockedReconcile).toHaveBeenNthCalledWith(1, mockTeamConfig.toolPaths, '/path/to/project', TEAM_DEFS, expect.any(String), { builtinOverride: undefined });
        expect(mockedReconcile).toHaveBeenNthCalledWith(2, mockTeamConfig.toolPaths, '/home/testuser', TEAM_DEFS, expect.any(String), { builtinOverride: undefined });

        // #85: the user-home target must be reconciled against the USER's own
        // manifest, not the project's — otherwise `pull`'s per-scope reconcile
        // (which always uses each scope's own manifest) diverges from `inject`,
        // causing duplicate injection / wrongful cleanup of the shared file.
        const projectManifestPath = mockedReconcile.mock.calls[0][3] as string;
        const userManifestPath = mockedReconcile.mock.calls[1][3] as string;
        expect(userManifestPath).not.toBe(projectManifestPath);
        expect(projectManifestPath).toContain('/path/to/project');
        expect(userManifestPath).toContain('/home/testuser');
        expect(userManifestPath).not.toContain('/path/to/project');
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

    it('should list project and user base dirs when project config detected', async () => {
        const restoreHome = mockHome('/home/testuser');
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const projectConfig = {
            ...mockLocalConfig,
            scope: 'project',
            projectRoot: '/path/to/project',
        };
        mockedAutoDetectInit.mockResolvedValue({ localConfig: projectConfig, teamConfig: mockTeamConfig });

        try {
            await hooksList({});

            expect(mockedGetHookStatus).toHaveBeenCalledTimes(6);
            expect(mockedGetHookStatus).toHaveBeenCalledWith(
                path.join('/path/to/project', '.claude/settings.json'),
                'claude',
            );
            expect(mockedGetHookStatus).toHaveBeenCalledWith(
                path.join('/home/testuser', '.claude/settings.json'),
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

    it('removes from project and user base dirs when project config detected', async () => {
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
        expect(mockedReconcile).toHaveBeenCalledTimes(2);

        // #85: same per-scope manifest requirement as `hooksInject`.
        const projectManifestPath = mockedReconcile.mock.calls[0][3] as string;
        const userManifestPath = mockedReconcile.mock.calls[1][3] as string;
        expect(userManifestPath).not.toBe(projectManifestPath);
        expect(userManifestPath).not.toContain('/path/to/project');
    });

    it('does not duplicate when HOME equals projectRoot', async () => {
        const restoreHome = mockHome('/path/to/project');
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: { ...mockLocalConfig, scope: 'project', projectRoot: '/path/to/project' },
            teamConfig: mockTeamConfig,
        });
        try {
            await hooksRemove({});
        } finally {
            restoreHome();
        }
        expect(mockedReconcile).toHaveBeenCalledTimes(1);
    });

    it('propagates error when not initialized', async () => {
        mockedAutoDetectInit.mockRejectedValue(new Error('teamai is not initialized'));
        await expect(hooksRemove({})).rejects.toThrow('not initialized');
    });
});
