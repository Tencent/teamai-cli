import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalRepo, attributeRepo, repoKeys, repoLabel, repoName } from '../utils/repo-attribution.js';
import { attributeByRepo, timeAnalytics, renderHourSparkline } from '../session-analytics.js';
import type { DashboardEvent, TokenUsage } from '../types.js';

function ev(p: Partial<DashboardEvent> & { type: DashboardEvent['type']; timestamp: string; sessionId: string }): DashboardEvent {
  return { tool: 'claude', ...p } as DashboardEvent;
}
function tok(input: number, output: number): TokenUsage {
  return { input, output, cacheRead: 0, cacheCreation: 0 };
}

describe('canonicalRepo', () => {
  it('drops host and keeps owner/repo across platforms', () => {
    expect(canonicalRepo('github.com/Eyre921/new-api')).toBe('Eyre921/new-api');
    expect(canonicalRepo('cnb.cool/Eyre921/new-api')).toBe('Eyre921/new-api');
    expect(canonicalRepo('https://github.com/Tencent/teamai-cli.git')).toBe('Tencent/teamai-cli');
    expect(canonicalRepo('git@github.com:Tencent/teamai-cli.git')).toBe('Tencent/teamai-cli');
  });
  it('handles the legacy owner_repo underscore form', () => {
    expect(canonicalRepo('Eyre921_new-api')).toBe('Eyre921/new-api');
  });
  it('returns null when no owner can be derived', () => {
    expect(canonicalRepo('new-api')).toBeNull();
  });
});

describe('attributeRepo', () => {
  it('uses the project directory name for filesystem paths', () => {
    expect(attributeRepo('/home/u/new-api')).toBe('new-api');
    expect(attributeRepo('/opt/teamai-cli/')).toBe('teamai-cli');
  });
  it('canonicalizes remote-form cwds to owner/repo', () => {
    expect(attributeRepo('github.com/Tencent/teamai-cli')).toBe('Tencent/teamai-cli');
  });
  it('maps home/root/ops/empty dirs to no_repo', () => {
    expect(attributeRepo('/home')).toBe('no_repo');
    expect(attributeRepo('/root')).toBe('no_repo');
    expect(attributeRepo('/opt')).toBe('no_repo');
    expect(attributeRepo('')).toBe('no_repo');
    expect(attributeRepo(undefined)).toBe('no_repo');
  });
  it('splits Windows paths on the backslash too', () => {
    expect(attributeRepo('C:\\Users\\u\\new-api')).toBe('new-api');
    expect(attributeRepo('D:\\src\\teamai-cli')).toBe('teamai-cli');
    expect(attributeRepo('\\\\srv\\share\\new-api')).toBe('new-api');
  });
  it('maps a Windows path whose leaf is not a project to no_repo', () => {
    expect(attributeRepo('C:\\Users')).toBe('no_repo');
    expect(attributeRepo('C:\\src\\data')).toBe('no_repo');
    expect(attributeRepo('C:\\')).toBe('no_repo');
  });
});

describe('repoKeys (#809)', () => {
  it('keys a session by the last anchor it recorded, else its last cwd', () => {
    const keys = repoKeys([
      ev({ type: 'prompt_submit', timestamp: 't1', sessionId: 'wt', cwd: '/w/wt-a', projectAnchor: '/w/repo' }),
      // Written after the worktree was removed: no anchor, and the session keeps it.
      ev({ type: 'stop', timestamp: 't2', sessionId: 'wt', cwd: '/w/wt-a' }),
      ev({ type: 'prompt_submit', timestamp: 't1', sessionId: 'old', cwd: '/w/old' }),
      ev({ type: 'prompt_submit', timestamp: 't1', sessionId: 'none' }),
    ]);
    expect(Object.fromEntries(keys)).toEqual({ wt: '/w/repo', old: '/w/old', none: '' });
  });
});

