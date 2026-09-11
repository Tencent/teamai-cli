import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// ─── Shared fixtures ───────────────────────────────────────

const TEAM_CONFIG = {
    toolPaths: {
        claude: {
            skills: '.claude/skills',
            rules: '.claude/rules',
            agents: '.claude/agents',
            settings: '.claude/settings.json',
            claudemd: '.claude/CLAUDE.md',
        },
        hermes: {
            skills: '.hermes/skills',
            rules: '.hermes/rules',
            agents: '.hermes/agents',
            claudemd: '.hermes/CLAUDE.md',
        },
        // cursor is in ALL_SUPPORTED_TOOLS (unlike hermes), so deployBuiltinAgents
        // has no format gate to hide behind: it isolates the whitelist check alone.
        cursor: {
            skills: '.cursor/skills',
            rules: '.cursor/rules',
            agents: '.cursor/agents',
        },
    },
} as any;

/** localConfig with `claude` whitelisted; `hermes` installed but NOT opted in. */
const WHITELIST_CONFIG = { enabledAgents: ['claude'], disabledAgents: [] } as any;

function installBothTools(home: string): void {
    for (const dir of [
        '.claude/skills', '.claude/rules', '.claude/agents',
        '.hermes/skills', '.hermes/rules', '.hermes/agents',
        '.cursor/skills', '.cursor/rules', '.cursor/agents',
    ]) {
        fs.mkdirSync(path.join(home, dir), { recursive: true });
    }
}

// ─── Part A/B: disk-level checks, no mocks ─────────────────

describe('enabledAgents whitelist gates resource writes (issue #510)', () => {
    let tmpDir: string;
    let originalHome: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-agent-wl-'));
        originalHome = process.env.HOME ?? '';
        process.env.HOME = tmpDir;
        installBothTools(tmpDir);
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('deployBuiltinSkills', () => {
        it('deploys builtins into the whitelisted tool', async () => {
            const { deployBuiltinSkills } = await import('../builtin-skills.js');
            await deployBuiltinSkills(TEAM_CONFIG, WHITELIST_CONFIG);
            expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'team-wiki-codebase'))).toBe(true);
        });

        it('must NOT write builtin skills into an installed tool outside the whitelist', async () => {
            const { deployBuiltinSkills } = await import('../builtin-skills.js');
            await deployBuiltinSkills(TEAM_CONFIG, WHITELIST_CONFIG);
            expect(fs.readdirSync(path.join(tmpDir, '.hermes', 'skills'))).toEqual([]);
        });
    });

    describe('deployBuiltinRules', () => {
        it('deploys builtin rules into the whitelisted tool', async () => {
            const { deployBuiltinRules } = await import('../builtin-rules.js');
            await deployBuiltinRules(TEAM_CONFIG, WHITELIST_CONFIG);
            expect(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'teamai-recall.md'))).toBe(true);
        });

        it('must NOT write builtin rules into an installed tool outside the whitelist', async () => {
            const { deployBuiltinRules } = await import('../builtin-rules.js');
            await deployBuiltinRules(TEAM_CONFIG, WHITELIST_CONFIG);
            expect(fs.readdirSync(path.join(tmpDir, '.hermes', 'rules'))).toEqual([]);
        });
    });

    describe('deployBuiltinAgents', () => {
        it('deploys builtin agents into the whitelisted tool', async () => {
            const { deployBuiltinAgents } = await import('../builtin-agents.js');
            await deployBuiltinAgents(TEAM_CONFIG, WHITELIST_CONFIG);
            const deployed = fs.readdirSync(path.join(tmpDir, '.claude', 'agents'));
            expect(deployed.length).toBeGreaterThan(0);
        });

        it('must NOT write builtin agents into an installed tool outside the whitelist', async () => {
            const { deployBuiltinAgents } = await import('../builtin-agents.js');
            await deployBuiltinAgents(TEAM_CONFIG, WHITELIST_CONFIG);
            expect(fs.readdirSync(path.join(tmpDir, '.cursor', 'agents'))).toEqual([]);
        });
    });

    describe('injectRecallBlockIntoTools', () => {
        it('injects the recall block into the whitelisted tool CLAUDE.md', async () => {
            const { injectRecallBlockIntoTools } = await import('../pull.js');
            const { TEAMAI_RECALL_RULES_START } = await import('../types.js');
            await injectRecallBlockIntoTools(TEAM_CONFIG, { ...WHITELIST_CONFIG, recallEnabled: true } as any, 'test');
            expect(fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8')).toContain(TEAMAI_RECALL_RULES_START);
        });

        it('must NOT inject into an installed tool outside the whitelist', async () => {
            const { injectRecallBlockIntoTools } = await import('../pull.js');
            await injectRecallBlockIntoTools(TEAM_CONFIG, { ...WHITELIST_CONFIG, recallEnabled: true } as any, 'test');
            expect(fs.existsSync(path.join(tmpDir, '.hermes', 'CLAUDE.md'))).toBe(false);
        });
    });
});

// ─── Part C: lastPullTargets via pull() (mocked externals) ──

