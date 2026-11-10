import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseRemoteToRepo, buildHintMessage, computeMrHintOutput, stashMrHint, takePendingMrHint } from '../mr-hint.js';
import type { MRSummary } from '../mr-hint.js';
import { DefaultHooks } from '../default-hooks.js';
import { getRemoteUrl } from '../utils/git.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return { ...actual, getRemoteUrl: vi.fn(actual.getRemoteUrl) };
});

const mrHint = await DefaultHooks.load('teamai-mr-hint', null);

describe('parseRemoteToRepo', () => {
  it('parses TGit HTTPS URL with simple path', () => {
    const result = parseRemoteToRepo('https://git.woa.com/owner/repo.git');
    expect(result).toEqual({ provider: 'tgit', owner: 'owner', repo: 'repo' });
  });

  it('parses TGit HTTPS URL with group path', () => {
    const result = parseRemoteToRepo('https://git.woa.com/group/subgroup/repo.git');
    expect(result).toEqual({ provider: 'tgit', owner: 'group/subgroup', repo: 'repo' });
  });

  it('parses TGit SSH URL', () => {
    const result = parseRemoteToRepo('git@git.woa.com:group/repo.git');
    expect(result).toEqual({ provider: 'tgit', owner: 'group', repo: 'repo' });
  });

  it('parses GitHub HTTPS URL', () => {
    const result = parseRemoteToRepo('https://github.com/myorg/myrepo.git');
    expect(result).toEqual({ provider: 'github', owner: 'myorg', repo: 'myrepo' });
  });

  it('parses GitHub SSH URL', () => {
    const result = parseRemoteToRepo('git@github.com:myorg/myrepo.git');
    expect(result).toEqual({ provider: 'github', owner: 'myorg', repo: 'myrepo' });
  });

  it('parses URL without .git suffix', () => {
    const result = parseRemoteToRepo('https://git.woa.com/owner/repo');
    expect(result).toEqual({ provider: 'tgit', owner: 'owner', repo: 'repo' });
  });

  it('returns null for unrecognized URL', () => {
    expect(parseRemoteToRepo('https://gitlab.com/owner/repo.git')).toBeNull();
    expect(parseRemoteToRepo('')).toBeNull();
    expect(parseRemoteToRepo('not-a-url')).toBeNull();
  });
});

