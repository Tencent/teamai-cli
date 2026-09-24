import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
    autoDetectInit: vi.fn(),
}));

vi.mock('../hooks.js', async () => {
    const actual = await vi.importActual<typeof import('../hooks.js')>('../hooks.js');
    return {
        getHookStatus: vi.fn(),
        reconcileHooks: vi.fn(),
        reconcileHooksToAllTools: vi.fn(),
        reconcileTeamHooksForConfig: vi.fn(),
        sweepLegacyProjectHooks: vi.fn(),
        hasInstalledCodexTrustGatedTool: vi.fn(),
        // Keep the real reminder text so assertions verify the actual wording.
        codexTrustReminder: actual.codexTrustReminder,
    };
});

vi.mock('../resources/hooks.js', () => ({
    parseTeamHooksConfig: vi.fn(),
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
import { getHookStatus, reconcileHooks, reconcileHooksToAllTools, reconcileTeamHooksForConfig, sweepLegacyProjectHooks, hasInstalledCodexTrustGatedTool } from '../hooks.js';
import { parseTeamHooksConfig } from '../resources/hooks.js';
import { log } from '../utils/logger.js';
import { hooksInject, hooksRemove, hooksList } from '../hooks-cmd.js';
import { TeamaiConfigSchema } from '../types.js';

const mockedAutoDetectInit = autoDetectInit as Mock;
const mockedGetHookStatus = getHookStatus as Mock;
const mockedSweep = sweepLegacyProjectHooks as Mock;
const mockedReconcileStandalone = reconcileHooks as Mock;
const mockedReconcile = reconcileHooksToAllTools as Mock;
const mockedReconcileForConfig = reconcileTeamHooksForConfig as Mock;
const mockedHasCodexTrustGated = hasInstalledCodexTrustGatedTool as Mock;
const mockedParseTeamHooks = parseTeamHooksConfig as Mock;

/** hooks.yaml parse result: team defs (B) plus the optional builtin override. */
function hooksYaml(defs: unknown[], builtin?: unknown) {
    return { defs, builtin };
}
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
const COPILOT_HOME_FIXTURE = '/tmp/custom-copilot';

function copilotConfig() {
    return {
        ...mockTeamConfig,
        toolPaths: {
            copilot: {
                hooks: '.github/hooks/teamai.json',
                userScope: { hooks: 'hooks/teamai.json' },
            },
        },
    };
}

/** Hook lines listed under `<tool>:` in the built-in (A) block. */
function builtinBlock(text: string, tool: string): string[] | undefined {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^ {2}\S/.test(l) && l.trim().slice(0, -1).split(', ').includes(tool));
    if (start === -1) return undefined;
    const block: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (!line.startsWith('    ')) break;
        block.push(line.trim());
    }
    return block;
}

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
    mockedReconcileStandalone.mockResolvedValue(undefined);
    mockedReconcile.mockResolvedValue(undefined);
    mockedReconcileForConfig.mockResolvedValue(undefined);
    mockedHasCodexTrustGated.mockResolvedValue(false);
    mockedParseTeamHooks.mockResolvedValue(hooksYaml(TEAM_DEFS));
});

describe('hooksInject', () => {
    it('reconciles built-in + team hooks across all tools (user scope)', async () => {
        await hooksInject({});

        expect(mockedAutoDetectInit).toHaveBeenCalled();
        // Injection routes through reconcileTeamHooksForConfig so it applies
        // the same enabledAgents whitelist minus disabledAgents scoping as
        // pull and init (the per-tool reconciliation itself is covered by the
        // hooks-reconcile tests).
        expect(mockedReconcileForConfig).toHaveBeenCalledTimes(1);
        expect(mockedReconcileForConfig).toHaveBeenCalledWith(
            mockTeamConfig,
            mockLocalConfig,
            expect.objectContaining({ auto: false }),
        );
        expect(mockedLog.success).toHaveBeenCalledWith(expect.stringContaining('Hooks injected'));
    });

    it('suppresses success message with --silent', async () => {
        await hooksInject({ silent: true });
        expect(mockedReconcileForConfig).toHaveBeenCalled();
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

    it('delegates reconciliation to the shared per-config choke point (project scope)', async () => {
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: { ...mockLocalConfig, scope: 'project', projectRoot: '/path/to/project' },
            teamConfig: mockTeamConfig,
        });
        await hooksInject({});

        // #264/#370: HOME targeting and the legacy <projectRoot> sweep are owned
        // by the shared reconcileTeamHooksForConfig choke point (identical to
        // init/pull); their on-disk behavior is covered in
        // hooks-reconcile-scope.test.ts.
        expect(mockedReconcileForConfig).toHaveBeenCalledTimes(1);
        expect(mockedReconcileForConfig).toHaveBeenCalledWith(
            mockTeamConfig,
            expect.objectContaining({ scope: 'project', projectRoot: '/path/to/project' }),
            expect.objectContaining({ auto: false }),
        );
    });
});