vi.mock('../config.js', () => ({
    requireInit: vi.fn(),
    loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
    saveState: vi.fn(),
    loadLocalConfigForScope: vi.fn(),
    loadTeamConfig: vi.fn(),
    detectProjectConfig: vi.fn().mockResolvedValue(null),
    loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
    saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
    pullRepo: vi.fn().mockResolvedValue('already up to date'),
    getHeadRev: vi.fn().mockResolvedValue('abc1234'),
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

vi.mock('../roles.js', () => ({
    loadRolesManifest: vi.fn().mockResolvedValue({
        version: 1,
        roles: [
            {
                id: 'hai',
                name: 'HAI R&D',
                description: 'HyperAI resources',
                resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], learnings: ['common', 'hai'] },
            },
        ],
        defaults: { shareTarget: 'primary-role' },
    }),
    resolveRoleResourceNamespaces: vi.fn(({ manifest, primaryRole, additionalRoles }) => {
        const allRoles = [primaryRole, ...additionalRoles].map((id: string) =>
            manifest.roles.find((role: { id: string }) => role.id === id),
        );
        const dedupe = (values: string[]) => [...new Set(values)];
        return {
            knowledge: dedupe(allRoles.flatMap((role: { resources: { knowledge: string[] } }) => role.resources.knowledge)),
            skills: dedupe(allRoles.flatMap((role: { resources: { skills: string[] } }) => role.resources.skills)),
            learnings: dedupe(allRoles.flatMap((role: { resources: { learnings: string[] } }) => role.resources.learnings)),
        };
    }),
}));

vi.mock('../update.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig, detectProjectConfig, loadStateForScope, saveStateForScope } from '../config.js';
import { getHeadRev } from '../utils/git.js';
import { log } from '../utils/logger.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('enabledAgents whitelist gates lastPullTargets (issue #510 repro 2)', () => {
    let tmpDir: string;
    let homeDir: string;
    let repoPath: string;

    beforeEach(async () => {
        tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-wl-targets-'));
        homeDir = path.join(tmpDir, 'home');
        repoPath = path.join(tmpDir, 'team-repo');

        await fse.ensureDir(path.join(repoPath, 'rules'));
        await fse.ensureDir(path.join(repoPath, 'skills', 'common'));
        await fse.ensureDir(path.join(repoPath, 'skills', 'hai'));
        await fse.ensureDir(path.join(repoPath, 'learnings', 'common'));
        await fse.ensureDir(path.join(repoPath, 'learnings', 'hai'));
        await fse.ensureDir(path.join(repoPath, 'manifest'));
        await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');
        installBothTools(homeDir);

        vi.stubEnv('HOME', homeDir);

        const teamConfig: TeamaiConfig = {
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
            toolPaths: TEAM_CONFIG.toolPaths,
        };

        const localConfig: LocalConfig = {
            repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
            username: 'testuser',
            updatePolicy: 'auto',
            primaryRole: 'hai',
            additionalRoles: [],
            resourceProfileVersion: 1,
            scope: 'user',
            enabledAgents: ['claude'],
        } as any;

        vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
        vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
        vi.mocked(detectProjectConfig).mockResolvedValue(null);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
        await fse.remove(tmpDir);
    });

    it('records only whitelisted tools in lastPullTargets on first sync', async () => {
        vi.mocked(getHeadRev).mockResolvedValue('abc1234');
        vi.mocked(loadStateForScope).mockResolvedValue({
            lastPull: null,
            lastPullRev: null,
            lastPush: null,
            pushedRules: [],
            pushedSkills: [],
            pushedEnvVars: [],
            pendingPushes: [],
            lastUpdateCheck: null,
            availableUpdate: null,
        });

        await pull({});

        expect(saveStateForScope).toHaveBeenCalled();
        expect(vi.mocked(saveStateForScope).mock.calls[0][0].lastPullTargets).toEqual(['claude']);
    });

    it('does not skip sync when a newly whitelisted installed tool joins with unchanged HEAD', async () => {
        vi.mocked(getHeadRev).mockResolvedValue('abc1234');
        vi.mocked(loadStateForScope).mockResolvedValue({
            lastPull: '2026-04-01',
            lastPullRev: 'abc1234',
            lastPullTargets: ['claude'],
            lastPush: null,
            pushedRules: [],
            pushedSkills: [],
            pushedEnvVars: [],
            pendingPushes: [],
            lastUpdateCheck: null,
            availableUpdate: null,
        });
        // User adds hermes to the whitelist without re-running init (rev cache not cleared).
        vi.mocked(loadLocalConfigForScope).mockResolvedValue({
            repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
            username: 'testuser',
            updatePolicy: 'auto',
            primaryRole: 'hai',
            additionalRoles: [],
            resourceProfileVersion: 1,
            scope: 'user',
            enabledAgents: ['claude', 'hermes'],
        } as any);

        await pull({});

        expect(log.success).not.toHaveBeenCalledWith(
            expect.stringContaining('Already synced'),
        );
        expect(saveStateForScope).toHaveBeenCalled();
        expect(vi.mocked(saveStateForScope).mock.calls[0][0].lastPullTargets).toEqual(['claude', 'hermes']);
    });
});