describe('repoLabel (#809)', () => {
  it('names a key by its directory, qualified by the parent only when names collide', () => {
    const keys = ['/w/work/api', '/w/personal/api', '/w/solo'];
    expect(repoLabel('/w/work/api', keys)).toBe('work/api');
    expect(repoLabel('/w/personal/api', keys)).toBe('personal/api');
    expect(repoLabel('/w/solo', keys)).toBe('solo');
  });
  it('falls back to the whole key when the parent names collide too', () => {
    expect(repoLabel('/a/work/api', ['/a/work/api', '/b/work/api'])).toBe('/a/work/api');
  });
  it('keeps no_repo for directories that are not a project', () => {
    expect(repoLabel('/home', ['/home', '/root', ''])).toBe('no_repo');
    expect(repoLabel('', ['/home', ''])).toBe('no_repo');
  });
  it('gives remote-form keys that canonicalize alike one label, so they share a row', () => {
    const keys = ['github.com/Tencent/teamai-cli', 'cnb.cool/Tencent/teamai-cli'];
    expect(keys.map((k) => repoLabel(k, keys))).toEqual(['Tencent/teamai-cli', 'Tencent/teamai-cli']);
    const repos = attributeByRepo(keys.map((cwd, i) => ev({ type: 'tool_use', timestamp: 't1', sessionId: `s${i}`, cwd })));
    expect(repos.map((r) => [r.repo, r.sessions])).toEqual([['Tencent/teamai-cli', 2]]);
  });
  it('does not give a local path the label of a remote key (#823)', () => {
    const keys = ['github.com/acme/api', '/x/acme/api', '/y/other/api'];
    expect(keys.map((k) => repoLabel(k, keys))).toEqual(['acme/api', '/x/acme/api', 'other/api']);
    const repos = attributeByRepo(keys.map((cwd, i) => ev({ type: 'tool_use', timestamp: 't1', sessionId: `s${i}`, cwd })));
    expect(repos.map((r) => [r.repo, r.sessions]).sort()).toEqual([['/x/acme/api', 1], ['acme/api', 1], ['other/api', 1]]);
  });
});

describe('repoName (#809)', () => {
  let base = '';
  beforeAll(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-repo-name-')));
  });
  afterAll(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });
  const bare = (...segs: string[]) => {
    const dir = path.join(base, ...segs);
    execFileSync('git', ['init', '-q', '--bare', dir]);
    return dir;
  };

  it('names a bare git directory after its repo', () => {
    expect(repoName(bare('a', 'repo', '.bare'))).toBe('repo');
    expect(repoName(bare('b', 'repo', '.git'))).toBe('repo');
    expect(repoName(bare('c', 'repo.git'))).toBe('repo');
  });

  it('keeps every other directory\'s own name', () => {
    const checkout = path.join(base, 'd', 'foo.git');
    fs.mkdirSync(checkout, { recursive: true });
    execFileSync('git', ['init', '-q', checkout]);
    // A checkout whose own files are named like a git directory's is still a checkout.
    fs.writeFileSync(path.join(checkout, 'HEAD'), '');
    fs.mkdirSync(path.join(checkout, 'objects'));
    expect(repoName(checkout)).toBe('foo.git');
    expect(repoName(path.join(base, 'gone', 'repo', '.bare'))).toBe('.bare');
  });

  it('labels two bare repos with the same name by their parents', () => {
    const keys = [bare('work', 'repo', '.bare'), bare('personal', 'repo', '.bare')];
    expect(keys.map((k) => repoLabel(k, keys))).toEqual(['work/repo', 'personal/repo']);
    expect(repoLabel(keys[0], [keys[0]])).toBe('repo');
  });

  it('names a repo after its directory even when that is a word like workspace, with its worktrees', () => {
    for (const word of ['workspace', 'home', 'data']) {
      const main = path.join(base, 'words', word);
      const worktree = path.join(base, 'words', `${word}-wt`);
      fs.mkdirSync(main, { recursive: true });
      execFileSync('git', ['init', '-q', main]);
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main });
      execFileSync('git', ['worktree', 'add', '-q', worktree], { cwd: main });
      const repos = attributeByRepo([
        ev({ type: 'tool_use', timestamp: 't1', sessionId: 'main', cwd: main, projectAnchor: main }),
        ev({ type: 'tool_use', timestamp: 't1', sessionId: 'wt', cwd: worktree, projectAnchor: main }),
      ]);
      expect(repos.map((r) => [r.repo, r.sessions])).toEqual([[word, 2]]);
    }
    // A directory with that name that is not a repo is still no_repo.
    const plain = path.join(base, 'plain', 'data');
    fs.mkdirSync(plain, { recursive: true });
    expect(repoLabel(plain, [plain])).toBe('no_repo');
  });

  it('keeps a bare repo\'s keys in one row when its label falls back to a path (#823)', () => {
    // A remote key takes `acme/api`, so the bare repo cannot be qualified to it.
    const anchor = bare('g', 'acme', 'api', '.bare');
    const container = path.join(base, 'g', 'acme', 'api');
    const other = path.join(base, 'h', 'other', 'api');
    fs.mkdirSync(other, { recursive: true });
    const keys = ['github.com/acme/api', anchor, container, other];
    expect(repoLabel(anchor, keys)).toBe(repoLabel(container, keys));
    expect(repoLabel(anchor, keys)).not.toBe('acme/api');
  });

  it('counts a session in a bare layout\'s own directory as that repo', () => {
    const anchor = bare('e', 'repo', '.bare');
    const container = path.join(base, 'e', 'repo');
    const repos = attributeByRepo([
      ev({ type: 'tool_use', timestamp: 't1', sessionId: 'wt', cwd: path.join(container, 'main'), projectAnchor: anchor }),
      ev({ type: 'tool_use', timestamp: 't1', sessionId: 'top', cwd: container }),
    ]);
    expect(repos.map((r) => [r.repo, r.sessions])).toEqual([['repo', 2]]);
  });
});

