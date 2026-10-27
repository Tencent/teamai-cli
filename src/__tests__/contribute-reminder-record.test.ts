import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReminderDecisions, writeContributeState } from '../contribute-check.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let home = '';
const originalHome = process.env.HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-reminder-record-'));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function backdate(file: string, days: number): void {
  const when = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(file, when, when);
}

/** Writes the state of `sessionId`, then ages it `days`, as a session last written that long ago. */
async function stateOf(sessionId: string, hinted: boolean | undefined, days: number): Promise<void> {
  await writeContributeState(sessionId, { contributed: false, ...(hinted === undefined ? {} : { hinted }) });
  backdate(path.join(home, '.teamai', 'sessions', `${sessionId}.json`), days);
}

describe('reminder decisions kept past the 24 hours sweep', () => {
  it('still says yes for a session whose reminder fired 10 days ago and whose state file was swept since', async () => {
    await stateOf('fired', true, 10);
    await writeContributeState('next-session', { contributed: false });
    expect(fs.existsSync(path.join(home, '.teamai', 'sessions', 'fired.json'))).toBe(false);
    expect((await readReminderDecisions()).get('fired')).toBe(true);
  });

  it('still says no for a session whose reminder did not fire and whose state file was swept 10 days ago', async () => {
    await stateOf('quiet', undefined, 10);
    await writeContributeState('next-session', { contributed: false });
    expect(fs.existsSync(path.join(home, '.teamai', 'sessions', 'quiet.json'))).toBe(false);
    expect((await readReminderDecisions()).get('quiet')).toBe(false);
  });

  it('forgets a swept session 30 days after its sweep', async () => {
    await stateOf('old', true, 2);
    await writeContributeState('next-session', { contributed: false });
    backdate(path.join(home, '.teamai', 'sessions', 'swept', 'old.json'), 31);
    await writeContributeState('later-session', { contributed: false });
    expect((await readReminderDecisions()).has('old')).toBe(false);
  });

  it('reads a session that was not swept from its state file', async () => {
    await writeContributeState('live', { contributed: false, hinted: true });
    expect((await readReminderDecisions()).get('live')).toBe(true);
    expect((await readReminderDecisions()).has('never-seen')).toBe(false);
  });
});
