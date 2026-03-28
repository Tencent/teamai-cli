import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
        it('should deploy teamai-recall.md to all configured tool rules directories', async () => {
            // Arrange: create tool rules directories
            const claudeRulesDir = path.join(tmpDir, '.claude', 'rules');
            const claudeInternalRulesDir = path.join(tmpDir, '.claude-internal', 'rules');
            fs.mkdirSync(claudeRulesDir, { recursive: true });
            fs.mkdirSync(claudeInternalRulesDir, { recursive: true });

            const teamConfig = {
                toolPaths: {
                    claude: {
                        skills: '.claude/skills',
                        rules: '.claude/rules',
                        settings: '.claude/settings.json',
                        claudemd: '.claude/CLAUDE.md',
                    },
                    'claude-internal': {
                        skills: '.claude-internal/skills',
                        rules: '.claude-internal/rules',
                        settings: '.claude-internal/settings.json',
                        claudemd: '.claude-internal/CLAUDE.md',
                    },
                },
            } as any;

            // Act
            const { deployBuiltinRules } = await import('../builtin-rules.js');
            const deployed = await deployBuiltinRules(teamConfig);

            // Assert
            expect(deployed).toBeGreaterThan(0);

            const claudeRuleFile = path.join(claudeRulesDir, 'teamai-recall.md');
            const claudeInternalRuleFile = path.join(claudeInternalRulesDir, 'teamai-recall.md');

            expect(fs.existsSync(claudeRuleFile)).toBe(true);
            expect(fs.existsSync(claudeInternalRuleFile)).toBe(true);

            // Verify content contains recall instructions
            const content = fs.readFileSync(claudeRuleFile, 'utf-8');
            expect(content).toContain('teamai recall');
            expect(content).toContain('Bash');
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

            // Assert: only claude got deployed
            expect(deployed).toBe(1);
            expect(fs.existsSync(path.join(claudeRulesDir, 'teamai-recall.md'))).toBe(true);
            expect(fs.existsSync(path.join(tmpDir, '.cursor', 'rules', 'teamai-recall.md'))).toBe(false);
        });

        it('should overwrite existing teamai-recall.md on update', async () => {
            // Arrange: create tool dir with old rule file
            const claudeRulesDir = path.join(tmpDir, '.claude', 'rules');
            fs.mkdirSync(claudeRulesDir, { recursive: true });
            fs.writeFileSync(path.join(claudeRulesDir, 'teamai-recall.md'), 'old content', 'utf-8');

            const teamConfig = {
                toolPaths: {
                    claude: {
                        rules: '.claude/rules',
                        claudemd: '.claude/CLAUDE.md',
                    },
                },
            } as any;

            // Act
            const { deployBuiltinRules } = await import('../builtin-rules.js');
            await deployBuiltinRules(teamConfig);

            // Assert: content is updated
            const content = fs.readFileSync(path.join(claudeRulesDir, 'teamai-recall.md'), 'utf-8');
            expect(content).not.toBe('old content');
            expect(content).toContain('teamai recall');
        });
    });

    describe('BUILTIN_RULE_NAMES', () => {
        it('should contain teamai-recall', async () => {
            const { BUILTIN_RULE_NAMES } = await import('../builtin-rules.js');
            expect(BUILTIN_RULE_NAMES.has('teamai-recall')).toBe(true);
        });
    });
});
