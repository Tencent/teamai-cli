import { describe, expect, it } from 'vitest';
import type { SessionCapture } from '../session-flow/captures.js';
import type { Session } from '../session-flow/ir.js';
import { judgeSession } from '../session-flow/session-work.js';

const session = (): Session => ({
  sessionId: 's1', title: '', cwd: '/w', platform: 'claude-code',
  createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z', messages: [],
});

const capture = (extra: Partial<SessionCapture>): SessionCapture => ({
  captureId: '0b6f2a52-5d7e-4c7e-9a43-000000000001', platform: 'claude-code', sessionId: 's1',
  capturedAt: '2026-10-20T10:00:00.000Z',
  agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' },
  ...extra,
});

describe('a finished session carries its team skills in its evidence (#1469)', () => {
  it('lists the delivered team skills and loads no skills_unknown gap', () => {
    const judged = judgeSession({
      platform: 'claude-code', found: { session: session() },
      captures: [capture({ teamSkillInfo: { release: { namespace: 'ops', description: 'cut a release' } } })],
      mask: (text) => text,
    });
    expect(judged.manifest.skills).toEqual({ available: [{ name: 'release', namespace: 'ops', description: 'cut a release' }], used: [] });
    expect(judged.manifest.gaps).not.toContain('skills_unknown');
  });

  it('has no skills key and the skills_unknown gap when no capture recorded descriptions', () => {
    const judged = judgeSession({ platform: 'claude-code', found: { session: session() }, captures: [capture({})], mask: (text) => text });
    expect(judged.manifest.skills).toBeUndefined();
    expect(judged.manifest.gaps).toContain('skills_unknown');
  });
});
