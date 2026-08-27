import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
    autoDetectInit: vi.fn(),
    loadLocalConfig: vi.fn(),
    saveLocalConfig: vi.fn(),
    loadTeamConfig: vi.fn(),
    saveLocalConfigForScope: vi.fn(),
    loadStateForScope: vi.fn(),
    saveStateForScope: vi.fn(),
}));

vi.mock('../roles.js', () => ({
    loadRolesManifest: vi.fn().mockResolvedValue({
        version: 1,
        roles: [
            {
                id: 'hai',
                description: 'HyperAI R&D',
                resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'] },
            },
            {
                id: 'pm',
                description: 'Product Manager',
                resources: { knowledge: ['common', 'pm'], skills: ['common', 'pm'] },
            },
        ],
    }),
    listRoleIds: vi.fn().mockReturnValue(['hai', 'pm']),
}));

vi.mock('../utils/logger.js', () => ({
    log: {
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        dim: vi.fn(),
    },
    spinner: vi.fn(() => ({
        start: vi.fn().mockReturnThis(),
        succeed: vi.fn().mockReturnThis(),
        fail: vi.fn().mockReturnThis(),
        warn: vi.fn().mockReturnThis(),
        info: vi.fn().mockReturnThis(),
        stop: vi.fn().mockReturnThis(),
    })),
}));

import { rolesSet } from '../roles-cmd.js';
import {
    autoDetectInit,
    saveLocalConfig,
    saveLocalConfigForScope,
    loadStateForScope,
    saveStateForScope,
} from '../config.js';
import type { LocalConfig } from '../types.js';

describe('rolesSet — state invalidation', () => {
    const baseLocalConfig: LocalConfig = {
        repo: { localPath: '/tmp/fake-repo', remote: 'https://git.woa.com/test/repo.git' },
        username: 'testuser',
        updatePolicy: 'auto',
        primaryRole: 'hai',
        additionalRoles: [],
        resourceProfileVersion: 1,
        scope: 'user',
    };

    beforeEach(() => {
        vi.mocked(autoDetectInit).mockResolvedValue({
            localConfig: { ...baseLocalConfig },
            teamConfig: {
                team: 'test',
                description: '',
                repo: 'https://git.woa.com/test/repo.git',
                provider: 'tgit' as const,
                reviewers: [],
                sharing: {
                    skills: {},
                    rules: { enforced: [] },
                    docs: { localDir: '' },
                    env: { injectShellProfile: true },
                },
                toolPaths: {
                    claude: { skills: '.claude/skills', rules: '.claude/rules' },
                },
            },
        });

        vi.mocked(loadStateForScope).mockResolvedValue({
            lastPull: '2026-04-01',
            lastPullRev: 'abc1234',
            lastPush: null,
            pushedRules: [],
            pushedSkills: [],
            pushedEnvVars: [],
            pendingPushes: [],
            lastUpdateCheck: null,
            availableUpdate: null,
        });
        vi.mocked(saveStateForScope).mockResolvedValue(undefined);
        vi.mocked(saveLocalConfig).mockResolvedValue(undefined);
        vi.mocked(saveLocalConfigForScope).mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should clear lastPullRev when setting a new role', async () => {
        await rolesSet('pm', {});

        expect(saveStateForScope).toHaveBeenCalledTimes(1);
        const savedState = vi.mocked(saveStateForScope).mock.calls[0][0];
        expect(savedState.lastPullRev).toBeNull();
        expect(savedState.lastPull).toBe('2026-04-01');
    });

    it('should save config with the new role before invalidating state', async () => {
        await rolesSet('pm', {});

        // Config should be saved
        expect(saveLocalConfig).toHaveBeenCalledTimes(1);
        const savedConfig = vi.mocked(saveLocalConfig).mock.calls[0][0];
        expect(savedConfig.primaryRole).toBe('pm');

        // State should be invalidated
        expect(saveStateForScope).toHaveBeenCalledTimes(1);
    });

    it('should not fail if state loading throws', async () => {
        vi.mocked(loadStateForScope).mockRejectedValue(new Error('State file not found'));

        // Should not throw
        await rolesSet('pm', {});

        // Config should still be saved successfully
        expect(saveLocalConfig).toHaveBeenCalledTimes(1);
    });

    it('should clear lastPullRev for project scope', async () => {
        vi.mocked(autoDetectInit).mockResolvedValue({
            localConfig: { ...baseLocalConfig, scope: 'project', projectRoot: '/tmp/my-project' },
            teamConfig: {
                team: 'test',
                description: '',
                repo: 'https://git.woa.com/test/repo.git',
                provider: 'tgit' as const,
                reviewers: [],
                sharing: {
                    skills: {},
                    rules: { enforced: [] },
                    docs: { localDir: '' },
                    env: { injectShellProfile: true },
                },
                toolPaths: {
                    claude: { skills: '.claude/skills', rules: '.claude/rules' },
                },
            },
        });

        await rolesSet('pm', {});

        expect(saveStateForScope).toHaveBeenCalledWith(
            expect.objectContaining({ lastPullRev: null }),
            'project',
            '/tmp/my-project',
        );
    });

    it('should handle setting additional roles', async () => {
        await rolesSet('hai', { add: ['pm'] });

        // Config should include additional roles
        expect(saveLocalConfig).toHaveBeenCalledTimes(1);
        const savedConfig = vi.mocked(saveLocalConfig).mock.calls[0][0];
        expect(savedConfig.primaryRole).toBe('hai');
        expect(savedConfig.additionalRoles).toEqual(['pm']);

        // State should still be invalidated
        expect(saveStateForScope).toHaveBeenCalledTimes(1);
        const savedState = vi.mocked(saveStateForScope).mock.calls[0][0];
        expect(savedState.lastPullRev).toBeNull();
    });
});
