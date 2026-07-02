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
});
