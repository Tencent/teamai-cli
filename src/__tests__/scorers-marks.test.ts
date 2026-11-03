import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Marks, type MarkKey, type RunStatus } from '../scorers/marks.js';
import type { LocalConfig } from '../types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scope(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-marks-'));
  dirs.push(root);

  return { repo: { localPath: path.join(root, 'knowledge'), remote: 'local' }, username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data') };
}

const NOW = '2026-11-03T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const later = (days: number) => new Date(Date.parse(NOW) + days * DAY).toISOString();
const JUDGED = 'r00000000aaaaaaaa';

function pass(scorer: string, number = 1): MarkKey {
  return { scorer, subject: { kind: 'run', subject: { runId: JUDGED, step: 'fix', pass: number } } };
}

function session(scorer: string, sessionId = '7c1e', sourceHash = 'h1'): MarkKey {
  return { scorer, sourceHash, subject: { kind: 'session', subject: { platform: 'claude-code', sessionId } } };
}

/** Runs by id, as the run store would answer: the judged run changed at NOW, every scoring run is still going. */
function runs(): { readRun: (id: string) => Promise<RunStatus | undefined>; end: (id: string) => void; set: (id: string, status: RunStatus) => void } {
  const known = new Map<string, RunStatus>([[JUDGED, { ended: true, changedAt: NOW }]]);

  return {
    readRun: async (id) => known.get(id) ?? (id.startsWith('score-') ? { ended: false, changedAt: NOW } : undefined),
    end: (id) => known.set(id, { ended: true, changedAt: NOW }),
    set: (id, status) => known.set(id, status),
  };
}

async function launch(config: LocalConfig, keys: MarkKey[], at = NOW, options: { run?: string; demand?: 'auto' | 'named'; reader?: ReturnType<typeof runs>; group?: string; dailyLimit?: number } = {}) {
  const { run = 'score-1', demand = 'auto', reader = runs(), group = 'g0' } = options;

  return Marks.open(config, { run, demand, groups: [{ group, keys }], ...options.dailyLimit === undefined ? {} : { dailyLimit: options.dailyLimit } }, { now: at, readRun: reader.readRun });
}