describe('attributeByRepo', () => {
  const events: DashboardEvent[] = [
    // Session A in /home/u/alpha: 2 tools, 1 prompt, tokens 100/50
    ev({ type: 'session_start', timestamp: '2026-07-01T10:00:00.000Z', sessionId: 'A', cwd: '/home/u/alpha' }),
    ev({ type: 'prompt_submit', timestamp: '2026-07-01T10:00:01.000Z', sessionId: 'A', cwd: '/home/u/alpha', promptSummary: 'hi' }),
    ev({ type: 'tool_use', timestamp: '2026-07-01T10:00:02.000Z', sessionId: 'A', cwd: '/home/u/alpha', toolName: 'Edit' }),
    ev({ type: 'tool_use', timestamp: '2026-07-01T10:00:03.000Z', sessionId: 'A', cwd: '/home/u/alpha', toolName: 'Bash' }),
    ev({ type: 'stop', timestamp: '2026-07-01T10:00:10.000Z', sessionId: 'A', cwd: '/home/u/alpha', tokens: tok(100, 50), prompts: 1, interventions: { interrupt: 1, toolReject: 0 } }),
    // Session B also in /home/u/alpha: 1 tool
    ev({ type: 'tool_use', timestamp: '2026-07-01T11:00:00.000Z', sessionId: 'B', cwd: '/home/u/alpha', toolName: 'Read' }),
    ev({ type: 'stop', timestamp: '2026-07-01T11:00:05.000Z', sessionId: 'B', cwd: '/home/u/alpha', tokens: tok(10, 5), prompts: 0 }),
    // Session C in /home/u/beta: 1 tool
    ev({ type: 'tool_use', timestamp: '2026-07-01T12:00:00.000Z', sessionId: 'C', cwd: '/home/u/beta', toolName: 'Grep' }),
  ];

  it('groups sessions by repo and rolls up totals', () => {
    const repos = attributeByRepo(events);
    const alpha = repos.find((r) => r.repo === 'alpha')!;
    const beta = repos.find((r) => r.repo === 'beta')!;
    expect(alpha.sessions).toBe(2);
    expect(alpha.tools).toBe(3); // Edit + Bash + Read
    expect(alpha.prompts).toBe(1);
    expect(alpha.interventions).toBe(1);
    expect(alpha.tokens.input).toBe(110);
    expect(beta.sessions).toBe(1);
    expect(beta.tools).toBe(1);
  });

  it('sorts repos by total tokens then sessions (alpha before beta)', () => {
    const repos = attributeByRepo(events);
    expect(repos[0].repo).toBe('alpha');
  });

  it('counts every worktree of a repo as the repo, and merges non-project dirs into no_repo', () => {
    const repos = attributeByRepo([
      ev({ type: 'tool_use', timestamp: 't1', sessionId: 'main', cwd: '/w/repo', projectAnchor: '/w/repo' }),
      ev({ type: 'tool_use', timestamp: 't1', sessionId: 'wt', cwd: '/w/wt-a', projectAnchor: '/w/repo' }),
      ev({ type: 'tool_use', timestamp: 't1', sessionId: 'h', cwd: '/home' }),
      ev({ type: 'tool_use', timestamp: 't1', sessionId: 'r', cwd: '/root' }),
    ]);
    expect(repos.map((r) => [r.repo, r.sessions]).sort()).toEqual([['no_repo', 2], ['repo', 2]]);
  });

  it('labels Windows cwds by their project directory and merges non-project dirs into no_repo', () => {
    const repos = attributeByRepo([
      ev({ type: 'tool_use', timestamp: 't1', sessionId: 'a', cwd: 'C:\\Users\\dev\\work\\teamai-cli' }),
      ev({ type: 'tool_use', timestamp: 't2', sessionId: 'b', cwd: 'C:\\Users\\dev\\work\\teamai-cli' }),
      ev({ type: 'tool_use', timestamp: 't3', sessionId: 'c', cwd: 'C:\\Users\\dev\\home' }),
      ev({ type: 'tool_use', timestamp: 't4', sessionId: 'd', cwd: 'C:\\src\\data' }),
    ]);
    expect(repos.map((r) => [r.repo, r.sessions]).sort()).toEqual([['no_repo', 2], ['teamai-cli', 2]]);
  });
});

