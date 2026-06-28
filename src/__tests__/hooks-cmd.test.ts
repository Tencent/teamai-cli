import path from 'node:path';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../config.js', () => ({
    autoDetectInit: vi.fn(),
}));

vi.mock('../hooks.js', () => ({
    getHookStatus: vi.fn(),
    injectHooksToAllTools: vi.fn(),
    removeHooks: vi.fn(),
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
import { getHookStatus, injectHooksToAllTools, removeHooks } from '../hooks.js';
import { log } from '../utils/logger.js';
import { hooksInject, hooksList, hooksRemove } from '../hooks-cmd.js';

const mockedAutoDetectInit = autoDetectInit as Mock;
const mockedGetHookStatus = getHookStatus as Mock;
const mockedInjectHooksToAllTools = injectHooksToAllTools as Mock;
const mockedRemoveHooks = removeHooks as Mock;
const mockedLog = log as unknown as {
    info: Mock;
    success: Mock;
    warn: Mock;
    error: Mock;
    debug: Mock;
};

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

function mockHome(home: string): () => void {
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    return () => {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
    };
}

// ── Setup ────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    mockedAutoDetectInit.mockResolvedValue({ localConfig: mockLocalConfig, teamConfig: mockTeamConfig });
    mockedGetHookStatus.mockResolvedValue('missing');
    mockedInjectHooksToAllTools.mockResolvedValue(undefined);
    mockedRemoveHooks.mockResolvedValue(undefined);
});

// ── Tests ────────────────────────────────────────────────

describe('hooksInject', () => {
    it('should inject hooks into all tools when config exists', async () => {
        await hooksInject({});

        expect(mockedAutoDetectInit).toHaveBeenCalled();
        expect(mockedInjectHooksToAllTools).toHaveBeenCalledWith(
            mockTeamConfig.toolPaths,
            expect.any(String),
        );
        expect(mockedLog.success).toHaveBeenCalledWith(
            expect.stringContaining('Hooks injected'),
        );
    });

    it('should suppress success message with --silent option', async () => {
        await hooksInject({ silent: true });

        expect(mockedInjectHooksToAllTools).toHaveBeenCalled();
        expect(mockedLog.success).not.toHaveBeenCalled();
    });

    it('should propagate error when not initialized', async () => {
        mockedAutoDetectInit.mockRejectedValue(new Error('teamai is not initialized'));

        await expect(hooksInject({})).rejects.toThrow('not initialized');
    });

    it('should inject into project and user base dirs when project config detected', async () => {
        const restoreHome = mockHome('/home/testuser');
        const projectConfig = {
            ...mockLocalConfig,
            scope: 'project',
            projectRoot: '/path/to/project',
        };
        mockedAutoDetectInit.mockResolvedValue({ localConfig: projectConfig, teamConfig: mockTeamConfig });

        try {
            await hooksInject({});
        } finally {
            restoreHome();
        }

        expect(mockedInjectHooksToAllTools).toHaveBeenCalledTimes(2);
        expect(mockedInjectHooksToAllTools).toHaveBeenNthCalledWith(
            1,
            mockTeamConfig.toolPaths,
            '/path/to/project',
        );
        expect(mockedInjectHooksToAllTools).toHaveBeenNthCalledWith(
            2,
            mockTeamConfig.toolPaths,
            '/home/testuser',
        );
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
    it('should remove hooks from all tools with settings', async () => {
        await hooksRemove({});

        expect(mockedRemoveHooks).toHaveBeenCalledTimes(3); // claude, claude-internal, cursor
        expect(mockedLog.success).toHaveBeenCalledWith(
            expect.stringContaining('Hooks removed'),
        );
    });

    it('should warn on removal failure for individual tools', async () => {
        mockedRemoveHooks
            .mockResolvedValueOnce(undefined) // claude OK
            .mockRejectedValueOnce(new Error('ENOENT')) // claude-internal fails
            .mockResolvedValueOnce(undefined); // cursor OK

        await hooksRemove({});

        expect(mockedLog.warn).toHaveBeenCalledWith(
            expect.stringContaining('Failed to remove hooks from claude-internal'),
        );
        expect(mockedLog.success).toHaveBeenCalled();
    });

    it('should remove hooks from project and user base dirs when project config detected', async () => {
        const restoreHome = mockHome('/home/testuser');
        const projectConfig = {
            ...mockLocalConfig,
            scope: 'project',
            projectRoot: '/path/to/project',
        };
        mockedAutoDetectInit.mockResolvedValue({ localConfig: projectConfig, teamConfig: mockTeamConfig });

        try {
            await hooksRemove({});
        } finally {
            restoreHome();
        }

        expect(mockedRemoveHooks).toHaveBeenCalledTimes(6);
        expect(mockedRemoveHooks).toHaveBeenCalledWith(
            path.join('/path/to/project', '.claude/settings.json'),
            'claude',
        );
        expect(mockedRemoveHooks).toHaveBeenCalledWith(
            path.join('/path/to/project', '.claude-internal/settings.json'),
            'claude-internal',
        );
        expect(mockedRemoveHooks).toHaveBeenCalledWith(
            path.join('/path/to/project', '.cursor/hooks.json'),
            'cursor',
        );
        expect(mockedRemoveHooks).toHaveBeenCalledWith(
            path.join('/home/testuser', '.claude/settings.json'),
            'claude',
        );
        expect(mockedRemoveHooks).toHaveBeenCalledWith(
            path.join('/home/testuser', '.claude-internal/settings.json'),
            'claude-internal',
        );
        expect(mockedRemoveHooks).toHaveBeenCalledWith(
            path.join('/home/testuser', '.cursor/hooks.json'),
            'cursor',
        );
    });

    it('should not duplicate hook operations when HOME equals projectRoot', async () => {
        const restoreHome = mockHome('/path/to/project');
        const projectConfig = {
            ...mockLocalConfig,
            scope: 'project',
            projectRoot: '/path/to/project',
        };
        mockedAutoDetectInit.mockResolvedValue({ localConfig: projectConfig, teamConfig: mockTeamConfig });

        try {
            await hooksRemove({});
        } finally {
            restoreHome();
        }

        expect(mockedRemoveHooks).toHaveBeenCalledTimes(3);
    });

    it('should propagate error when not initialized', async () => {
        mockedAutoDetectInit.mockRejectedValue(new Error('teamai is not initialized'));

        await expect(hooksRemove({})).rejects.toThrow('not initialized');
    });
});
