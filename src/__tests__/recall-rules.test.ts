import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

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
  })),
}));

import { compileRecallRulesBlock } from '../pull.js';
import { injectClaudeMdSection } from '../utils/claudemd.js';
import { TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END } from '../types.js';

describe('compileRecallRulesBlock', () => {
  it('produces a marker-delimited block containing both required rules', () => {
    const block = compileRecallRulesBlock();
    expect(block).toContain(TEAMAI_RECALL_RULES_START);
    expect(block).toContain(TEAMAI_RECALL_RULES_END);
    // Rule 1: must call teamai-recall before tasks
    expect(block).toMatch(/teamai-recall/);
    expect(block).toMatch(/Before/i);
    // Rule 2: must declare referenced-doc-ids after task
    expect(block).toContain('teamai:referenced-doc-ids');
  });

  it('is idempotent (same input produces same output)', () => {
    expect(compileRecallRulesBlock()).toBe(compileRecallRulesBlock());
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
    const block = compileRecallRulesBlock();
    await injectClaudeMdSection(claudeMdPath, TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END, block);

    const content = await fse.readFile(claudeMdPath, 'utf8');
    expect(content).toContain(TEAMAI_RECALL_RULES_START);
    expect(content).toContain(TEAMAI_RECALL_RULES_END);
    expect(content).toContain('teamai-recall');
  });

  it('appends the block when CLAUDE.md exists but has no marker', async () => {
    await fse.writeFile(claudeMdPath, '# My Project\n\nUser-written instructions.\n');
    const block = compileRecallRulesBlock();
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

    const block = compileRecallRulesBlock();
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
    const startMatches = content.match(new RegExp(TEAMAI_RECALL_RULES_START.replace(/[\[\]\-]/g, '\\$&'), 'g')) ?? [];
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
      compileRecallRulesBlock(),
    );

    const content = await fse.readFile(claudeMdPath, 'utf8');
    expect(content).toContain('<!-- [teamai:claudemd:start] -->');
    expect(content).toContain('some legacy injected content');
    expect(content).toContain(TEAMAI_RECALL_RULES_START);
  });
});
