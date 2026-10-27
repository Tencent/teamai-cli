import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';
import { AGENT_SESSION_ENV } from '../../utils/session-id.js';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

describe('session workflow public CLI (#1086)', () => {
  it('advertises and describes an alias, prepares from outside, reports from a worktree, and requires a direct approval', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-workflow-')));
    const home = path.join(root, 'home'); const repo = path.join(root, 'product'); const outside = path.join(root, 'outside'); const bare = path.join(root, 'origin.git');
    for (const dir of [home, repo, outside]) fs.mkdirSync(dir);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
    const run = (command: string, args: string[], cwd = repo, input?: string) => spawnSync(command, args, { cwd, env, input, encoding: 'utf8', timeout: 30_000 });
    const git = (...args: string[]) => { const result = run('git', args); expect(result.status, result.stderr).toBe(0); return result.stdout.trim(); };
    const call = (args: string[], cwd = repo, input?: string) => run(process.execPath, [cli, ...args], cwd, input);
    const envelope = (stdout: string) => JSON.parse(stdout.trim().split('\n').filter((line) => line.startsWith('{')).at(-1)!);
    try {
      git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Trusted base instructions.\n');
      git('add', '.'); git('commit', '-qm', 'fixture'); git('init', '-q', '--bare', '-b', 'main', bare);
      git('remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git');
      const initialized = call(['init', '--self', '--agent', 'claude', '--force']); expect(initialized.status, initialized.stderr).toBe(0);
      git('remote', 'set-url', 'origin', bare);
      const workflows = path.join(repo, '.teamai', 'workflows'); fs.mkdirSync(workflows, { recursive: true });
      fs.writeFileSync(path.join(workflows, 'change.yaml'), `schemaVersion: v1alpha1
name: change
description: Make a reviewed change.
invoke: allow
alias: ship
inputs: { task: string }
steps:
  - id: work
    workspace: new
    workflow:
      steps:
        - id: write
          prompt: "Implement {{ inputs.task }}."
        - id: approval
          needs: [write]
          approve: { message: Continue?, required: true }
        - id: polish
          needs: [approval]
          prompt: Polish the implementation.
`);
      fs.writeFileSync(path.join(workflows, 'private.yaml'), 'schemaVersion: v1alpha1\nname: private\ndescription: Not advertised.\nsteps:\n  - id: work\n    command: echo private\n');
      fs.writeFileSync(path.join(workflows, 'pair.yaml'), 'schemaVersion: v1alpha1\nname: pair\ndescription: Interactive editing.\nsteps:\n  - id: pair\n    prompt: Pair on code.\n    interactive: true\n');
      git('add', '.teamai/workflows'); git('commit', '-qm', 'workflows');
      const pulled = call(['pull']); expect(pulled.status, pulled.stderr).toBe(0);
      const hook = call(['hook-dispatch', 'session-start', '--tool', 'claude'], repo, JSON.stringify({ cwd: repo, session_id: 'session-fixture', hook_event_name: 'SessionStart' }));
      expect(hook.status, hook.stderr).toBe(0);
      expect(hook.stdout).not.toContain('Make a reviewed change.');
      expect(fs.readFileSync(path.join(repo, '.claude', 'skills', 'workflow-change', 'SKILL.md'), 'utf8')).toContain('Alias: ship.');
      expect(fs.existsSync(path.join(repo, '.claude', 'skills', 'workflow-private'))).toBe(false);
      await waitForDetachedChildren();
      const described = call(['workflow', 'start', 'ship', '--describe']); expect(described.status, described.stderr).toBe(0);
      expect(envelope(described.stdout)).toMatchObject({ data: { name: 'change', inputs: { task: { type: 'string' } } } });
      expect(described.stdout).not.toContain('Polish the implementation.');
      const started = call(['workflow', 'start', 'ship', '--inputs', '{"task":"a fixture"}']); expect(started.status, started.stderr).toBe(0);
      const id = envelope(started.stdout).data.run;
      const driver = { kind: 'skill', machine: 'fixture', workspace: repo, can: { hitl: true, workspace: ['read-only', 'new', 'continue'] } };
      const next = (cwd: string) => { const answer = call(['workflow', 'next', id, '--prepare', '--json', JSON.stringify({ driver })], cwd); expect(answer.status, answer.stderr).toBe(0); return envelope(answer.stdout).data; };
      const first = next(outside).lease;
      expect(first.step).toBe('work.write'); expect(first.cwd).not.toBe(outside);
      // The place gets the base checkout's generated skill, the same bytes, not one of its own.
      const generated = (dir: string) => fs.readFileSync(path.join(dir, '.claude', 'skills', 'workflow-change', 'SKILL.md'), 'utf8');
      expect(generated(first.cwd)).toBe(generated(repo));
      fs.writeFileSync(path.join(first.cwd, 'code.txt'), 'first\n'); fs.writeFileSync(path.join(first.cwd, 'AGENTS.md'), 'Untrusted branch instructions.\n');
      expect(next(first.cwd).lease.cwd).toBe(first.cwd);
      expect(fs.readFileSync(path.join(first.cwd, 'code.txt'), 'utf8')).toBe('first\n');
      const report = (lease: { attempt: string; revision: number }, cwd: string) => call(['workflow', 'report', id, '--json', JSON.stringify({ driver, attempt: lease.attempt, revision: lease.revision, outcome: 'success' })], cwd);
      const firstReport = report(first, first.cwd); expect(firstReport.status, firstReport.stderr).toBe(0);
      const question = next(first.cwd).hitl; expect(question).toMatchObject({ step: 'work.approval', required: true });
      const mediated = call(['workflow', 'respond', id, question.step, 'yes', '--pass', String(question.pass)], outside);
      expect(envelope(mediated.stdout)).toMatchObject({ error: { code: 'agent_in_path' } });
      const direct = call(['workflow', 'respond', id, question.step, 'yes', '--pass', String(question.pass), '--json', JSON.stringify({ driver })], first.cwd);
      expect(direct.status, direct.stderr).toBe(0);
      const second = next(outside).lease;
      expect(fs.readFileSync(path.join(second.cwd, 'AGENTS.md'), 'utf8')).toBe('Trusted base instructions.\n');
      fs.appendFileSync(path.join(second.cwd, 'code.txt'), 'second\n');
      const secondReport = report(second, outside); expect(secondReport.status, secondReport.stderr).toBe(0);
      expect(envelope(secondReport.stdout)).toMatchObject({ data: { accepted: true, cleanup: true } });
      expect(next(outside)).toMatchObject({ done: { outcome: 'succeeded' } });
      expect(fs.existsSync(second.cwd)).toBe(false);
      const pushed = run('git', ['--git-dir', bare, 'show', `${first.workspace.branch}:code.txt`]); expect(pushed.status, pushed.stderr).toBe(0);
      expect(pushed.stdout).toBe('first\nsecond\n'); expect(fs.existsSync(path.join(repo, 'code.txt'))).toBe(false);
      const skill = call(['skill', 'get', 'workflow']); expect(skill.status, skill.stderr).toBe(0); expect(skill.stdout).toContain('Never run git');
      const pair = call(['workflow', 'start', 'pair']); expect(pair.status, pair.stderr).toBe(0);
      const pairId = envelope(pair.stdout).data.run;
      const pairNext = call(['workflow', 'next', pairId, '--prepare', '--json', JSON.stringify({ driver })]); expect(pairNext.status, pairNext.stderr).toBe(0);
      const pairLease = envelope(pairNext.stdout).data.lease;
      fs.writeFileSync(path.join(pairLease.cwd, 'pair.txt'), 'human edits\n');
      const pairReport = call(['workflow', 'report', pairId, '--json', JSON.stringify({ driver, attempt: pairLease.attempt, revision: pairLease.revision, outcome: 'success' })]);
      expect(envelope(pairReport.stdout)).toMatchObject({ data: { step: { status: 'succeeded' } } });
      expect(fs.readFileSync(path.join(repo, 'pair.txt'), 'utf8')).toBe('human edits\n');
    } finally { await waitForDetachedChildren(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('judges a scored step of a skill run in the background with the session tool\'s confined judge, and the poll after done returns judged', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-judged-')));
    const home = path.join(root, 'home'); const repo = path.join(root, 'product'); const bin = path.join(root, 'bin');
    for (const dir of [home, repo, bin]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1' }));
console.log(JSON.stringify({ type: 'result', structured_output: { label: 'thorough', reasoning: 'It read the change.' } }));
});\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TEAMAI_WORKFLOW_ATTEMPT', ...AGENT_SESSION_ENV]) delete env[name];
    env.CLAUDE_CODE_SESSION_ID = 'session-judged';
    const run = (command: string, args: string[], timeout = 30_000) => spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', timeout });
    const git = (...args: string[]) => { const result = run('git', args); expect(result.status, result.stderr).toBe(0); };
    const envelope = (stdout: string) => JSON.parse(stdout.trim().split('\n').filter((line) => line.startsWith('{')).at(-1) ?? 'null');
    /** Runs a literal the CLI printed, `teamai …`, with the built CLI: its answer. */
    const literal = (line: string, timeout?: number) => {
      const result = run(process.execPath, [cli, ...line.split(' ').slice(1)], timeout); expect(result.status, result.stderr).toBe(0);
      return envelope(result.stdout);
    };
    try {
      git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n'); git('add', '.'); git('commit', '-qm', 'fixture');
      const bare = path.join(root, 'origin.git'); git('init', '-q', '--bare', '-b', 'main', bare); git('remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git');
      const initialized = run(process.execPath, [cli, 'init', '--self', '--agent', 'claude', '--force']); expect(initialized.status, initialized.stderr).toBe(0);
      git('remote', 'set-url', 'origin', bare);
      for (const dir of ['workflows', 'scorers']) fs.mkdirSync(path.join(repo, '.teamai', dir), { recursive: true });
      fs.writeFileSync(path.join(repo, '.teamai', 'workflows', 'review.yaml'), 'schemaVersion: v1alpha1\nname: review\ndescription: Review the change.\ninvoke: allow\nsteps:\n  - id: review\n    prompt: Review the change.\n    scorers: [review-quality]\n');
      fs.writeFileSync(path.join(repo, '.teamai', 'scorers', 'review-quality.md'), '---\nlabels:\n  - { value: thorough, score: 1, description: Did the work }\n  - { value: shallow, score: 0, description: Did not }\npassingScore: 0.5\nsamplingRate: 100\n---\nJudge the review.\n');
      git('add', '.teamai'); git('commit', '-qm', 'workflows');
      literal('teamai pull');

      const described = literal('teamai workflow start --describe review --driver skill');
      expect(described).toMatchObject({ data: { describe: { judging: { kind: 'here', tool: 'claude' }, ask: { kind: 'ask', question: { options: [
        { label: 'Recommended: with judging', start: 'teamai workflow start review --driver skill' },
        { label: 'Same, but without judging', start: 'teamai workflow start review --driver skill --no-judge' },
      ] } } } } });
      let turn = literal(described.data.describe.ask.question.options[0].start).data.turn;
      turn = literal(turn.actions[0].options[0].run).data.turn;
      const [dispatch] = turn.actions;
      expect(dispatch).toMatchObject({ kind: 'dispatch', step: 'review' });
      literal(dispatch.ack);
      const result = /Write `([^`]+result\.json)`/.exec(fs.readFileSync(dispatch.brief, 'utf8'))?.[1] ?? '';
      fs.writeFileSync(result, JSON.stringify({ kind: 'output', output: 'Reviewed the change.' }));
      expect(literal(dispatch.report)).toMatchObject({ data: { runner: { status: 'reported' } } });

      const done = literal(`teamai workflow next ${turn.run} --driver skill`).data.turn;
      expect(done).toMatchObject({ status: 'done', events: [{ kind: 'settled', step: 'review', outcome: 'success' }, { kind: 'judging', step: 'review', scorers: ['review-quality'] }],
        actions: [{ kind: 'done', outcome: 'succeeded', judging: { step: 'review', scorers: ['review-quality'] } }],
        // oxlint-disable-next-line unicorn/no-thenable
        then: { kind: 'poll' } });
      const judged = literal(done.then.run, 120_000).data.turn;
      expect(judged).toEqual({ run: turn.run, status: 'done', running: [], events: [{ kind: 'judged', step: 'review', scorer: 'review-quality', label: 'thorough' }], actions: [{ kind: 'done', outcome: 'succeeded', prs: [] }] });
    } finally { await waitForDetachedChildren(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
