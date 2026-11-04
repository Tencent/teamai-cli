import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { judgeUnavailable, verifiedScorers } from '../scorers/judges-here.js';
import type { PinnedScorer } from '../scorers/pin.js';
import type { LocalConfig } from '../types.js';
import * as cliPaths from '../utils/cli-path.js';

const scorer = (frontmatter = ''): string => `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 0.5
${frontmatter}---
Judge the work.
`;

const pin = (content: string): PinnedScorer => ({ sourceHash: 'h1', content });

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-judges-here-')));
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('USERPROFILE', path.join(root, 'home'));
  vi.spyOn(cliPaths, 'resolveCliPath').mockImplementation((cmd) => {
    const executable = path.join(root, 'bin', cmd);
    return fs.existsSync(executable) ? executable : null;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A member scope whose team repo holds `files` under its root, such as `scorers/scoring.yaml`. */
function member(files: Record<string, string> = {}): LocalConfig {
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(knowledge, file)), { recursive: true });
    fs.writeFileSync(path.join(knowledge, file), text);
  }
  return { repo: { localPath: knowledge, remote: 'local', kind: 'git' }, username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data') };
}

/** A Claude on PATH that reports `version`; 2.1.308 runs its confined profile verified. */
function claude(version = '2.1.308 (Claude Code)'): void {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
}

describe('judgeUnavailable', () => {
  it('says nothing when a judge tool here runs every scorer', async () => {
    claude();

    expect(await judgeUnavailable(member(), { quality: pin(scorer()), strict: pin(scorer('isolation: verified\n')) })).toBeUndefined();
  });

  it('says scoring is off for a project whose teamai data is still inside the repository', async () => {
    claude();
    const project = path.join(root, 'app');
    const config: LocalConfig = { ...member(), scope: 'project', projectRoot: project, dataHome: path.join(project, '.teamai') };

    expect(await judgeUnavailable(config, { quality: pin(scorer()) })).toMatch(/^Scoring is off for this project: its teamai data is still in .+\.teamai, inside the repository/u);
  });

  it('says why the team\'s scoring settings cannot be read', async () => {
    claude();

    expect(await judgeUnavailable(member({ 'scorers/scoring.yaml': 'isolation: [unclosed\n' }), { quality: pin(scorer()) })).toContain('scorers/scoring.yaml');
  });

  it('says no judge tool is on PATH', async () => {
    expect(await judgeUnavailable(member(), { quality: pin(scorer()) })).toBe('No judge tool is on PATH: install Claude Code, Codex, OpenCode or CodeBuddy.');
  });

  it('says this teamai cannot read a scorer it was given', async () => {
    claude();

    expect(await judgeUnavailable(member(), { quality: pin('not a scorer') })).toBe('This teamai cannot read scorer quality. Update teamai.');
  });

  it('names what asks for a verified judge when every judge tool here runs best-effort', async () => {
    claude('1.0.0 (Claude Code)');

    expect(await judgeUnavailable(member(), { quality: pin(scorer()), strict: pin(scorer('isolation: verified\n')) }))
      .toMatch(/^Scorer "strict" needs a verified judge, which .*strict.* asks for, and no judge tool here runs verified\.$/u);
  });

  it('says no judge tool here runs the model alias a scorer names', async () => {
    claude();
    const config = member({ 'models/aliases.yaml': 'aliases:\n  strong:\n    codex: gpt-6\n' });

    expect(await judgeUnavailable(config, { quality: pin(scorer('model: strong\n')) }))
      .toBe('Scorer "quality" asks for model alias "strong", which has no model for claude in models/aliases.yaml. Add one, or remove model from the scorer.');
  });
});

describe('verifiedScorers', () => {
  it('names only the scorers among those asked for whose judge must be verified', async () => {
    const pinned = { quality: pin(scorer()), strict: pin(scorer('isolation: verified\n')), other: pin(scorer('isolation: verified\n')) };

    expect(await verifiedScorers(member(), ['quality', 'strict'], pinned)).toEqual({ ok: true, scorers: ['strict'] });
  });

  it('asks for verified for every scorer when the team\'s settings do', async () => {
    const config = member({ 'scorers/scoring.yaml': 'isolation: verified\n' });

    expect(await verifiedScorers(config, ['quality'], { quality: pin(scorer()) })).toEqual({ ok: true, scorers: ['quality'] });
  });

  it('leaves out a scorer this teamai cannot read', async () => {
    expect(await verifiedScorers(member(), ['quality'], { quality: pin('not a scorer') })).toEqual({ ok: true, scorers: [] });
  });

  it('reads the scorers cached now when it is given no pins', async () => {
    expect(await verifiedScorers(member(), ['quality'])).toEqual({ ok: true, scorers: [] });
  });

  it('says why the team\'s scoring settings cannot be read', async () => {
    expect(await verifiedScorers(member({ 'scorers/scoring.yaml': 'isolation: [unclosed\n' }), ['quality'], { quality: pin(scorer()) }))
      .toEqual({ ok: false, reason: expect.stringContaining('scorers/scoring.yaml') });
  });
});
