import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── Test helpers ──────────────────────────────────────────

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-builtin-rules-'));
}

describe('builtin-rules', () => {
    let tmpDir: string;
    let originalHome: string;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        originalHome = process.env.HOME ?? '';
        process.env.HOME = tmpDir;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('deployBuiltinRules', () => {
        it('should deploy teamai-recall.md rule to tool rules directory', async () => {
            const claudeRulesDir = path.join(tmpDir, '.claude', 'rules');
            fs.mkdirSync(claudeRulesDir, { recursive: true });

            const teamConfig = {
                toolPaths: {
                    claude: {
                        skills: '.claude/skills',
                        rules: '.claude/rules',
                        settings: '.claude/settings.json',
                        claudemd: '.claude/CLAUDE.md',
                    },
                },
            } as any;

            const { deployBuiltinRules } = await import('../builtin-rules.js');
            await deployBuiltinRules(teamConfig);

            const deployed = path.join(claudeRulesDir, 'teamai-recall.md');
            expect(fs.existsSync(deployed)).toBe(true);
            const content = fs.readFileSync(deployed, 'utf-8');
            expect(content).toContain('Team Knowledge Recall');
            expect(content).toContain('teamai recall');
        });

        it('deploys an English-only recall rule when language is en and treats that body as teamai-owned (#1014)', async () => {
            const claudeRulesDir = path.join(tmpDir, '.claude', 'rules');
            fs.mkdirSync(claudeRulesDir, { recursive: true });
            const teamConfig = {
                language: 'en',
                toolPaths: { claude: { rules: '.claude/rules' } },
            } as any;

            const { deployBuiltinRules, isDeployedRecallRule } = await import('../builtin-rules.js');
            await deployBuiltinRules(teamConfig);

            const content = fs.readFileSync(path.join(claudeRulesDir, 'teamai-recall.md'), 'utf-8');
            expect(content).toContain('Self-exemption');
            expect(content).toContain('teamai-recall');
            expect(content).toContain('teamai recall');
            expect(content).toContain('Nothing was searched');
            expect(content).toContain('Recall skips the older index');
            expect(content).not.toMatch(/[\u4e00-\u9fff]/);
            expect(isDeployedRecallRule(content)).toBe(true);
            expect(isDeployedRecallRule(content + '\nedited\n')).toBe(false);
        });

        it('keeps the historical bilingual recall rule when language is omitted or zh (#1014)', async () => {
            const write = async (language?: 'zh') => {
                const dir = path.join(tmpDir, language ?? 'omit', '.claude', 'rules');
                fs.mkdirSync(dir, { recursive: true });
                const teamConfig = {
                    ...(language ? { language } : {}),
                    toolPaths: { claude: { rules: path.join(language ?? 'omit', '.claude', 'rules') } },
                } as any;
                const { deployBuiltinRules, isDeployedRecallRule } = await import('../builtin-rules.js');
                await deployBuiltinRules(teamConfig);
                const content = fs.readFileSync(path.join(dir, 'teamai-recall.md'), 'utf-8');
                expect(isDeployedRecallRule(content)).toBe(true);
                return content;
            };

            const omitted = await write();
            const zh = await write('zh');
            expect(zh).toBe(omitted);
            expect(omitted).toContain('规则：任务开始前检索团队知识库');
        });

        it('should deploy the recall rule to cursor as .mdc, not an ignored .md', async () => {
            const cursorRulesDir = path.join(tmpDir, '.cursor', 'rules');
            fs.mkdirSync(cursorRulesDir, { recursive: true });
            // A copy left by the layout that predates `.mdc`.
            fs.writeFileSync(path.join(cursorRulesDir, 'teamai-recall.md'), 'stale');

            const teamConfig = {
                toolPaths: {
                    cursor: {
                        skills: '.cursor/skills',
                        rules: '.cursor/rules',
                        settings: '.cursor/hooks.json',
                    },
                },
            } as any;

            const { deployBuiltinRules } = await import('../builtin-rules.js');
            await deployBuiltinRules(teamConfig);

            const mdc = path.join(cursorRulesDir, 'teamai-recall.mdc');
            expect(fs.existsSync(mdc)).toBe(true);
            // Cursor silently ignores a plain `.md` here, so it must not linger.
            expect(fs.existsSync(path.join(cursorRulesDir, 'teamai-recall.md'))).toBe(false);
            const content = fs.readFileSync(mdc, 'utf-8');
            expect(content.startsWith('---\n')).toBe(true);
            expect(content).toContain('alwaysApply: true');
            expect(content).toContain('Team Knowledge Recall');
        });

        it.each([
            ['kiro', '.kiro/steering', 'inclusion: always'],
            ['qoder', '.qoder/rules', 'trigger: always_on'],
        ])('deploys the recall rule to %s in its own rules format (#946)', async (tool, dir, header) => {
            fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
            const teamConfig = { toolPaths: { [tool]: { rules: dir } } } as any;

            const { deployBuiltinRules } = await import('../builtin-rules.js');
            await deployBuiltinRules(teamConfig);

            const content = fs.readFileSync(path.join(tmpDir, dir, 'teamai-recall.md'), 'utf-8');
            expect(content.startsWith(`---\n${header}\n---\n\n`)).toBe(true);
            expect(content).toContain('Team Knowledge Recall');
        });

        it('should skip tool directories that do not exist (tool not installed)', async () => {
            // Arrange: only create one tool directory
            const claudeRulesDir = path.join(tmpDir, '.claude', 'rules');
            fs.mkdirSync(claudeRulesDir, { recursive: true });
            // Do NOT create .cursor/rules/

            const teamConfig = {
                toolPaths: {
                    claude: {
                        skills: '.claude/skills',
                        rules: '.claude/rules',
                        settings: '.claude/settings.json',
                        claudemd: '.claude/CLAUDE.md',
                    },
                    cursor: {
                        skills: '.cursor/skills',
                        rules: '.cursor/rules',
                        settings: '.cursor/settings.json',
                        claudemd: '.cursor/CLAUDE.md',
                    },
                },
            } as any;

            // Act
            const { deployBuiltinRules } = await import('../builtin-rules.js');
            const deployed = await deployBuiltinRules(teamConfig);

            // Assert: only claude dir processed
            expect(deployed).toBe(1);
        });

        it('should not fail when legacy file does not exist', async () => {
            // Arrange: create tool dir without legacy file
            const claudeRulesDir = path.join(tmpDir, '.claude', 'rules');
            fs.mkdirSync(claudeRulesDir, { recursive: true });

            const teamConfig = {
                toolPaths: {
                    claude: {
                        rules: '.claude/rules',
                        claudemd: '.claude/CLAUDE.md',
                    },
                },
            } as any;

            // Act & Assert: should not throw
            const { deployBuiltinRules } = await import('../builtin-rules.js');
            const deployed = await deployBuiltinRules(teamConfig);
            expect(deployed).toBe(1);
        });
    });

    describe('BUILTIN_RULE_NAMES', () => {
        it('should contain teamai-recall', async () => {
            const { BUILTIN_RULE_NAMES } = await import('../builtin-rules.js');
            expect(BUILTIN_RULE_NAMES.has('teamai-recall')).toBe(true);
        });
    });

    describe('enabledAgents whitelist (#510)', () => {
        it('does not write builtin rules into an installed tool outside the whitelist', async () => {
            const workbuddyRules = path.join(tmpDir, '.workbuddy', 'rules');
            const hermesRules = path.join(tmpDir, '.hermes', 'rules');
            fs.mkdirSync(workbuddyRules, { recursive: true });
            fs.mkdirSync(hermesRules, { recursive: true });

            const teamConfig = {
                toolPaths: {
                    workbuddy: { rules: '.workbuddy/rules' },
                    hermes: { rules: '.hermes/rules' },
                },
            } as any;
            const localConfig = {
                repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://example.com/repo.git' },
                username: 'testuser',
                additionalRoles: [],
                scope: 'user',
                enabledAgents: ['workbuddy'],
            } as any;

            const { deployBuiltinRules } = await import('../builtin-rules.js');
            const deployed = await deployBuiltinRules(teamConfig, localConfig);

            expect(deployed).toBe(1);
            expect(fs.existsSync(path.join(workbuddyRules, 'teamai-recall.md'))).toBe(true);
            expect(fs.existsSync(path.join(hermesRules, 'teamai-recall.md'))).toBe(false);
        });

        it('still deploys to every installed tool when enabledAgents is unset', async () => {
            fs.mkdirSync(path.join(tmpDir, '.workbuddy', 'rules'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, '.hermes', 'rules'), { recursive: true });

            const teamConfig = {
                toolPaths: {
                    workbuddy: { rules: '.workbuddy/rules' },
                    hermes: { rules: '.hermes/rules' },
                },
            } as any;
            const localConfig = {
                repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://example.com/repo.git' },
                username: 'testuser',
                additionalRoles: [],
                scope: 'user',
            } as any;

            const { deployBuiltinRules } = await import('../builtin-rules.js');
            const deployed = await deployBuiltinRules(teamConfig, localConfig);

            expect(deployed).toBe(2);
            expect(fs.existsSync(path.join(tmpDir, '.workbuddy', 'rules', 'teamai-recall.md'))).toBe(true);
            expect(fs.existsSync(path.join(tmpDir, '.hermes', 'rules', 'teamai-recall.md'))).toBe(true);
        });
    });
});
