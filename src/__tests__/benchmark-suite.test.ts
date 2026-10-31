import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { loadCachedSuite, syncTeamDefinitions } from '../benchmark/suite-cache.js';
import { formatUnknownScorer } from '../workflow/cache.js';
import { parseSuite, type SuiteFile } from '../benchmark/suite.js';

const START = 'a'.repeat(40);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function suiteText(lines: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    schemaVersion: 'v1alpha1',
    name: 'fix',
    repo: 'https://github.com/acme/app.git',
    defaults: '{ tool: claude }',
    arms: '[{ name: baseline }, { name: codex, tool: codex }]',
    repetitions: '1',
    timeout: '1h',
    ...lines,
  };
  return Object.entries(fields).filter(([, value]) => value !== '').map(([key, value]) => `${key}: ${value}\n`).join('');
}

function taskText(lines: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    schemaVersion: 'v1alpha1',
    title: 'Fix it',
    prompt: 'Make the test pass.',
    startingCommit: START,
    check: '{ run: node test.js, protect: [test.js] }',
    ...lines,
  };
  return Object.entries(fields).filter(([, value]) => value !== '').map(([key, value]) => `${key}: ${value}\n`).join('');
}

function parse(suite: string, tasks: Record<string, string> = { fix: taskText() }, isAlias = (_model: string) => true, files: readonly SuiteFile[] = []) {
  return parseSuite({
    suite: { relativePath: 'benchmarks/fix/suite.yaml', content: suite },
    tasks: Object.entries(tasks).map(([name, content]) => ({ relativePath: `benchmarks/fix/tasks/${name}.yaml`, content })),
    files,
    isAlias,
  });
}

/** A file of the suite directory `benchmarks/fix/`, as the sync reads it. */
function suiteFile(relativePath: string, text: string, mode: SuiteFile['mode'] = '100644'): SuiteFile {
  return { relativePath: `benchmarks/fix/${relativePath}`, base64: Buffer.from(text).toString('base64'), mode };
}