describe('hooksList', () => {
    it('prints built-in hooks and team hooks from hooks.yaml', async () => {
        mockedParseTeamHooks.mockResolvedValue(hooksYaml([
            { source: 'team', key: 'lint', event: 'Stop', command: 'npm run lint', description: '[teamai:hook:lint] lint', tools: ['claude'] },
        ]));
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

    it('prints the roles restriction next to the tools one', async () => {
        mockedParseTeamHooks.mockResolvedValue(hooksYaml([
            { source: 'team', key: 'guard-tf', event: 'PreToolUse', matcher: 'Bash', command: 'guard-tf.sh', description: '[teamai:hook:guard-tf] x', roles: ['devops'] },
            { source: 'team', key: 'lint', event: 'Stop', command: 'npm run lint', description: '[teamai:hook:lint] lint' },
        ]));
        const out: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
        try {
            await hooksList({});
        } finally {
            spy.mockRestore();
        }
        const text = out.join('\n');
        expect(text).toContain('(tools: all, roles: devops)');
        expect(text).toContain('npm run lint  (tools: all)');
    });

    it('prints the projects restriction next to the roles one', async () => {
        mockedParseTeamHooks.mockResolvedValue(hooksYaml([
            { source: 'team', key: 'checkout-lint', event: 'Stop', command: 'echo checkout', description: '[teamai:hook:checkout-lint] x', projects: ['checkout'] },
            { source: 'team', key: 'both', event: 'Stop', command: 'echo both', description: '[teamai:hook:both] x', roles: ['frontend'], projects: ['checkout', 'billing'] },
            { source: 'team', key: 'nobody', event: 'Stop', command: 'echo none', description: '[teamai:hook:nobody] x', projects: [] },
        ]));
        const out: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
        try {
            await hooksList({});
        } finally {
            spy.mockRestore();
        }
        const text = out.join('\n');
        expect(text).toContain('(tools: all, projects: checkout)');
        expect(text).toContain('(tools: all, roles: frontend, projects: checkout,billing)');
        expect(text).toContain('(tools: all, projects: nobody)');
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
                undefined,
            );
            expect(mockedGetHookStatus).toHaveBeenCalledWith(
                path.join('/home/testuser', '.claude-internal/settings.json'),
                'claude-internal',
                undefined,
            );
            expect(mockedGetHookStatus).toHaveBeenCalledWith(
                path.join('/home/testuser', '.cursor/hooks.json'),
                'cursor',
                undefined,
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
                undefined,
            );
            expect(mockedGetHookStatus).not.toHaveBeenCalledWith(
                path.join('/path/to/project', '.claude/settings.json'),
                'claude',
                undefined,
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

    // #667: a non-self project scope injects hooks into HOME (#264), so the file
    // to probe is the one the injected scope names. Qoder CN keeps its user-scope
    // resources in ~/.qoder-cn, so the previous project-scope lookup probed the
    // international build's ~/.qoder/settings.json and always said "missing".
    it('probes each tool settings file at the scope hooks were injected into', async () => {
        const restoreHome = mockHome('/home/testuser');
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: { ...mockLocalConfig, scope: 'project', projectRoot: '/path/to/project' },
            teamConfig: TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' }),
        });

        try {
            await hooksList({});
        } finally {
            restoreHome();
            consoleLog.mockRestore();
        }

        expect(mockedGetHookStatus).toHaveBeenCalledWith(
            path.join('/home/testuser', '.qoder-cn', 'settings.json'),
            'qoder-cn',
            undefined,
        );
        expect(mockedGetHookStatus).not.toHaveBeenCalledWith(
            path.join('/home/testuser', '.qoder', 'settings.json'),
            'qoder-cn',
            undefined,
        );
    });

    // #667: Qoder CN's project scope IS Qoder's `<root>/.qoder/settings.json`, so
    // the file is one install. Listing it twice would report the second target as
    // "missing" — the hooks there carry the owning target's dispatch identity.
    it('lists a settings file shared by two targets once, for its owner', async () => {
        const restoreHome = mockHome('/home/testuser');
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const projectRoot = '/path/to/project';
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: {
                ...mockLocalConfig,
                scope: 'project',
                projectRoot,
                repo: { ...mockLocalConfig.repo, kind: 'self', businessRepoRoot: projectRoot },
            },
            teamConfig: TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' }),
        });

        try {
            await hooksList({});
        } finally {
            restoreHome();
            consoleLog.mockRestore();
        }

        const shared = path.join(projectRoot, '.qoder', 'settings.json');
        expect(mockedGetHookStatus).toHaveBeenCalledWith(shared, 'qoder', undefined);
        expect(mockedGetHookStatus).not.toHaveBeenCalledWith(shared, 'qoder-cn', undefined);
    });

    // #667: ownership of the file shared by Qoder and Qoder CN follows the
    // *enabled* target, not the shipped table order. The write path only ever
    // renders the file for an enabled target (`filterAgents`), so `hooks list`
    // must skip a disabled one before it can claim the file. Otherwise a
    // self-scope install that enabled Qoder CN alone probed
    // `<root>/.qoder/settings.json` for Qoder's dispatch identity, reported
    // `missing`, and never listed the enabled `qoder-cn` at all.
    it('gives the shared file to the enabled target, not the table-earlier one', async () => {
        const restoreHome = mockHome('/home/testuser');
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const projectRoot = '/path/to/project';
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: {
                ...mockLocalConfig,
                scope: 'project',
                projectRoot,
                enabledAgents: ['qoder-cn'],
                repo: { ...mockLocalConfig.repo, kind: 'self', businessRepoRoot: projectRoot },
            },
            teamConfig: TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' }),
        });

        try {
            await hooksList({});
        } finally {
            restoreHome();
            consoleLog.mockRestore();
        }

        const shared = path.join(projectRoot, '.qoder', 'settings.json');
        expect(mockedGetHookStatus).toHaveBeenCalledWith(shared, 'qoder-cn', undefined);
        // `qoder` is not enabled, so it must not claim — and mis-probe — the file.
        expect(mockedGetHookStatus).not.toHaveBeenCalledWith(shared, 'qoder', undefined);
    });

    // The same rule with no whitelist: `disabledAgents` alone moves ownership.
    it('gives the shared file to Qoder CN when Qoder is disabled', async () => {
        const restoreHome = mockHome('/home/testuser');
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const projectRoot = '/path/to/project';
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: {
                ...mockLocalConfig,
                scope: 'project',
                projectRoot,
                disabledAgents: ['qoder'],
                repo: { ...mockLocalConfig.repo, kind: 'self', businessRepoRoot: projectRoot },
            },
            teamConfig: TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' }),
        });

        try {
            await hooksList({});
        } finally {
            restoreHome();
            consoleLog.mockRestore();
        }

        const shared = path.join(projectRoot, '.qoder', 'settings.json');
        expect(mockedGetHookStatus).toHaveBeenCalledWith(shared, 'qoder-cn', undefined);
        expect(mockedGetHookStatus).not.toHaveBeenCalledWith(shared, 'qoder', undefined);
    });

    it('lists standalone Copilot hooks under COPILOT_HOME', async () => {
        const originalCopilotHome = process.env.COPILOT_HOME;
        process.env.COPILOT_HOME = COPILOT_HOME_FIXTURE;
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: { ...mockLocalConfig, enabledAgents: ['copilot'] },
            teamConfig: copilotConfig(),
        });

        try {
            await hooksList({});
        } finally {
            if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
            else process.env.COPILOT_HOME = originalCopilotHome;
            consoleLog.mockRestore();
        }

        expect(mockedGetHookStatus).toHaveBeenCalledWith(
            path.join(COPILOT_HOME_FIXTURE, 'hooks/teamai.json'),
            'copilot',
            undefined,
        );
    });

    it('prints the built-in hook set of each listed tool, including Copilot SessionEnd', async () => {
        const originalCopilotHome = process.env.COPILOT_HOME;
        process.env.COPILOT_HOME = COPILOT_HOME_FIXTURE;
        const out: string[] = [];
        const consoleLog = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: { ...mockLocalConfig, enabledAgents: ['copilot'] },
            teamConfig: copilotConfig(),
        });

        try {
            await hooksList({});
        } finally {
            if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
            else process.env.COPILOT_HOME = originalCopilotHome;
            consoleLog.mockRestore();
        }

        // Copilot's built-in set carries an extra SessionEnd entry that no other
        // tool has; listing a hardcoded tool's set hides it even though inject
        // really installs it.
        const text = out.join('\n');
        expect(text).toContain('  copilot:');
        expect(text).toContain('SessionEnd');
        expect(text).toContain('hook-dispatch session-end');
    });

    it('hides a built-in hook the team disabled in hooks.yaml', async () => {
        // The reconcile engine applies `builtin.disabled`, so a hook listed
        // here that is no longer in the settings file would be a lie.
        mockedParseTeamHooks.mockResolvedValue(hooksYaml([], { disabled: ['Hook dispatch stop'] }));
        const out: string[] = [];
        const consoleLog = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });

        try {
            await hooksList({});
        } finally {
            consoleLog.mockRestore();
        }

        const text = out.join('\n');
        const builtin = text.slice(text.indexOf('Built-in hooks (A)'), text.indexOf('Team hooks (B)'));
        const claude = builtinBlock(builtin, 'claude') ?? [];
        expect(claude).toHaveLength(5);
        expect(claude.join('\n')).not.toContain('Stop  →');
    });

    it('reports adapter-driven tools by their generated artifact, not "not configured"', async () => {
        // Hermes / OpenCode / OMP / OpenClaw have no settings file to probe:
        // reconciliation writes one generated artifact each, so its presence
        // is the status. Falling through to the generic branch printed
        // "not configured" for tools the pipeline does install hooks for.
        const restoreHome = mockHome('/home/testuser');
        const out: string[] = [];
        const consoleLog = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: mockLocalConfig,
            teamConfig: { toolPaths: { hermes: { skills: '.hermes/skills' } } },
        });

        try {
            await hooksList({});
        } finally {
            restoreHome();
            consoleLog.mockRestore();
        }

        const text = out.join('\n');
        expect(text).toContain('~/.hermes/hooks/teamai-status-report.sh');
        expect(text).not.toContain('no settings configured');
    });

    it('checks tool status against the overridden built-in set', async () => {
        // Reconciliation applies `builtin.disabled` when writing, so a status
        // check that still expects the disabled hook reads `missing` forever.
        mockedParseTeamHooks.mockResolvedValue(hooksYaml([], { disabled: ['Hook dispatch stop'] }));
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await hooksList({});
        } finally {
            consoleLog.mockRestore();
        }

        expect(mockedGetHookStatus).toHaveBeenCalledWith(
            expect.any(String),
            'claude',
            { disabled: ['Hook dispatch stop'] },
        );
    });

    it('lists only the built-in hooks a tool actually receives (#717)', async () => {
        const out: string[] = [];
        const consoleLog = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: mockLocalConfig,
            teamConfig: {
                toolPaths: {
                    claude: { settings: '.claude/settings.json', skills: '.claude/skills' },
                    // Standalone adapters: each covers a narrower slice of the
                    // built-in set than the settings-file tools.
                    hermes: { skills: '.hermes/skills' },
                    omp: { skills: '.omp/skills' },
                    openclaw: { skills: '.openclaw/skills' },
                    // No built-in hook from the hook pipeline.
                    joycode: { skills: '.joycode/skills' },
                    kiro: { skills: '.kiro/skills', agents: '.kiro/agents' },
                },
            },
        });

        try {
            await hooksList({});
        } finally {
            consoleLog.mockRestore();
        }

        const text = out.join('\n');
        const builtin = text.slice(text.indexOf('Built-in hooks (A)'), text.indexOf('Team hooks (B)'));

        // Claude is reconciled through its settings file: the whole set.
        expect(builtinBlock(builtin, 'claude')).toHaveLength(6);
        // Hermes installs a single on_session_start script running the raw
        // dispatch command (hermes-hooks.ts).
        expect(builtinBlock(builtin, 'hermes')).toEqual([
            'SessionStart  →  teamai hook-dispatch session-start --tool <tool> >/dev/null 2>&1 || true',
        ]);
        // OMP's extension subscribes to four events and has no matcher-scoped
        // PostToolUse pass (omp-hooks.ts).
        const omp = builtinBlock(builtin, 'omp') ?? [];
        expect(omp).toHaveLength(4);
        expect(omp.join('\n')).not.toContain('[Skill]');
        expect(omp.join('\n')).not.toContain('[TodoWrite]');
        // OpenClaw's handler maps session:start and command:new only
        // (openclaw-hooks.ts EVENT_MAP).
        expect(builtinBlock(builtin, 'openclaw')).toEqual([
            'SessionStart  →  teamai hook-dispatch session-start --tool <tool>',
            'UserPromptSubmit  →  teamai hook-dispatch prompt-submit --tool <tool>',
        ]);
        // JoyCode has no hook surface, and Kiro's session-start command is
        // embedded per agent by the agent sync instead of the hook pipeline:
        // neither may be listed.
        expect(builtinBlock(builtin, 'joycode')).toBeUndefined();
        expect(builtinBlock(builtin, 'kiro')).toBeUndefined();
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
            { removeAll: true, scope: 'user', installedBaseDir: undefined },
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
        // Main removal targets HOME with the user manifest; the legacy
        // <projectRoot> cleanup is delegated to the shared sweep helper.
        expect(mockedReconcile).toHaveBeenCalledTimes(1);
        expect(mockedReconcile).toHaveBeenCalledWith(
            mockTeamConfig.toolPaths,
            '/home/testuser',
            [],
            expect.any(String),
            { removeAll: true, scope: 'project', installedBaseDir: '/path/to/project' },
        );
        const userManifest = mockedReconcile.mock.calls[0][3] as string;
        expect(userManifest).toContain('/home/testuser');
        expect(mockedSweep).toHaveBeenCalledWith(
            mockTeamConfig.toolPaths,
            expect.objectContaining({ scope: 'project', projectRoot: '/path/to/project' }),
        );
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
        // it must not fire — exactly one removal against <projectRoot>. The
        // "must not fire" half lives in resolveLegacyProjectHookScope, which
        // returns null for self mode (see types.test.ts).
        expect(mockedReconcile).toHaveBeenCalledTimes(1);
        expect(mockedReconcile).toHaveBeenCalledWith(
            mockTeamConfig.toolPaths,
            '/path/to/project',
            [],
            expect.any(String),
            { removeAll: true, scope: 'project', installedBaseDir: '/path/to/project' },
        );
    });

    it('explicit project removal deletes the shared Pi extension', async () => {
        const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-hooks-remove-pi-'));
        const restoreHome = mockHome(tmp);
        const globalPiHook = path.join(tmp, '.pi', 'agent', 'extensions', 'teamai-hooks.ts');
        await fse.ensureDir(path.dirname(globalPiHook));
        await fse.writeFile(globalPiHook, '// [teamai] hooks extension');
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: { ...mockLocalConfig, scope: 'project', projectRoot: '/path/to/project' },
            teamConfig: { toolPaths: { pi: { skills: '.pi/skills' } } },
        });

        try {
            await hooksRemove({});
            expect(await fse.pathExists(globalPiHook)).toBe(false);
        } finally {
            restoreHome();
            await fse.remove(tmp);
        }
    });

    it('removes standalone Copilot hooks under COPILOT_HOME', async () => {
        const originalCopilotHome = process.env.COPILOT_HOME;
        process.env.COPILOT_HOME = COPILOT_HOME_FIXTURE;
        mockedAutoDetectInit.mockResolvedValue({
            localConfig: { ...mockLocalConfig, enabledAgents: ['copilot'] },
            teamConfig: copilotConfig(),
        });

        try {
            await hooksRemove({});
        } finally {
            if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
            else process.env.COPILOT_HOME = originalCopilotHome;
        }

        expect(mockedReconcileStandalone).toHaveBeenCalledWith(
            path.join(COPILOT_HOME_FIXTURE, 'hooks/teamai.json'),
            'copilot',
            [],
            expect.objectContaining({ removeAll: true }),
        );
    });

    it('propagates error when not initialized', async () => {
        mockedAutoDetectInit.mockRejectedValue(new Error('teamai is not initialized'));
        await expect(hooksRemove({})).rejects.toThrow('not initialized');
    });
});
