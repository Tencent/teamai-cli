import { describe, expect, it } from 'vitest';
import { Subject } from '../scorers/subject.js';

const forms: Array<[string, Subject]> = [
  ['run:r0123456789abcdef:fix:2', { kind: 'run', subject: { runId: 'r0123456789abcdef', step: 'fix', pass: 2 } }],
  ['run:r01234567:loop[1].review:12', { kind: 'run', subject: { runId: 'r01234567', step: 'loop[1].review', pass: 12 } }],
  ['run:r01234567:a:b:3', { kind: 'run', subject: { runId: 'r01234567', step: 'a:b', pass: 3 } }],
  ['session:claude-code:7c1e2a', { kind: 'session', subject: { platform: 'claude-code', sessionId: '7c1e2a' } }],
  ['session:codex:rollout:2026-10-21', { kind: 'session', subject: { platform: 'codex', sessionId: 'rollout:2026-10-21' } }],
  ['team-session:alice:claude-code_fix-the-retry-loop_20261021', { kind: 'team-session', subject: { author: 'alice', name: 'claude-code_fix-the-retry-loop_20261021' } }],
  ['team-session:bob:name:with:colons', { kind: 'team-session', subject: { author: 'bob', name: 'name:with:colons' } }],
];

describe('Subject', () => {
  it.each(forms)('reads %s as its structured subject and writes it back unchanged', (text, subject) => {
    expect(Subject.parse(text)).toEqual({ ok: true, subject });
    expect(Subject.format(subject)).toBe(text);
  });

  it.each([
    '',
    'run',
    'pass:r01234567:fix:1',
    'run:r01234567:fix',
    'run::fix:1',
    'run:r01234567::1',
    'run:r01234567:fix:0',
    'run:r01234567:fix:01',
    'run:r01234567:fix:-1',
    'run:r01234567:fix:1.5',
    'run:r01234567:fix:9007199254740993',
    'session:claude-code',
    'session::7c1e2a',
    'session:claude-code:',
    'team-session:alice',
    'team-session::name',
    'team-session:alice:',
  ])('refuses %j with subject_invalid, naming the three forms', (text) => {
    expect(Subject.parse(text)).toEqual({
      ok: false,
      code: 'subject_invalid',
      message: `${JSON.stringify(text)} is not a subject. Pass run:<runId>:<step path>:<pass> with a pass from 1, session:<source>:<sessionId>, or team-session:<author>:<archive name>.`,
    });
  });
});