describe('parseSuite', () => {
  it('accepts a suite whose arms each change one key', () => {
    const parsed = parse(suiteText({ defaults: '{ tool: claude, model: strong }', arms: '[{ name: baseline }, { name: codex, tool: codex }, { name: fast, model: fast }]' }));

    expect(parsed).toMatchObject({ ok: true, diagnostics: [], warnings: [] });
  });

  it.each([
    ['a suite with 7 arms', suiteText({ arms: `[${['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `{ name: ${name}, tool: ${name} }`).join(', ')}]` }), 'arms', 'a suite has 1 to 6 arms'],
    ['a suite without timeout', suiteText({ timeout: '' }), 'timeout', 'timeout is required: the run\'s timeout, such as 6h'],
    ['an arm that changes tool and model', suiteText({ arms: '[{ name: baseline }, { name: codex, tool: codex, model: fast }]' }), 'arms.1', 'arm "codex" changes tool and model; an arm changes at most one of the defaults keys'],
    ['two arms of one name', suiteText({ arms: '[{ name: baseline }, { name: baseline, tool: codex }]' }), 'arms.1.name', 'arm "baseline" is named twice; arm names are unique'],
    ['two arms that change nothing', suiteText({ arms: '[{ name: baseline }, { name: same, tool: claude }]' }), 'arms.1', 'arm "same" changes none of the defaults keys, and neither does arm "baseline"; at most one arm changes none'],
  ])('reports %s at its suite file', (_rule, suite, field, message) => {
    const parsed = parse(suite);

    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ file: 'benchmarks/fix/suite.yaml', field, message })]);
  });

  it('crosses every value of each matrix key into one arm, named after the values that vary', () => {
    const parsed = parse(suiteText({ defaults: '{ tool: claude, model: strong }', arms: '', matrix: '{ tool: [claude, codex], team: [pulled, none] }' }));

    expect(parsed).toMatchObject({ ok: true, diagnostics: [] });
    expect(parsed.ok && parsed.suite.arms).toEqual([
      { name: 'claude-pulled', tool: 'claude', model: 'strong', team: { kind: 'pulled' } },
      { name: 'claude-none', tool: 'claude', model: 'strong', team: { kind: 'none' } },
      { name: 'codex-pulled', tool: 'codex', model: 'strong', team: { kind: 'pulled' } },
      { name: 'codex-none', tool: 'codex', model: 'strong', team: { kind: 'none' } },
    ]);
  });

  it('reads an arm\'s team as the pulled revision, none, a ref of the team repo, or the pulled revision without some paths, sorted', () => {
    const parsed = parse(suiteText({ arms: '[{ name: team }, { name: bare, team: none }, { name: main, team: main }, { name: no-auth, team: { without: [skills/release, rules/commits.md, skills/dev/deploy, CLAUDE.md] } }]' }));

    expect(parsed).toMatchObject({ ok: true, diagnostics: [] });
    expect(parsed.ok && parsed.suite.arms.map(({ name, team }) => ({ name, team }))).toEqual([
      { name: 'team', team: { kind: 'pulled' } },
      { name: 'bare', team: { kind: 'none' } },
      { name: 'main', team: { kind: 'ref', ref: 'main' } },
      { name: 'no-auth', team: { kind: 'without', paths: ['CLAUDE.md', 'rules/commits.md', 'skills/dev/deploy', 'skills/release'] } },
    ]);
  });

  it('names a matrix arm after a ref, a model or a path list with only name characters', () => {
    const parsed = parse(suiteText({ arms: '', matrix: '{ model: [sonnet-4.5, opus], team: [origin/main, { without: [skills/auth, rules/db.md] }] }' }));

    expect(parsed.ok && parsed.suite.arms.map(({ name }) => name)).toEqual(['sonnet-4-5-origin-main', 'sonnet-4-5-without-rules-db-md-skills-auth', 'opus-origin-main', 'opus-without-rules-db-md-skills-auth']);
  });

  it.each([
    ['a suite with both arms and matrix', suiteText({ matrix: '{ tool: [claude, codex] }' }), '(root)', 'a suite has exactly one of arms and matrix'],
    ['a suite with neither arms nor matrix', suiteText({ arms: '' }), '(root)', 'a suite has exactly one of arms and matrix'],
    ['a matrix that varies nothing', suiteText({ arms: '', matrix: '{ tool: [claude] }' }), 'matrix', 'the matrix varies no key; list two values or more under tool, model, team or workflow'],
    ['a matrix of 16 arms', suiteText({ arms: '', matrix: '{ tool: [a, b, c, d], model: [e, f, g, h] }' }), 'matrix', 'the matrix makes 16 arms; a suite has 1 to 12'],
    ['a matrix that names two arms alike', suiteText({ arms: '', matrix: '{ model: [sonnet.5, sonnet-5] }' }), 'matrix', 'the matrix names two arms "sonnet-5"; list values whose names differ'],
    ['an arm that changes tool and team', suiteText({ arms: '[{ name: baseline }, { name: codex, tool: codex, team: none }]' }), 'arms.1', 'arm "codex" changes tool and team; an arm changes at most one of the defaults keys'],
    ['a team ref that is not a ref name', suiteText({ arms: '[{ name: baseline }, { name: main, team: "-x" }]' }), 'arms.1.team', 'must be pulled, none, a branch, tag or commit of the team repo, or { without: [<path>, ...] }'],
    ['more lanes than a run can wait on', suiteText({ parallel: '33' }), 'parallel', 'must be a whole number from 1 to 32'],
    ['an arm that changes tool and workflow', suiteText({ arms: '[{ name: baseline }, { name: flow, tool: codex, workflow: fixer }]' }), 'arms.1', 'arm "flow" changes tool and workflow; an arm changes at most one of the defaults keys'],
    ['a team without no path', suiteText({ arms: '[{ name: baseline }, { name: bare, team: { without: [] } }]' }), 'arms.1.team.without', 'lists the team repo paths the arm runs without, at least one'],
    ['a team without one path twice', suiteText({ arms: '[{ name: baseline }, { name: bare, team: { without: [skills/a, rules/b.md, skills/a] } }]' }), 'arms.1.team.without', 'lists skills/a twice; list each path once'],
    ['a team without a path inside another it lists', suiteText({ arms: '[{ name: baseline }, { name: bare, team: { without: [skills/a/notes.md, rules/b.md, skills/a] } }]' }), 'arms.1.team.without', 'lists skills/a/notes.md, which is inside skills/a; list only skills/a'],
    ...['/skills/a', 'skills/a/', 'skills/../rules', './skills/a', 'skills//a', 'skills\\\\a'].map((written): [string, string, string, string] => [
      `a team without path ${written}`, suiteText({ arms: `[{ name: baseline }, { name: bare, team: { without: ["${written}"] } }]` }), 'arms.1.team.without.0',
      'must be a path in the team repo as git lists it, such as skills/release or rules/commits.md: no leading or trailing "/", no backslash and no ".", ".." or empty segment',
    ]),
  ])('reports %s at its suite file', (_rule, suite, field, message) => {
    const parsed = parse(suite);

    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ file: 'benchmarks/fix/suite.yaml', field, message })]);
  });

  it('keeps the limits a suite sets for every trial', () => {
    const parsed = parse(suiteText({ timeout: '45m', trial: '{ timeout: 8m, budget: { tokens: 300000 }, max_turns: 60 }' }));
    const without = parse(suiteText());

    expect(parsed).toMatchObject({ ok: true, diagnostics: [], suite: { trial: { timeoutMs: 8 * 60_000, tokens: 300_000, maxTurns: 60 } } });
    expect(without.ok && without.suite.trial).toBeUndefined();
  });

  it.each([
    ['a trial timeout as long as the suite\'s', suiteText({ timeout: '45m', trial: '{ timeout: 45m }' }), 'trial.timeout', 'trial.timeout must be shorter than timeout, which bounds the whole run'],
    ['a trial timeout longer than the suite\'s', suiteText({ timeout: '45m', trial: '{ timeout: 1h }' }), 'trial.timeout', 'trial.timeout must be shorter than timeout, which bounds the whole run'],
    ['a trial budget of no tokens', suiteText({ trial: '{ budget: { tokens: 0 } }' }), 'trial.budget.tokens', 'must be a positive whole number of tokens'],
    ['a fractional max_turns', suiteText({ trial: '{ max_turns: 1.5 }' }), 'trial.max_turns', 'must be a positive whole number'],
    ['a trial key the suite does not know', suiteText({ trial: '{ turns: 3 }' }), 'trial', 'Unrecognized key: "turns"'],
  ])('reports %s at its suite file', (_rule, suite, field, message) => {
    const parsed = parse(suite);

    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ file: 'benchmarks/fix/suite.yaml', field, message })]);
  });

  it.each([
    ['a task with both check and successCriteria', taskText({ successCriteria: 'The test passes.' }), 'check', 'a task has exactly one of check and successCriteria'],
    ['a task with an empty protect', taskText({ check: '{ run: node test.js, protect: [] }' }), 'check.protect', 'check.protect lists every path the check reads and the agent must not supply'],
    ['a short startingCommit', taskText({ startingCommit: 'abc1234' }), 'startingCommit', 'must be a full 40-character commit'],
    ['a short source.fix', taskText({ source: '{ platform: claude-code, sessionId: s1, fix: 9a1d4e7 }' }), 'source.fix', 'must be a full 40-character commit'],
    ['check.add without source.fix', taskText({ check: "{ run: node test.js, protect: ['test/**'], add: [test/startup.test.js] }" }), 'check.add', 'check.add writes its files from source.fix; add source.fix, the full commit that brought them'],
    ['check.add outside protect', taskText({ check: "{ run: node test.js, protect: ['test/**'], add: [lib/startup.test.js] }", source: `{ platform: claude-code, sessionId: s1, fix: ${'b'.repeat(40)} }` }), 'check.add.0', 'check.add "lib/startup.test.js" is not under check.protect, so the agent could supply it; add a protect path that covers it'],
    ['a glob in check.add', taskText({ check: "{ run: node test.js, protect: ['test/**'], add: ['test/*.js'] }", source: `{ platform: claude-code, sessionId: s1, fix: ${'b'.repeat(40)} }` }), 'check.add.0', 'must name one file, without glob characters'],
    ['check.add paths that nest', taskText({ check: "{ run: node test.js, protect: ['test/**'], add: [test/a, test/a/b.js] }", source: `{ platform: claude-code, sessionId: s1, fix: ${'b'.repeat(40)} }` }), 'check.add.1', 'check.add writes "test/a" as a file and as the directory of "test/a/b.js"; write paths that do not nest'],
    ...['test/[', 'test/[!'].map((entry) => [
      `an unclosed class ${entry} in check.protect`, taskText({ check: `{ run: node test.js, protect: ['${entry}'], add: ['test/check.js'] }`, source: `{ platform: claude-code, sessionId: s1, fix: ${'b'.repeat(40)} }` }), 'check.protect.0', 'has a [ class with no closing ]',
    ]),
    ...['./test.js', 'lib/../test.js', 'test//check.js', 'test/', 'te\\sts/**'].map((entry) => [
      `a protected path ${entry}`, taskText({ check: `{ run: node test.js, protect: ['${entry}'] }` }), 'check.protect.0', 'must be a path relative to the repo, with no backslash and no ".", ".." or empty segment',
    ]),
  ])('reports %s at its task file and runs the suite without it', (_rule, task, field, message) => {
    const parsed = parse(suiteText(), { bad: task, fix: taskText() });

    expect(parsed).toMatchObject({ ok: true, suite: { tasks: [{ id: 'fix' }] } });
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ file: 'benchmarks/fix/tasks/bad.yaml', field, message })]);
  });

  it('keeps the commit a task names as its fix', () => {
    const fix = 'b'.repeat(40);
    const parsed = parse(suiteText(), { fix: taskText({ source: `{ platform: claude-code, sessionId: s1, fix: ${fix} }` }) });

    expect(parsed).toMatchObject({ ok: true, diagnostics: [], suite: { tasks: [{ id: 'fix', source: { platform: 'claude-code', sessionId: 's1', fix } }] } });
  });

  it.each([
    ['a directory glob', "['test/**']", 'test/startup.test.js'],
    ['a file glob', "['test/*.test.js']", 'test/startup.test.js'],
    ['a directory', '[test]', 'test/unit/startup.test.js'],
    ['the path itself', '[test/startup.test.js]', 'test/startup.test.js'],
    ['a path with a literal ^', "['test/^check.js']", 'test/^check.js'],
    ['a class with a literal *', "['test/[ab*].js']", 'test/a.js'],
  ])('keeps the files check.add writes from the fix, under %s in protect', (_case, protect, added) => {
    const fix = 'b'.repeat(40);
    const parsed = parse(suiteText(), { fix: taskText({ check: `{ run: node test.js, protect: ${protect}, add: [${added}] }`, source: `{ platform: claude-code, sessionId: s1, fix: ${fix} }` }) });

    expect(parsed).toMatchObject({ ok: true, diagnostics: [], suite: { tasks: [{ judge: { kind: 'check', add: { commit: fix, paths: [added] } } }] } });
  });

  it('keeps a file of the suite directory that check.add writes at its own path, with its bytes and mode, without source.fix', () => {
    const test = 'assert(refresh(expired) === null);\n';
    const parsed = parse(suiteText(), { fix: taskText({ check: "{ run: node test.js, protect: ['test/**'], add: [{ from: check-files/refresh.test.js, to: test/auth/refresh.test.js }] }" }) }, undefined, [
      suiteFile('check-files/refresh.test.js', test, '100755'),
    ]);

    expect(parsed).toMatchObject({ ok: true, diagnostics: [] });
    expect(parsed.ok && parsed.suite.tasks[0].judge).toEqual({
      kind: 'check', run: 'node test.js', protect: ['test/**'],
      files: [{ path: 'test/auth/refresh.test.js', mode: '100755', base64: Buffer.from(test).toString('base64') }],
    });
  });

  it('keeps every file under a directory of the suite directory that check.add writes, below its own path, in path order', () => {
    const parsed = parse(suiteText(), { fix: taskText({ check: "{ run: node test.js, protect: ['test/**'], add: [{ from: check-files/auth, to: test/auth }] }" }) }, undefined, [
      suiteFile('check-files/auth/refresh.test.js', 'refresh'),
      suiteFile('check-files/auth/fixtures/token.json', '{}'),
      suiteFile('check-files/other.test.js', 'other'),
    ]);

    expect(parsed.ok && parsed.suite.tasks[0].judge).toMatchObject({
      files: [{ path: 'test/auth/fixtures/token.json', base64: Buffer.from('{}').toString('base64') }, { path: 'test/auth/refresh.test.js', base64: Buffer.from('refresh').toString('base64') }],
    });
  });

  it.each([
    ['a from that names no file of the suite directory', '[{ from: check-files/missing.js, to: test/missing.js }]', 'check.add.0.from', '"check-files/missing.js" is no file or directory of the suite directory; a symlink is not one'],
    ['a from outside the suite directory', '[{ from: ../other/check-files/a.js, to: test/a.js }]', 'check.add.0.from', 'must be a path inside the suite directory, with no backslash and no ".", ".." or empty segment'],
    ['an absolute from', '[{ from: /etc/passwd, to: test/a.js }]', 'check.add.0.from', 'must be a path inside the suite directory, with no backslash and no ".", ".." or empty segment'],
    ['a to with ..', '[{ from: check-files/a.js, to: test/../a.js }]', 'check.add.0.to', 'must be a path relative to the repo, with no backslash and no ".", ".." or empty segment'],
    ['a to with a glob', "[{ from: check-files/a.js, to: 'test/*.js' }]", 'check.add.0.to', 'must name one file, without glob characters'],
    ['a to outside protect', '[{ from: check-files/a.js, to: lib/a.js }]', 'check.add.0.to', 'check.add "lib/a.js" is not under check.protect, so the agent could supply it; add a protect path that covers it'],
    ['a directory whose files land outside protect', '[{ from: check-files, to: test }]', 'check.add.0.to', 'check.add "test/a.js" is not under check.protect, so the agent could supply it; add a protect path that covers it'],
    ['two entries that write one path', '[{ from: check-files/a.js, to: test/unit/a.test.js }, { from: check-files/a.js, to: test/unit/a.test.js }]', 'check.add.1.to', 'check.add writes "test/unit/a.test.js" twice; write each path once'],
    ['two entries whose paths nest', '[{ from: check-files/a.js, to: test/a.test.js/b.test.js }, { from: check-files/a.js, to: test/a.test.js }]', 'check.add.1.to', 'check.add writes "test/a.test.js" as a file and as the directory of "test/a.test.js/b.test.js"; write paths that do not nest'],
    ['an entry with neither form', '[{ to: test/unit/a.test.js }]', 'check.add.0', 'must be a path of source.fix, or { from, to }: a file or directory of the suite directory, and where the check reads it'],
  ])('reports %s at its check.add entry', (_rule, add, field, message) => {
    const parsed = parse(suiteText(), { bad: taskText({ check: `{ run: node test.js, protect: ['test/**/*.test.js'], add: ${add} }` }), fix: taskText() }, undefined, [suiteFile('check-files/a.js', 'a')]);

    expect(parsed).toMatchObject({ ok: true, suite: { tasks: [{ id: 'fix' }] } });
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ file: 'benchmarks/fix/tasks/bad.yaml', line: 5, field, message })]);
  });

  it.each(['test/[[:digit:]].js', 'test/[![:alpha:]]x.js'])("reports protect %s, whose named class git reads and a check would not, at its file", (protect) => {
    const parsed = parse(suiteText(), { bad: taskText({ check: `{ run: node test.js, protect: ['${protect}'] }` }), fix: taskText() });

    expect(parsed).toMatchObject({ ok: true, suite: { tasks: [{ id: 'fix' }] } });
    expect(parsed.diagnostics).toEqual([expect.objectContaining({
      file: 'benchmarks/fix/tasks/bad.yaml', field: 'check.protect.0', message: 'has a named class such as [:digit:], which a check cannot read; list its characters, such as [0-9]',
    })]);
  });

  it('hashes a task with check files over their paths, modes and bytes too, and a task without them over its file alone', () => {
    const task = taskText({ check: "{ run: node test.js, protect: ['test/**'], add: [{ from: check-files/a.js, to: test/a.js }] }" });
    const hashed = (files: SuiteFile[]): string | undefined => {
      const parsed = parse(suiteText(), { fix: task }, undefined, files);
      return parsed.ok ? parsed.suite.tasks[0].sourceHash : undefined;
    };
    const plain = parse(suiteText(), { fix: taskText() });

    const kept = hashed([suiteFile('check-files/a.js', 'a')]);

    expect(kept).toMatch(/^[0-9a-f]{64}$/);
    expect(kept).not.toBe(createHash('sha256').update(task).digest('hex'));
    expect(hashed([suiteFile('check-files/a.js', 'a')])).toBe(kept);
    expect(hashed([suiteFile('check-files/a.js', 'b')])).not.toBe(kept);
    expect(hashed([suiteFile('check-files/a.js', 'a', '100755')])).not.toBe(kept);
    expect(plain.ok && plain.suite.tasks[0].sourceHash).toBe(createHash('sha256').update(taskText()).digest('hex'));
  });

  it('reports a suite with no valid task', () => {
    const parsed = parse(suiteText(), { bad: taskText({ startingCommit: 'abc1234' }) });

    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ file: 'benchmarks/fix/suite.yaml', message: 'suite fix has no valid task' }));
  });

  it('warns about a model name in defaults.model while an arm changes the tool, and not about an alias', () => {
    const suite = suiteText({ defaults: '{ tool: claude, model: claude-opus-5-5 }' });

    const named = parse(suite, undefined, () => false);
    const aliased = parse(suite, undefined, (model) => model === 'claude-opus-5-5');

    expect(named).toMatchObject({ ok: true, diagnostics: [] });
    expect(named.ok && named.warnings).toEqual([expect.objectContaining({
      file: 'benchmarks/fix/suite.yaml',
      field: 'defaults.model',
      message: 'defaults.model "claude-opus-5-5" is a model name, not an alias in models/aliases.yaml, and arm "codex" changes the tool; use an alias that names a model for each tool',
    })]);
    expect(aliased.ok && aliased.warnings).toEqual([]);
  });
});