describe('Marks', () => {
  it('opens an unmarked scorer for the run that launched it, and the open mark holds it against another launch', async () => {
    const config = scope();
    const reader = runs();

    expect(await Marks.states(config, [pass('review')], { now: NOW, readRun: reader.readRun })).toEqual([{ kind: 'unmarked' }]);
    expect(await launch(config, [pass('review')], NOW, { reader })).toEqual({ status: 'done', opened: [{ group: 'g0', keys: [pass('review')] }], skipped: [], limited: false });
    expect(await Marks.states(config, [pass('review')], { now: NOW, readRun: reader.readRun })).toEqual([{ kind: 'open', at: NOW, run: 'score-1', group: 'g0', demand: 'auto' }]);

    expect(await launch(config, [pass('review')], NOW, { run: 'score-2', demand: 'named', reader })).toEqual({
      status: 'done', opened: [], skipped: [{ key: pass('review'), state: { kind: 'open', at: NOW, run: 'score-1', group: 'g0', demand: 'auto' } }], limited: false,
    });
  });

  it('opens again for the run that holds it, without a second launch', async () => {
    const config = scope();
    const reader = runs();
    await launch(config, [session('review')], NOW, { reader });

    expect(await launch(config, [session('review')], NOW, { reader })).toMatchObject({ opened: [{ group: 'g0', keys: [session('review')] }] });
    expect(await Marks.launchesToday(config, NOW)).toBe(1);
  });

  it('closes a mark labelled when a label is written, and failed with the code of a failed attempt', async () => {
    const config = scope();
    const reader = runs();
    await launch(config, [pass('review'), pass('tests')], NOW, { reader });

    expect(await Marks.close(config, [pass('review')], { kind: 'labelled' }, { now: NOW })).toEqual({ status: 'done' });
    expect(await Marks.close(config, [pass('tests')], { kind: 'failed', code: 'judge_failed' }, { now: NOW })).toEqual({ status: 'done' });
    reader.end('score-1');

    expect(await Marks.states(config, [pass('review'), pass('tests')], { now: NOW, readRun: reader.readRun })).toEqual([{ kind: 'labelled' }, { kind: 'failed', code: 'judge_failed' }]);
    expect(await launch(config, [pass('review'), pass('tests')], NOW, { run: 'score-2', reader })).toEqual({
      status: 'done', opened: [], skipped: [{ key: pass('review'), state: { kind: 'labelled' } }, { key: pass('tests'), state: { kind: 'failed', code: 'judge_failed' } }], limited: false,
    });
  });

  it('counts a lapse each time the launching run ends with the mark still open, and closes it at the fourth', async () => {
    const config = scope();
    const reader = runs();
    const states = async () => (await Marks.states(config, [pass('review')], { now: NOW, readRun: reader.readRun }))[0];

    for (const lapses of [1, 2, 3]) {
      expect(await launch(config, [pass('review')], NOW, { run: `score-${lapses}`, reader })).toMatchObject({ opened: [{ keys: [pass('review')] }] });
      reader.end(`score-${lapses}`);
      expect(await states()).toEqual({ kind: 'lapsed', lapses });
    }

    await launch(config, [pass('review')], NOW, { run: 'score-4', reader });
    reader.set('score-4', { ended: false, changedAt: NOW });
    expect(await states()).toMatchObject({ kind: 'open', run: 'score-4' });
    reader.end('score-4');
    expect(await states()).toEqual({ kind: 'lapsed', lapses: 4 });
    expect(await launch(config, [pass('review')], NOW, { run: 'score-5', reader })).toMatchObject({ opened: [], skipped: [{ state: { kind: 'lapsed', lapses: 4 } }] });
  });

  it('counts a run that is gone from this machine as ended', async () => {
    const config = scope();
    await launch(config, [session('review')], NOW, { run: 'r-gone', reader: runs() });

    expect(await Marks.states(config, [session('review')], { now: NOW, readRun: runs().readRun })).toEqual([{ kind: 'lapsed', lapses: 1 }]);
  });

  it('leaves a mark waiting for CI, which is no lapse when its run ends and starts again', async () => {
    const config = scope();
    const reader = runs();
    await launch(config, [pass('delivered')], NOW, { reader });
    reader.end('score-1');
    await launch(config, [pass('delivered')], NOW, { run: 'score-2', reader });

    expect(await Marks.close(config, [pass('delivered')], { kind: 'waiting' }, { now: NOW })).toEqual({ status: 'done' });
    reader.end('score-2');
    expect(await Marks.states(config, [pass('delivered')], { now: NOW, readRun: reader.readRun })).toEqual([{ kind: 'waiting' }]);

    await launch(config, [pass('delivered')], NOW, { run: 'score-3', reader });
    reader.end('score-3');
    expect(await Marks.states(config, [pass('delivered')], { now: NOW, readRun: reader.readRun })).toEqual([{ kind: 'lapsed', lapses: 2 }]);
  });

  it('expires a pass 14 days after its run last changed, and a named launch reopens it with 14 days of its own', async () => {
    const config = scope();
    const reader = runs();
    await launch(config, [pass('review')], NOW, { reader });
    reader.end('score-1');
    const at = (now: string) => Marks.states(config, [pass('review')], { now, readRun: reader.readRun });

    expect(await at(later(13.9))).toEqual([{ kind: 'lapsed', lapses: 1 }]);
    expect(await at(later(14))).toEqual([{ kind: 'expired' }]);
    expect(await launch(config, [pass('review')], later(14), { run: 'score-2', reader })).toMatchObject({ opened: [], skipped: [{ state: { kind: 'expired' } }] });

    expect(await launch(config, [pass('review')], later(20), { run: 'score-3', demand: 'named', reader })).toMatchObject({ opened: [{ keys: [pass('review')] }] });
    reader.end('score-3');
    expect(await at(later(33.9))).toEqual([{ kind: 'lapsed', lapses: 1 }]);
    expect(await at(later(34))).toEqual([{ kind: 'expired' }]);
  });

  it('expires a pass whose run is gone, and never expires a session', async () => {
    const config = scope();
    const reader = runs();
    const gone: MarkKey = { scorer: 'review', subject: { kind: 'run', subject: { runId: 'r-gone', step: 'fix', pass: 1 } } };

    expect(await Marks.states(config, [gone, session('review')], { now: later(400), readRun: reader.readRun })).toEqual([{ kind: 'expired' }, { kind: 'unmarked' }]);
  });

  it('reopens a failed or labelled mark only for a named launch, which starts its lapses again', async () => {
    const config = scope();
    const reader = runs();
    await launch(config, [session('review'), session('tests')], NOW, { reader });
    await Marks.close(config, [session('review')], { kind: 'failed', code: 'judge_answer_invalid' }, { now: NOW });
    await Marks.close(config, [session('tests')], { kind: 'labelled' }, { now: NOW });
    reader.end('score-1');

    expect(await launch(config, [session('review'), session('tests')], NOW, { run: 'score-2', reader })).toMatchObject({ opened: [] });
    expect(await launch(config, [session('review'), session('tests')], NOW, { run: 'score-3', demand: 'named', reader })).toMatchObject({ opened: [{ keys: [session('review'), session('tests')] }] });
    reader.end('score-3');
    expect(await Marks.states(config, [session('review'), session('tests')], { now: NOW, readRun: reader.readRun })).toEqual([{ kind: 'lapsed', lapses: 1 }, { kind: 'lapsed', lapses: 1 }]);
  });

  it('keys a session by its rubric too, so a new rubric of the scorer is judged of its own', async () => {
    const config = scope();
    const reader = runs();
    await launch(config, [session('review')], NOW, { reader });
    await Marks.close(config, [session('review')], { kind: 'labelled' }, { now: NOW });

    expect(await Marks.states(config, [session('review'), session('review', '7c1e', 'h2')], { now: NOW, readRun: reader.readRun })).toEqual([{ kind: 'labelled' }, { kind: 'unmarked' }]);
  });

  describe('the daily limit', () => {
    it('counts the session launches of the local day, a group once, and no pass', async () => {
      const config = scope();
      const reader = runs();
      await launch(config, [session('review', 'a'), session('tests', 'a')], NOW, { reader });
      await launch(config, [session('review', 'b')], NOW, { run: 'score-2', reader });
      await launch(config, [pass('review')], NOW, { run: 'score-3', reader });
      await launch(config, [session('review', 'c')], later(-1), { run: 'score-4', reader });

      expect(await Marks.launchesToday(config, NOW)).toBe(2);
    });

    it('counts each start of a lapsed session', async () => {
      const config = scope();
      const reader = runs();
      await launch(config, [session('review')], NOW, { reader });
      reader.end('score-1');
      await launch(config, [session('review')], NOW, { run: 'score-2', reader });

      expect(await Marks.launchesToday(config, NOW)).toBe(2);
    });

    it('refuses an automatic group past the limit, and counts a named one without refusing it', async () => {
      const config = scope();
      const reader = runs();
      await launch(config, [session('review', 'a')], NOW, { reader, dailyLimit: 2 });

      const opened = await Marks.open(config, { run: 'score-2', demand: 'auto', dailyLimit: 2, groups: [{ group: 'g0', keys: [session('review', 'b')] }, { group: 'g1', keys: [session('tests', 'b')] }] }, { now: NOW, readRun: reader.readRun });
      expect(opened).toEqual({ status: 'done', opened: [{ group: 'g0', keys: [session('review', 'b')] }], skipped: [], limited: true });
      expect(await launch(config, [session('review', 'c')], NOW, { run: 'score-3', reader, dailyLimit: 2 })).toMatchObject({ opened: [], limited: true });
      expect(await launch(config, [session('review', 'c')], NOW, { run: 'score-4', demand: 'named', reader, dailyLimit: 2 })).toMatchObject({ opened: [{ keys: [session('review', 'c')] }], limited: false });
      expect(await Marks.launchesToday(config, NOW)).toBe(3);
    });

    it('spends no slot on a group whose scorers are all closed', async () => {
      const config = scope();
      const reader = runs();
      await launch(config, [session('review', 'a')], NOW, { reader });
      await Marks.close(config, [session('review', 'a')], { kind: 'labelled' }, { now: NOW });

      const opened = await Marks.open(config, { run: 'score-2', demand: 'auto', dailyLimit: 2, groups: [{ group: 'g0', keys: [session('review', 'a')] }, { group: 'g1', keys: [session('review', 'b')] }] }, { now: NOW, readRun: reader.readRun });
      expect(opened).toMatchObject({ opened: [{ group: 'g1' }], limited: false });
    });
  });

  it('lists the marks automatic judging starts again: lapses before the fourth and marks waiting for CI', async () => {
    const config = scope();
    const reader = runs();
    await launch(config, [pass('lapsed'), pass('waiting'), pass('labelled'), session('lapsed')], NOW, { reader });
    await launch(config, [pass('open')], NOW, { run: 'score-2', reader });
    await Marks.close(config, [pass('waiting')], { kind: 'waiting' }, { now: NOW });
    await Marks.close(config, [pass('labelled')], { kind: 'labelled' }, { now: NOW });
    reader.end('score-1');

    expect(await Marks.restartable(config, { now: NOW, readRun: reader.readRun })).toEqual([
      { key: pass('lapsed'), state: { kind: 'lapsed', lapses: 1 } },
      { key: pass('waiting'), state: { kind: 'waiting' } },
      { key: session('lapsed'), state: { kind: 'lapsed', lapses: 1 } },
    ]);
    expect(await Marks.restartable(config, { now: later(14), readRun: reader.readRun })).toEqual([{ key: session('lapsed'), state: { kind: 'lapsed', lapses: 1 } }]);
  });

  it('keeps the marks of writers in parallel, and opens a scorer for only one of two parallel launches', async () => {
    const config = scope();
    const reader = runs();

    const [first, second] = await Promise.all([
      launch(config, [session('review', 'a')], NOW, { reader }),
      launch(config, [session('review', 'b')], NOW, { run: 'score-2', reader }),
    ]);
    expect([first, second]).toMatchObject([{ opened: [{ keys: [session('review', 'a')] }] }, { opened: [{ keys: [session('review', 'b')] }] }]);

    const both = await Promise.all([launch(config, [pass('review')], NOW, { run: 'score-3', reader }), launch(config, [pass('review')], NOW, { run: 'score-4', reader })]);
    expect(both.map((outcome) => outcome.status === 'done' ? outcome.opened.length : 'busy').sort()).toEqual([0, 1]);
    expect(await Marks.states(config, [session('review', 'a'), session('review', 'b')], { now: NOW, readRun: reader.readRun })).toMatchObject([{ kind: 'open' }, { kind: 'open' }]);
  });

  it('ignores a torn last line and keeps every mark written after it', async () => {
    const config = scope();
    const reader = runs();
    await launch(config, [pass('review')], NOW, { reader });
    const file = path.join(config.dataHome ?? '', 'scores', 'marks.jsonl');
    fs.appendFileSync(file, '{"scorer":"tests","subject":"run:r00000000aaaaaaaa:fix:1","at":"2026-11-0');

    expect(await Marks.states(config, [pass('review'), pass('tests')], { now: NOW, readRun: reader.readRun })).toMatchObject([{ kind: 'open' }, { kind: 'unmarked' }]);
    await launch(config, [pass('tests')], NOW, { reader });
    expect(await Marks.states(config, [pass('review'), pass('tests')], { now: NOW, readRun: reader.readRun })).toMatchObject([{ kind: 'open' }, { kind: 'open' }]);
  });
});

