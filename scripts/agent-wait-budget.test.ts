import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROCESS_READ_CHANNEL } from '@teamai/shared/process-group';

import { type AgentWaitBudget, compareAgentWait, fileSystemCalls, otherProcesses } from './agent-wait-budget.js';

type Row = AgentWaitBudget['rows'][number];

const row = (name: string, run: Row['run'], counts: Partial<Row> = {}): Row => ({
  row: name,
  run,
  gitWaited: 2,
  gitAfter: 3,
  nodeWaited: 1,
  nodeAfter: 1,
  fastPath: true,
  filesWritten: 1,
  remote: [],
  ghWaited: 0,
  ghAfter: 0,
  otherWaited: 0,
  otherAfter: 0,
  gitByCommand: {},
  otherByCommand: {},
  waitedMs: 100,
  fsWaited: 40,
  fsAfter: 0,
  ...counts,
});

const budget = (...rows: Row[]): AgentWaitBudget => ({ commit: 'abc', platform: 'linux-x64', git: '2.54.0', tool: 'claude', toolVersion: '2.1.322', rows });

const top = (markdown: string): string => markdown.split('<details>')[0]?.trim() ?? '';

describe('compareAgentWait', () => {
  it('reports a waited count that grew, with the sentence the review keeps', () => {
    const { markdown, grew } = compareAgentWait(budget(row('SessionStart', 'second', { gitWaited: 8 })), budget(row('SessionStart', 'second', { gitWaited: 7 })));

    expect(top(markdown)).toBe(
      [
        '| What the agent waits on | main | this PR | Change |',
        '| --- | ---: | ---: | ---: |',
        '| SessionStart, second run, git processes | 7 | 8 | +1 |',
        '',
        'Agent wait grew. Say why in the PR.',
      ].join('\n'),
    );
    expect(grew).toEqual(['SessionStart, second run, git processes']);
  });

  it('reports a waited process that is not git, Node or gh, and asks why it grew', () => {
    const { markdown, grew } = compareAgentWait(budget(row('SessionStart with a stale fetch', 'first', { otherWaited: 1 })), budget(row('SessionStart with a stale fetch', 'first')));
    const label = 'SessionStart with a stale fetch, first run, other processes';

    expect(top(markdown)).toContain(`| ${label} | 0 | 1 | +1 |`);
    // The review keeps only rows its filter matches (codex-review-on-assign.yml, ROW).
    expect(`| ${label} | 0 | 1 | +1 |`).toMatch(/^\| [A-Za-z ,-]{1,60} \|( [0-9 ,.%()+*<B\u2212\u2014-]{1,30} \|){3}$/);
    expect(grew).toEqual([label]);
  });

  it('reports a waited count that dropped without asking for a reason', () => {
    const { markdown, grew } = compareAgentWait(budget(row('UserPromptSubmit', 'second', { gitWaited: 0 })), budget(row('UserPromptSubmit', 'second')));

    expect(top(markdown)).toBe(['| What the agent waits on | main | this PR | Change |', '| --- | ---: | ---: | ---: |', '| UserPromptSubmit, second run, git processes | 2 | 0 | -2 |'].join('\n'));
    expect(grew).toEqual([]);
  });

  it('says nothing changed when only work after the hook moved', () => {
    const { markdown, grew } = compareAgentWait(budget(row('Stop', 'first', { gitAfter: 1 })), budget(row('Stop', 'first')));

    expect(top(markdown)).toBe('What the agent waits on did not change.');
    expect(markdown).toContain('| Stop, first run | 2 | 3 / 1 |');
    expect(grew).toEqual([]);
  });

  it('compares no time: a row whose only difference is how long it waited did not change, and shows both times', () => {
    const { markdown, grew } = compareAgentWait(budget(row('SessionStart', 'second', { waitedMs: 412 })), budget(row('SessionStart', 'second', { waitedMs: 1180 })));

    expect(top(markdown)).toBe('What the agent waits on did not change.');
    expect(markdown).toContain('| SessionStart, second run | 2 | 3 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 40 | 0 | 1180 / 412 |');
    expect(grew).toEqual([]);
  });

  it('shows file system calls in the full table without comparing them, and none for a main that did not count them', () => {
    const { fsWaited: _waited, fsAfter: _after, ...uncounted } = row('pull after init', 'second');
    const { markdown, grew } = compareAgentWait(budget(row('pull after init', 'second', { fsWaited: 900 })), budget(uncounted));

    expect(top(markdown)).toBe('What the agent waits on did not change.');
    expect(markdown).toContain('| pull after init, second run | 2 | 3 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | none / 900 | none / 0 | 100 / 100 |');
    expect(grew).toEqual([]);
  });

  it('keeps a row only one side measured out of the comparison and shows it in the full table', () => {
    const { markdown, grew } = compareAgentWait(budget(row('Stop', 'first'), row('git worktree add', 'first', { gitWaited: 17 })), budget(row('Stop', 'first'), row('pull after init', 'first')));

    expect(top(markdown)).toBe('What the agent waits on did not change.');
    expect(markdown).toContain('| git worktree add, first run | none / 17 |');
    expect(markdown).toContain('| pull after init, first run | 2 / none |');
    expect(grew).toEqual([]);
  });
});