describe('suite sync', () => {
  function team(files: Record<string, string>): LocalConfig {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-suite-'));
    dirs.push(root);
    const repo = path.join(root, 'team-repo');
    write(repo, files);
    return { repo: { localPath: repo, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  }

  function write(repo: string, files: Record<string, string>): void {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    }
  }

  const suiteAt = (dir: string, name: string): Record<string, string> => ({
    [`benchmarks/${dir}/suite.yaml`]: suiteText({ name }),
    [`benchmarks/${dir}/tasks/fix.yaml`]: taskText(),
  });
  const ROLES = 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [], benchmarks: [dev] }\n  - id: ops\n    resources: { knowledge: [], skills: [], benchmarks: [ops] }\n';

  it('caches a role\'s suites only for that role, and shared suites for everyone', async () => {
    const config = team({ 'manifest/roles.yaml': ROLES, ...suiteAt('dev/dev-fix', 'dev-fix'), ...suiteAt('fix', 'fix') });
    const dev = { ...config, primaryRole: 'dev' };
    const ops = { ...config, primaryRole: 'ops', dataHome: `${config.dataHome}-ops` };

    const devSync = await syncTeamDefinitions(dev);
    const opsSync = await syncTeamDefinitions(ops);

    expect(devSync.benchmarks.map((suite) => suite.relativePath).sort()).toEqual(['benchmarks/dev/dev-fix/suite.yaml', 'benchmarks/fix/suite.yaml']);
    expect(opsSync.benchmarks.map((suite) => suite.relativePath)).toEqual(['benchmarks/fix/suite.yaml']);
    expect((await loadCachedSuite(dev, 'dev-fix'))?.relativePath).toBe('benchmarks/dev/dev-fix/suite.yaml');
    expect(await loadCachedSuite(ops, 'dev-fix')).toBeNull();
    expect((await loadCachedSuite(ops, 'fix'))?.relativePath).toBe('benchmarks/fix/suite.yaml');
  });

  it('names each scorer a suite lists that this member receives no valid scorer of', async () => {
    const quality = '---\nlabels:\n  - { value: good, score: 1, description: Good. }\n  - { value: bad, score: 0, description: Bad. }\npassingScore: 1\n---\nJudge it.\n';
    const config = team({ 'manifest/roles.yaml': ROLES.replace('benchmarks: [dev]', 'benchmarks: [dev], scorers: [dev]'), 'scorers/dev/quality.md': quality, 'benchmarks/fix/suite.yaml': suiteText({ scorers: '[quality, missing]' }), 'benchmarks/fix/tasks/fix.yaml': taskText() });
    const dev = { ...config, primaryRole: 'dev' };
    const ops = { ...config, primaryRole: 'ops', dataHome: `${config.dataHome}-ops` };

    const devSync = await syncTeamDefinitions(dev);
    const opsSync = await syncTeamDefinitions(ops);

    const unknown = (scorer: string) => `benchmarks/fix/suite.yaml: suite "fix" lists scorer "${scorer}", which has no valid scorers/${scorer}.md; the benchmark does not start without it`;
    expect(devSync.unknownScorers.map(formatUnknownScorer)).toEqual([unknown('missing')]);
    expect(opsSync.unknownScorers.map(formatUnknownScorer)).toEqual([unknown('quality'), unknown('missing')]);
  });

  it('caches neither suite of one name in two active namespaces', async () => {
    const config = { ...team({ 'manifest/roles.yaml': ROLES, ...suiteAt('dev/fix', 'fix'), ...suiteAt('ops/fix', 'fix') }), primaryRole: 'dev', additionalRoles: ['ops'] };

    const result = await syncTeamDefinitions(config);

    expect(result.benchmarks).toEqual([]);
    expect(result.invalid).toEqual([expect.objectContaining({
      file: 'benchmarks/dev/fix/suite.yaml',
      code: 'benchmark_namespace_conflict',
      message: 'Suite "fix" is defined in two active namespaces (benchmarks/dev/fix/suite.yaml and benchmarks/ops/fix/suite.yaml); neither runs',
    })]);
    expect(await loadCachedSuite(config, 'fix')).toBeNull();
  });

  it('reports a declared namespace directory that holds suite.yaml itself', async () => {
    const config = { ...team({ 'manifest/roles.yaml': ROLES, 'benchmarks/dev/suite.yaml': suiteText({ name: 'dev' }), 'benchmarks/dev/tasks/fix.yaml': taskText() }), primaryRole: 'dev' };

    const result = await syncTeamDefinitions(config);

    expect(result.benchmarks).toEqual([]);
    expect(result.invalid).toEqual([expect.objectContaining({
      file: 'benchmarks/dev/suite.yaml',
      message: 'benchmarks/dev is a namespace; put the suite in benchmarks/dev/<suite>/',
    })]);
  });

  const HIDDEN = taskText({ check: "{ run: node test.js, protect: ['test/**'], add: [{ from: check-files, to: test/hidden }] }" });
  const base64 = (text: string): string => Buffer.from(text).toString('base64');

  it('caches the files a check.add entry names from the suite directory, with their mode, until the next sync', async () => {
    const config = team({ 'benchmarks/fix/suite.yaml': suiteText(), 'benchmarks/fix/tasks/fix.yaml': HIDDEN, 'benchmarks/fix/check-files/a.test.js': 'a', 'benchmarks/fix/check-files/run.sh': 'run' });
    fs.chmodSync(path.join(config.repo.localPath, 'benchmarks/fix/check-files/run.sh'), 0o755);

    const result = await syncTeamDefinitions(config);
    write(config.repo.localPath, { 'benchmarks/fix/check-files/a.test.js': 'edited after the sync' });

    expect(result.invalid).toEqual([]);
    expect((await loadCachedSuite(config, 'fix'))?.tasks[0].judge).toMatchObject({
      files: [{ path: 'test/hidden/a.test.js', mode: '100644', base64: base64('a') }, { path: 'test/hidden/run.sh', mode: '100755', base64: base64('run') }],
    });
  });

  it.each([
    ['is a symlink to a file outside the suite directory', (suite: string, outside: string) => {
      fs.mkdirSync(path.join(suite, 'check-files'));
      fs.symlinkSync(path.join(outside, 'a.test.js'), path.join(suite, 'check-files/a.test.js'));
    }],
    ['goes through a symlinked directory', (suite: string, outside: string) => fs.symlinkSync(outside, path.join(suite, 'check-files'))],
  ])('reads nothing for a from that %s, and reports it', async (_case, link) => {
    const task = taskText({ check: "{ run: node test.js, protect: ['test/**'], add: [{ from: check-files/a.test.js, to: test/a.test.js }] }" });
    const config = team({ 'benchmarks/fix/suite.yaml': suiteText(), 'benchmarks/fix/tasks/fix.yaml': task, 'outside/a.test.js': 'outside' });
    link(path.join(config.repo.localPath, 'benchmarks/fix'), path.join(config.repo.localPath, 'outside'));

    const result = await syncTeamDefinitions(config);

    expect(result.invalid).toEqual([
      expect.objectContaining({ file: 'benchmarks/fix/suite.yaml', message: 'suite fix has no valid task' }),
      expect.objectContaining({ file: 'benchmarks/fix/tasks/fix.yaml', field: 'check.add.0.from', message: '"check-files/a.test.js" is no file or directory of the suite directory; a symlink is not one' }),
    ]);
  });

  it('leaves out a symlink under a directory a check.add entry names', async () => {
    const config = team({ 'benchmarks/fix/suite.yaml': suiteText(), 'benchmarks/fix/tasks/fix.yaml': HIDDEN, 'benchmarks/fix/check-files/a.test.js': 'a', 'outside.js': 'outside' });
    fs.symlinkSync(path.join(config.repo.localPath, 'outside.js'), path.join(config.repo.localPath, 'benchmarks/fix/check-files/b.test.js'));

    await syncTeamDefinitions(config);

    expect((await loadCachedSuite(config, 'fix'))?.tasks[0].judge).toMatchObject({ files: [{ path: 'test/hidden/a.test.js' }] });
  });

  it('leaves out the dot entries under a directory a check.add entry names, and reads a dotfile a from names', async () => {
    const task = taskText({ check: "{ run: node test.js, protect: ['test/**'], add: [{ from: check-files, to: test/hidden }, { from: check-files/.env.test, to: test/.env.test }] }" });
    const config = team({
      'benchmarks/fix/suite.yaml': suiteText(), 'benchmarks/fix/tasks/fix.yaml': task, 'benchmarks/fix/check-files/a.test.js': 'a',
      'benchmarks/fix/check-files/.DS_Store': 'finder', 'benchmarks/fix/check-files/.env.test': 'env', 'benchmarks/fix/check-files/.cache/b.test.js': 'b',
    });

    await syncTeamDefinitions(config);

    expect((await loadCachedSuite(config, 'fix'))?.tasks[0].judge).toMatchObject({
      files: [{ path: 'test/hidden/a.test.js', base64: base64('a') }, { path: 'test/.env.test', base64: base64('env') }],
    });
  });

  it('keeps the last valid version of a suite with no valid task', async () => {
    const config = team(suiteAt('fix', 'fix'));
    await syncTeamDefinitions(config);
    const valid = await loadCachedSuite(config, 'fix');
    write(config.repo.localPath, { 'benchmarks/fix/tasks/fix.yaml': taskText({ startingCommit: 'abc1234' }) });

    const result = await syncTeamDefinitions(config);

    expect(result.benchmarks).toEqual([]);
    expect(result.invalid).toContainEqual(expect.objectContaining({ file: 'benchmarks/fix/suite.yaml', message: 'suite fix has no valid task' }));
    expect(valid).not.toBeNull();
    expect(await loadCachedSuite(config, 'fix')).toEqual(valid);
  });
});
