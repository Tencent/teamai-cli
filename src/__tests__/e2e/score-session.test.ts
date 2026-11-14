/**
 * Real CLI against a local bare team repo: a member judges a finished Claude Code session with a team scorer and a fake
 * Claude judge, by id and from inside the session, and publishes its labels, never the transcript, with --push.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { executableOf, LAUNCH_ORDER } from '../../tool-launch/tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const TEAM_URL = 'https://github.com/acme/team.git';
const SESSION = '7c1e0000-0000-4000-8000-000000000001';
const PHRASE = 'Only-the-session-said-this-wombat';

const EnvelopeSchema = z.object({ data: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });

function runCLI(args: string[], cwd: string, env: NodeJS.ProcessEnv, input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...env, FORCE_COLOR: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(input);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function envelope(stdout: string): z.infer<typeof EnvelopeSchema> {
  const line = stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return EnvelopeSchema.parse(JSON.parse(line));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' }).toString();
}

const SCORER = `---
labels:
  - { value: thorough, score: 1, description: Did the work it was asked for }
  - { value: shallow, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 0
---
Judge whether the session did what the member asked.
`;

describe('teamai score --session', () => {
  let root: string;
  let knowledge: string;
  let team: string;
  let app: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-session-e2e-'));
    knowledge = path.join(root, 'knowledge');
    team = path.join(root, 'team.git');
    fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
    fs.mkdirSync(path.join(knowledge, 'skills', 'review-notes'), { recursive: true });
    fs.writeFileSync(path.join(knowledge, 'skills', 'review-notes', 'SKILL.md'), '---\ndescription: Write review notes for a PR.\n---\nReview a PR.\n');
    fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), `team: acme\nrepo: ${TEAM_URL}\nprovider: github\n`);
    fs.writeFileSync(path.join(knowledge, 'scorers', 'review-quality.md'), SCORER);
    git(root, 'init', '-q', '-b', 'main', knowledge);
    git(knowledge, 'add', '-A');
    git(knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'team');
    git(root, 'clone', '-q', '--bare', knowledge, team);
    app = path.join(root, 'app');
    fs.mkdirSync(app);
    git(app, 'init', '-q', '-b', 'main');

    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = tester\n\temail = tester@example.com\n[url "${pathToFileURL(team).href}"]\n\tinsteadOf = ${TEAM_URL}\n`);
    const project = path.join(home, '.claude', 'projects', encodeCwdClaude(app));
    fs.mkdirSync(project, { recursive: true });
    const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
    fs.writeFileSync(path.join(project, `${SESSION}.jsonl`),
      line({ type: 'user', uuid: 'u1', parentUuid: null, cwd: app, sessionId: SESSION, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: `Add retries. ${PHRASE}` } })
      + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd: app, sessionId: SESSION, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    // Fails a session that holds the agent's work, and passes one without it, as a lenient rubric would; keeps the last transcript it judged.
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
const transcript = fs.readFileSync(require('node:path').join('transcripts', 'session.md'), 'utf8');
fs.writeFileSync(${JSON.stringify(path.join(root, 'judged-transcript.md'))}, transcript);
fs.writeFileSync(${JSON.stringify(path.join(root, 'judged-evidence.json'))}, fs.readFileSync('evidence.json'));
if (transcript.includes('Added the retries.')) fs.writeFileSync(${JSON.stringify(path.join(root, 'judged-full-evidence.json'))}, fs.readFileSync('evidence.json'));
const label = transcript.includes('Added the retries.') ? 'shallow' : 'thorough';
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1' }));
const at = process.argv.indexOf('--json-schema');
const given = at >= 0 ? JSON.parse(process.argv[at + 1]) : undefined;
const schema = given?.properties.answer ?? given;
const oneAnswer = (one) => ({ label: one?.properties.label.enum.includes('fit')
  ? (transcript.includes('Added the retries.') ? 'fit' : 'missed') : label, reasoning: 'It never ran the tests.' });
const answer = schema && !schema.properties.label
  ? Object.fromEntries(Object.entries(schema.properties).map(([name, one]) => [name, oneAnswer(one)])) : oneAnswer(schema);
console.log(JSON.stringify({ type: 'result', structured_output: given?.properties.answer ? { answer } : answer }));
});\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${path.join(bin, 'claude')}" %*\r\n`);
    env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEBUDDY_SESSION_ID', 'COPILOT_AGENT_SESSION_ID', 'CURSOR_CONVERSATION_ID', 'CLAUDE_SESSION_ID', 'OPENCODE_SESSION_ID', 'TEAMAI_AGENT_SESSION_ID', 'PI_SESSION_ID', 'MUSE_SESSION_ID']) delete env[name];
    for (const command of [['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'], ['pull']]) {
      const result = await runCLI(command, app, env);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    }
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports malformed scorer labels once', async () => {
    fs.mkdirSync(path.join(app, 'scorers'), { recursive: true });
    fs.writeFileSync(path.join(app, 'scorers', 'invalid-labels.md'), '---\nlabels: x\npassingScore: 0.5\n---\nJudge the session.\n');
    const scorer = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'scorers/invalid-labels.md'], app, env);
    expect(scorer.code).toBe(1);
    expect(envelope(scorer.stdout).error).toEqual({
      code: 'scorer_invalid', message: 'scorers/invalid-labels.md: labels must list 2 to 20 labels: at least one that passes and one that fails',
    });
  });

  it('judges a session by id, publishes its label and keeps its reasoning here, never guesses the session, and refuses a judging from inside it', async () => {
    const guessed = await runCLI(['score', '--scorer', 'review-quality'], app, env);
    expect(guessed.code).toBe(1);
    expect(envelope(guessed.stdout).error).toEqual({ code: 'session_required', message: 'Pass --session <id>; scoring never guesses the session.' });

    const scored = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'review-quality'], app, env);
    expect(scored.code, scored.stdout + scored.stderr).toBe(0);
    const label = z.object({ reasoning: z.string() }).passthrough().parse(envelope(scored.stdout).data?.label);
    expect(label).toMatchObject({ scorer: 'review-quality', label: 'shallow', score: 0, passed: false });
    expect(scored.stderr).toContain(`First prompt: Add retries. ${PHRASE}`);
    expect(scored.stderr).toMatch(new RegExp(`To share what went wrong, ask your agent to read .*\\.md and share it with the team \\(teamai contribute --session-id ${SESSION}\\)\\.`));
    const dataHome = path.resolve(label.reasoning, '..', '..', '..');
    expect(fs.readFileSync(path.join(dataHome, 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').map((text) => JSON.parse(text) as unknown))
      .toEqual([expect.objectContaining({ source: 'session', subject: { platform: 'claude-code', sessionId: SESSION }, judge: expect.objectContaining({ tool: 'claude', model: { reported: 'm1' } }) })]);
    expect(fs.readdirSync(path.join(dataHome, 'scores', 'reasoning'))).toHaveLength(1);
    expect(git(team, 'ls-tree', '-r', '--name-only', 'teamai-reports').split('\n').filter((file) => file.startsWith('scores/'))).toEqual([expect.stringMatching(/^scores\/tester\/\d{4}-\d{2}\.jsonl$/)]);
    expect(() => git(team, 'grep', '-q', 'It never ran the tests.', 'teamai-reports')).toThrow();

    // A session is judged from the person's terminal: from inside it, teamai-score refuses the agent, and nothing is written.
    const inside = await runCLI(['score', '--scorer', 'review-quality'], app, { ...env, CLAUDE_CODE_SESSION_ID: SESSION });
    expect(inside.code, inside.stdout + inside.stderr).toBe(1);
    expect(envelope(inside.stdout).error).toEqual({
      code: 'invoke_denied',
      message: 'Workflow "teamai-score" has invoke: deny, so no coding agent starts it, with any driver, and this command runs inside an agent session (CLAUDE_CODE_SESSION_ID is set). '
        + `The person runs teamai score --session ${SESSION} --source claude-code --scorer review-quality in their own terminal, and the agent judges this session with /teamai-share-session.`,
    });
    expect(fs.readFileSync(path.join(dataHome, 'scores', 'labels.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('tries a scorer file next to the labels stored for its scorer and a control on the first prompt alone, stores nothing, and refuses it with --push and --run', async () => {
    const byName = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'review-quality'], app, env);
    expect(byName.code, byName.stdout + byName.stderr).toBe(0);
    const dataHome = path.resolve(z.object({ reasoning: z.string() }).parse(envelope(byName.stdout).data?.label).reasoning, '..', '..', '..');
    const store = () => ['labels.jsonl', 'pending', 'reasoning'].map((name) => {
      const at = path.join(dataHome, 'scores', name);
      return fs.statSync(at).isDirectory() ? fs.readdirSync(at).join(',') : fs.readFileSync(at, 'utf8');
    });
    const before = store();
    const reportsBefore = git(team, 'for-each-ref', '--format=%(refname) %(objectname)');
    fs.mkdirSync(path.join(app, 'scorers'), { recursive: true });
    fs.writeFileSync(path.join(app, 'scorers', 'review-quality.md'), SCORER.replace('Judge whether', 'Judge strictly whether'));

    const tried = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', './scorers/review-quality.md'], app, env);
    expect(tried.code, tried.stdout + tried.stderr).toBe(0);
    const { rubric: cachedRubric } = z.object({ rubric: z.object({ sourceHash: z.string() }).passthrough() })
      .parse(JSON.parse(fs.readFileSync(path.join(dataHome, 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').at(-1) ?? 'null'));
    expect(envelope(tried.stdout).data).toEqual({
      label: expect.objectContaining({ scorer: 'review-quality', file: 'scorers/review-quality.md', label: 'shallow', passed: false, reasoning: 'It never ran the tests.', stored: false }),
      stored: [{ rubric: cachedRubric, label: 'shallow', score: 0, passed: false, judge: { kind: 'model', tool: 'claude' } }],
      control: { label: 'thorough', score: 1, passed: true, warning: 'This rubric passes a session where the agent did nothing, so it may not judge the work.' },
    });
    const control = fs.readFileSync(path.join(root, 'judged-transcript.md'), 'utf8');
    expect(control).toContain(`Add retries. ${PHRASE}`);
    expect(control).not.toContain('Added the retries.');
    expect(tried.stderr).toContain('⚠ review-quality: This rubric passes a session where the agent did nothing, so it may not judge the work.');
    expect(z.object({ label: z.object({ rubric: z.object({ sourceHash: z.string() }) }).passthrough() }).parse(envelope(tried.stdout).data).label.rubric.sourceHash)
      .not.toBe(cachedRubric.sourceHash);
    expect(store()).toEqual(before);

    fs.writeFileSync(path.join(app, 'scorers', 'broken.md'), SCORER.replace('passingScore: 0.5', 'passingScore: 2'));
    const invalid = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'scorers/broken.md'], app, env);
    expect(invalid.code).toBe(1);
    expect(envelope(invalid.stdout).error).toEqual({ code: 'scorer_invalid', message: 'scorers/broken.md: passingScore must have at least one label at or above it and one below it' });

    const pushed = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', './scorers/review-quality.md', '--push'], app, env);
    expect(pushed.code).toBe(1);
    expect(envelope(pushed.stdout).error?.code).toBe('invalid_arguments');
    const run = await runCLI(['score', '--run', 'r1', '--step', 'review', '--scorer', './scorers/review-quality.md'], app, env);
    expect(run.code).toBe(1);
    expect(envelope(run.stdout).error?.code).toBe('invalid_arguments');
    expect(store()).toEqual(before);
    expect(git(team, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(reportsBefore);
  });

  it('publishes labels with --push without the transcript, keeps one line per key, and keeps them pending while it cannot publish', async () => {
    const score = (...extra: string[]) => runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'review-quality', ...extra], app, env);
    const published = (): string[] => git(team, 'ls-tree', '-r', '--name-only', 'teamai-reports').split('\n').filter((file) => file.startsWith('scores/'));
    const originLabels = () => published().flatMap((file) => git(team, 'show', `teamai-reports:${file}`).trim().split('\n').map((text) => z.object({ scoredAt: z.string(), rubric: z.object({ sourceHash: z.string() }) }).passthrough().parse(JSON.parse(text))));

    const first = await score('--push');
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const firstData = envelope(first.stdout).data;
    expect(firstData).toMatchObject({ label: { label: 'shallow' }, published: true });
    const dataHome = path.resolve(z.object({ reasoning: z.string() }).parse(firstData?.label).reasoning, '..', '..', '..');
    expect(published()).toEqual([expect.stringMatching(/^scores\/tester\/\d{4}-\d{2}\.jsonl$/)]);
    expect(originLabels()).toEqual([expect.objectContaining({ source: 'session', subject: { platform: 'claude-code', sessionId: SESSION }, label: 'shallow' })]);
    expect(() => git(team, 'grep', '-q', PHRASE, 'teamai-reports')).toThrow();
    expect(fs.readdirSync(path.join(dataHome, 'scores', 'pending'))).toEqual([]);

    const [before] = originLabels();
    expect((await score('--push')).code).toBe(0);
    const [rescored, ...others] = originLabels();
    expect(others).toEqual([]);
    expect(rescored?.scoredAt > (before?.scoredAt ?? '')).toBe(true);

    fs.writeFileSync(path.join(knowledge, 'scorers', 'review-quality.md'), SCORER.replace('Judge whether', 'Judge strictly whether'));
    git(knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'stricter rubric');
    git(knowledge, 'push', '-q', team, 'main');
    expect((await runCLI(['pull'], app, env)).code).toBe(0);
    expect((await score('--push')).code).toBe(0);
    expect(new Set(originLabels().map((label) => label.rubric.sourceHash)).size).toBe(2);

    const config = path.join(dataHome, 'config.yaml');
    const kept = fs.readFileSync(config, 'utf8');
    fs.writeFileSync(config, `${kept}usageReportEnabled: false\n`);
    const reportsBefore = git(team, 'rev-parse', 'teamai-reports');
    const optedOut = await score('--push');
    expect(optedOut.code, optedOut.stdout + optedOut.stderr).toBe(0);
    expect(optedOut.stderr).toContain('Usage reporting is off, so labels stay on this machine.');
    expect(envelope(optedOut.stdout).data).toMatchObject({ published: false });
    expect(fs.readdirSync(path.join(dataHome, 'scores', 'pending'))).toHaveLength(1);
    expect(git(team, 'rev-parse', 'teamai-reports')).toBe(reportsBefore);
    fs.writeFileSync(config, kept);

    fs.renameSync(team, `${team}.away`);
    const offline = await runCLI(['score', '--push'], app, env);
    fs.renameSync(`${team}.away`, team);
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    expect(envelope(offline.stdout).data).toMatchObject({ published: false });
    // The labels' own line says they stay pending; teamai-reports is not reported stuck a second time.
    expect(offline.stderr).toContain('The labels stay pending until teamai score --push can publish them.');
    expect(offline.stderr).not.toContain('What workflow steps published to teamai-reports stays pending');
    expect(fs.readdirSync(path.join(dataHome, 'scores', 'pending'))).toHaveLength(1);
    const online = await runCLI(['score', '--push'], app, env);
    expect(envelope(online.stdout).data, online.stdout + online.stderr).toEqual({ published: true });
    expect(fs.readdirSync(path.join(dataHome, 'scores', 'pending'))).toEqual([]);
    expect(git(team, 'rev-parse', 'teamai-reports')).not.toBe(reportsBefore);

    const files = () => ['labels.jsonl', 'reasoning', 'pending'].map((name) => {
      const at = path.join(dataHome, 'scores', name);
      return fs.statSync(at).isDirectory() ? fs.readdirSync(at).join(',') : fs.readFileSync(at, 'utf8');
    });
    const stored = files();
    const reportsNow = git(team, 'rev-parse', 'teamai-reports');
    const dry = await runCLI(['--dry-run', 'score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'review-quality', '--push'], app, env);
    expect(dry.code).not.toBe(0);
    expect(dry.stderr).toContain('teamai score has no --dry-run preview, nothing was run');
    expect(files()).toEqual(stored);
    expect(git(team, 'rev-parse', 'teamai-reports')).toBe(reportsNow);
  });

  it('reports unknown skills for a session without a delivery capture (#1469)', async () => {
    const scored = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'review-quality'], app, env);
    expect(scored.code, scored.stdout + scored.stderr).toBe(0);
    const evidence = JSON.parse(fs.readFileSync(path.join(root, 'judged-evidence.json'), 'utf8')) as Record<string, unknown>;
    expect(evidence.gaps).toContain('skills_unknown');
    expect(evidence).not.toHaveProperty('skills');

    const routing = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'teamai:routing:review-notes'], app, env);
    expect(routing.code).toBe(1);
    expect(routing.stderr).toContain('scorer_not_found');
  });

  it('keeps the session-start skill description after a later pull changes it (#1469)', async () => {
    const transcript = path.join(env.HOME ?? '', '.claude', 'projects', encodeCwdClaude(app), `${SESSION}.jsonl`);
    const hook = await runCLI(['hook-dispatch', 'session-start', '--tool', 'claude'], app, env,
      JSON.stringify({ cwd: app, session_id: SESSION, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-x', transcript_path: transcript }) + '\n');
    expect(hook.code, hook.stdout + hook.stderr).toBe(0);

    const scored = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'review-quality'], app, env);
    expect(scored.code, scored.stdout + scored.stderr).toBe(0);
    const evidence = JSON.parse(fs.readFileSync(path.join(root, 'judged-evidence.json'), 'utf8')) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      skills: { available: [{ name: 'review-notes', description: 'Write review notes for a PR.' }], used: [] },
    });
    expect(evidence.gaps).not.toContain('skills_unknown');

    const skill = path.join(knowledge, 'skills', 'review-notes', 'SKILL.md');
    fs.writeFileSync(skill, '---\ndescription: The replacement description.\n---\nReview a PR.\n');
    git(knowledge, 'add', '-A');
    git(knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'change skill description');
    git(knowledge, 'push', team, 'main');
    const pulled = await runCLI(['pull'], app, env);
    expect(pulled.code, pulled.stdout + pulled.stderr).toBe(0);
    expect(fs.readFileSync(path.join(env.HOME ?? '', '.claude', 'skills', 'review-notes', 'SKILL.md'), 'utf8'))
      .toContain('The replacement description.');

    const rescored = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'review-quality'], app, env);
    expect(rescored.code, rescored.stdout + rescored.stderr).toBe(0);
    const laterEvidence = JSON.parse(fs.readFileSync(path.join(root, 'judged-evidence.json'), 'utf8')) as Record<string, unknown>;
    expect(laterEvidence.skills).toEqual(evidence.skills);
  });

  it('keeps captured skills in a custom scorer control while removing the agent skill use (#1469)', async () => {
    const transcript = path.join(env.HOME ?? '', '.claude', 'projects', encodeCwdClaude(app), `${SESSION}.jsonl`);
    const hook = await runCLI(['hook-dispatch', 'session-start', '--tool', 'claude'], app, env,
      JSON.stringify({ cwd: app, session_id: SESSION, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-x', transcript_path: transcript }) + '\n');
    expect(hook.code, hook.stdout + hook.stderr).toBe(0);
    const original = fs.readFileSync(transcript, 'utf8');
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: 'skill-use', parentUuid: 'u2', cwd: app,
      sessionId: SESSION, timestamp: new Date(Date.now() + 1_000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-skill', name: 'Skill', input: { skill: 'review-notes' } }] } }) + '\n');
    const scorer = path.join(app, 'scorers', 'ops', 'routing-review-notes.md');
    fs.mkdirSync(path.dirname(scorer), { recursive: true });
    fs.writeFileSync(scorer, '---\nlabels:\n  - { value: fit, score: 1, description: The session needed and loaded review-notes. }\n'
      + '  - { value: missed, score: 0, description: The session needed review-notes but did not load it. }\npassingScore: 1\n---\n'
      + 'Judge review-notes against skills.available and skills.used in evidence.json.\n');

    try {
      const scored = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', './scorers/ops/routing-review-notes.md'], app, env);
      expect(scored.code, scored.stdout + scored.stderr).toBe(0);
      expect(envelope(scored.stdout).data).toMatchObject({ label: { label: 'fit' }, control: { label: 'missed', passed: false } });
      const fullEvidence = JSON.parse(fs.readFileSync(path.join(root, 'judged-full-evidence.json'), 'utf8')) as Record<string, unknown>;
      expect(fullEvidence.skills).toMatchObject({ used: ['review-notes'] });
      const controlEvidence = JSON.parse(fs.readFileSync(path.join(root, 'judged-evidence.json'), 'utf8')) as Record<string, unknown>;
      expect(controlEvidence.skills).toMatchObject({ available: [expect.objectContaining({ name: 'review-notes' })], used: [] });
      expect(controlEvidence.gaps).not.toContain('skills_unknown');
      expect(scored.stderr).not.toContain('may not judge the work');
    } finally {
      fs.writeFileSync(transcript, original);
    }
  });

  it('distinguishes a capture with no delivered skills from unknown skills (#1469)', async () => {
    const emptySession = '7c1e0000-0000-4000-8000-000000000002';
    const project = path.join(env.HOME ?? '', '.claude', 'projects', encodeCwdClaude(app));
    const transcript = path.join(project, `${emptySession}.jsonl`);
    fs.writeFileSync(transcript, fs.readFileSync(path.join(project, `${SESSION}.jsonl`), 'utf8').replaceAll(SESSION, emptySession));
    fs.rmSync(path.join(knowledge, 'skills', 'review-notes'), { recursive: true });
    git(knowledge, 'add', '-A');
    git(knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'remove team skill');
    git(knowledge, 'push', team, 'main');
    const pulled = await runCLI(['pull'], app, env);
    expect(pulled.code, pulled.stdout + pulled.stderr).toBe(0);
    const hook = await runCLI(['hook-dispatch', 'session-start', '--tool', 'claude'], app, env,
      JSON.stringify({ cwd: app, session_id: emptySession, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-x', transcript_path: transcript }) + '\n');
    expect(hook.code, hook.stdout + hook.stderr).toBe(0);

    const scored = await runCLI(['score', '--session', emptySession, '--source', 'claude-code', '--scorer', 'review-quality'], app, env);
    expect(scored.code, scored.stdout + scored.stderr).toBe(0);
    const evidence = JSON.parse(fs.readFileSync(path.join(root, 'judged-evidence.json'), 'utf8')) as Record<string, unknown>;
    expect(evidence.skills).toEqual({ available: [], used: [] });
    expect(evidence.gaps).not.toContain('skills_unknown');
    const routing = await runCLI(['score', '--session', emptySession, '--source', 'claude-code', '--scorer', 'teamai:routing:review-notes'], app, env);
    expect(routing.code).toBe(1);
    expect(routing.stderr).toContain('scorer_not_found');
  });

  it('leaves open the judge of a scorer whose model no tool here runs, and exits judge_pending with the label the other scorer got', async () => {
    fs.mkdirSync(path.join(knowledge, 'models'), { recursive: true });
    fs.writeFileSync(path.join(knowledge, 'models', 'aliases.yaml'), 'aliases:\n  fast:\n    codex: gpt-6-mini\n');
    fs.writeFileSync(path.join(knowledge, 'scorers', 'style.md'), SCORER.replace('samplingRate: 0', 'samplingRate: 0\nmodel: fast'));
    git(knowledge, 'add', '-A');
    git(knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'style on a codex model');
    git(knowledge, 'push', '-q', team, 'main');
    expect((await runCLI(['pull'], app, env)).code).toBe(0);
    // Only the fake Claude judges here, so no tool here runs style's model.
    const agents = LAUNCH_ORDER.flatMap((tool) => ['', '.exe', '.cmd', '.bat'].map((ext) => `${executableOf(tool)}${ext}`));
    const claudeOnly = { ...env, PATH: [path.join(root, 'bin'), ...(env.PATH ?? '').split(path.delimiter)
      .filter((dir) => !agents.some((name) => fs.existsSync(path.join(dir, name))))].join(path.delimiter) };

    const scored = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'review-quality', '--scorer', 'style'], app, claudeOnly);

    expect(scored.code, scored.stdout + scored.stderr).toBe(1);
    const { error } = z.object({ error: z.object({ code: z.string(), message: z.string(), labels: z.array(z.record(z.string(), z.unknown())) }) }).parse(JSON.parse(scored.stdout.trim().split('\n').at(-1) ?? 'null'));
    expect(error).toMatchObject({ code: 'judge_pending', labels: [expect.objectContaining({ scorer: 'review-quality', label: 'shallow' })] });
    expect(error.message).toMatch(/^Run (r\w+) left the judge of style open for a driver that can run it: .*Kept the label of review-quality: shallow\.$/);
    const run = /^Run (r\w+)/.exec(error.message)?.[1] ?? '';
    const dataHome = path.resolve(z.object({ reasoning: z.string() }).parse(error.labels[0]).reasoning, '..', '..', '..');
    const { steps } = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string() })) })
      .parse(JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${run}.json`), 'utf8')));
    expect(steps.filter((step) => step.id.endsWith('.judge'))).toEqual([{ id: 'score[0].judge', status: 'succeeded' }, { id: 'score[1].judge', status: 'pending' }]);
  });
});