describe('otherProcesses', () => {
  const start = (pid: number, side: 'waited' | 'after') => ({ ev: 'start' as const, pid, argv: ['node', 'teamai'], side });
  const spawn = (pid: number, command: string[], child: number | null = null, detached = false) => ({ ev: 'spawn' as const, pid, child, command, detached });

  it('counts each process on the side of the Node that started it, or after when detached, by name', () => {
    expect(otherProcesses([
      start(1, 'waited'),
      start(2, 'after'),
      spawn(1, ['claude', '--version'], 10),
      spawn(1, ['/bin/bash', '-lc', 'exec teamai "$@"', 'teamai'], 11, true),
      spawn(2, ['/usr/bin/claude', '--version'], 12),
      spawn(1, ['which opencode']),
    ])).toEqual({
      waited: 2,
      after: 2,
      byCommand: { 'bash -lc exec': { waited: 0, after: 1 }, claude: { waited: 1, after: 1 }, 'sh -c which': { waited: 1, after: 0 } },
    });
  });

  it('leaves out git, gh and Node, which have their own counts', () => {
    expect(otherProcesses([
      start(1, 'waited'),
      start(5, 'after'),
      spawn(1, ['/usr/bin/git', 'rev-parse'], 3),
      spawn(1, ['gh', 'pr', 'list'], 4),
      spawn(1, ['/opt/node/bin/node', 'index.js'], 6),
      spawn(1, ['/home/m/.teamai/bin/teamai', 'hook-dispatch'], 5, true),
    ])).toEqual({ waited: 0, after: 0, byCommand: {} });
  });
});

describe('fileSystemCalls', () => {
  it('adds each process\'s calls to the side it ran on, and a process with no start record to the waited side', () => {
    expect(fileSystemCalls([
      { ev: 'start', pid: 1, argv: ['node', 'teamai'], side: 'waited' },
      { ev: 'start', pid: 2, argv: ['node', 'teamai'], side: 'after' },
      { ev: 'fs', pid: 1, calls: 120 },
      { ev: 'fs', pid: 2, calls: 30 },
      { ev: 'fs', pid: 3, calls: 5 },
    ])).toEqual({ waited: 125, after: 30 });
  });
});

describe('agent-wait-preload.cjs', () => {
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-wait-preload.cjs');

  /** The records the preload logs for a Node process that tells `reads` on the process read channel. */
  function recordsOf(reads: Array<{ ps: string[]; spawned: boolean }>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-wait-preload-'));
    const log = path.join(dir, 'node.jsonl');

    try {
      const script = `const channel = require('node:diagnostics_channel').channel(${JSON.stringify(PROCESS_READ_CHANNEL)}); for (const read of ${JSON.stringify(reads)}) channel.publish(read);`;
      const ran = spawnSync(process.execPath, ['--require', preload, '-e', script], { env: { ...process.env, AGENT_WAIT_NODE_LOG: log }, encoding: 'utf8' });
      expect(ran.status, ran.stderr).toBe(0);

      return fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('counts a process read Linux answers from /proc as the ps macOS runs for it, so CI sees a wait only macOS has', () => {
    const records = recordsOf([{ ps: ['-o', 'lstart=', '-p', '42'], spawned: false }]);

    expect(records.filter((record) => record.ev === 'spawn')).toEqual([expect.objectContaining({ command: ['ps', '-o', 'lstart=', '-p', '42'], child: null, detached: false })]);
    expect(otherProcesses(records)).toMatchObject({ waited: 1, after: 0, byCommand: { ps: { waited: 1, after: 0 } } });
  });

  it('counts a read that ran ps once, by its spawn alone', () => {
    expect(recordsOf([{ ps: ['-o', 'lstart=', '-p', '42'], spawned: true }]).filter((record) => record.ev === 'spawn')).toEqual([]);
  });
});
