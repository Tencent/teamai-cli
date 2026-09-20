import { describe, expect, it } from 'vitest';
import { workspaceEvents, type DashboardWorkspace } from '../dashboard/workspaces.js';
import type { DashboardEvent } from '../types.js';

// Minimal event factory: workspaceEvents only reads sessionId + cwd.
const ev = (sessionId: string, cwd: string | undefined, timestamp = '2026-09-17T00:00:00Z'): DashboardEvent =>
  ({ type: 'session_start', timestamp, sessionId, tool: 'claude', cwd });

const project = (id: string, roots: string[]): DashboardWorkspace =>
  ({ id, label: id, scope: 'project', root: roots[0], config: null, roots });

const user: DashboardWorkspace = { id: 'user', label: 'User scope', scope: 'user', root: '/home', config: null, roots: [] };
const unassigned: DashboardWorkspace = { id: 'unassigned', label: 'Unassigned sessions', scope: 'unassigned', root: '', config: null, roots: [] };

describe('workspaceEvents ownership', () => {
  it('assigns an event to the project whose root contains its cwd', () => {
    const ws = [user, project('p1', ['/repo/a']), unassigned];
    const events = [ev('s1', '/repo/a/src')];
    expect(workspaceEvents(events, ws[1], ws).map(e => e.sessionId)).toEqual(['s1']);
    expect(workspaceEvents(events, unassigned, ws)).toEqual([]);
  });

  it('breaks ties by longest matching root (nested projects)', () => {
    const outer = project('outer', ['/repo']);
    const inner = project('inner', ['/repo/pkg']);
    const ws = [user, outer, inner, unassigned];
    const events = [ev('s1', '/repo/pkg/src/x')];
    // /repo/pkg is longer than /repo, so inner wins.
    expect(workspaceEvents(events, inner, ws).map(e => e.sessionId)).toEqual(['s1']);
    expect(workspaceEvents(events, outer, ws)).toEqual([]);
  });

  it('matches a linked-worktree root, not just the main root', () => {
    const p = project('p1', ['/repo/main', '/repo/feat']);
    const ws = [user, p, unassigned];
    const events = [ev('s1', '/repo/feat/src')];
    expect(workspaceEvents(events, p, ws).map(e => e.sessionId)).toEqual(['s1']);
  });

  it('routes an event outside every project to unassigned, not user', () => {
    const ws = [user, project('p1', ['/repo/a']), unassigned];
    const events = [ev('s1', '/somewhere/else'), ev('s2', undefined)];
    expect(workspaceEvents(events, unassigned, ws).map(e => e.sessionId).sort()).toEqual(['s1', 's2']);
    // User scope no longer absorbs unmatched sessions (PR #604 review #3).
    expect(workspaceEvents(events, user, ws)).toEqual([]);
  });

  it('keeps a whole session together once any of its events matches a project', () => {
    const p = project('p1', ['/repo/a']);
    const ws = [user, p, unassigned];
    // First event has no cwd, later event lands in the project — all of s1 follows the match.
    const events = [ev('s1', undefined, '2026-09-17T00:00:00Z'), ev('s1', '/repo/a', '2026-09-17T00:01:00Z')];
    expect(workspaceEvents(events, p, ws).map(e => e.sessionId)).toEqual(['s1', 's1']);
    expect(workspaceEvents(events, unassigned, ws)).toEqual([]);
  });
});
