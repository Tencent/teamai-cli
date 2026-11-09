import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deployBuiltinRules } from '../builtin-rules.js';
import { resolveInstructionBlocks } from '../pull.js';
import { LocalConfigSchema, TeamaiConfigSchema } from '../types.js';

// The recall rule and both recall blocks as teamai delivered them before they became the folder
// rules/teamai-recall/ (#1787). With no team replacement they stay byte-identical for every language.
const GOLDEN = path.join(import.meta.dirname, 'fixtures', 'recall-golden');
const golden = (file: string): string => fs.readFileSync(path.join(GOLDEN, file), 'utf8');

const LANGUAGES = [
  { label: 'unset', language: undefined, suffix: '' },
  { label: 'en', language: 'en', suffix: '.en' },
  { label: 'zh', language: 'zh', suffix: '.zh' },
] as const;

describe('recall texts with no team replacement', () => {
  let home: string;
  let repo: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-golden-home-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-golden-repo-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it.each(LANGUAGES)('deploys the recall rule unchanged with language $label', async ({ language, suffix }) => {
    const rules = path.join(home, '.claude', 'rules');
    fs.mkdirSync(rules, { recursive: true });
    const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo', language, toolPaths: { claude: { rules: '.claude/rules' } } });

    await deployBuiltinRules(teamConfig);

    expect(fs.readFileSync(path.join(rules, 'teamai-recall.md'), 'utf8')).toBe(golden(`rule${suffix}.md`));
  });

  it.each(LANGUAGES)('delivers both recall blocks unchanged with language $label', async ({ language, suffix }) => {
    const localConfig = LocalConfigSchema.parse({ repo: { localPath: repo, remote: '' }, username: 'member', recallEnabled: true });
    const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo', language });

    const { blocks } = await resolveInstructionBlocks(teamConfig, localConfig, null);

    expect(blocks.recall).toBe(golden(`block${suffix}.md`));
    expect(blocks.directRecall).toBe(golden(`block-direct${suffix}.md`));
  });
});
