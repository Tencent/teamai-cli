import { describe, it, expect } from 'vitest';
import { filterEventsByScope } from '../team-push.js';
import type { DashboardEvent } from '../types.js';

function makeEvent(cwd: string | undefined, sessionId = 's1'): DashboardEvent {
  return { type: 'prompt_submit', timestamp: new Date().toISOString(), sessionId, tool: 'claude', cwd };
}

describe('filterEventsByScope', () => {
  const events: DashboardEvent[] = [
    makeEvent('/Users/jeff/project-a', 's1'),
    makeEvent('/Users/jeff/project-a/src', 's2'),
    makeEvent('/Users/jeff/other-work', 's3'),
    makeEvent('/Users/jeff/project-b', 's4'),
    makeEvent(undefined, 's5'),
  ];

  it('returns all events when no filter is provided', () => {
    expect(filterEventsByScope(events)).toEqual(events);
    expect(filterEventsByScope(events, {})).toEqual(events);
  });

  it('filters to projectRoot (exact match and subdirectories)', () => {
    const result = filterEventsByScope(events, { projectRoot: '/Users/jeff/project-a' });
    expect(result.map((e) => e.sessionId)).toEqual(['s1', 's2']);
  });

  it('projectRoot with trailing slash works the same', () => {
    const result = filterEventsByScope(events, { projectRoot: '/Users/jeff/project-a/' });
    expect(result.map((e) => e.sessionId)).toEqual(['s1', 's2']);
  });

  it('excludeProjectRoots removes matching events and keeps the rest', () => {
    const result = filterEventsByScope(events, { excludeProjectRoots: ['/Users/jeff/project-a'] });
    expect(result.map((e) => e.sessionId)).toEqual(['s3', 's4', 's5']);
  });

  it('excludeProjectRoots with multiple roots', () => {
    const result = filterEventsByScope(events, {
      excludeProjectRoots: ['/Users/jeff/project-a', '/Users/jeff/project-b'],
    });
    expect(result.map((e) => e.sessionId)).toEqual(['s3', 's5']);
  });

  it('events with undefined cwd are kept by excludeProjectRoots', () => {
    const result = filterEventsByScope(events, { excludeProjectRoots: ['/Users/jeff/project-a'] });
    expect(result.find((e) => e.sessionId === 's5')).toBeDefined();
  });

  it('events with undefined cwd are excluded by projectRoot', () => {
    const result = filterEventsByScope(events, { projectRoot: '/Users/jeff/project-a' });
    expect(result.find((e) => e.sessionId === 's5')).toBeUndefined();
  });

  it('does not match partial directory name prefixes', () => {
    const evts = [
      makeEvent('/Users/jeff/project-ab', 'x1'),
      makeEvent('/Users/jeff/project-a', 'x2'),
    ];
    const result = filterEventsByScope(evts, { projectRoot: '/Users/jeff/project-a' });
    expect(result.map((e) => e.sessionId)).toEqual(['x2']);
  });

  // Windows paths are plain strings here, so these run on the ubuntu CI too.
  // Both sides of the comparison are native paths in production: projectRoot is
  // path.resolve(cwd) from init, and cwd is whatever the tool's hook payload
  // carried.
  describe('Windows paths', () => {
    const winEvents: DashboardEvent[] = [
      makeEvent('C:\\Users\\jeff\\project-a', 'w1'),
      makeEvent('C:\\Users\\jeff\\project-a\\src', 'w2'),
      makeEvent('C:\\Users\\jeff\\project-ab', 'w3'),
      makeEvent('C:\\Users\\jeff\\other-work', 'w4'),
    ];

    it('filters to projectRoot including subdirectories', () => {
      const result = filterEventsByScope(winEvents, {
        projectRoot: 'C:\\Users\\jeff\\project-a',
      });
      expect(result.map((e) => e.sessionId)).toEqual(['w1', 'w2']);
    });

    it('excludeProjectRoots removes subdirectory sessions too', () => {
      const result = filterEventsByScope(winEvents, {
        excludeProjectRoots: ['C:\\Users\\jeff\\project-a'],
      });
      expect(result.map((e) => e.sessionId)).toEqual(['w3', 'w4']);
    });

    it('matches a root and a cwd that disagree on separator style', () => {
      const result = filterEventsByScope(winEvents, {
        projectRoot: 'C:/Users/jeff/project-a',
      });
      expect(result.map((e) => e.sessionId)).toEqual(['w1', 'w2']);
    });

    it('trailing backslash on the root works the same', () => {
      const result = filterEventsByScope(winEvents, {
        projectRoot: 'C:\\Users\\jeff\\project-a\\',
      });
      expect(result.map((e) => e.sessionId)).toEqual(['w1', 'w2']);
    });

    it('ignores drive-letter and directory casing', () => {
      const result = filterEventsByScope(winEvents, {
        projectRoot: 'c:\\users\\JEFF\\Project-A',
      });
      expect(result.map((e) => e.sessionId)).toEqual(['w1', 'w2']);
    });

    it('excludeProjectRoots ignores casing too', () => {
      const result = filterEventsByScope(winEvents, {
        excludeProjectRoots: ['c:/users/jeff/project-a'],
      });
      expect(result.map((e) => e.sessionId)).toEqual(['w3', 'w4']);
    });

    it('matches a UNC root whatever its case or separators', () => {
      const uncEvents: DashboardEvent[] = [
        makeEvent('\\\\Server\\Share\\Proj', 'u1'),
        makeEvent('\\\\server\\share\\proj\\src', 'u2'),
        makeEvent('\\\\server\\share\\other', 'u3'),
      ];
      const result = filterEventsByScope(uncEvents, {
        projectRoot: '\\\\SERVER\\SHARE\\proj',
      });
      expect(result.map((e) => e.sessionId)).toEqual(['u1', 'u2']);
    });
  });

  // A POSIX path is case-sensitive, and `\` is a legal character in a POSIX
  // filename, so neither folding may be applied to one.
  describe('POSIX paths keep their own rules', () => {
    it('does not fold case', () => {
      const result = filterEventsByScope(events, { projectRoot: '/users/jeff/PROJECT-A' });
      expect(result.map((e) => e.sessionId)).toEqual([]);
    });

    it('treats a backslash in a filename as part of the name', () => {
      const evts = [makeEvent('/work/a\\b', 'p1'), makeEvent('/work/a/b', 'p2')];
      expect(
        filterEventsByScope(evts, { projectRoot: '/work/a/b' }).map((e) => e.sessionId),
      ).toEqual(['p2']);
      expect(
        filterEventsByScope(evts, { projectRoot: '/work/a\\b' }).map((e) => e.sessionId),
      ).toEqual(['p1']);
    });

    it('does not let a backslash filename escape an excluded root', () => {
      const evts = [makeEvent('/work/a\\b', 'p1'), makeEvent('/work/a/b', 'p2')];
      const result = filterEventsByScope(evts, { excludeProjectRoots: ['/work/a/b'] });
      expect(result.map((e) => e.sessionId)).toEqual(['p1']);
    });
  });
});
