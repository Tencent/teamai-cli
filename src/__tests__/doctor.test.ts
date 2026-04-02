import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../config.js', () => ({
    loadLocalConfig: vi.fn(),
    loadTeamConfig: vi.fn(),
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
import { doctor } from '../doctor.js';

const mockedLoadLocalConfig = loadLocalConfig as Mock;
const mockedLoadTeamConfig = loadTeamConfig as Mock;
const mockedPathExists = pathExists as Mock;
const mockedReadFileSafe = readFileSafe as Mock;

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
        await doctor({});

        // Should show the hooks check passing (✔)
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('✔'),
        );
    });

    it('should fail when a subcommand is missing from settings', async () => {
        // Missing 'contribute-check' subcommand
        mockedReadFileSafe.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json')) {
                return buildPartialHooksContent(['contribute-check']);
            }
            if (filePath.includes('.zshrc') || filePath.includes('.bashrc')) {
                return '# [teamai:env:start]';
            }
            return null;
        });

        await doctor({});

        // Should show the hooks check failing (✖) with fix suggestion
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('✖'),
        );
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('teamai hooks inject'),
        );
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
        // Verify the subcommands list is what we expect
        expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('pull');
        expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('update');
        expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('track');
        expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('track-slash');
        expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('dashboard-report');
        expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('contribute-check');
        expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('auto-recall');
        expect(TEAMAI_HOOK_SUBCOMMANDS).toHaveLength(7);
    });
});
