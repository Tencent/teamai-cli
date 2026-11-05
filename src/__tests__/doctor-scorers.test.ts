import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import { localAliasesPath } from '../models/aliases.js';
import { scorerNotes } from '../doctor-scorers.js';
import { getUserConfigPath, type LocalConfig } from '../types.js';

const dirs: string[] = [];

afterEach(() => {
  fs.rmSync(localAliasesPath(), { force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function teamRepo(files: Record<string, string>): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-doctor-scorers-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(knowledge, file)), { recursive: true });
    fs.writeFileSync(path.join(knowledge, file), content);
  }
  return { repo: { localPath: knowledge, remote: 'local' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
}

const SCORER = '---\nlabels:\n  - { value: good, score: 1, description: Good }\n  - { value: bad, score: 0, description: Bad }\npassingScore: 0.5\n---\nJudge.\n';

describe('scorerNotes', () => {
  it('lists invalid scorer files and scorers a step lists that have no valid file, and writes no cache', async () => {
    const config = teamRepo({
      'scorers/eval.yaml': 'name: eval\n',
      'workflows/ship.yaml': 'schemaVersion: v1alpha1\nname: ship\ndescription: Ship it.\nsteps:\n  - id: plan\n    prompt: Plan it.\n    scorers: [nope]\n',
    });

    expect(await scorerNotes(config)).toEqual([
      'Invalid scorer: scorers/eval.yaml: not a scorer file; scorers/ holds <name>.md and <namespace>/<name>.md scorers, scoring.yaml settings and an optional README.md',
      'Unknown scorer: workflows/ship.yaml: step "plan" lists scorer "nope", which has no valid scorers/nope.md; the step runs without it',
    ]);
    expect(fs.existsSync(config.dataHome ?? '')).toBe(false);
  });

  it('says why scoring is off while the project keeps its data inside the repository', async () => {
    const config = teamRepo({ 'scorers/q.md': '---\nlabels:\n  - { value: good, score: 1, description: Good }\n  - { value: bad, score: 0, description: Bad }\npassingScore: 0.5\n---\nJudge.\n' });
    const inRepo = { ...config, dataHome: path.join(config.projectRoot ?? '', '.teamai') };

    expect(await scorerNotes(inRepo)).toEqual([expect.stringMatching(/^Scoring is off for this project: its teamai data is still in .*\.teamai, inside the repository.*Run teamai pull/)]);
    expect(await scorerNotes(config, { resolveTool: () => null })).toEqual(['Scoring isolation: best-effort, the default.', 'Judge tools here: none on PATH. Install one of: claude, claude-internal, tclaude, codex, codex-internal, tcodex, opencode, codebuddy, workbuddy, cursor, pi, agy to judge on this machine.']);
  });

  it('prints a scoring sessions value it ignores', async () => {
    const config = teamRepo({ 'scorers/q.md': SCORER, 'scorers/scoring.yaml': 'sessions: { unattended: yes }\n' });

    expect(await scorerNotes(config, { resolveTool: () => null })).toContain('scorers/scoring.yaml sessions.unattended is "yes", not off, ask or auto, so it is ignored.');
  });

  it.each([
    [{ 'scorers/scoring.yaml': 'isolation: verified\n' }, {}, 'Scoring isolation: verified, set by scorers/scoring.yaml isolation.'],
    [{ 'scorers/scoring.yaml': 'isolation: best-effort\n' }, { scoring: { isolation: 'verified' } }, 'Scoring isolation: verified, set by config.yaml scoring.isolation.'],
    [{}, { scoring: { isolation: 'strict' } },
      'Scoring isolation: verified, set by config.yaml scoring.isolation. config.yaml scoring.isolation is "strict", which is not verified or best-effort, so it counts as verified.'],
  ])('prints the isolation every judge needs and what sets it: %o %o', async (files, machine, line) => {
    const config = { ...teamRepo({ 'scorers/q.md': SCORER, ...files }), ...machine };

    expect(await scorerNotes(config, { resolveTool: () => null })).toEqual([line, 'Judge tools here: none on PATH. Install one of: claude, claude-internal, tclaude, codex, codex-internal, tcodex, opencode, codebuddy, workbuddy, cursor, pi, agy to judge on this machine.']);
  });

  it('names each scorer file that asks for more isolation than the team and this machine', async () => {
    const verified = SCORER.replace('passingScore: 0.5', 'passingScore: 0.5\nisolation: verified');
    const config = teamRepo({ 'scorers/q.md': SCORER, 'scorers/ops/strict.md': verified, 'scorers/strict-too.md': verified });

    expect(await scorerNotes(config, { resolveTool: () => null })).toEqual(['Scoring isolation: best-effort, the default. scorers/ops/strict.md and scorers/strict-too.md ask for verified for their own work.', 'Judge tools here: none on PATH. Install one of: claude, claude-internal, tclaude, codex, codex-internal, tcodex, opencode, codebuddy, workbuddy, cursor, pi, agy to judge on this machine.']);
  });

  it('warns about a cached scorer whose alias no installed judge tool maps, and notes one the member sends to the tool default', async () => {
    const config = teamRepo({
      'scorers/q.md': SCORER.replace('passingScore: 0.5', 'passingScore: 0.5\nmodel: fast'),
      'scorers/r.md': SCORER.replace('passingScore: 0.5', 'passingScore: 0.5\nmodel: strong'),
      'scorers/s.md': SCORER.replace('passingScore: 0.5', 'passingScore: 0.5\nmodel: claude-haiku-4-5'),
      'models/aliases.yaml': 'aliases:\n  fast:\n    codex: gpt-6-mini\n  strong:\n    claude: opus\n',
    });
    await syncScorersThenWorkflows(config);
    fs.mkdirSync(path.dirname(localAliasesPath()), { recursive: true });
    fs.writeFileSync(localAliasesPath(), 'aliases:\n  strong:\n    claude: ~\n');

    expect(await scorerNotes(config, { resolveTool: (tool) => (tool === 'claude' ? '/bin/claude' : null) })).toEqual([
      'Scoring isolation: best-effort, the default.',
      'Judge tools here: claude (version unknown) is best-effort.',
      'Scorer "q" asks for model alias "fast", which has no model for claude in models/aliases.yaml. Add one, or remove model from the scorer.',
      `Scorer "r" asks for model alias "strong", which ${localAliasesPath()} turns off for claude, so claude judges with its default model.`,
    ]);
  });

  it('lists the judge tools on this machine next to the isolation, with the level each profile reaches', async () => {
    const config = teamRepo({ 'scorers/q.md': SCORER });
    const bin = path.join(config.projectRoot ?? '', 'bin');
    fs.mkdirSync(bin);
    const fake = (name: string, version: string) => {
      fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
      return path.join(bin, name);
    };
    const onPath: Record<string, string> = { claude: fake('claude', '2.1.308 (Claude Code)'), codex: fake('codex', 'codex-cli 9.9.9') };

    expect(await scorerNotes(config, { resolveTool: (tool) => onPath[tool] ?? null })).toEqual([
      'Scoring isolation: best-effort, the default.',
      'Judge tools here: claude 2.1.308 (Claude Code) is verified, codex codex-cli 9.9.9 is best-effort.',
    ]);
    expect(await scorerNotes(config, { resolveTool: () => null })).toEqual([
      'Scoring isolation: best-effort, the default.',
      'Judge tools here: none on PATH. Install one of: claude, claude-internal, tclaude, codex, codex-internal, tcodex, opencode, codebuddy, workbuddy, cursor, pi, agy to judge on this machine.',
    ]);
  });

  it('prints what sets session judging in each run mode and the daily limit, once a setting does', async () => {
    const machineFile = getUserConfigPath();
    fs.mkdirSync(path.dirname(machineFile), { recursive: true });
    fs.writeFileSync(machineFile, 'scoring:\n  sessions: { unattended: off }\n  daily_limit: 2\n');
    onTestFinished(() => fs.rmSync(machineFile, { force: true }));
    const config = teamRepo({ 'scorers/q.md': SCORER, 'scorers/scoring.yaml': 'sessions: { attended: auto }\n' });

    expect(await scorerNotes(config, { resolveTool: () => null })).toContain(
      'Session judging: attended auto, set by scorers/scoring.yaml sessions.attended; unattended off, set by ~/.teamai/config.yaml scoring.sessions.unattended; '
      + 'up to 2 sessions a day, set by ~/.teamai/config.yaml scoring.daily_limit.',
    );
  });

  it('says TEAMAI_UPVOTE_JUDGE=1 is deprecated and what it reads as, even where the team keeps no scorer (#1391)', async () => {
    vi.stubEnv('TEAMAI_UPVOTE_JUDGE', '1');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    expect(await scorerNotes(teamRepo({}))).toEqual([
      'TEAMAI_UPVOTE_JUDGE=1 is deprecated: no Stop hook judges adoption any more. It reads as scoring.recall_adoption: true and scoring.sessions: { attended: auto } for each key config.yaml leaves unset; set those in config.yaml and unset TEAMAI_UPVOTE_JUDGE.',
    ]);
  });

  it('says nothing when every scorer is valid and known', async () => {
    expect(await scorerNotes(teamRepo({}))).toEqual([]);
  });

  it('says how much open judge work the upgrade carried over from judge attempts', async () => {
    const config = teamRepo({});
    const plant = (entry: string, attempt: string, fields: Record<string, unknown>) => {
      fs.mkdirSync(path.join(config.dataHome ?? '', 'scores', 'attempts', entry), { recursive: true });
      fs.writeFileSync(path.join(config.dataHome ?? '', 'scores', 'attempts', entry, `${attempt}.json`), JSON.stringify({
        attempt, entry, scorer: 'review', rubric: { sourceHash: 'h1' }, driver: { kind: 'local', machine: 'm', workspace: '/w' },
        judge: { tool: 'claude', by: 'scorer', isolation: 'verified', access: 'read' }, status: 'leased', ...fields,
      }));
    };
    plant('s0000000000001', 'a00000001', { subject: { runId: 'r00000000', step: 'fix', pass: 1 }, leasedAt: '2026-10-25T00:00:00.000Z', expiresAt: '2026-10-25T00:30:00.000Z' });
    plant('s0000000000002', 'a00000002', { subject: { runId: 'r00000000', step: 'fix', pass: 2 }, leasedAt: '2026-10-25T00:00:00.000Z', expiresAt: '2026-10-25T00:30:00.000Z' });
    plant('s0000000000003', 'a00000003', {
      source: 'session', subject: { platform: 'claude-code', sessionId: '7c1e' }, session: { used: { skills: [] }, prompt: 'Add retries' },
      leasedAt: '2026-10-25T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
    });

    expect(await scorerNotes(config)).toEqual(['The upgrade carried 2 open workflow passes and 1 open session over from judge attempts into marks. The next teamai score --drain, or a session start where sessions are judged or archived automatically, starts teamai-score for each, and for a pass only while its run last changed under 14 days ago.']);
  });
});