describe('timeAnalytics', () => {
  const events: DashboardEvent[] = [
    ev({ type: 'prompt_submit', timestamp: '2026-07-01T02:00:00.000Z', sessionId: 'A' }),
    ev({ type: 'tool_use', timestamp: '2026-07-01T02:02:00.000Z', sessionId: 'A' }), // +2min (active)
    ev({ type: 'tool_use', timestamp: '2026-07-01T02:30:00.000Z', sessionId: 'A' }), // +28min (idle, not counted)
    ev({ type: 'prompt_submit', timestamp: '2026-07-01T14:00:00.000Z', sessionId: 'B' }),
  ];

  it('counts active minutes only for sub-idle gaps', () => {
    const ta = timeAnalytics(events);
    expect(ta.activeMinutes).toBe(2);
    expect(ta.totalEvents).toBe(4);
  });

  it('byHour sums to total and peakHour is the argmax (TZ-independent checks)', () => {
    const ta = timeAnalytics(events);
    expect(ta.byHour.reduce((a, b) => a + b, 0)).toBe(4);
    const max = Math.max(...ta.byHour);
    expect(ta.byHour[ta.peakHour]).toBe(max);
  });

  it('night-owl ratio matches the local-hour split of the same timestamps', () => {
    const ta = timeAnalytics(events);
    const expectedNight = events.filter((e) => new Date(e.timestamp).getHours() < 6).length / events.length;
    expect(ta.nightOwlRatio).toBeCloseTo(expectedNight, 5);
  });

  it('returns empty analytics for no events', () => {
    const ta = timeAnalytics([]);
    expect(ta).toEqual({ byHour: Array.from({ length: 24 }, () => 0), peakHour: -1, nightOwlRatio: 0, activeMinutes: 0, totalEvents: 0 });
  });
});

describe('renderHourSparkline', () => {
  it('renders 24 characters', () => {
    const spark = renderHourSparkline(Array.from({ length: 24 }, (_, i) => i));
    expect(spark.length).toBe(24);
  });

  it('renders all-zero input as 24 dots (idle is distinct from low activity)', () => {
    expect(renderHourSparkline(Array.from({ length: 24 }, () => 0))).toBe('·'.repeat(24));
  });

  it('renders a single peak as a full bar and empty hours as dots', () => {
    const byHour = Array.from({ length: 24 }, () => 0);
    byHour[9] = 42;
    const spark = renderHourSparkline(byHour);
    expect(spark[9]).toBe('█');
    expect(spark[0]).toBe('·');
    expect(spark.replace(/[·█]/g, '')).toBe(''); // only dots and the one full bar
  });
});
