import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('@teamai/shared/log', () => ({
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
  })),
}));

import { compileDirectRecallRulesBlock, compileRecallRulesBlock, resolveInstructionBlocks } from '../pull.js';
import { injectClaudeMdSection } from '../utils/claudemd.js';
import { TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END, type LocalConfig, type TeamaiConfig } from '../types.js';

describe('compileRecallRulesBlock', () => {
  it('produces a marker-delimited block containing both required rules', async () => {
    const block = await compileRecallRulesBlock();
    expect(block).toContain(TEAMAI_RECALL_RULES_START);
    expect(block).toContain(TEAMAI_RECALL_RULES_END);
    // Rule 1: must call teamai-recall before tasks
    expect(block).toMatch(/teamai-recall/);
    expect(block).toMatch(/Before/i);
  });

  it('is idempotent (same input produces same output)', async () => {
    expect(await compileRecallRulesBlock()).toBe(await compileRecallRulesBlock());
  });

  it('is English only for language en, and keeps the bilingual self-exemption for zh or no language', async () => {
    const english = await compileRecallRulesBlock('en');
    expect(english).toContain('Self-exemption');
    expect(english).not.toMatch(/[一-鿿]/);
    expect(await compileRecallRulesBlock('zh')).toBe(await compileRecallRulesBlock());
    expect(await compileRecallRulesBlock()).toContain('自豁免');
  });

  it('follows teamai.yaml language in the blocks pull, the session hook and doctor deliver', async () => {
    const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-language-'));
    try {
      const localConfig = { repo: { localPath: repo }, recallEnabled: true } as LocalConfig;
      const { blocks } = await resolveInstructionBlocks({ language: 'en' } as TeamaiConfig, localConfig, null);
      expect(blocks.recall).toContain('Self-exemption');
      expect(blocks.recall).not.toMatch(/[一-鿿]/);
    } finally {
      await fse.remove(repo);
    }
  });
});

describe('compileDirectRecallRulesBlock (#945)', () => {
  it('tells a tool without the recall subagent to run teamai recall itself, inside the same markers', async () => {
    const block = await compileDirectRecallRulesBlock();
    expect(block.startsWith(TEAMAI_RECALL_RULES_START)).toBe(true);
    expect(block.endsWith(TEAMAI_RECALL_RULES_END)).toBe(true);
    expect(block).toContain('teamai recall "');
    expect(block).toMatch(/Before/);
    expect(block).not.toContain('teamai-recall');
    expect(block).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('injectClaudeMdSection — recall rules block lifecycle', () => {
  let tmpDir: string;
  let claudeMdPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-rules-'));
    claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('injects the block into a fresh CLAUDE.md (file did not exist)', async () => {
    const block = await compileRecallRulesBlock();
    await injectClaudeMdSection(claudeMdPath, TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END, block);

    const content = await fse.readFile(claudeMdPath, 'utf8');
    expect(content).toContain(TEAMAI_RECALL_RULES_START);
    expect(content).toContain(TEAMAI_RECALL_RULES_END);
    expect(content).toContain('teamai-recall');
  });

  it('appends the block when CLAUDE.md exists but has no marker', async () => {
    await fse.writeFile(claudeMdPath, '# My Project\n\nUser-written instructions.\n');
    const block = await compileRecallRulesBlock();
    await injectClaudeMdSection(claudeMdPath, TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END, block);

    const content = await fse.readFile(claudeMdPath, 'utf8');
    // User content preserved
    expect(content).toContain('# My Project');
    expect(content).toContain('User-written instructions.');
    // Recall block appended
    expect(content).toContain(TEAMAI_RECALL_RULES_START);
    expect(content).toContain(TEAMAI_RECALL_RULES_END);
  });

  it('replaces ONLY the marker region on subsequent injections', async () => {
    const before = `# My Project

Custom user content above.

${TEAMAI_RECALL_RULES_START}
old block — to be replaced
${TEAMAI_RECALL_RULES_END}

Custom user content below.
`;
    await fse.writeFile(claudeMdPath, before);

    const block = await compileRecallRulesBlock();
    await injectClaudeMdSection(claudeMdPath, TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END, block);

    const content = await fse.readFile(claudeMdPath, 'utf8');
    // Outside-marker user content preserved
    expect(content).toContain('Custom user content above.');
    expect(content).toContain('Custom user content below.');
    // Old block content gone
    expect(content).not.toContain('old block — to be replaced');
    // New block present
    expect(content).toContain('teamai-recall');
    // Only one occurrence of the markers
    const startMatches = content.match(new RegExp(TEAMAI_RECALL_RULES_START.replace(/[[\]-]/g, '\\$&'), 'g')) ?? [];
    expect(startMatches.length).toBe(1);
  });

  it('coexists with the legacy [teamai:claudemd] marker block (independent regions)', async () => {
    const before = `<!-- [teamai:claudemd:start] -->
some legacy injected content
<!-- [teamai:claudemd:end] -->
`;
    await fse.writeFile(claudeMdPath, before);

    await injectClaudeMdSection(
      claudeMdPath,
      TEAMAI_RECALL_RULES_START,
      TEAMAI_RECALL_RULES_END,
      await compileRecallRulesBlock(),
    );

    const content = await fse.readFile(claudeMdPath, 'utf8');
    expect(content).toContain('<!-- [teamai:claudemd:start] -->');
    expect(content).toContain('some legacy injected content');
    expect(content).toContain(TEAMAI_RECALL_RULES_START);
  });
});