describe('Marks carried over from the judge attempts of an earlier teamai', () => {
  const SESSION_SUBJECT = { platform: 'claude-code', sessionId: '7c1e' };
  const lapsedLease = { status: 'leased', leasedAt: later(-2), expiresAt: later(-1.9) };
  const liveLease = { status: 'leased', leasedAt: later(-0.01), expiresAt: later(0.01) };
  const settled = { leasedAt: later(-2), expiresAt: later(-1.9), settledAt: later(-1.95) };
  const verdict = { labelId: 'l1', verdict: { label: 'good', score: 1, passed: true, version: 'v1' } };
  let entries = 0;

  /** One entry's attempts as an earlier teamai wrote them, under an entry id of its own. */
  function plant(config: LocalConfig, attempts: Array<Record<string, unknown>>, request?: { scorer: string; pass: number; requestedAt: string }): string {
    entries += 1;
    const entry = `s${entries.toString(16).padStart(13, '0')}`;
    const dir = path.join(config.dataHome ?? '', 'scores', 'attempts', entry);
    fs.mkdirSync(dir, { recursive: true });
    attempts.forEach((fields, index) => {
      const attempt = `a${(entries * 16 + index).toString(16).padStart(8, '0')}`;
      fs.writeFileSync(path.join(dir, `${attempt}.json`), JSON.stringify({
        attempt, entry, rubric: { sourceHash: 'h1' }, driver: { kind: 'local', machine: 'm', workspace: '/w' },
        judge: { tool: 'claude', by: 'scorer', isolation: 'verified', access: 'read' }, ...fields,
      }));
    });
    if (request) {
      const pin = { sourceHash: 'h1', content: 'Judge.' };
      fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ entry, scorer: request.scorer, subject: { runId: JUDGED, step: 'fix', pass: request.pass }, pin, requestedAt: request.requestedAt }));
    }

    return dir;
  }

  const ofPass = (scorer: string, number: number) => ({ scorer, subject: { runId: JUDGED, step: 'fix', pass: number } });
  const ofSession = (scorer: string, sessionId: string) => ({ scorer, source: 'session', subject: { ...SESSION_SUBJECT, sessionId }, session: { used: { skills: [] }, prompt: 'Add retries' } });

  function sessionLabel(scorer: string, sessionId: string, judge: Record<string, unknown>): string {
    return `${JSON.stringify({ scorer, rubric: { sourceHash: 'h1' }, label: 'good', score: 1, passed: true, source: 'session', subject: { ...SESSION_SUBJECT, sessionId }, judge, scoredAt: later(-1) })}\n`;
  }

  /** An attempts store with each kind of entry main's lease rules knew, and labels written without an attempt. */
  function upgraded(): LocalConfig {
    const config = scope();
    plant(config, [{ ...ofPass('labelled', 1), ...settled, status: 'succeeded', ...verdict }]);
    plant(config, [{ ...ofPass('failed', 1), ...settled, status: 'failed', code: 'judge_failed' }]);
    plant(config, [{ ...ofPass('lapsed', 1), ...lapsedLease }, { ...ofPass('lapsed', 1), ...lapsedLease }]);
    plant(config, [1, 2, 3, 4].map(() => ({ ...ofPass('worn', 1), ...lapsedLease })));
    plant(config, [{ ...ofPass('leased', 1), ...lapsedLease }, { ...ofPass('leased', 1), ...liveLease }]);
    plant(config, [], { scorer: 'requested', pass: 1, requestedAt: later(-1) });
    plant(config, [{ ...ofSession('labelled', 's1'), ...settled, status: 'succeeded', ...verdict }]);
    plant(config, [{ ...ofSession('released', 's1'), ...settled, status: 'released' }]);
    plant(config, [{ ...ofSession('failed', 's1'), ...settled, status: 'failed', code: 'judge_answer_invalid' }]);
    plant(config, [{ ...ofSession('leased', 's1'), ...liveLease }]);
    fs.writeFileSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), [
      sessionLabel('judged', 's2', { kind: 'model', tool: 'claude', isolation: 'verified', access: 'read' }),
      sessionLabel('by-hand', 's2', { kind: 'human' }),
    ].join(''));

    return config;
  }

  const passKeys = ['labelled', 'failed', 'lapsed', 'worn', 'leased', 'requested'].map((scorer) => pass(scorer));
  const sessionKeys = [['labelled', 's1'], ['released', 's1'], ['failed', 's1'], ['leased', 's1'], ['judged', 's2'], ['by-hand', 's2']].map(([scorer = '', id]) => session(scorer, id));

  it('keeps a closed entry closed and an open one open, its lapses counted and its request kept', async () => {
    const config = upgraded();
    const reader = runs();
    reader.set(JUDGED, { ended: true, changedAt: later(-10) });

    expect(await Marks.states(config, passKeys, { now: NOW, readRun: reader.readRun })).toEqual([
      { kind: 'labelled' },
      { kind: 'failed', code: 'judge_failed' },
      { kind: 'lapsed', lapses: 2 },
      { kind: 'failed', code: 'lease_expired' },
      { kind: 'lapsed', lapses: 1 },
      { kind: 'lapsed', lapses: 0 },
    ]);
    expect(await Marks.states(config, [pass('lapsed'), pass('requested')], { now: later(10), readRun: reader.readRun })).toEqual([{ kind: 'expired' }, { kind: 'lapsed', lapses: 0 }]);
  });

  it('closes a session that was tried or labelled, and keeps a session a live lease held open', async () => {
    const config = upgraded();

    expect(await Marks.states(config, sessionKeys, { now: NOW, readRun: runs().readRun })).toEqual([
      { kind: 'labelled' },
      { kind: 'failed', code: 'lease_expired' },
      { kind: 'failed', code: 'judge_answer_invalid' },
      { kind: 'lapsed', lapses: 0 },
      { kind: 'labelled' },
      { kind: 'unmarked' },
    ]);
    expect(await Marks.carriedOver(config, { now: NOW })).toEqual({ passes: 3, sessions: 1 });
  });

  it('carries the attempts once, and a mark written since outranks what it carried', async () => {
    const config = upgraded();
    const reader = runs();
    await Marks.states(config, [], { now: NOW, readRun: reader.readRun });
    plant(config, [{ ...ofPass('lapsed', 1), ...settled, status: 'succeeded', ...verdict }, { ...ofPass('fresh', 1), ...settled, status: 'failed', code: 'judge_failed' }]);

    expect(await launch(config, [pass('lapsed')], NOW, { reader })).toMatchObject({ opened: [{ keys: [pass('lapsed')] }] });
    reader.end('score-1');
    expect(await Marks.states(config, [pass('lapsed'), pass('fresh')], { now: later(1), readRun: reader.readRun })).toEqual([{ kind: 'lapsed', lapses: 3 }, { kind: 'unmarked' }]);
    expect(await Marks.carriedOver(config, { now: NOW })).toEqual({ passes: 3, sessions: 1 });
  });

  it('counts what a pass was asked again for only from that request on, and skips an attempt file it cannot read', async () => {
    const config = scope();
    const reader = runs();
    reader.set(JUDGED, { ended: true, changedAt: later(-10) });
    const asked = (scorer: string) => ({ scorer, pass: 1, requestedAt: later(-2) });
    const since = { status: 'leased', leasedAt: later(-1.5), expiresAt: later(-1.4) };
    plant(config, [{ ...ofPass('asked', 1), leasedAt: later(-3), expiresAt: later(-2.9), status: 'failed', code: 'judge_failed' }], asked('asked'));
    plant(config, [{ ...ofPass('held', 1), ...liveLease, leasedAt: later(-3) }, ...[1, 2, 3, 4].map(() => ({ ...ofPass('held', 1), ...since }))], asked('held'));
    plant(config, [], asked('relabelled'));
    const torn = plant(config, [{ ...ofPass('torn', 1), ...settled, status: 'failed', code: 'judge_failed' }]);
    fs.writeFileSync(path.join(torn, 'a0000ffff.json'), '{"attempt":');
    const judged = { kind: 'model', tool: 'claude', isolation: 'verified', access: 'read' };
    const runLabel = (scorer: string, scoredAt: string) => `${JSON.stringify({
      scorer, rubric: { sourceHash: 'h1' }, label: 'good', score: 1, passed: true, source: 'workflow', subject: { runId: JUDGED, step: 'fix', pass: 1 }, judge: judged, scoredAt,
    })}\n`;
    fs.writeFileSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), runLabel('asked', later(-2.5)) + runLabel('relabelled', later(-1)));

    expect(await Marks.states(config, ['asked', 'held', 'relabelled', 'torn'].map((scorer) => pass(scorer)), { now: NOW, readRun: reader.readRun })).toEqual([
      { kind: 'lapsed', lapses: 0 },
      { kind: 'lapsed', lapses: 3 },
      { kind: 'labelled' },
      { kind: 'failed', code: 'judge_failed' },
    ]);
  });

  it('carries nothing and writes nothing where nothing was ever scored', async () => {
    const config = scope();

    expect(await Marks.carriedOver(config, { now: NOW })).toBeUndefined();
    expect(fs.existsSync(config.dataHome ?? '')).toBe(false);
  });
});
