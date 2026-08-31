import { describe, expect, it } from 'vitest';
import { resolveHookCwd } from '../utils/hook-cwd.js';

describe('resolveHookCwd', () => {
  it('prefers a non-empty cwd over workspace_roots', () => {
    expect(resolveHookCwd({
      cwd: '/from-cwd',
      workspace_roots: ['/from-roots'],
    })).toBe('/from-cwd');
  });

  it('uses the first workspace_roots entry when cwd is missing', () => {
    expect(resolveHookCwd({
      hook_event_name: 'sessionStart',
      workspace_roots: ['/Users/jeffxu/Project/teamai-cli'],
    })).toBe('/Users/jeffxu/Project/teamai-cli');
  });

  it('treats empty cwd as missing and falls back to workspace_roots', () => {
    expect(resolveHookCwd({
      cwd: '',
      workspace_roots: ['/project'],
    })).toBe('/project');
  });

  it('skips blank workspace_roots entries', () => {
    expect(resolveHookCwd({
      workspace_roots: ['', '  ', '/real-root'],
    })).toBe('/real-root');
  });

  it('returns undefined when neither cwd nor workspace_roots is usable', () => {
    expect(resolveHookCwd({})).toBeUndefined();
    expect(resolveHookCwd({ cwd: '  ', workspace_roots: [] })).toBeUndefined();
    expect(resolveHookCwd({ workspace_roots: [123, null] })).toBeUndefined();
  });
});