describe('buildHintMessage', () => {
  const sampleMRs: MRSummary[] = [
    {
      id: '42',
      title: 'feat: add new feature',
      url: 'https://git.woa.com/owner/repo/merge_requests/42',
      mergedAt: '2024-06-01T10:00:00Z',
    },
  ];

  it('includes MR title in hint', () => {
    const msg = buildHintMessage(sampleMRs, mrHint);
    expect(msg).toContain('feat: add new feature');
  });

  it('includes teamai import command', () => {
    const msg = buildHintMessage(sampleMRs, mrHint);
    expect(msg).toContain('teamai import --from-mr');
    expect(msg).toContain('https://git.woa.com/owner/repo/merge_requests/42');
  });

  it('mentions MR count', () => {
    const msg = buildHintMessage(sampleMRs, mrHint);
    expect(msg).toContain('1');
  });

  it('includes the [teamai:mr-hint] prefix', () => {
    const msg = buildHintMessage(sampleMRs, mrHint);
    expect(msg).toContain('[teamai:mr-hint]');
  });

  it('is English-only when the team language is en (#1014)', () => {
    const msg = buildHintMessage(sampleMRs, mrHint, { language: 'en' });
    expect(msg).toContain('[teamai:mr-hint]');
    expect(msg).toContain('feat: add new feature');
    expect(msg).toContain('teamai import --from-mr');
    expect(msg).toContain('https://git.woa.com/owner/repo/merge_requests/42');
    expect(msg).toContain('2024-06-01');
    expect(msg).toContain('1');
    expect(msg).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('stays byte-identical to the bilingual hint when language is omitted or zh (#1014)', () => {
    const omitted = buildHintMessage(sampleMRs, mrHint);
    expect(buildHintMessage(sampleMRs, mrHint, { language: 'zh' })).toBe(omitted);
    expect(omitted).toContain('发现');
    expect(omitted).toContain('Found merged MR(s) not yet imported');
  });

  it('handles multiple MRs', () => {
    const mrs: MRSummary[] = [
      { id: '1', title: 'MR One', url: 'https://git.woa.com/a/b/merge_requests/1', mergedAt: '2024-06-01T00:00:00Z' },
      { id: '2', title: 'MR Two', url: 'https://git.woa.com/a/b/merge_requests/2', mergedAt: '2024-06-02T00:00:00Z' },
    ];
    const msg = buildHintMessage(mrs, mrHint);
    expect(msg).toContain('2');
    expect(msg).toContain('MR One');
    expect(msg).toContain('MR Two');
  });

  it.each(['en', 'zh'] as const)('prints one import command for every MR, not one per MR (#1104, %s)', (language) => {
    const mrs: MRSummary[] = [
      { id: '1', title: 'MR One', url: 'https://git.woa.com/a/b/merge_requests/1', mergedAt: '2024-06-01T00:00:00Z' },
      { id: '2', title: 'MR Two', url: 'https://git.woa.com/a/b/merge_requests/2', mergedAt: '2024-06-02T00:00:00Z' },
    ];
    const msg = buildHintMessage(mrs, mrHint, { language });
    const commands = msg.split('\n').filter((line) => line.includes('teamai import --from-mr http'));
    expect(commands).toEqual([
      '  teamai import --from-mr https://git.woa.com/a/b/merge_requests/1 https://git.woa.com/a/b/merge_requests/2',
    ]);
  });

  it.each(['en', 'zh'] as const)('no longer promises a codebase.md update (#1104, %s)', (language) => {
    // `import --from-mr` refreshes teamwiki only where that repo already has evidence.
    expect(buildHintMessage(sampleMRs, mrHint, { language })).not.toContain('codebase.md');
  });
});

describe('a hint the session start leaves for the next prompt', () => {
  let home: string;
  const mergedAt = new Date().toISOString();
  const pr = { number: 7, title: 'Fix the login redirect', url: 'https://github.com/acme/shop/pull/7', mergedAt };
  const at = (sessionId: string) => ({ sessionId, cwd: home, run: { runMode: 'attended' as const } });

  const ghLists = (prs: unknown[]) => vi.mocked(spawnSync).mockImplementation(() => {
    const stdout = JSON.stringify(prs);
    return { pid: 0, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
  });

  const hintIn = (output: string | null) => (output === null ? null : JSON.parse(output).hookSpecificOutput);

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mrhint-stash-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('TEAMAI_MR_HINT_CWD', home);
    vi.stubEnv('TEAMAI_MR_HINT_DISABLED', '');
    vi.mocked(getRemoteUrl).mockResolvedValue('https://github.com/acme/shop.git');
    ghLists([pr]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(getRemoteUrl).mockReset();
    vi.mocked(spawnSync).mockReset();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('shows it once, at the first prompt of that session', async () => {
    await stashMrHint('en', null, at('s1'));

    expect(await takePendingMrHint('s2')).toBeNull();
    const shown = hintIn(await takePendingMrHint('s1'));
    expect(shown?.hookEventName).toBe('UserPromptSubmit');
    expect(shown?.additionalContext).toContain('- Fix the login redirect');
    expect(await takePendingMrHint('s1')).toBeNull();
    // Shown, so a later session start has nothing new to hint.
    expect(await computeMrHintOutput('en', null, at('s3'))).toBeNull();
  });

  it('leaves the MRs of a hint no prompt took to the next session that shows them', async () => {
    await stashMrHint('en', null, at('s1'));

    expect(hintIn(await computeMrHintOutput('en', null, at('s2')))?.additionalContext).toContain('- Fix the login redirect');
    // s2 showed them since, so s1's late prompt does not show them again.
    expect(await takePendingMrHint('s1')).toBeNull();
  });

  it('drops it unshown when the hint was turned off before the prompt', async () => {
    await stashMrHint('en', null, at('s1'));
    vi.stubEnv('TEAMAI_MR_HINT_DISABLED', '1');

    expect(await takePendingMrHint('s1')).toBeNull();
    vi.stubEnv('TEAMAI_MR_HINT_DISABLED', '');
    // Dropped, not kept for a later prompt; and not recorded as shown, so the next session start hints the same MRs.
    expect(await takePendingMrHint('s1')).toBeNull();
    expect(hintIn(await computeMrHintOutput('en', null, at('s2')))?.additionalContext).toContain('- Fix the login redirect');
  });

  it('drops the hint a session had waiting when its next session start finds nothing new', async () => {
    await stashMrHint('en', null, at('s1'));
    ghLists([]);
    await stashMrHint('en', null, at('s1'));

    expect(await takePendingMrHint('s1')).toBeNull();
  });
});
