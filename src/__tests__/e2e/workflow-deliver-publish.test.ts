/**
 * Real CLI: a step with `deliver: publish` in `workspace: { team: { branch: teamai-reports } }` runs at origin's tip of
 * that data branch, and what it staged in the member's own files lands there: no default branch merged in, no pull
 * request, and a teammate's commit that reached origin meanwhile kept. Offline, the step succeeds and its data waits.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const workflow = (script: string, branch = 'teamai-reports'): string => `schemaVersion: v1alpha1
name: ${branch === 'teamai-reports' ? 'publish-note' : 'publish-learning'}
description: Publish this member's note to ${branch}.
steps:
  - id: note
    workspace: { team: { branch: ${branch} } }
    deliver: publish
    command: node ${JSON.stringify(script)}
`;

const RunSchema = z.object({
  steps: z.array(z.object({ id: z.string(), status: z.string(), message: z.string().optional(), failure: z.object({ code: z.string(), message: z.string() }).optional() })),
  deliveries: z.array(z.unknown()).optional(),
  copies: z.record(z.string(), z.unknown()).optional(),
});

describe('a step that publishes to a teamai data branch, run through the real CLI', () => {
  let fixture: BenchmarkFixture;
  let script: string;
  let member = '';

  const git = (args: string[]): string => execFileSync('git', ['--git-dir', fixture.teamOrigin, ...args], { encoding: 'utf8' }).trim();
  /** How many commits on origin's teamai-reports the step published; teamai's own writers push there after every command too. */
  const published = (): number => git(['log', '--format=%s', 'teamai-reports']).split('\n').filter((subject) => subject === `[teamai] note: ${member}`).length;
  const onReports = (file: string): string | undefined => {
    const shown = spawnSync('git', ['--git-dir', fixture.teamOrigin, 'show', `teamai-reports:${file}`], { encoding: 'utf8' });
    return shown.status === 0 ? shown.stdout : undefined;
  };
  const mainIsMerged = (): boolean => spawnSync('git', ['--git-dir', fixture.teamOrigin, 'merge-base', '--is-ancestor', 'main', 'teamai-reports']).status === 0;

  const onLearnings = (file: string): string | undefined => {
    const shown = spawnSync('git', ['--git-dir', fixture.teamOrigin, 'show', `teamai-learnings:${file}`], { encoding: 'utf8' });
    return shown.status === 0 ? shown.stdout : undefined;
  };

  /** Runs `name`, publish-note by default, with the local driver, its step doing `body` in the place it runs in. */
  async function run(body: string, name = 'publish-note') {
    fs.writeFileSync(script, `const fs = require('fs'); const { execFileSync } = require('child_process');\nconst stage = (file) => execFileSync('git', ['add', '--', file]);\n${body}\n`);
    const ran = await fixture.teamai(['workflow', 'start', name, '--driver', 'local']);
    const done = z.object({ run: z.string(), outcome: z.string() }).safeParse(envelope(ran).data?.done);
    if (!done.success) throw new Error(`no run: ${said(ran)}`);
    const state = RunSchema.parse(fixture.runFile(done.data.run));
    return { run: done.data.run, outcome: done.data.outcome, step: state.steps.find((step) => step.id === 'note'), state, said: said(ran) };
  }

  beforeAll(async () => {
    fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false });
    script = path.join(fixture.root, 'note.js');
    fixture.pushTeam({ 'workflows/publish-note.yaml': workflow(script), 'workflows/publish-learning.yaml': workflow(script, 'teamai-learnings') });
    const pulled = await fixture.teamai(['pull']);
    expect(pulled.code, said(pulled)).toBe(0);
    member = z.object({ username: z.string() }).parse(parseYaml(fs.readFileSync(path.join(fixture.dataHome(), 'config.yaml'), 'utf8'))).username;
  }, 120_000);

  afterAll(() => fixture?.remove());

  it('pushes only what the step staged in the member\'s own files, with no default branch merged in and no pull request', async () => {
    const own = JSON.stringify(`notes/${member}.yaml`);
    const ran = await run(`fs.mkdirSync('notes', { recursive: true }); fs.writeFileSync(${own}, 'seen: 3\\n'); stage(${own});
fs.writeFileSync('stray.txt', 'not staged\\n');`);

    expect(ran.outcome, ran.said).toBe('succeeded');
    expect(onReports(`notes/${member}.yaml`)).toBe('seen: 3\n');
    expect(onReports('stray.txt')).toBeUndefined();
    expect(mainIsMerged()).toBe(false);
    expect(published()).toBe(1);
    expect(ran.state.deliveries ?? []).toEqual([]);
    expect(Object.keys(ran.state.copies ?? {})).not.toContain('teamai-reports');
  }, 120_000);

  it('lets the run be published, since a step that published to a data branch leaves nothing only this machine has', async () => {
    const ran = await run(`fs.mkdirSync('notes', { recursive: true }); fs.writeFileSync(${JSON.stringify(`notes/${member}.yaml`)}, 'seen: 6\\n'); stage(${JSON.stringify(`notes/${member}.yaml`)});`);
    expect(ran.outcome, ran.said).toBe('succeeded');

    const handed = await fixture.teamai(['workflow', 'publish', ran.run]);

    expect(handed.code, said(handed)).toBe(0);
  }, 120_000);

  it('refuses a step that staged a file of another member, and pushes nothing', async () => {
    const before = published();
    const ran = await run(`fs.mkdirSync('votes', { recursive: true });
fs.writeFileSync(${JSON.stringify(`votes/${member}.yaml`)}, 'up: 1\\n'); stage(${JSON.stringify(`votes/${member}.yaml`)});
fs.writeFileSync('votes/someone-else.yaml', 'up: 9\\n'); stage('votes/someone-else.yaml');`);

    expect(ran.outcome, ran.said).toBe('failed');
    expect(ran.step?.failure).toEqual({
      code: 'push_failed',
      message: `Step "note" staged files outside ${member}'s own on teamai-reports, so nothing was published:\nvotes/someone-else.yaml: belongs to someone-else, not ${member}\nA step publishes only paths such as scores/${member}/… or votes/${member}.yaml. Have it stage only those, then run the workflow again.`,
    });
    expect(published()).toBe(before);
  }, 120_000);

  it('succeeds and pushes nothing when the step staged nothing', async () => {
    const before = published();
    const ran = await run("fs.writeFileSync('stray.txt', 'not staged\\n');");

    expect(ran.outcome, ran.said).toBe('succeeded');
    expect(published()).toBe(before);
  }, 120_000);

  it('keeps a teammate\'s commit that reached teamai-reports while the step ran, and lands on top of it', async () => {
    const teammate = path.join(fixture.root, 'teammate');
    const at = (file: string): string => JSON.stringify(path.join(teammate, file));
    const as = "['-c', 'user.name=T', '-c', 'user.email=t@example.com']";
    const own = JSON.stringify(`notes/${member}.yaml`);
    const ran = await run(`execFileSync('git', ['clone', '-q', '--branch', 'teamai-reports', ${JSON.stringify(fixture.teamOrigin)}, ${JSON.stringify(teammate)}]);
fs.mkdirSync(${at('votes')}, { recursive: true }); fs.writeFileSync(${at('votes/teammate.yaml')}, 'up: 2\\n');
execFileSync('git', ['add', 'votes/teammate.yaml'], { cwd: ${JSON.stringify(teammate)} });
execFileSync('git', [...${as}, 'commit', '-qm', 'teammate'], { cwd: ${JSON.stringify(teammate)} });
execFileSync('git', ['push', '-q', 'origin', 'teamai-reports'], { cwd: ${JSON.stringify(teammate)} });
fs.mkdirSync('notes', { recursive: true }); fs.writeFileSync(${own}, 'seen: 4\\n'); stage(${own});`);

    expect(ran.outcome, ran.said).toBe('succeeded');
    expect(onReports('votes/teammate.yaml')).toBe('up: 2\n');
    expect(onReports(`notes/${member}.yaml`)).toBe('seen: 4\n');
    expect(mainIsMerged()).toBe(false);
  }, 120_000);

  it('succeeds offline with its data pending on this machine, and the next teamai score --push sends it', async () => {
    const before = published();
    const away = `${fixture.teamOrigin}.away`;
    fs.renameSync(fixture.teamOrigin, away);
    try {
      const ran = await run(`fs.mkdirSync('notes', { recursive: true });
fs.writeFileSync(${JSON.stringify(`notes/${member}.yaml`)}, 'seen: 5\\n'); stage(${JSON.stringify(`notes/${member}.yaml`)});`);

      expect(ran.outcome, ran.said).toBe('succeeded');
      expect(ran.step?.message).toMatch(/^Step "note" left its data on this machine, pending: /);
    } finally {
      fs.renameSync(away, fixture.teamOrigin);
    }
    expect(published()).toBe(before);

    const pushed = await fixture.teamai(['score', '--push']);

    expect(pushed.code, said(pushed)).toBe(0);
    expect(envelope(pushed).data).toEqual({ published: true });
    expect(published()).toBe(before + 1);
    expect(onReports(`notes/${member}.yaml`)).toBe('seen: 5\n');
  }, 120_000);

  /** Runs publish-learning with origin unreachable, so its note to teamai-learnings stays pending on this machine. */
  async function learnOffline(seen: number, whileAway: () => Promise<void> = async () => {}): Promise<void> {
    const away = `${fixture.teamOrigin}.away`;
    fs.renameSync(fixture.teamOrigin, away);
    try {
      const ran = await run(`fs.mkdirSync('notes', { recursive: true });
fs.writeFileSync(${JSON.stringify(`notes/${member}.yaml`)}, 'seen: ${seen}\\n'); stage(${JSON.stringify(`notes/${member}.yaml`)});`, 'publish-learning');

      expect(ran.outcome, ran.said).toBe('succeeded');
      expect(ran.step?.message).toMatch(/^Step "note" left its data on this machine, pending: /);
      await whileAway();
    } finally {
      fs.renameSync(away, fixture.teamOrigin);
    }
    expect(onLearnings(`notes/${member}.yaml`)).not.toBe(`seen: ${seen}\n`);
  }

  it('sends with the next teamai pull what a step published to teamai-learnings while origin was unreachable', async () => {
    await learnOffline(7);

    const pulled = await fixture.teamai(['pull']);

    expect(pulled.code, said(pulled)).toBe(0);
    expect(onLearnings(`notes/${member}.yaml`)).toBe('seen: 7\n');
  }, 120_000);

  it('says with teamai score --drain that what a step published to teamai-learnings stays pending, and sends it once origin is back', async () => {
    await learnOffline(8, async () => {
      const stuck = await fixture.teamai(['score', '--drain']);

      expect(stuck.code, said(stuck)).toBe(1);
      expect(said(stuck)).toContain('What workflow steps published to teamai-learnings stays pending on this machine: ');
    });

    const drained = await fixture.teamai(['score', '--drain']);

    expect(said(drained)).not.toMatch(/teamai-learnings/);
    expect(onLearnings(`notes/${member}.yaml`)).toBe('seen: 8\n');
  }, 120_000);
});
